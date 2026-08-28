/** WanAPIs HTTP 客户端。只做传输与信封解析，参数翻译在 models.js。 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE = 'https://api.wanapis.com';

/** 网关的计费单位:¥1 = 500000 quota。任务响应里的 quota 按这个折人民币。 */
const QUOTA_PER_CNY = 500000;

const EXT_BY_TYPE = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export class WanApisClient {
  constructor({ apiKey, baseUrl }) {
    if (!apiKey) throw new Error('WANAPIS_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  async #request(path, { method = 'GET', body, timeoutMs = 120000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 300)}`);
      }
      if (!res.ok) {
        const msg = json?.error?.message || json?.message || text.slice(0, 300);
        throw new Error(`${res.status}: ${msg}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 提交生成任务。
   *
   * 上游的提交信封有两种形状，两种都要认:
   *   {"code":200,"data":[{"status":"submitted","task_id":"..."}]}   data 是数组
   *   {"code":"success","data":{"status":"submitted","task_id":"..."}}
   * 直接对数组调 .task_id 会静默拿到 undefined —— 这个坑踩过两次。
   */
  async submit(path, body) {
    const json = await this.#request(path, { method: 'POST', body });
    const d = json?.data;
    const taskId =
      json?.task_id ??
      (Array.isArray(d) ? d[0]?.task_id : d?.task_id) ??
      null;
    return { taskId, raw: json };
  }

  /**
   * 同步生图。超时给到 7 分钟 —— 实测生图 25s~572s 都出现过，卡在 180s 会把
   * 正常请求砍掉;而且客户端断开并不会取消上游，照样扣费，所以宁可多等。
   */
  async submitSync(path, body) {
    return this.#request(path, { method: 'POST', body, timeoutMs: 420000 });
  }

  async fetchTask(kind, taskId) {
    const path =
      kind === 'video'
        ? `/v1/video/generations/${encodeURIComponent(taskId)}`
        : `/v1/images/tasks/${encodeURIComponent(taskId)}`;
    return this.#request(path);
  }

  async pricing() {
    return this.#request('/api/pricing', { timeoutMs: 30000 });
  }

  /**
   * 把媒体下载到本地。
   *
   * 必须走这里、不能让 agent 把 URL 直接交给用户:结果 URL 指向网关自己的
   * 媒体代理，**要带 Bearer key 才给内容**(裸访问一律 401)。上游直链被网关
   * 主动重写掉了(防多出口泄露)，所以不存在可公开分享的地址。
   */
  async download(url, destDir, basename) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT_BY_TYPE[type] || '.bin';
    const dest = path.join(destDir, basename.endsWith(ext) ? basename : basename + ext);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return { path: dest, bytes: buf.length, contentType: type };
  }
}

/**
 * 从任务响应里抽出媒体 URL。
 *
 * 一共要认四种形状 —— 前两种是 WanAPIs 自己的 API 形状，后两种是各家上游的
 * 原始结构(经 task.data 透传下来):
 *
 *   data.result_url                     网关规范字段，指向自家媒体代理
 *   data.data.content.video_url         火山口径
 *   data.data.result.videos[].url[]     apimart 口径(url 本身是数组)
 *   data.data.result.images[].url[]     图片同上;Midjourney 一次 4 个 URL
 *
 * ⚠️ 代理是**按需回源**、不长期存储，所以上游直链一过期(约 24h)这个地址也
 * 跟着失效;而且它要带 key 才能访问。真要留存必须 download() 落地。
 */
export function extractMediaUrls(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const urls = [];
  const push = (u) => {
    if (typeof u === 'string' && u && !urls.includes(u)) urls.push(u);
  };

  push(d?.result_url);

  const inner = d?.data && typeof d.data === 'object' ? d.data : null;
  push(inner?.content?.video_url);
  push(inner?.content?.image_url);

  const result = inner?.result ?? d?.result;
  for (const item of result?.videos ?? result?.images ?? []) {
    const u = item?.url;
    if (Array.isArray(u)) u.forEach(push);
    else push(u);
  }
  return urls;
}

export function taskStatus(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const inner = d?.data && typeof d.data === 'object' ? d.data : null;
  const quota = typeof d?.quota === 'number' ? d.quota : null;

  // 上游不保证按请求的规格出片 —— 实测请求 4 秒、出了 5 秒，并按 5 秒计费。
  // 所以完成后要以 actual + costCny 为准，estimate_cost 只是事前预算。
  const actual = {
    duration: inner?.duration ?? null,
    resolution: inner?.resolution ?? null,
    ratio: inner?.ratio ?? null,
  };

  return {
    status: String(d?.status ?? '').toLowerCase(),
    progress: d?.progress ?? null,
    costCny: quota != null ? Number((quota / QUOTA_PER_CNY).toFixed(4)) : null,
    failReason: d?.fail_reason ?? d?.error?.message ?? null,
    actual: Object.values(actual).some((v) => v != null) ? actual : null,
  };
}
