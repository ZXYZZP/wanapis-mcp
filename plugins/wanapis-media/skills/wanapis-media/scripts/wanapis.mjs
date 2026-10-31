#!/usr/bin/env node
/**
 * WanAPIs 生图/生视频 CLI —— 零依赖，只用 Node 内置模块。
 *
 * 存在的意义:各家模型参数体系互不相同(Seedance 的 resolution、Kling 的 mode、
 * Midjourney 塞在 prompt 里的 --q)，让 agent 逐个记住不现实。这里对外只暴露
 * quality / aspect / seconds 三个语义参数，由脚本翻译成各家真实字段。
 *
 * 用法见 --help。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = (process.env.WANAPIS_BASE_URL || 'https://api.wanapis.com').replace(/\/+$/, '');
const KEY = process.env.WANAPIS_API_KEY;

// BEGIN GENERATED MEDIA HELPERS
// Source: src/models.js
/** Verified adapters: a catalog entry alone does not establish its request protocol. */
const QUALITY = {
  seedance: { low: '480p', medium: '720p', high: '1080p' },
  veo: { low: '720p', medium: '1080p', high: '4k' },
  kling: { low: 'std', medium: 'pro', high: '4k' },
  vidu: { low: '540p', medium: '720p', high: '1080p' },
  wan: { low: '720p', medium: '720p', high: '1080p' },
  seedream: { low: '1K', medium: '1K', high: '2K' },
  nanobanana: { low: '1K', medium: '2K', high: '4K' },
  gptimage: { low: '1K', medium: '2K', high: '4K' },
};

const VIDEO_MODELS = {
  'seedance-2.5': { family: 'seedance', billing: 'per-second', note: '最新一代，画质与一致性最好' },
  'seedance-2.0': { family: 'seedance', billing: 'per-second', note: '标准版，质量优先' },
  'seedance-2.0-fast': { family: 'seedance', billing: 'per-second', note: '速度版，适合草稿' },
  'seedance-2.0-mini': { family: 'seedance', billing: 'per-second', note: '最便宜，适合大批量试稿' },
  'veo3.1-quality': { family: 'veo', billing: 'per-call', note: 'Google Veo 3.1，4K + 同步音频' },
  'veo3.1-fast': { family: 'veo', billing: 'per-call', note: 'Veo 3.1 速度档' },
  'veo3.1-lite': { family: 'veo', billing: 'per-call', note: 'Veo 3.1 最低价' },
  'kling-v3': { family: 'kling', billing: 'per-second', note: '可灵 v3，人物动作最自然' },
  'kling-v2-6': { family: 'kling', billing: 'per-second', note: '可灵 2.6，性价比档' },
  viduq3: { family: 'vidu', billing: 'per-second', note: 'Vidu Q3' },
  'happyhorse-1.0': { family: 'wan', billing: 'per-second', note: '阿里 ATH' },
  'grok-video': { family: 'seedance', billing: 'per-second', note: 'xAI，固定 6 秒' },
  'minimax-h3': { family: 'h3', billing: 'per-second', note: '4–30秒；2K至多15秒；默认4秒768P、IR开启' },
};

const IMAGE_MODELS = {
  'gpt-image-2': { family: 'gptimage', async: false, note: '主力模型，同步返回' },
  'gpt-image-2-official': { family: 'gptimage', async: true, note: '异步高清，支持 quality/resolution 分档' },
  'seedream-5-0-pro': { family: 'seedream', async: true, note: 'Seedream 最强，1K/2K 分档' },
  'seedream-5-0-lite': { family: 'seedream', async: true, note: 'Seedream 轻量' },
  'seedream-4-5': { family: 'seedream', async: true, note: 'Seedream 4.5' },
  'nano-banana-pro': { family: 'nanobanana', async: false, note: 'Gemini 3 Pro Image，1K/2K/4K' },
  'nano-banana-2': { family: 'nanobanana', async: false, note: 'Gemini 3.1 Flash Image' },
  midjourney: { family: 'midjourney', async: true, note: '一次出 4 张(2x2 四宫格拆分)' },
  'gpt-image-2.5-flare': { family: 'gptimage25', async: true, note: '异步；独立质量/分辨率；默认low/1k/1张，按实际消耗结算' },
  'gpt-image-2.5-sunburst': { family: 'gptimage25', async: true, note: '异步编辑；支持参考图；默认low/1k/1张，按实际消耗结算' },
};

