/** Verified adapters: a catalog entry alone does not establish its request protocol. */
export const QUALITY = {
  seedance: { low: '480p', medium: '720p', high: '1080p' },
  veo: { low: '720p', medium: '1080p', high: '4k' },
  kling: { low: 'std', medium: 'pro', high: '4k' },
  vidu: { low: '540p', medium: '720p', high: '1080p' },
  wan: { low: '720p', medium: '720p', high: '1080p' },
  seedream: { low: '1K', medium: '1K', high: '2K' },
  nanobanana: { low: '1K', medium: '2K', high: '4K' },
  gptimage: { low: '1K', medium: '2K', high: '4K' },
};

export const VIDEO_MODELS = {
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

export const IMAGE_MODELS = {
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

export const IMAGE25_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'];
export const IMAGE25_RESOLUTIONS = ['1k', '2k', '4k'];
export const H3_RESOLUTIONS = ['480p', '768P', '1080p', '2K'];
export const H3_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
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
export function normalizeImageOptions(model, options = {}) {
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

export function normalizeVideoOptions(model, options = {}) {
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

export function buildVideoBody(model, options = {}) {
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

export function buildImageBody(model, options = {}) {
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

export function submitPath(kind, model) {
  if (kind === 'video') return '/v1/video/generations';
  return IMAGE_MODELS[model]?.async ? '/v1/images/tasks' : '/v1/images/generations';
}

export function modelCapabilities(model) {
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
