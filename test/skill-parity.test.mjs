/**
 * skill 里的模型表是独立一份(为了零依赖单文件分发)，会和 src/models.js 漂移。
 * 这个测试强制两边一致 —— 改了一边忘了另一边，CI 会拦下来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIDEO_MODELS, IMAGE_MODELS } from '../src/models.js';

const script = readFileSync(new URL('../skills/wanapis-media/scripts/wanapis.mjs', import.meta.url), 'utf8');

/** 从脚本源码里把某个对象字面量的顶层键抠出来 */
function keysOf(name) {
  const m = script.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `脚本里找不到 ${name}`);
  return [...m[1].matchAll(/^\s{2}'?([A-Za-z0-9.\-_]+)'?:/gm)].map((x) => x[1]).sort();
}

test('skill 与 MCP 的视频模型列表一致', () => {
  assert.deepEqual(keysOf('VIDEO_MODELS'), Object.keys(VIDEO_MODELS).sort());
});

test('skill 与 MCP 的图片模型列表一致', () => {
  assert.deepEqual(keysOf('IMAGE_MODELS'), Object.keys(IMAGE_MODELS).sort());
});

test('skill 与 MCP 的画质映射表一致', () => {
  assert.deepEqual(keysOf('QUALITY'),
    [...new Set([...Object.values(VIDEO_MODELS), ...Object.values(IMAGE_MODELS)]
      .map((s) => s.family))].filter((f) => f !== 'midjourney').sort());
});

test('SKILL.md 有合法的 frontmatter', () => {
  const md = readFileSync(new URL('../skills/wanapis-media/SKILL.md', import.meta.url), 'utf8');
  assert.ok(md.startsWith('---\n'), 'SKILL.md 必须以 frontmatter 开头');
  const fm = md.slice(4, md.indexOf('\n---', 4));
  assert.match(fm, /^name: [a-z0-9-]+$/m, 'name 必须是小写短横线格式');
  const desc = fm.match(/^description: (.+)$/m);
  assert.ok(desc, '缺 description');
  // description 是技能被检索到的唯一依据，太短会导致永远不被触发
  assert.ok(desc[1].length > 80, 'description 太短，不足以让 agent 判断何时使用');
});

test('下载不会把 key 发给第三方域名', () => {
  assert.match(script, /sameHost/, 'skill 脚本缺少同源判断');
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.match(client, /sameHost/, 'MCP client 缺少同源判断');
});
