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
export const H3_MAX_IMAGES = 9;
export const H3_MAX_REFERENCE_VIDEOS = 3;
export const H3_MAX_REFERENCE_AUDIO = 3;
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

function mediaList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item) => text(item, field));
}

function mediaSource(value) {
  return value.startsWith('asset_') ? { asset_id: value } : { url: value };
}

const isSeedanceModel = (model) => model.startsWith('seedance-');

function seedanceMedia(options = {}) {
  const referenceImages = mediaList(options.referenceImages, 'reference_images');
  const referenceVideos = mediaList(options.referenceVideos, 'reference_videos');
  const referenceAudio = mediaList(options.referenceAudio, 'reference_audio');
  const firstFrame = options.firstFrame === undefined ? undefined : text(options.firstFrame, 'first_frame');
  const lastFrame = options.lastFrame === undefined ? undefined : text(options.lastFrame, 'last_frame');
  const imageCount = referenceImages.length + Number(Boolean(firstFrame)) + Number(Boolean(lastFrame));
  if (imageCount > 9) throw new Error('Seedance accepts at most 9 images including frames');
  if (referenceVideos.length > 3) throw new Error('Seedance accepts at most 3 reference videos');
  if (referenceAudio.length > 3) throw new Error('Seedance accepts at most 3 audio clips');
  if (firstFrame && lastFrame && firstFrame === lastFrame) throw new Error('first_frame and last_frame must be different media');
  if (options.imageUrl !== undefined && imageCount > 0) throw new Error('image_url cannot be combined with reference_images or frame roles');
  if (referenceAudio.length && !referenceImages.length && !firstFrame && !lastFrame && !referenceVideos.length) {
    throw new Error('audio references require an image or video reference');
  }
  if ((firstFrame || lastFrame) && (referenceVideos.length || referenceAudio.length)) {
    throw new Error('first/last-frame mode cannot be combined with video or audio references');
  }
  return { referenceImages, referenceVideos, referenceAudio, firstFrame, lastFrame, imageCount };
}

function seedanceBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function seedanceSeed(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('seed must be a non-negative integer');
  return value;
}

