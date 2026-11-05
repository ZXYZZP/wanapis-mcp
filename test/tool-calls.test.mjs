import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./helpers/mock-gateway.cjs', import.meta.url));

async function startServer(t, extraEnv = {}) {
  const child = fork('src/index.js', [], {
    cwd: root,
    execArgv: ['--require', preload],
    env: {
      PATH: process.env.PATH,
      WANAPIS_API_KEY: 'sk-offline-fixture',
      WANAPIS_BASE_URL: 'https://offline.example',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const closed = once(child, 'close');
  const pending = new Map();
  const controls = new Map();
  const requests = [];
  let sequence = 0;
  let buffer = '';
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.on('message', (message) => {
    if (message.type === 'http-request') requests.push(message);
    const resolve = controls.get(message.type);
    if (resolve) { controls.delete(message.type); resolve(); }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP child exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  t.after(async () => { child.kill(); await closed; });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}: ${stderr}`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-regression', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const control = (type, data, expected) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controls.delete(expected); reject(new Error(`Missing control ${expected}`)); }, 5000);
    controls.set(expected, () => { clearTimeout(timer); resolve(); });
    child.send({ type, ...data });
  });

  return {
    requests,
    async call(name, args) {
      const message = await rpc('tools/call', { name, arguments: args });
      assert.equal(message.error, undefined, JSON.stringify(message.error));
      // stdout and IPC arrive independently; wait until every request is observed.
      await control('flush-requests', {}, 'requests-flushed');
      return { ...message.result, data: JSON.parse(message.result.content[0].text) };
    },
    control,
  };
}

const invalidCalls = [
  ['video missing prompt', 'wanapis_generate_video', {}],
  ['image missing prompt', 'wanapis_generate_image', {}],
  ['prompt has wrong type', 'wanapis_generate_video', { prompt: 42 }],
  ['quality is outside declared enum', 'wanapis_generate_video', { prompt: 'demo', quality: 'ultra' }],
  ['seconds has wrong type', 'wanapis_generate_video', { prompt: 'demo', seconds: '5' }],
  ['reference image has wrong type', 'wanapis_generate_image', { prompt: 'demo', reference_images: [42] }],
  ['unknown model', 'wanapis_generate_video', { prompt: 'demo', model: 'does-not-exist' }],
  ['task kind outside enum', 'wanapis_check_task', { task_id: 'task-demo', kind: 'audio' }],
  ['estimate missing model', 'wanapis_estimate_cost', {}],
  ['model-list kind outside enum', 'wanapis_list_models', { kind: 'audio' }],
];

for (const [label, name, args] of invalidCalls) {
  test(`invalid tool input: ${label} never makes an HTTP request`, async (t) => {
    const server = await startServer(t);
    const result = await server.call(name, args);
    assert.equal(result.isError, true);
    assert.equal(server.requests.length, 0, JSON.stringify(server.requests));
  });
}

test('valid video input is submitted once with existing defaults', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_generate_video', { prompt: 'a quiet landscape' });
  assert.equal(result.isError, undefined);
  assert.equal(result.data.task_id, 'video-offline-1');
  assert.equal(server.requests.length, 1);
  assert.deepEqual(JSON.parse(server.requests[0].body), {
    model: 'seedance-2.0', prompt: 'a quiet landscape', resolution: '720p', duration: 5,
  });
});

test('H3 advanced media builds one typed content request with frames and references', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_generate_video', {
    model: 'minimax-h3', prompt: 'scene', resolution: '768P', seconds: 4, ratio: '16:9',
    context_ir_enabled: false,
    reference_images: ['https://cdn.example/r1.png', 'https://cdn.example/r2.png'],
    first_frame: 'https://cdn.example/first.png',
    last_frame: 'https://cdn.example/last.png',
    reference_videos: ['https://cdn.example/ref.mp4'],
    reference_audio: ['https://cdn.example/ref.mp3'],
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.task_id, 'video-offline-1');
  const body = JSON.parse(server.requests[0].body);
  assert.equal(body.prompt, undefined);
  assert.equal(body.input_reference, undefined);
  assert.deepEqual(body.content.map((item) => [item.type, item.role]), [
    ['text', undefined],
    ['image_url', 'first_frame'], ['image_url', 'last_frame'],
    ['image_url', 'reference_image'], ['image_url', 'reference_image'],
    ['video_url', 'reference_video'], ['audio_url', 'reference_audio'],
  ]);
  assert.deepEqual(body.content[1].image_url, { url: 'https://cdn.example/first.png' });
});

test('H3 local media is uploaded to an opaque asset before one generation submit', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reference.png');
  await writeFile(file, Buffer.from('offline image bytes'));
  const result = await server.call('wanapis_generate_video', {
    model: 'minimax-h3', prompt: 'scene', context_ir_enabled: false, reference_images: [file],
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].path, '/v1/videos/assets');
  assert.equal(server.requests[0].body.model, 'minimax-h3');
  assert.equal(server.requests[0].body.media_type, 'image');
  assert.equal(server.requests[1].path, '/v1/video/generations');
  const body = JSON.parse(server.requests[1].body);
  assert.deepEqual(body.content[1].image_url, { asset_id: 'asset_offline_1' });
  assert.equal(JSON.stringify(body).includes(file), false);
});

test('Seedance local media is uploaded to a temporary public URL before one submit', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-seedance-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reference.png');
  await writeFile(file, Buffer.from('offline image bytes'));
  const result = await server.call('wanapis_generate_video', {
    model: 'seedance-2.0-mini', prompt: 'scene', seconds: 4, reference_images: [file],
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].path, '/v1/media');
  assert.equal(server.requests[0].body.model, 'seedance-2.0-mini');
  assert.equal(server.requests[0].body.media_type, 'image');
  assert.equal(server.requests[1].path, '/v1/video/generations');
  const body = JSON.parse(server.requests[1].body);
  assert.deepEqual(body.image_urls, ['https://offline.example/v1/media/media_offline_1?expires=9999999999&signature=offline']);
  assert.equal(JSON.stringify(body).includes(file), false);
});

test('upload_media with a Seedance model returns a temporary URL', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-seedance-upload-tool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'motion.mp4');
  await writeFile(file, Buffer.from('offline video bytes'));
  const result = await server.call('wanapis_upload_media', { path: file, media_type: 'video', model: 'seedance-2.0' });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.url, 'https://offline.example/v1/media/media_offline_1?expires=9999999999&signature=offline');
  assert.equal(server.requests[0].path, '/v1/media');
  assert.equal(server.requests[0].body.model, 'seedance-2.0');
  assert.equal(server.requests[0].body.media_type, 'video');
});

test('upload_media returns the opaque asset and reuses a binding', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-upload-tool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'motion.mp4');
  await writeFile(file, Buffer.from('offline video bytes'));
  const result = await server.call('wanapis_upload_media', { path: file, media_type: 'video', binding_asset_id: 'asset_existing_1' });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.asset_id, 'asset_offline_1');
  assert.equal(server.requests[0].body.binding_asset_id, 'asset_existing_1');
});

test('content regeneration submits the original prompt and references to the source path', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_regenerate_video', {
    source_task_id: 'video-offline-1', mode: 'content', prompt: 'original prompt',
    reference_images: ['https://cdn.example/r1.png'],
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.task_id, 'regen-offline-1');
  assert.equal(server.requests[0].path, '/v1/videos/video-offline-1/regenerations');
  const body = JSON.parse(server.requests[0].body);
  assert.equal(body.mode, 'content');
  assert.equal(body.resolution, '2K');
  assert.deepEqual(body.content.map((item) => item.type), ['text', 'image_url']);
});

test('standalone prompt optimization is a text task with billing', async (t) => {
  const server = await startServer(t);
  const submitted = await server.call('wanapis_optimize_prompt', { prompt: 'make it cinematic' });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted.data));
  assert.equal(submitted.data.task_id, 'ir-offline-1');
  assert.equal(server.requests[0].path, '/v1/videos/prompt-optimizations');
  const checked = await server.call('wanapis_check_task', { task_id: 'ir-offline-1', kind: 'prompt' });
  assert.equal(checked.data.status, 'completed');
  assert.equal(checked.data.text, 'Improved offline prompt');
  assert.equal(checked.data.billing.status, 'settled');
  assert.equal(checked.data.costCny, 0.065);
});

test('H3 pending settlement is not reported as a final cost', async (t) => {
  const server = await startServer(t, { TASK_PENDING: '1' });
  const result = await server.call('wanapis_check_task', { task_id: 'video-offline-1' });
  assert.equal(result.data.billing.status, 'pending_usage');
  assert.equal(result.data.costCny, null);
  assert.match(result.data.costNote, /reserved amount/);
});

test('H3 media estimate uses the reference-video reservation upper bound', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_estimate_cost', {
    model: 'minimax-h3', seconds: 4, resolution: '768P', context_ir_enabled: false,
    reference_videos: ['https://cdn.example/ref.mp4'],
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.estimate_kind, 'reservation_upper_bound');
  assert.equal(result.data.estimated_quota, 1170000);
  assert.equal(result.data.breakdown.reference_video_reserved_seconds, 16);
});

test('Seedance media request uses the canonical apimart fields', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_generate_video', {
    model: 'seedance-2.0-mini', prompt: 'scene', quality: 'low', seconds: 4, aspect: '16:9',
    reference_images: ['https://cdn.example/ref.png'],
    reference_videos: ['https://cdn.example/ref.mp4'],
    reference_audio: ['https://cdn.example/ref.mp3'],
    generate_audio: false, return_last_frame: true, seed: 7,
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.task_id, 'video-offline-1');
  const body = JSON.parse(server.requests[0].body);
  assert.equal(body.resolution, '480p');
  assert.equal(body.duration, 4);
  assert.equal(body.size, '16:9');
  assert.deepEqual(body.image_urls, ['https://cdn.example/ref.png']);
  assert.deepEqual(body.video_urls, ['https://cdn.example/ref.mp4']);
  assert.deepEqual(body.audio_urls, ['https://cdn.example/ref.mp3']);
  assert.equal(body.generate_audio, false);
  assert.equal(body.return_last_frame, true);
  assert.equal(body.seed, 7);
});

test('Seedance rejects H3 asset IDs before any HTTP request', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_generate_video', {
    model: 'seedance-2.0-mini', prompt: 'scene', reference_images: ['asset_0123456789abcdef0123456789abcdef'],
  });
  assert.equal(result.isError, true);
  assert.match(result.data.error, /H3 asset IDs/);
  assert.equal(server.requests.length, 0);
});

test('finished image job can be checked again to download without generating twice', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-repeat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = await server.call('wanapis_generate_image', { prompt: 'offline demo' });
  assert.equal(created.data.status, 'running');
  await server.control('finish-image', {}, 'image-finished');
  const first = await server.call('wanapis_check_task', { task_id: created.data.job_id });
  assert.equal(first.data.status, 'success');
  const second = await server.call('wanapis_check_task', { task_id: created.data.job_id, save_dir: dir });
  assert.equal(second.isError, undefined, JSON.stringify(second.data));
  assert.equal(second.data.status, 'success');
  assert.equal(second.data.saved.length, 1);
  assert.equal(await readFile(second.data.saved[0].path, 'utf8'), 'offline image fixture');
  assert.equal(server.requests.filter((r) => r.path === '/v1/images/generations').length, 1);
});

test('failed image download can be retried using the same finished job', async (t) => {
  const server = await startServer(t, { FAIL_FIRST_DOWNLOAD: '1' });
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = await server.call('wanapis_generate_image', { prompt: 'offline demo' });
  await server.control('finish-image', {}, 'image-finished');
  const failed = await server.call('wanapis_check_task', { task_id: created.data.job_id, save_dir: dir });
  assert.match(failed.data.saved[0].error, /fixture download interrupted/);
  const retried = await server.call('wanapis_check_task', { task_id: created.data.job_id, save_dir: dir });
  assert.equal(retried.isError, undefined, JSON.stringify(retried.data));
  assert.equal(retried.data.saved.length, 1);
  assert.equal(retried.data.saved[0].error, undefined);
  assert.equal(server.requests.filter((r) => r.path === '/v1/images/generations').length, 1);
});

test('documented async image envelope is downloaded after a successful task poll', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-mcp-async-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = await server.call('wanapis_generate_image', {
    model: 'gpt-image-2-official', prompt: 'offline fixture', quality: 'low',
  });
  assert.equal(created.data.task_id, 'image-offline-1');
  const result = await server.call('wanapis_check_task', {
    task_id: created.data.task_id, kind: 'image', save_dir: dir,
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.data));
  assert.equal(result.data.status, 'success');
  assert.deepEqual(result.data.media, ['https://cdn.example/image.png']);
  assert.equal(result.data.saved.length, 1);
  assert.equal(await readFile(result.data.saved[0].path, 'utf8'), 'offline image fixture');
  assert.equal(server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/images/tasks').length, 1);
  assert.equal(server.requests.filter((r) => r.path === '/v1/images/tasks/image-offline-1').length, 1);
  assert.equal(server.requests.filter((r) => r.path === '/image.png').length, 1);
});

test('finished image job is unavailable after its existing TTL', async (t) => {
  const server = await startServer(t);
  const created = await server.call('wanapis_generate_image', { prompt: 'offline demo' });
  await server.control('finish-image', {}, 'image-finished');
  await server.control('advance-clock', { ms: 30 * 60_000 + 1 }, 'clock-advanced');
  const expired = await server.call('wanapis_check_task', { task_id: created.data.job_id });
  assert.equal(expired.isError, true);
  assert.match(expired.data.error, /unknown job/);
  assert.equal(server.requests.filter((r) => r.path === '/v1/images/generations').length, 1);
});

for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  test(`${model}: independent tiers, image references and async download`, async (t) => {
    const server = await startServer(t);
    const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-25-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const created = await server.call('wanapis_generate_image', {
      model, prompt: 'offline edit', quality: 'xhigh', resolution: '2k', count: 2,
      aspect: '3:2', reference_images: ['https://cdn.example/reference.png'],
    });
    assert.equal(created.isError, undefined, JSON.stringify(created.data));
    assert.equal(created.data.task_id, 'image-offline-1');
    assert.deepEqual(JSON.parse(server.requests[0].body), {
      model, prompt: 'offline edit', quality: 'xhigh', resolution: '2k', n: 2,
      size: '3:2', image_urls: ['https://cdn.example/reference.png'],
    });
    const result = await server.call('wanapis_check_task', { task_id: created.data.task_id, kind: 'image', save_dir: dir });
    assert.equal(result.data.status, 'success');
    assert.equal(await readFile(result.data.saved[0].path, 'utf8'), 'offline image fixture');
    assert.equal(server.requests.filter((r) => r.method === 'POST').length, 1);
  });
}

test('Image 2.5 defaults explicitly use low, 1k and one image', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_generate_image', { model: 'gpt-image-2.5-flare', prompt: 'fixture' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(server.requests[0].body), {
    model: 'gpt-image-2.5-flare', prompt: 'fixture', quality: 'low', resolution: '1k', n: 1,
  });
});

test('H3 defaults and reference image use native fields, then download once', async (t) => {
  const server = await startServer(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'wanapis-h3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = await server.call('wanapis_generate_video', {
    model: 'minimax-h3', prompt: 'fixture', image_url: 'https://cdn.example/frame.png', context_ir_enabled: false,
  });
  assert.equal(created.isError, undefined, JSON.stringify(created.data));
  assert.deepEqual(JSON.parse(server.requests[0].body), {
    model: 'minimax-h3', prompt: 'fixture', resolution: '768P', ratio: '9:16', seconds: 4,
    fast_mode: false, context_ir_enabled: false, input_reference: { image_url: 'https://cdn.example/frame.png' },
  });
  const result = await server.call('wanapis_check_task', { task_id: created.data.task_id, kind: 'video', save_dir: dir });
  assert.equal(result.data.status, 'success');
  assert.equal(await readFile(result.data.saved[0].path, 'utf8'), 'offline video fixture');
  assert.equal(server.requests.filter((r) => r.method === 'POST').length, 1);
  assert.match(server.requests.at(-1).headers.authorization, /^Bearer /);
});

test('failed H3 task reports its error without downloading', async (t) => {
  const server = await startServer(t, { TASK_FAILURE: '1' });
  const result = await server.call('wanapis_check_task', { task_id: 'video-offline-1', save_dir: '/unused' });
  assert.equal(result.data.status, 'failure');
  assert.equal(result.data.failReason, 'offline render failed');
  assert.equal(server.requests.length, 1);
});

for (const [name, args] of [
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', seconds: 4.5 }],
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', resolution: '2K', seconds: 16 }],
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', quality: 'high' }],
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', fast_mode: 'false' }],
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', reference_images: Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.png`) }],
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', reference_videos: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4', 'https://cdn.example/3.mp4', 'https://cdn.example/4.mp4'] }],
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', first_frame: 'https://cdn.example/a.png', last_frame: 'https://cdn.example/a.png' }],
  ['wanapis_regenerate_video', { source_task_id: 'task-1', mode: 'source', prompt: 'p' }],
  ['wanapis_optimize_prompt', { prompt: 'p', seconds: 3 }],
  ['wanapis_generate_image', { model: 'gpt-image-2.5-flare', prompt: 'p', n: 2 }],
  ['wanapis_generate_video', { model: 'seedance-2.0', prompt: 'p', context_ir_enabled: false }],
  ['wanapis_generate_image', { model: 'gpt-image-2', prompt: 'p', quality: 'max' }],
  ['wanapis_generate_image', { model: 'gpt-image-2.5-flare', prompt: 'p', count: 1.5 }],
  ['wanapis_generate_image', { model: 'gpt-image-2.5-flare', prompt: 'p', resolution: '8k' }],
  ['wanapis_estimate_cost', { model: 'minimax-h3', seconds: 3 }],
]) {
  test(`model-specific invalid input makes no HTTP: ${JSON.stringify(args)}`, async (t) => {
    const server = await startServer(t);
    const result = await server.call(name, args);
    assert.equal(result.isError, true);
    assert.equal(server.requests.length, 0);
  });
}