const IMAGE25_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'];
const IMAGE25_RESOLUTIONS = ['1k', '2k', '4k'];
const H3_RESOLUTIONS = ['480p', '768P', '1080p', '2K'];
const H3_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const LEGACY_QUALITIES = ['low', 'medium', 'high'];

function choice(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function unsupported(options, fields, model) {
  for (const field of fields) {
    if (options[field] !== undefined) throw new Error(`${field} is not supported for ${model}`);
  }
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function boolean(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function imageReferences(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('reference_images must be an array of URLs');
  return value.map((url) => text(url, 'reference image URL'));
}

/** Shared by request building and pricing; it never makes network requests. */
function normalizeImageOptions(model, options = {}) {
  const spec = IMAGE_MODELS[model];
  if (!spec) throw new Error(`unknown image model: ${model}`);
  unsupported(options, ['seconds', 'ratio', 'fast_mode', 'context_ir_enabled', 'imageUrl'], model);
  const refs = imageReferences(options.referenceImages);
  if (spec.family === 'gptimage25') {
    if (options.aspect !== undefined && options.size !== undefined && options.aspect !== options.size) {
      throw new Error('size and aspect conflict; supply only one image size');
    }
    const size = options.size ?? options.aspect;
    if (size !== undefined) text(size, 'size');
    return {
      quality: choice(options.quality ?? 'low', IMAGE25_QUALITIES, 'quality'),
      resolution: choice(options.resolution ?? '1k', IMAGE25_RESOLUTIONS, 'resolution'),
      count: positiveInteger(options.count ?? 1, 'count'),
      ...(size !== undefined ? { size } : {}),
      ...(refs !== undefined ? { referenceImages: refs } : {}),
    };
  }
  unsupported(options, ['resolution', 'size'], model);
  if (options.count !== undefined && options.count !== 1) throw new Error(`count is not supported for ${model}; use 1`);
  return {
    quality: choice(options.quality ?? 'medium', LEGACY_QUALITIES, 'quality'),
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
    ...(refs !== undefined ? { referenceImages: refs } : {}),
  };
}

function normalizeVideoOptions(model, options = {}) {
  const spec = VIDEO_MODELS[model];
  if (!spec) throw new Error(`unknown video model: ${model}`);
  unsupported(options, ['count', 'size', 'referenceImages'], model);
  if (spec.family === 'h3') {
    if (options.quality !== undefined) throw new Error('minimax-h3 uses resolution, not quality');
    if (options.aspect !== undefined && options.ratio !== undefined && options.aspect !== options.ratio) {
      throw new Error('ratio and aspect conflict; supply only one video ratio');
    }
    const resolution = choice(options.resolution ?? '768P', H3_RESOLUTIONS, 'resolution');
    const seconds = positiveInteger(options.seconds ?? 4, 'seconds');
    if (seconds < 4 || seconds > (resolution === '2K' ? 15 : 30)) {
      throw new Error(`minimax-h3 seconds must be 4–${resolution === '2K' ? 15 : 30} at ${resolution}`);
    }
    if (options.imageUrl !== undefined) text(options.imageUrl, 'image_url');
    return {
      resolution, seconds, ratio: choice(options.ratio ?? options.aspect ?? '9:16', H3_RATIOS, 'ratio'),
      fast_mode: boolean(options.fast_mode, false, 'fast_mode'),
      context_ir_enabled: boolean(options.context_ir_enabled, true, 'context_ir_enabled'),
      ...(options.imageUrl !== undefined ? { imageUrl: options.imageUrl } : {}),
    };
  }
  unsupported(options, ['resolution', 'ratio', 'fast_mode', 'context_ir_enabled'], model);
  return {
    quality: choice(options.quality ?? 'medium', LEGACY_QUALITIES, 'quality'),
    seconds: options.seconds ?? 5,
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
    ...(options.imageUrl !== undefined ? { imageUrl: options.imageUrl } : {}),
  };
}

function buildVideoBody(model, options = {}) {
  const settings = normalizeVideoOptions(model, options);
  const spec = VIDEO_MODELS[model];
  if (spec.family === 'h3') {
    text(options.prompt, 'prompt');
    const { imageUrl, ...native } = settings;
    return { model, prompt: options.prompt, ...native,
      ...(imageUrl !== undefined ? { input_reference: { image_url: imageUrl } } : {}) };
  }
  const body = { model, prompt: options.prompt };
  const q = QUALITY[spec.family]?.[settings.quality];
  if (spec.family === 'kling') {
    if (q) body.mode = q;
    if (settings.aspect) body.aspect_ratio = settings.aspect;
  } else {
    if (q) body.resolution = q;
    if (settings.aspect) body.size = settings.aspect;
  }
  if (settings.seconds) body.duration = settings.seconds;
  if (settings.imageUrl) body.image_urls = [settings.imageUrl];
  return body;
}

function buildImageBody(model, options = {}) {
  const settings = normalizeImageOptions(model, options);
  const spec = IMAGE_MODELS[model];
  const body = { model, prompt: options.prompt };
  if (spec.family === 'gptimage25') {
    text(options.prompt, 'prompt');
    body.quality = settings.quality;
    body.resolution = settings.resolution;
    body.n = settings.count;
    if (settings.size !== undefined) body.size = settings.size;
  } else if (spec.family === 'midjourney') {
    const flags = [];
    if (settings.aspect) flags.push(`--ar ${settings.aspect}`);
    if (settings.quality === 'low') flags.push('--q .25');
    if (flags.length) body.prompt = `${options.prompt} ${flags.join(' ')}`;
  } else {
    const q = QUALITY[spec.family]?.[settings.quality];
    if (q) body.resolution = q;
    if (settings.aspect) body.size = settings.aspect;
  }
  if (settings.referenceImages?.length) body.image_urls = settings.referenceImages;
  return body;
}

function submitPath(kind, model) {
  if (kind === 'video') return '/v1/video/generations';
  return IMAGE_MODELS[model]?.async ? '/v1/images/tasks' : '/v1/images/generations';
}

function modelCapabilities(model) {
  const image = IMAGE_MODELS[model];
  const video = VIDEO_MODELS[model];
  if (image?.family === 'gptimage25') return {
    quality: IMAGE25_QUALITIES, resolution: IMAGE25_RESOLUTIONS, count: { minimum: 1 },
    references: true, defaults: { quality: 'low', resolution: '1k', count: 1 },
    billing: 'tier_precharge_with_actual_usage_settlement',
  };
  if (video?.family === 'h3') return {
    resolution: H3_RESOLUTIONS, ratio: H3_RATIOS, seconds: { minimum: 4, maximum: 30, maximum_at_2K: 15 },
    max_reference_images: 1, fast_mode: true, context_ir_enabled: true,
    defaults: { resolution: '768P', seconds: 4, ratio: '9:16', fast_mode: false, context_ir_enabled: true },
  };
  return { quality: LEGACY_QUALITIES, defaults: { quality: 'medium', ...(video ? { seconds: 5 } : {}) } };
}

// Source: src/catalog.js

/** Keep routing metadata without treating anonymous visibility as token permission. */
function parseCatalog(payload) {
  if (!payload || payload.success === false || !Array.isArray(payload.data)) {
    throw new Error('Invalid pricing catalog: expected a successful data array');
  }
  const entries = new Map();
  for (const row of payload.data) {
    if (!row || typeof row !== 'object' || typeof row.model_name !== 'string' || !row.model_name) {
      throw new Error('Invalid pricing catalog model entry');
    }
    if (entries.has(row.model_name)) throw new Error(`Ambiguous pricing catalog entry: ${row.model_name}`);
    entries.set(row.model_name, row);
  }
  return {
    entries, pricing_version: payload.pricing_version ?? null,
    group_ratio: payload.group_ratio ?? {}, usable_group: payload.usable_group ?? {},
    auto_groups: payload.auto_groups ?? [],
  };
}

function listCatalogModels(catalog, kind = 'all') {
  if (!['image', 'video', 'all'].includes(kind)) throw new Error('kind must be image, video or all');
  const rows = [];
  for (const [models, k] of [[VIDEO_MODELS, 'video'], [IMAGE_MODELS, 'image']]) {
    if (kind !== 'all' && kind !== k) continue;
    for (const [id, spec] of Object.entries(models)) {
      const entry = catalog.entries.get(id);
      if (!entry) continue;
      rows.push({
        model: id, kind: k, note: spec.note, price: entry.model_price ?? null,
        tiers: entry.video_pricing ?? entry.image_pricing ?? null,
        image_tier_ratios: entry.image_tier_ratios ?? null,
        video_pricing_meta: entry.video_pricing_meta ?? null,
        enable_groups: entry.enable_groups ?? [], capabilities: modelCapabilities(id),
      });
    }
  }
  return rows;
}

// Source: src/pricing.js

const QUOTA_PER_CNY = 500000;
const PRICE_NOTE = 'Public catalog budget with an assumed group multiplier; the API key route and final charge are not established by this estimate.';
const finiteRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Validate native parameters before loading a catalog, just as generation does. */
function normalizeEstimateOptions(model, options = {}) {
  const groupRatio = options.group_ratio ?? 1;
  if (!finiteRate(groupRatio)) throw new Error('group_ratio must be a finite non-negative number');
  let settings;
  if (IMAGE_MODELS[model]?.family === 'gptimage25') settings = normalizeImageOptions(model, options);
  else if (VIDEO_MODELS[model]?.family === 'h3') settings = normalizeVideoOptions(model, options);
  else {
    if (options.quality !== undefined && !['low', 'medium', 'high'].includes(options.quality)) throw new Error('quality must be low, medium or high for this model');
    for (const field of ['resolution', 'ratio', 'fast_mode', 'context_ir_enabled']) {
      if (options[field] !== undefined) throw new Error(`${field} is not supported for ${model}`);
    }
    if (options.count !== undefined && (!Number.isSafeInteger(options.count) || options.count < 1)) throw new Error('count must be a positive integer');
    settings = { ...options, quality: options.quality ?? 'medium' };
    delete settings.group_ratio;
  }
  return { settings, groupRatio };
}

function unavailable(model, groupRatio, note, settings) {
  return { model, estimate: null, currency: 'CNY', group_ratio: groupRatio,
    group_ratio_source: 'user_assumption', settings, note };
}

// Decimal retail prices must round once, half-up, at the gateway's quota precision.
function decimal(value) {
  if (typeof value === 'object') return value;
  const [mantissa, exponent = '0'] = String(value).split(/e/i);
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const units = BigInt(whole + fraction);
  return scale >= 0 ? { units, scale } : { units: units * 10n ** BigInt(-scale), scale: 0 };
}

function product(...values) {
  return values.map(decimal).reduce((a, b) => ({ units: a.units * b.units, scale: a.scale + b.scale }), { units: 1n, scale: 0 });
}

function sum(a, b) {
  a = decimal(a); b = decimal(b);
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale), scale };
}

function quoted(model, rawAmount, groupRatio, details) {
  const amount = product(rawAmount, groupRatio, QUOTA_PER_CNY);
  const denominator = 10n ** BigInt(amount.scale);
  const rounded = amount.units / denominator + (amount.units % denominator * 2n >= denominator ? 1n : 0n);
  if (rounded < 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    return unavailable(model, groupRatio, 'Price calculation is outside the supported numeric range', details.settings);
  }
  const quota = Number(rounded);
  return { model, estimate: quota / QUOTA_PER_CNY, estimated_quota: quota,
    currency: 'CNY', group_ratio: groupRatio, group_ratio_source: 'user_assumption',
    ...details };
}

function legacyPrice(entry, { quality, seconds, count }) {
  const tier = { low: '480p', medium: '720p', high: '1080p' };
  const imageTier = { low: '1K', medium: '2K', high: '4K' };
  const video = entry.video_pricing;
  if (video && seconds > 0) {
    const rate = video[tier[quality]] ?? video['*'] ?? Object.values(video)[0];
    if (finiteRate(rate) && rate > 0) return { amount: rate * seconds, basis: `${rate}/s × ${seconds}s` };
  }
  const image = entry.image_pricing;
  if (image) {
    const rate = image[imageTier[quality]];
    if (finiteRate(rate) && rate > 0) return { amount: rate * (count ?? 1), basis: `${rate} × ${count ?? 1}` };
  }
  if (finiteRate(entry.model_price) && entry.model_price > 0) {
    if (seconds > 0) return { amount: entry.model_price * seconds, basis: `${entry.model_price}/s × ${seconds}s` };
    return { amount: entry.model_price * (count ?? 1), basis: `${entry.model_price} × ${count ?? 1}` };
  }
  return null;
}

function estimateCost(catalog, model, options = {}) {
  const { settings, groupRatio } = normalizeEstimateOptions(model, options);
  const entry = catalog.entries.get(model);
  if (!entry) return unavailable(model, groupRatio, 'Model is absent from the public pricing catalog', settings);
  if (IMAGE_MODELS[model]?.family === 'gptimage25') {
    const ratios = entry.image_tier_ratios;
    const quality = settings.quality === 'low' ? 1 : ratios?.[`quality:${settings.quality}`];
    const resolution = settings.resolution === '1k' ? 1 : ratios?.[`resolution:${settings.resolution}`];
    if (![entry.model_price, quality, resolution].every(finiteRate)) {
      return unavailable(model, groupRatio, 'Image tier pricing is missing or invalid', settings);
    }
    return quoted(model, product(entry.model_price, quality, resolution, settings.count), groupRatio, {
      basis: `${entry.model_price} × quality ${quality} × resolution ${resolution} × ${settings.count} images × group ${groupRatio}`,
      estimate_kind: 'tier_precharge', pricing_version: catalog.pricing_version, settings,
      breakdown: { base_image_price: entry.model_price, quality_multiplier: quality, resolution_multiplier: resolution, count: settings.count },
      note: `${PRICE_NOTE} Image tasks settle on actual usage; references, dimensions and prompt content can increase the charge beyond this tier precharge.`,
    });
  }
  if (VIDEO_MODELS[model]?.family === 'h3') {
    const meta = entry.video_pricing_meta;
    const rate = entry.video_pricing?.[settings.resolution];
    if (!meta || typeof meta.version !== 'string' || !Array.isArray(meta.resolutions) || !meta.resolutions.includes(settings.resolution) ||
        !Array.isArray(meta.ratios) || !meta.ratios.includes(settings.ratio) ||
        !Number.isSafeInteger(meta.long_from) || meta.long_from < 1 ||
        ![rate, meta.long_multiplier, meta.fast_mode?.multiplier, meta.context_ir?.price].every(finiteRate) ||
        meta.long_multiplier < 1 || meta.fast_mode.multiplier < 1 || meta.context_ir.unit !== 'request') {
      return unavailable(model, groupRatio, 'H3 pricing metadata is missing or incompatible', settings);
    }
    const maximum = meta.max_seconds_by_resolution?.[settings.resolution];
    if (!Number.isSafeInteger(meta.min_seconds) || !Number.isSafeInteger(meta.max_seconds) || !Number.isSafeInteger(maximum) ||
        settings.seconds < meta.min_seconds || settings.seconds > Math.min(meta.max_seconds, maximum)) {
      return unavailable(model, groupRatio, 'H3 pricing metadata does not cover this duration', settings);
    }
    const long = settings.seconds >= meta.long_from ? meta.long_multiplier : 1;
    const fast = settings.fast_mode ? meta.fast_mode.multiplier : 1;
    const ir = settings.context_ir_enabled ? meta.context_ir.price : 0;
    const video = rate * settings.seconds * long * fast;
    return quoted(model, sum(product(rate, settings.seconds, long, fast), ir), groupRatio, {
      basis: `(${rate}/s × ${settings.seconds}s × long ${long} × fast ${fast} + IR ${ir}) × group ${groupRatio}`,
      estimate_kind: 'specification_budget', pricing_version: meta.version, settings,
      breakdown: { price_per_second: rate, seconds: settings.seconds, long_multiplier: long, fast_multiplier: fast, video_fee: video, ir_fee: ir },
      note: PRICE_NOTE,
    });
  }
  const price = legacyPrice(entry, settings);
  if (!price) return unavailable(model, groupRatio, 'No price configured for this model', settings);
  // Preserve the legacy four-decimal display while identifying it as a budget.
  return { model, estimate: Number((price.amount * groupRatio).toFixed(4)), currency: 'CNY',
    basis: `${price.basis} × group ${groupRatio}`, settings, group_ratio: groupRatio,
    group_ratio_source: 'user_assumption', estimate_kind: 'budget', pricing_version: catalog.pricing_version, note: PRICE_NOTE };
}

// END GENERATED MEDIA HELPERS

// ── HTTP ───────────────────────────────────────────────────────
function requireKey() {
  if (!KEY) die('缺少 WANAPIS_API_KEY。到 https://wanapis.com 获取后 export WANAPIS_API_KEY=sk-...');
}

async function api(pathname, { method = 'GET', body, timeoutMs = 420000, authenticated = true } = {}) {
  if (authenticated) requireKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { ...(authenticated ? { Authorization: `Bearer ${KEY}` } : {}), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`${res.status}: ${json?.error?.message || json?.message || text.slice(0, 200)}`);
    return json;
  } finally { clearTimeout(timer); }
}

