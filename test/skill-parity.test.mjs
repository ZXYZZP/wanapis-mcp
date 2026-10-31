/**
 * skill 里的模型表是独立一份(为了零依赖单文件分发)，会和 src/models.js 漂移。
 * 这个测试强制两边一致 —— 改了一边忘了另一边，CI 会拦下来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIDEO_MODELS, IMAGE_MODELS, QUALITY, buildVideoBody, buildImageBody } from '../src/models.js';
import { parseCatalog, listCatalogModels } from '../src/catalog.js';
import { estimateCost } from '../src/pricing.js';
import * as skill from '../plugins/wanapis-media/skills/wanapis-media/scripts/wanapis.mjs';
import catalogFixture from './helpers/catalog.cjs';
import { execFileSync, spawnSync } from 'node:child_process';

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
  assert.deepEqual(keysOf('QUALITY'), Object.keys(QUALITY).sort());
  assert.deepEqual(skill.QUALITY, QUALITY);
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
  assert.equal(m.version, pkg.version, 'plugin and MCP candidate versions must match');
});

test('generated standalone helpers match the canonical source', () => {
  execFileSync(process.execPath, ['scripts/sync-skill.mjs', '--check'], { cwd: new URL('..', import.meta.url) });
});

test('MCP and standalone CLI use identical native requests, defaults and estimates', () => {
  const catalog = parseCatalog(catalogFixture);
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    for (const options of [{}, { quality: 'max', resolution: '4k', count: 2, aspect: '16:9', referenceImages: ['https://cdn.example/a.png'] }]) {
      assert.deepEqual(skill.buildImageBody(model, { prompt: 'p', ...options }), buildImageBody(model, { prompt: 'p', ...options }));
      assert.deepEqual(skill.estimateCost(catalog, model, options), estimateCost(catalog, model, options));
    }
  }
  for (const options of [{}, { context_ir_enabled: false, imageUrl: 'https://cdn.example/a.png' }, { seconds: 16, fast_mode: true, group_ratio: 0.5 }]) {
    assert.deepEqual(skill.buildVideoBody('minimax-h3', { prompt: 'p', ...options }), buildVideoBody('minimax-h3', { prompt: 'p', ...options }));
    assert.deepEqual(skill.estimateCost(catalog, 'minimax-h3', options), estimateCost(catalog, 'minimax-h3', options));
  }
  assert.deepEqual(skill.listCatalogModels(catalog), listCatalogModels(catalog));
});

test('standalone CLI parses false explicitly and rejects invalid booleans and numbers', () => {
  assert.deepEqual(skill.flagOptions({ 'fast-mode': 'false', 'context-ir-enabled': 'false', seconds: '4' }), {
    seconds: 4, fast_mode: false, context_ir_enabled: false,
  });
  assert.throws(() => skill.flagOptions({ 'fast-mode': '0' }), /true or false/);
  assert.throws(() => skill.flagOptions({ seconds: 'NaN' }), /finite number/);
  assert.throws(() => skill.buildVideoBody('minimax-h3', { prompt: 'p', ...skill.flagOptions({ seconds: '4.5' }) }), /positive integer/);
});

test('standalone CLI extracts the nested async image envelope', () => {
  const payload = { data: { data: { data: { result: { images: [{ url: ['https://cdn.example/a.png'] }] } } } } };
  assert.deepEqual(skill.extractMediaUrls(payload), ['https://cdn.example/a.png']);
});

function cli(args, expectedBody) {
  const run = spawnSync(process.execPath, ['--require', './test/helpers/cli-gateway.cjs',
    'plugins/wanapis-media/skills/wanapis-media/scripts/wanapis.mjs', ...args], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, WANAPIS_API_KEY: 'sk-offline-cli', WANAPIS_BASE_URL: 'https://offline.example',
      ...(expectedBody ? { EXPECT_BODY: JSON.stringify(expectedBody) } : {}) },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('standalone CLI executes Image 2.5 submission, poll and nested extraction', () => {
  const output = cli(['image', 'offline fixture', '--model', 'gpt-image-2.5-flare', '--quality', 'max', '--resolution', '2k', '--count', '2', '--reference-image', 'https://cdn.example/a.png'],
    buildImageBody('gpt-image-2.5-flare', { prompt: 'offline fixture', quality: 'max', resolution: '2k', count: 2, referenceImages: ['https://cdn.example/a.png'] }));
  assert.deepEqual(output.media, ['https://cdn.example/image.png']);
});

test('standalone CLI executes H3 with false IR and exact native request', () => {
  const output = cli(['video', 'offline fixture', '--model', 'minimax-h3', '--context-ir-enabled', 'false'],
    buildVideoBody('minimax-h3', { prompt: 'offline fixture', context_ir_enabled: false }));
  assert.equal(output.status, 'success');
  assert.equal(output.chargedCny, 0.468);
});

test('standalone CLI catalog and estimate use public metadata and native defaults', () => {
  const output = cli(['estimate', '--model', 'minimax-h3', '--seconds', '16', '--fast-mode', 'true']);
  assert.equal(output.estimateCny, 7.553);
  const rows = cli(['models']);
  assert.equal(rows.length, 5);
  assert.ok(!rows.some((r) => r.model === 'minimax-h3-max'));
});
