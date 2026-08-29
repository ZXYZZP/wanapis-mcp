#!/usr/bin/env node
/**
 * WanAPIs 生图/生视频 CLI —— 零依赖，只用 Node 内置模块。
 *
 * 存在的意义:各家模型参数体系互不相同(Seedance 的 resolution、Kling 的 mode、
 * Midjourney 塞在 prompt 里的 --q)，让 agent 逐个记住不现实。这里对外只暴露
 * quality / aspect / seconds 三个语义参数，由脚本翻译成各家真实字段。
 *
 * 用法见 --help。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = (process.env.WANAPIS_BASE_URL || 'https://api.wanapis.com').replace(/\/+$/, '');
const KEY = process.env.WANAPIS_API_KEY;
const QUOTA_PER_CNY = 500000;

// ── 模型表(与 @wanapis/mcp 的 src/models.js 保持一致，CI 有断言防漂移)──
const QUALITY = {
  seedance: { low: '480p', medium: '720p', high: '1080p' },
  veo: { low: '720p', medium: '1080p', high: '4k' },
  kling: { low: 'std', medium: 'pro', high: '4k' },
  vidu: { low: '540p', medium: '720p', high: '1080p' },
  wan: { low: '720p', medium: '720p', high: '1080p' },
  seedream: { low: '1K', medium: '1K', high: '2K' },
  nanobanana: { low: '1K', medium: '2K', high: '4K' },
  gptimage: { low: '1K', medium: '2K', high: '4K' },
};

const VIDEO_MODELS = {
  'seedance-2.5': { family: 'seedance', note: '最新一代，画质与一致性最好' },
  'seedance-2.0': { family: 'seedance', note: '标准版，质量优先' },
  'seedance-2.0-fast': { family: 'seedance', note: '速度版，适合草稿' },
  'seedance-2.0-mini': { family: 'seedance', note: '最便宜，适合大批量试稿' },
  'veo3.1-quality': { family: 'veo', note: 'Google Veo 3.1，4K + 同步音频' },
  'veo3.1-fast': { family: 'veo', note: 'Veo 3.1 速度档' },
  'veo3.1-lite': { family: 'veo', note: 'Veo 3.1 最低价' },
  'kling-v3': { family: 'kling', note: '可灵 v3，人物动作最自然' },
  'kling-v2-6': { family: 'kling', note: '可灵 2.6，性价比档' },
  viduq3: { family: 'vidu', note: 'Vidu Q3' },
  'happyhorse-1.0': { family: 'wan', note: '阿里 ATH' },
  'grok-video': { family: 'seedance', note: 'xAI，固定 6 秒' },
};

const IMAGE_MODELS = {
  'gpt-image-2': { family: 'gptimage', async: false, note: '主力模型，同步返回' },
  'gpt-image-2-official': { family: 'gptimage', async: true, note: '异步高清' },
  'seedream-5-0-pro': { family: 'seedream', async: true, note: 'Seedream 最强' },
  'seedream-5-0-lite': { family: 'seedream', async: true, note: 'Seedream 轻量' },
  'seedream-4-5': { family: 'seedream', async: true, note: 'Seedream 4.5' },
  'nano-banana-pro': { family: 'nanobanana', async: false, note: 'Gemini 3 Pro Image' },
  'nano-banana-2': { family: 'nanobanana', async: false, note: 'Gemini 3.1 Flash Image' },
  midjourney: { family: 'midjourney', async: true, note: '一次出 4 张' },
};

// ── HTTP ───────────────────────────────────────────────────────
function requireKey() {
  if (!KEY) die('缺少 WANAPIS_API_KEY。到 https://wanapis.com 获取后 export WANAPIS_API_KEY=sk-...');
}

async function api(pathname, { method = 'GET', body, timeoutMs = 420000 } = {}) {
  requireKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`${res.status}: ${json?.error?.message || json?.message || text.slice(0, 200)}`);
    return json;
  } finally { clearTimeout(timer); }
}

/**
 * 下载媒体。
 *
 * ⚠️ 只对自家域名带 Authorization。图片结果是上游 CDN 直链(公开可访问)，
 * 对它发 key 等于把用户凭据泄露给第三方；视频走自家代理，不带 key 会 401。
 */
async function download(url, out) {
  const sameHost = new URL(url).host === new URL(BASE).host;
  const res = await fetch(url, sameHost ? { headers: { Authorization: `Bearer ${KEY}` } } : {});
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  return { path: out, bytes: buf.length };
}

// ── 参数翻译 ───────────────────────────────────────────────────
function buildVideoBody(model, { prompt, quality, seconds, aspect, imageUrl }) {
  const spec = VIDEO_MODELS[model];
  if (!spec) die(`未知视频模型: ${model}\n可用: ${Object.keys(VIDEO_MODELS).join(', ')}`);
  const body = { model, prompt };
  const q = QUALITY[spec.family]?.[quality ?? 'medium'];
  if (spec.family === 'kling') {
    if (q) body.mode = q;
    if (aspect) body.aspect_ratio = aspect;
  } else {
    if (q) body.resolution = q;
    if (aspect) body.size = aspect;
  }
  if (seconds) body.duration = seconds;
  if (imageUrl) body.image_urls = [imageUrl];
  return body;
}

