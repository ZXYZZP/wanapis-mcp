#!/usr/bin/env node
/** Embed dependency-free helpers so the downloadable CLI uses the MCP adapters. */
import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../plugins/wanapis-media/skills/wanapis-media/scripts/wanapis.mjs', import.meta.url);
const start = '// BEGIN GENERATED MEDIA HELPERS';
const end = '// END GENERATED MEDIA HELPERS';
const modules = await Promise.all(['models.js', 'catalog.js', 'pricing.js'].map(async (name) => {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  return `// Source: src/${name}\n` + source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
}));
const original = await readFile(target, 'utf8');
const first = original.indexOf(start);
const last = original.indexOf(end);
if (first < 0 || last < first) throw new Error('Missing generated helper markers');
const updated = original.slice(0, first) + `${start}\n${modules.join('\n')}\n` + original.slice(last);
if (process.argv.includes('--check')) {
  if (updated !== original) throw new Error('Skill helpers are stale; run node scripts/sync-skill.mjs');
  console.log('Skill helpers match the MCP source.');
} else {
  await writeFile(target, updated);
  console.log('Skill helpers synchronized from src/models.js, src/catalog.js and src/pricing.js.');
}
