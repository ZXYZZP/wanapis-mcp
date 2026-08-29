/**
 * skill 里的模型表是独立一份(为了零依赖单文件分发)，会和 src/models.js 漂移。
 * 这个测试强制两边一致 —— 改了一边忘了另一边，CI 会拦下来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIDEO_MODELS, IMAGE_MODELS } from '../src/models.js';

const script = readFileSync(new URL('../plugins/wanapis-media/skills/wanapis-media/scripts/wanapis.mjs', import.meta.url), 'utf8');

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
  const md = readFileSync(new URL('../plugins/wanapis-media/skills/wanapis-media/SKILL.md', import.meta.url), 'utf8');
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

// ── Codex 插件清单 ──────────────────────────────────────────────
// 结构来自 ChatGPT.app 里官方 bundled 插件的实物,不是猜的。
test('Codex 插件清单结构完整', () => {
  const url = new URL('../plugins/wanapis-media/.codex-plugin/plugin.json', import.meta.url);
  const m = JSON.parse(readFileSync(url, 'utf8'));
  for (const k of ['name', 'version', 'description', 'author', 'license', 'skills', 'interface']) {
    assert.ok(m[k], `plugin.json 缺 ${k}`);
  }
  assert.equal(m.skills, './skills/');
  const i = m.interface;
  for (const k of ['displayName', 'shortDescription', 'longDescription', 'developerName',
                   'category', 'capabilities', 'composerIcon', 'logo', 'logoDark']) {
    assert.ok(i[k], `interface 缺 ${k}`);
  }
  assert.ok(Array.isArray(i.defaultPrompt) && i.defaultPrompt.length >= 2,
    'defaultPrompt 至少给两条,它决定用户第一次点开时看到什么');
});

test('清单引用的图标文件都存在', () => {
  const base = new URL('../plugins/wanapis-media/', import.meta.url);
  const m = JSON.parse(readFileSync(new URL('.codex-plugin/plugin.json', base), 'utf8'));
  for (const key of ['composerIcon', 'logo', 'logoDark']) {
    const rel = m.interface[key].replace(/^\.\//, '');
    assert.ok(readFileSync(new URL(rel, base), 'utf8').includes('<svg'), `${key} 不是有效 SVG`);
  }
});

test('marketplace 索引指向真实存在的插件目录', () => {
  const mk = JSON.parse(readFileSync(new URL('../.agents/plugins/marketplace.json', import.meta.url), 'utf8'));
  assert.ok(mk.name && mk.plugins?.length, 'marketplace.json 结构不完整');
  for (const p of mk.plugins) {
    const rel = p.source.path.replace(/^\.\//, '');
    const manifest = new URL(`../${rel}/.codex-plugin/plugin.json`, import.meta.url);
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(m.name, p.name, `索引里的 ${p.name} 与清单里的 name 不一致`);
  }
});

test('插件版本与 npm 包版本没有意外脱节', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const m = JSON.parse(readFileSync(new URL('../plugins/wanapis-media/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.version, 'package.json 缺 version');
});
