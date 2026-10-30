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
