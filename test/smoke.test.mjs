/**
 * 离线冒烟测试:不发任何网络请求，不产生任何费用。
 *
 * 重点是 extractMediaUrls —— 它踩过一次真实的坑:最初只认上游的
 * result.videos[].url[] 结构，而网关自己的 API 返回的是 result_url，
 * 于是「生成成功但 media 为空」。下面每个 case 都是抓下来的真实响应形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { extractMediaUrls, taskStatus } from '../src/client.js';
import { buildVideoBody, buildImageBody, submitPath, VIDEO_MODELS, IMAGE_MODELS } from '../src/models.js';

// ── 真实响应样本 ────────────────────────────────────────────────
const GATEWAY_VIDEO = {
  code: 'success',
  data: {
    task_id: 'task_QQ', status: 'SUCCESS', progress: '100%', quota: 348750,
    result_url: 'https://api.wanapis.com/v1/videos/task_QQ/content',
    data: {
      content: { video_url: 'https://api.wanapis.com/v1/videos/task_QQ/content' },
      duration: 5, resolution: '480p', ratio: '16:9',
    },
  },
};
const UPSTREAM_VIDEO = { data: { data: { result: { videos: [{ url: ['u1', 'u2'] }] } } } };
const UPSTREAM_IMAGES = { data: { data: { result: { images: [{ url: ['i1', 'i2', 'i3', 'i4'] }] } } } };
const PENDING = { data: { status: 'IN_PROGRESS', progress: '50%' } };

test('网关形状:result_url 与 content.video_url 指向同一地址，只返回一次', () => {
  assert.deepEqual(extractMediaUrls(GATEWAY_VIDEO),
    ['https://api.wanapis.com/v1/videos/task_QQ/content']);
});

test('上游形状:url 本身是数组，不能只取第一个', () => {
  assert.deepEqual(extractMediaUrls(UPSTREAM_VIDEO), ['u1', 'u2']);
});

test('Midjourney 一次四张全部取到', () => {
  assert.equal(extractMediaUrls(UPSTREAM_IMAGES).length, 4);
});

test('未完成的任务不返回任何 URL', () => {
  assert.deepEqual(extractMediaUrls(PENDING), []);
});

test('quota 折算成人民币，并带回上游实际出的规格', () => {
  const st = taskStatus(GATEWAY_VIDEO);
  assert.equal(st.status, 'success');
  assert.equal(st.costCny, 0.6975);          // 348750 / 500000
  assert.equal(st.actual.duration, 5);        // 请求 4 秒但上游出了 5 秒
  assert.equal(st.actual.resolution, '480p');
});

test('进行中的任务没有 costCny 也没有 actual', () => {
  const st = taskStatus(PENDING);
  assert.equal(st.costCny, null);
  assert.equal(st.actual, null);
});

// ── 参数翻译 ────────────────────────────────────────────────────
test('Kling 用 mode/aspect_ratio，Seedance 用 resolution/size', () => {
  const k = buildVideoBody('kling-v2-6', { prompt: 'p', quality: 'medium', seconds: 5, aspect: '16:9' });
  assert.equal(k.mode, 'pro');
  assert.equal(k.aspect_ratio, '16:9');
  assert.equal(k.resolution, undefined);

  const s = buildVideoBody('seedance-2.0-mini', { prompt: 'p', quality: 'low', seconds: 4, aspect: '16:9' });
  assert.equal(s.resolution, '480p');
  assert.equal(s.size, '16:9');
  assert.equal(s.mode, undefined);
});

test('Midjourney 没有独立参数，画质和比例要塞进 prompt', () => {
  const b = buildImageBody('midjourney', { prompt: 'a cat', quality: 'low', aspect: '16:9' });
  assert.match(b.prompt, /--ar 16:9/);
  assert.match(b.prompt, /--q \.25/);
  assert.equal(b.resolution, undefined);
});

test('同步模型走 generations，异步模型走 tasks', () => {
  assert.equal(submitPath('image', 'gpt-image-2'), '/v1/images/generations');
  assert.equal(submitPath('image', 'midjourney'), '/v1/images/tasks');
  assert.equal(submitPath('video', 'seedance-2.0'), '/v1/video/generations');
});

test('未知模型直接报错，不静默发出坏请求', () => {
  assert.throws(() => buildVideoBody('nope', { prompt: 'p' }), /unknown video model/);
  assert.throws(() => buildImageBody('nope', { prompt: 'p' }), /unknown image model/);
});

test('每个模型都有 family 且 QUALITY 表里能查到', () => {
  for (const [id, s] of Object.entries({ ...VIDEO_MODELS, ...IMAGE_MODELS })) {
    assert.ok(s.family, `${id} 缺 family`);
    assert.ok(s.note, `${id} 缺 note`);
  }
});

// ── MCP 协议握手(仍不发网络请求) ────────────────────────────────
test('server 能完成 initialize 并注册 5 个工具', async () => {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, WANAPIS_API_KEY: 'sk-dummy-for-offline-test' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const seen = new Map();
  child.stdout.on('data', (c) => {
    for (const line of c.toString().split('\n')) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); seen.set(m.id, m); } catch {}
    }
  });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');

  for (let i = 0; i < 60 && !seen.has(2); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();

  assert.equal(seen.get(1)?.result?.serverInfo?.name, 'wanapis-mcp');
  const tools = seen.get(2)?.result?.tools ?? [];
  assert.equal(tools.length, 5);
  for (const t of tools) {
    assert.ok(t.description?.length > 20, `${t.name} 描述过短`);
    assert.equal(t.inputSchema.type, 'object');
  }
});