test('live models intersect the verified adapters and fetch prices without key', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_list_models', {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.data.models.map((r) => r.model).sort(), [
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'minimax-h3', 'seedance-2.0', 'gpt-image-2-official',
  ].sort());
  assert.equal(server.requests[0].headers.authorization, undefined);
  assert.ok(result.data.models.find((r) => r.model === 'minimax-h3').capabilities);
});

for (const scenario of ['empty', 'malformed', 'http-error', 'abort']) {
  test(`catalog ${scenario} is explicit`, async (t) => {
    const server = await startServer(t, { CATALOG_SCENARIO: scenario });
    const result = await server.call('wanapis_list_models', {});
    if (scenario === 'empty') assert.deepEqual(result.data.models, []);
    else assert.equal(result.isError, true);
  });
}

for (const [args, amount] of [
  [{}, 0.533], [{ context_ir_enabled: false }, 0.468], [{ seconds: 16 }, 3.809],
  [{ seconds: 16, fast_mode: true }, 7.553], [{ seconds: 16, fast_mode: true, group_ratio: 0.5 }, 3.7765],
]) {
  test(`H3 estimator follows native rules: ${JSON.stringify(args)}`, async (t) => {
    const server = await startServer(t);
    const result = await server.call('wanapis_estimate_cost', { model: 'minimax-h3', ...args });
    assert.equal(result.isError, undefined, JSON.stringify(result.data));
    assert.equal(result.data.estimate, amount);
    assert.equal(result.data.currency, 'CNY');
    assert.equal(result.data.settings.seconds, args.seconds ?? 4);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].headers.authorization, undefined);
  });
}

test('H3 missing metadata is not estimated using the old base model price', async (t) => {
  const server = await startServer(t, { CATALOG_SCENARIO: 'missing-h3-meta' });
  const result = await server.call('wanapis_estimate_cost', { model: 'minimax-h3' });
  assert.equal(result.data.estimate, null);
  assert.match(result.data.note, /metadata/i);
});

test('Image 2.5 estimate multiplies independent tiers and count, labelled precharge', async (t) => {
  const server = await startServer(t);
  const result = await server.call('wanapis_estimate_cost', {
    model: 'gpt-image-2.5-sunburst', quality: 'max', resolution: '4k', count: 2,
  });
  assert.equal(result.data.estimate, 10.6488);
  assert.equal(result.data.estimate_kind, 'tier_precharge');
  assert.match(result.data.note, /actual usage/i);
});
