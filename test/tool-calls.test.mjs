import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  ['wanapis_generate_video', { model: 'minimax-h3', prompt: 'p', reference_images: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] }],
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