function buildImageBody(model, { prompt, quality, aspect, referenceImages }) {
  const spec = IMAGE_MODELS[model];
  if (!spec) die(`未知图片模型: ${model}\n可用: ${Object.keys(IMAGE_MODELS).join(', ')}`);
  const body = { model, prompt };
  if (spec.family === 'midjourney') {
    const flags = [];
    if (aspect) flags.push(`--ar ${aspect}`);
    if (quality === 'low') flags.push('--q .25');
    if (flags.length) body.prompt = `${prompt} ${flags.join(' ')}`;
  } else {
    const q = QUALITY[spec.family]?.[quality ?? 'medium'];
    if (q) body.resolution = q;
    if (aspect) body.size = aspect;
  }
  if (referenceImages?.length) body.image_urls = referenceImages;
  return body;
}

// ── 结果解析 ───────────────────────────────────────────────────
function extractMediaUrls(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const urls = [];
  const push = (u) => { if (typeof u === 'string' && u && !urls.includes(u)) urls.push(u); };
  push(d?.result_url);
  const inner = d?.data && typeof d.data === 'object' ? d.data : null;
  push(inner?.content?.video_url);
  push(inner?.content?.image_url);
  const result = inner?.result ?? d?.result;
  for (const item of result?.videos ?? result?.images ?? []) {
    const u = item?.url;
    if (Array.isArray(u)) u.forEach(push); else push(u);
  }
  return urls;
}

const DONE_OK = new Set(['success', 'succeeded', 'completed']);
const DONE_BAD = new Set(['failed', 'failure', 'error']);

// ── 估价 ───────────────────────────────────────────────────────
async function pricingIndex() {
  const data = (await api('/api/pricing', { timeoutMs: 30000 }))?.data ?? [];
  const idx = new Map();
  for (const m of data) if (m?.model_name) idx.set(m.model_name, m);
  return idx;
}

function priceFor(entry, { quality, seconds, count }) {
  if (!entry) return null;
  const tierKey = { low: '480p', medium: '720p', high: '1080p' };
  const imgTier = { low: '1K', medium: '2K', high: '4K' };
  const vp = entry.video_pricing;
  if (vp && seconds > 0) {
    const perSec = vp[tierKey[quality ?? 'medium']] ?? vp['*'] ?? Object.values(vp)[0];
    if (perSec > 0) return { amount: perSec * seconds, basis: `${perSec}/s × ${seconds}s` };
  }
  const ip = entry.image_pricing;
  if (ip) {
    const p = ip[imgTier[quality ?? 'medium']];
    if (p > 0) return { amount: p * (count ?? 1), basis: `${p} × ${count ?? 1}` };
  }
  const base = entry.model_price ?? 0;
  if (base > 0) {
    if (seconds > 0) return { amount: base * seconds, basis: `${base}/s × ${seconds}s` };
    return { amount: base * (count ?? 1), basis: `${base} × ${count ?? 1}` };
  }
  return null;
}

// ── 任务轮询 ───────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollTask(kind, taskId, { quiet } = {}) {
  const p = kind === 'video'
    ? `/v1/video/generations/${encodeURIComponent(taskId)}`
    : `/v1/images/tasks/${encodeURIComponent(taskId)}`;
  for (let i = 0; i < 80; i++) {
    await sleep(i < 4 ? 5000 : 15000);
    const payload = await api(p);
    const d = payload?.data ?? {};
    const status = String(d.status ?? '').toLowerCase();
    if (!quiet) process.stderr.write(`  ${status} ${d.progress ?? ''}\n`);
    if (DONE_OK.has(status)) return { payload, d };
    if (DONE_BAD.has(status)) die(`生成失败: ${d.fail_reason || status}`);
  }
  die('轮询超时(20 分钟)。任务可能仍在跑，用 task 子命令查:\n  ' +
      `node wanapis.mjs task ${taskId} --kind ${kind}`);
}

function report(d, urls, saved) {
  const out = { status: 'success', media: urls };
  if (typeof d.quota === 'number') out.chargedCny = Number((d.quota / QUOTA_PER_CNY).toFixed(4));
  const inner = d.data ?? {};
  if (inner.duration || inner.resolution) {
    out.actual = { duration: inner.duration ?? null, resolution: inner.resolution ?? null };
  }
  if (saved) out.saved = saved;
  console.log(JSON.stringify(out, null, 2));
}