/**
 * 下载媒体。
 *
 * ⚠️ 只对自家域名带 Authorization。图片结果是上游 CDN 直链(公开可访问)，
 * 对它发 key 等于把用户凭据泄露给第三方；视频走自家代理，不带 key 会 401。
 */
async function download(url, out) {
  const sameHost = new URL(url).host === new URL(BASE).host;
  const res = await fetch(url, sameHost ? { headers: { Authorization: `Bearer ${KEY}` } } : {});
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  return { path: out, bytes: buf.length };
}

// ── 结果解析 ───────────────────────────────────────────────────
function extractMediaUrls(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const urls = [];
  const push = (u) => { if (typeof u === 'string' && u && !urls.includes(u)) urls.push(u); };
  push(d?.result_url);
  const inner = d?.data && typeof d.data === 'object' ? d.data : null;
  push(inner?.content?.video_url);
  push(inner?.content?.image_url);
  const result = inner?.result ?? inner?.data?.result ?? d?.result;
  for (const item of result?.videos ?? result?.images ?? []) {
    const u = item?.url;
    if (Array.isArray(u)) u.forEach(push); else push(u);
  }
  return urls;
}

const DONE_OK = new Set(['success', 'succeeded', 'completed']);
const DONE_BAD = new Set(['failed', 'failure', 'error']);

