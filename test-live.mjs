/**
 * 端到端冒烟测试:用真实 key 走一遍 MCP server 的 stdio 协议。
 * 只做只读调用(list_models / estimate_cost)+ 一次最便宜的真实生成。
 */
import { spawn } from 'node:child_process';

const KEY = process.env.WANAPIS_API_KEY;
if (!KEY) {
  console.error('需要 WANAPIS_API_KEY');
  process.exit(1);
}

const child = spawn('node', ['src/index.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, WANAPIS_API_KEY: KEY },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    } catch { /* 非 JSON 行忽略 */ }
  }
});

let id = 0;
function rpc(method, params) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n');
  });
}

const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const txt = r?.result?.content?.[0]?.text ?? JSON.stringify(r?.error ?? r);
  try { return JSON.parse(txt); } catch { return txt; }
};

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});

const tools = await rpc('tools/list', {});
console.log('① 工具数:', tools?.result?.tools?.length);
console.log('   ', tools?.result?.tools?.map((t) => t.name).join(', '));

const models = await call('wanapis_list_models', { kind: 'video' });
const withPrice = (models.models ?? []).filter((m) => m.price != null);
console.log(`\n② list_models: ${models.models?.length} 个，其中 ${withPrice.length} 个有价`);
for (const m of (models.models ?? []).slice(0, 4)) {
  console.log(`    ${m.model.padEnd(20)} price=${m.price} tiers=${JSON.stringify(m.tiers)}`);
}

for (const args of [
  { model: 'seedance-2.0-mini', quality: 'low', seconds: 4 },
  { model: 'kling-v2-6', quality: 'medium', seconds: 5 },
  { model: 'nano-banana-pro', quality: 'high', count: 1 },
]) {
  const est = await call('wanapis_estimate_cost', args);
  console.log(`\n③ estimate ${args.model}:`, JSON.stringify(est));
}

child.kill();
