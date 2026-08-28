/**
 * 真实生成冒烟:最便宜组合(seedance-2.0-mini 480p / 4s ≈ ¥0.56)。
 * 验证 提交 → 轮询 → 取 URL 整条链路。
 */
import { spawn } from 'node:child_process';

const KEY = process.env.WANAPIS_API_KEY;
if (!KEY) { console.error('需要 WANAPIS_API_KEY'); process.exit(1); }

const child = spawn('node', ['src/index.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, WANAPIS_API_KEY: KEY },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    } catch {}
  }
});

let id = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });

const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = r?.result?.content?.[0]?.text ?? JSON.stringify(r?.error ?? r);
  try { return JSON.parse(t); } catch { return t; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'gen-smoke', version: '0' },
});

const est = await call('wanapis_estimate_cost', {
  model: 'seedance-2.0-mini', quality: 'low', seconds: 4,
});
console.log('① 生成前估价:', JSON.stringify(est));

console.log('\n② 提交视频生成 (seedance-2.0-mini, low=480p, 4s)');
const sub = await call('wanapis_generate_video', {
  prompt: 'a small red apple rolling on a white table',
  model: 'seedance-2.0-mini',
  quality: 'low',
  seconds: 4,
  aspect: '16:9',
});
console.log('   ', JSON.stringify(sub));

if (!sub?.task_id) { console.error('   提交失败'); child.kill(); process.exit(1); }

console.log('\n③ 轮询');
let done = null;
for (let i = 0; i < 15; i++) {
  await sleep(15000);
  const st = await call('wanapis_check_task', { task_id: sub.task_id, kind: 'video' });
  console.log(`   [${i}] status=${st.status} progress=${st.progress} media=${st.media?.length ?? 0}`);
  if (['completed', 'success', 'succeeded', 'failed', 'failure'].includes(st.status)) { done = st; break; }
}

console.log('\n④ 终态:', JSON.stringify(done, null, 2)?.slice(0, 600));
child.kill();