// ── 命令 ───────────────────────────────────────────────────────
function die(msg) { console.error(msg); process.exit(1); }

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `WanAPIs 生图/生视频 CLI

  estimate --model <m> [--quality low|medium|high] [--seconds N] [--count N]
      先算钱。生成前应当先跑这个并把金额告知用户。

  image "<prompt>" [--model gpt-image-2] [--quality low] [--aspect 1:1] [--out FILE]
  video "<prompt>" [--model seedance-2.0-mini] [--quality low] [--seconds 5]
                   [--aspect 16:9] [--image <首帧图 URL>] [--out FILE]

  task <task_id> --kind video|image [--out FILE]
      查已提交的任务(轮询中断后用它接回来)。

  models [--kind video|image]

环境变量: WANAPIS_API_KEY(必需)、WANAPIS_BASE_URL(可选)

注意:客户端中断【不会】取消上游任务，照样计费。宁可等，别重试。`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const quality = flags.quality ?? 'medium';

  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }

  if (cmd === 'models') {
    const idx = await pricingIndex().catch(() => new Map());
    const kind = flags.kind ?? 'all';
    const rows = [];
    const add = (id, spec, k) => {
      const e = idx.get(id);
      rows.push({ model: id, kind: k, note: spec.note,
                  price: e?.model_price ?? null,
                  tiers: e?.video_pricing ?? e?.image_pricing ?? null });
    };
    if (kind !== 'image') for (const [id, s] of Object.entries(VIDEO_MODELS)) add(id, s, 'video');
    if (kind !== 'video') for (const [id, s] of Object.entries(IMAGE_MODELS)) add(id, s, 'image');
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (cmd === 'estimate') {
    if (!flags.model) die('需要 --model');
    const idx = await pricingIndex();
    const p = priceFor(idx.get(flags.model), {
      quality, seconds: Number(flags.seconds ?? 0), count: Number(flags.count ?? 1),
    });
    if (!p) { console.log(JSON.stringify({ model: flags.model, estimate: null, note: '该模型未配置价格' })); return; }
    console.log(JSON.stringify({ model: flags.model, estimateCny: Number(p.amount.toFixed(4)), basis: p.basis }, null, 2));
    return;
  }

  if (cmd === 'image') {
    const prompt = positional.join(' ');
    if (!prompt) die('需要提示词');
    const model = flags.model ?? 'gpt-image-2';
    const body = buildImageBody(model, { prompt, quality, aspect: flags.aspect });
    const isAsync = IMAGE_MODELS[model]?.async;
    const path_ = isAsync ? '/v1/images/tasks' : '/v1/images/generations';
    process.stderr.write(`提交 ${model}…(生图通常 25 秒~5 分钟)\n`);
    const res = await api(path_, { method: 'POST', body });

    if (isAsync) {
      const taskId = res?.task_id ?? (Array.isArray(res?.data) ? res.data[0]?.task_id : res?.data?.task_id);
      if (!taskId) die(`响应里没有 task_id: ${JSON.stringify(res).slice(0, 200)}`);
      const { d } = await pollTask('image', taskId);
      const urls = extractMediaUrls({ data: d });
      report(d, urls, await saveAll(urls, flags.out, taskId));
      return;
    }
    const urls = (res?.data ?? []).map((x) => x?.url).filter((u) => typeof u === 'string');
    if (!urls.length) die('模型返回了内联数据而非 URL,已跳过(避免撑爆上下文)');
    report({}, urls, await saveAll(urls, flags.out, 'image'));
    return;
  }

  if (cmd === 'video') {
    const prompt = positional.join(' ');
    if (!prompt) die('需要提示词');
    const model = flags.model ?? 'seedance-2.0-mini';
    const body = buildVideoBody(model, {
      prompt, quality, seconds: Number(flags.seconds ?? 5),
      aspect: flags.aspect, imageUrl: flags.image,
    });
    process.stderr.write(`提交 ${model}…(生视频通常 60~150 秒)\n`);
    const res = await api('/v1/video/generations', { method: 'POST', body });
    const taskId = res?.task_id ?? (Array.isArray(res?.data) ? res.data[0]?.task_id : res?.data?.task_id);
    if (!taskId) die(`响应里没有 task_id: ${JSON.stringify(res).slice(0, 200)}`);
    const { d } = await pollTask('video', taskId);
    const urls = extractMediaUrls({ data: d });
    report(d, urls, await saveAll(urls, flags.out, taskId));
    return;
  }

  if (cmd === 'task') {
    const taskId = positional[0];
    if (!taskId) die('需要 task_id');
    const kind = flags.kind ?? 'video';
    const p = kind === 'video'
      ? `/v1/video/generations/${encodeURIComponent(taskId)}`
      : `/v1/images/tasks/${encodeURIComponent(taskId)}`;
    const payload = await api(p);
    const d = payload?.data ?? {};
    const status = String(d.status ?? '').toLowerCase();
    const urls = extractMediaUrls(payload);
    if (!DONE_OK.has(status)) { console.log(JSON.stringify({ status, progress: d.progress ?? null }, null, 2)); return; }
    report(d, urls, await saveAll(urls, flags.out, taskId));
    return;
  }

  die(`未知命令: ${cmd}\n\n${HELP}`);
}

async function saveAll(urls, out, stem) {
  if (!out || !urls.length) return undefined;
  const saved = [];
  for (const [i, url] of urls.entries()) {
    const dest = urls.length > 1
      ? path.join(path.dirname(out), `${path.basename(out, path.extname(out))}-${i + 1}${path.extname(out)}`)
      : out;
    process.stderr.write(`  下载 → ${dest}\n`);
    saved.push(await download(url, dest));
  }
  return saved;
}

main().catch((e) => die(String(e?.message ?? e)));