async function loadCatalog() {
  return parseCatalog(await api('/api/pricing', { timeoutMs: 30000, authenticated: false }));
}

// ── 任务轮询 ───────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollTask(kind, taskId, { quiet } = {}) {
  const p = kind === 'video'
    ? `/v1/video/generations/${encodeURIComponent(taskId)}`
    : `/v1/images/tasks/${encodeURIComponent(taskId)}`;
  for (let i = 0; i < 80; i++) {
    await sleep(i < 4 ? 5000 : 15000);
    const payload = await api(p);
    const d = payload?.data ?? {};
    const status = String(d.status ?? '').toLowerCase();
    if (!quiet) process.stderr.write(`  ${status} ${d.progress ?? ''}\n`);
    if (DONE_OK.has(status)) return { payload, d };
    if (DONE_BAD.has(status)) die(`生成失败: ${d.fail_reason || status}`);
  }
  die('轮询超时(20 分钟)。任务可能仍在跑，用 task 子命令查:\n  ' +
      `node wanapis.mjs task ${taskId} --kind ${kind}`);
}

function report(d, urls, saved) {
  const out = { status: 'success', media: urls };
  if (typeof d.quota === 'number') out.chargedCny = Number((d.quota / QUOTA_PER_CNY).toFixed(4));
  const inner = d.data ?? {};
  if (inner.duration || inner.resolution) {
    out.actual = { duration: inner.duration ?? null, resolution: inner.resolution ?? null };
  }
  if (saved) out.saved = saved;
  console.log(JSON.stringify(out, null, 2));
}