function h3MediaContent(options = {}) {
  const referenceImages = mediaList(options.referenceImages, 'reference_images');
  const referenceVideos = mediaList(options.referenceVideos, 'reference_videos');
  const referenceAudio = mediaList(options.referenceAudio, 'reference_audio');
  const firstFrame = options.firstFrame === undefined ? undefined : text(options.firstFrame, 'first_frame');
  const lastFrame = options.lastFrame === undefined ? undefined : text(options.lastFrame, 'last_frame');
  const imageCount = referenceImages.length + Number(Boolean(firstFrame)) + Number(Boolean(lastFrame));
  if (imageCount > H3_MAX_IMAGES) throw new Error(`minimax-h3 accepts at most ${H3_MAX_IMAGES} images including frames`);
  if (referenceVideos.length > H3_MAX_REFERENCE_VIDEOS) throw new Error(`minimax-h3 accepts at most ${H3_MAX_REFERENCE_VIDEOS} reference videos`);
  if (referenceAudio.length > H3_MAX_REFERENCE_AUDIO) throw new Error(`minimax-h3 accepts at most ${H3_MAX_REFERENCE_AUDIO} reference audio clips`);
  if (firstFrame && lastFrame && firstFrame === lastFrame) throw new Error('first_frame and last_frame must be different media');
  if (options.imageUrl !== undefined && imageCount > 0) throw new Error('image_url cannot be combined with reference_images or frame roles');
  const content = [];
  if (firstFrame) content.push({ type: 'image_url', role: 'first_frame', image_url: mediaSource(firstFrame) });
  if (lastFrame) content.push({ type: 'image_url', role: 'last_frame', image_url: mediaSource(lastFrame) });
  for (const value of referenceImages) content.push({ type: 'image_url', role: 'reference_image', image_url: mediaSource(value) });
  for (const value of referenceVideos) content.push({ type: 'video_url', role: 'reference_video', video_url: mediaSource(value) });
  for (const value of referenceAudio) content.push({ type: 'audio_url', role: 'reference_audio', audio_url: mediaSource(value) });
  return { content, referenceImages, referenceVideos, referenceAudio, firstFrame, lastFrame, imageCount };
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
    const media = h3MediaContent(options);
    return {
      resolution, seconds, ratio: choice(options.ratio ?? options.aspect ?? '9:16', H3_RATIOS, 'ratio'),
      fast_mode: boolean(options.fast_mode, false, 'fast_mode'),
      context_ir_enabled: boolean(options.context_ir_enabled, true, 'context_ir_enabled'),
      ...(options.imageUrl !== undefined ? { imageUrl: options.imageUrl } : {}),
      ...(media.referenceImages.length ? { referenceImages: media.referenceImages } : {}),
      ...(media.firstFrame ? { firstFrame: media.firstFrame } : {}),
      ...(media.lastFrame ? { lastFrame: media.lastFrame } : {}),
      ...(media.referenceVideos.length ? { referenceVideos: media.referenceVideos } : {}),
      ...(media.referenceAudio.length ? { referenceAudio: media.referenceAudio } : {}),
    };
  }
  if (isSeedanceModel(model)) {
    unsupported(options, ['resolution', 'ratio', 'fast_mode', 'context_ir_enabled'], model);
    const media = seedanceMedia(options);
    const quality = choice(options.quality ?? 'medium', LEGACY_QUALITIES, 'quality');
    const seconds = options.seconds === undefined ? 5 : positiveInteger(options.seconds, 'seconds');
    if (seconds < 4 || seconds > 15) throw new Error('Seedance seconds must be 4–15');
    let aspect = options.aspect;
    if (options.size !== undefined) {
      if (aspect !== undefined && aspect !== options.size) throw new Error('size and aspect conflict');
      aspect = options.size;
    }
    if (aspect !== undefined) text(aspect, 'aspect');
    return {
      quality, seconds,
      ...(aspect !== undefined ? { aspect } : {}),
      ...(media.referenceImages.length ? { referenceImages: media.referenceImages } : {}),
      ...(media.firstFrame ? { firstFrame: media.firstFrame } : {}),
      ...(media.lastFrame ? { lastFrame: media.lastFrame } : {}),
      ...(media.referenceVideos.length ? { referenceVideos: media.referenceVideos } : {}),
      ...(media.referenceAudio.length ? { referenceAudio: media.referenceAudio } : {}),
      ...(options.imageUrl !== undefined ? { imageUrl: options.imageUrl } : {}),
      ...(options.generateAudio !== undefined ? { generateAudio: seedanceBoolean(options.generateAudio, 'generate_audio') } : {}),
      ...(options.returnLastFrame !== undefined ? { returnLastFrame: seedanceBoolean(options.returnLastFrame, 'return_last_frame') } : {}),
      ...(options.seed !== undefined ? { seed: seedanceSeed(options.seed) } : {}),
    };
  }
  unsupported(options, ['count', 'size', 'referenceImages', 'firstFrame', 'lastFrame', 'referenceVideos', 'referenceAudio'], model);
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
    const { imageUrl, referenceImages, firstFrame, lastFrame, referenceVideos, referenceAudio, ...native } = settings;
    const media = h3MediaContent({ referenceImages, firstFrame, lastFrame, referenceVideos, referenceAudio });
    if (media.content.length) {
      return { model, content: [{ type: 'text', text: options.prompt }, ...media.content], ...native };
    }
    return { model, prompt: options.prompt, ...native,
      ...(imageUrl !== undefined ? { input_reference: { image_url: imageUrl } } : {}) };
  }
  if (isSeedanceModel(model)) {
    text(options.prompt, 'prompt');
    const body = {
      model,
      prompt: options.prompt,
      resolution: QUALITY[spec.family]?.[settings.quality] ?? '720p',
      duration: settings.seconds,
    };
    if (settings.aspect) body.size = settings.aspect;
    const images = [];
    if (settings.firstFrame) images.push({ url: settings.firstFrame, role: 'first_frame' });
    if (settings.lastFrame) images.push({ url: settings.lastFrame, role: 'last_frame' });
    for (const url of settings.referenceImages ?? []) images.push({ url, role: 'reference_image' });
    if (images.length) {
      if (images.some((image) => image.role !== 'reference_image')) body.image_with_roles = images;
      else body.image_urls = images.map((image) => image.url);
    }
    if (settings.imageUrl) body.image_urls = [settings.imageUrl];
    if (settings.referenceVideos?.length) body.video_urls = settings.referenceVideos;
    if (settings.referenceAudio?.length) body.audio_urls = settings.referenceAudio;
    if (settings.generateAudio !== undefined) body.generate_audio = settings.generateAudio;
    if (settings.returnLastFrame !== undefined) body.return_last_frame = settings.returnLastFrame;
    if (settings.seed !== undefined) body.seed = settings.seed;
    return body;
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

export function buildRegenerationBody(options = {}) {
  const mode = options.mode ?? 'content';
  if (mode !== 'source' && mode !== 'content') throw new Error('mode must be source or content');
  if (options.imageUrl !== undefined) throw new Error('regeneration requires typed media, not image_url');
  if (mode === 'source') {
    for (const field of ['prompt', 'referenceImages', 'firstFrame', 'lastFrame', 'referenceVideos', 'referenceAudio']) {
      if (options[field] !== undefined) throw new Error('source mode must not include prompt or reference media');
    }
    return { mode: 'source', resolution: '2K' };
  }
  text(options.prompt, 'prompt');
  const media = h3MediaContent(options);
  return { mode: 'content', resolution: '2K', content: [{ type: 'text', text: options.prompt }, ...media.content] };
}

export function buildPromptOptimizationBody(options = {}) {
  text(options.prompt, 'prompt');
  const seconds = options.seconds === undefined ? 4 : positiveInteger(options.seconds, 'seconds');
  if (seconds < 4 || seconds > 15) throw new Error('prompt optimization seconds must be 4–15');
  const ratio = choice(options.ratio ?? '9:16', H3_RATIOS, 'ratio');
  return { model: 'minimax-h3', content: [{ type: 'text', text: options.prompt }], duration: seconds, ratio };
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
    max_reference_images: H3_MAX_IMAGES, max_reference_videos: H3_MAX_REFERENCE_VIDEOS,
    max_reference_audio: H3_MAX_REFERENCE_AUDIO, frame_roles: ['first_frame', 'last_frame'],
    upload: true, regeneration: ['content'], prompt_optimization: true,
    fast_mode: true, context_ir_enabled: true,
    billing: 'reservation_then_actual_usage_settlement',
    defaults: { resolution: '768P', seconds: 4, ratio: '9:16', fast_mode: false, context_ir_enabled: true },
  };
  if (video && isSeedanceModel(model)) return {
    quality: LEGACY_QUALITIES, resolution: ['480p', '720p', '1080p'],
    seconds: { minimum: 4, maximum: 15 },
    max_reference_images: 9, max_reference_videos: 3, max_reference_audios: 3,
    frame_roles: ['first_frame', 'last_frame'], image_roles: ['reference_image', 'first_frame', 'last_frame'],
    generate_audio: true, return_last_frame: true, seed: true,
    billing: 'per_second',
    defaults: { quality: 'medium', seconds: 5 },
  };
  return { quality: LEGACY_QUALITIES, defaults: { quality: 'medium', ...(video ? { seconds: 5 } : {}) } };
}