// ── 命令 ───────────────────────────────────────────────────────
function die(msg) { console.error(msg); process.exit(1); }

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const known = new Set(['model', 'quality', 'resolution', 'seconds', 'count', 'aspect', 'size', 'ratio', 'image', 'reference-image', 'fast-mode', 'context-ir-enabled', 'group-ratio', 'out', 'kind']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!known.has(name)) throw new Error(`Unknown option --${name}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
    if (name === 'reference-image') (flags[name] ??= []).push(argv[++i]);
    else flags[name] = argv[++i];
  }
  return { positional, flags };
}

function numericFlag(value, name) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value))) throw new Error(`--${name} needs a finite number`);
  return Number(value);
}

function boolFlag(value, name) {
  if (value !== 'true' && value !== 'false') throw new Error(`--${name} needs true or false`);
  return value === 'true';
}

function flagOptions(flags) {
  const options = {};
  for (const name of ['quality', 'resolution', 'aspect', 'size', 'ratio']) if (flags[name] !== undefined) options[name] = flags[name];
  for (const name of ['seconds', 'count']) if (flags[name] !== undefined) options[name] = numericFlag(flags[name], name);
  if (flags.image !== undefined) options.imageUrl = flags.image;
  if (flags['reference-image'] !== undefined) options.referenceImages = flags['reference-image'];
  for (const name of ['fast-mode', 'context-ir-enabled']) if (flags[name] !== undefined) options[name.replaceAll('-', '_')] = boolFlag(flags[name], name);
  return options;
}

const HELP = `WanAPIs 生图/生视频 CLI

  estimate --model <m> [--quality <tier>] [--resolution <tier>] [--seconds N]
           [--count N] [--group-ratio N] [--fast-mode true|false]
           [--context-ir-enabled true|false]
      公共价格预算，group-ratio 默认为1，不代表令牌实际分组。图片实际消耗可能更高。

  image "<prompt>" [--model gpt-image-2] [--quality low] [--aspect 1:1] [--out FILE]
      Image 2.5: --model gpt-image-2.5-flare|gpt-image-2.5-sunburst
        --quality low|medium|high|xhigh|max --resolution 1k|2k|4k --count N
        --reference-image <URL> (可重复)；默认显式low/1k/1张，提交异步任务。
  video "<prompt>" [--model seedance-2.0-mini] [--quality low] [--seconds 5]
                   [--aspect 16:9] [--image <首帧图 URL>] [--out FILE]
      H3: --model minimax-h3 --resolution 480p|768P|1080p|2K
        --seconds 4..30 (2K最多15秒) --ratio 16:9 --image <单张首帧URL>
        --fast-mode true|false --context-ir-enabled true|false
        默认4秒/768P/9:16/fast=false/IR=true；不用quality。

  task <task_id> --kind video|image [--out FILE]
      查已提交的任务(轮询中断后用它接回来)。

  models [--kind video|image]

环境变量: WANAPIS_API_KEY(必需)、WANAPIS_BASE_URL(可选)

注意:客户端中断【不会】取消上游任务，照样计费。宁可等，别重试。`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }

  if (cmd === 'models') {
    const catalog = await loadCatalog();
    console.log(JSON.stringify(listCatalogModels(catalog, flags.kind ?? 'all'), null, 2));
    return;
  }

  if (cmd === 'estimate') {
    if (!flags.model) die('需要 --model');
    const options = flagOptions(flags);
    if (flags['group-ratio'] !== undefined) options.group_ratio = numericFlag(flags['group-ratio'], 'group-ratio');
    normalizeEstimateOptions(flags.model, options);
    const result = estimateCost(await loadCatalog(), flags.model, options);
    console.log(JSON.stringify({ ...result, estimateCny: result.estimate }, null, 2));
    return;
  }

  if (cmd === 'image') {
    if (flags['group-ratio'] !== undefined) throw new Error('--group-ratio is only an estimate assumption, not a generation option');
    const prompt = positional.join(' ');
    if (!prompt) die('需要提示词');
    const model = flags.model ?? 'gpt-image-2';
    const body = buildImageBody(model, { prompt, ...flagOptions(flags) });
    const isAsync = IMAGE_MODELS[model]?.async;
    const path_ = isAsync ? '/v1/images/tasks' : '/v1/images/generations';
    process.stderr.write(`提交 ${model}…(生图通常 25 秒~5 分钟)\n`);
    const res = await api(path_, { method: 'POST', body });

    if (isAsync) {
      const taskId = res?.task_id ?? (Array.isArray(res?.data) ? res.data[0]?.task_id : res?.data?.task_id);
      if (!taskId) die(`响应里没有 task_id: ${JSON.stringify(res).slice(0, 200)}`);
      const { d } = await pollTask('image', taskId);
      const urls = extractMediaUrls({ data: d });
      report(d, urls, await saveAll(urls, flags.out, taskId));
      return;
    }
    const urls = (res?.data ?? []).map((x) => x?.url).filter((u) => typeof u === 'string');
    if (!urls.length) die('模型返回了内联数据而非 URL,已跳过(避免撑爆上下文)');
    report({}, urls, await saveAll(urls, flags.out, 'image'));
    return;
  }

  if (cmd === 'video') {
    if (flags['group-ratio'] !== undefined) throw new Error('--group-ratio is only an estimate assumption, not a generation option');
    const prompt = positional.join(' ');
    if (!prompt) die('需要提示词');
    const model = flags.model ?? 'seedance-2.0-mini';
    const body = buildVideoBody(model, { prompt, ...flagOptions(flags) });
    process.stderr.write(`提交 ${model}…(生视频通常 60~150 秒)\n`);
    const res = await api('/v1/video/generations', { method: 'POST', body });
    const taskId = res?.task_id ?? (Array.isArray(res?.data) ? res.data[0]?.task_id : res?.data?.task_id);
    if (!taskId) die(`响应里没有 task_id: ${JSON.stringify(res).slice(0, 200)}`);
    const { d } = await pollTask('video', taskId);
    const urls = extractMediaUrls({ data: d });
    report(d, urls, await saveAll(urls, flags.out, taskId));
    return;
  }

  if (cmd === 'task') {
    const taskId = positional[0];
    if (!taskId) die('需要 task_id');
    const kind = flags.kind ?? 'video';
    const p = kind === 'video'
      ? `/v1/video/generations/${encodeURIComponent(taskId)}`
      : `/v1/images/tasks/${encodeURIComponent(taskId)}`;
    const payload = await api(p);
    const d = payload?.data ?? {};
    const status = String(d.status ?? '').toLowerCase();
    const urls = extractMediaUrls(payload);
    if (!DONE_OK.has(status)) { console.log(JSON.stringify({ status, progress: d.progress ?? null }, null, 2)); return; }
    report(d, urls, await saveAll(urls, flags.out, taskId));
    return;
  }

  die(`未知命令: ${cmd}\n\n${HELP}`);
}

async function saveAll(urls, out, stem) {
  if (!out || !urls.length) return undefined;
  const saved = [];
  for (const [i, url] of urls.entries()) {
    const dest = urls.length > 1
      ? path.join(path.dirname(out), `${path.basename(out, path.extname(out))}-${i + 1}${path.extname(out)}`)
      : out;
    process.stderr.write(`  下载 → ${dest}\n`);
    saved.push(await download(url, dest));
  }
  return saved;
}

export { VIDEO_MODELS, IMAGE_MODELS, QUALITY, buildVideoBody, buildImageBody, normalizeImageOptions, normalizeVideoOptions, modelCapabilities, parseCatalog, listCatalogModels, normalizeEstimateOptions, estimateCost, extractMediaUrls, flagOptions };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => die(String(e?.message ?? e)));
}
