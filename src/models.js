/**
 * 模型映射层 —— 这个文件是整个插件的核心价值。
 *
 * 各家上游的参数体系互不相同，让 agent 记住这些不现实:
 *
 *   Seedance   resolution: 480p/720p/1080p   size: 比例      duration: 4~15
 *   Kling      mode: std/pro/4k              aspect_ratio    duration: 3~15
 *   Veo 3.1    resolution                    —               按次计费
 *   Midjourney prompt 里塞 --ar / --q        异步四宫格出 4 张
 *   Seedream   resolution: 1K/2K             size: 比例
 *
 * 所以对 agent 只暴露统一语义(quality / aspect / seconds)，由这里翻译成
 * 各家真实字段。agent 说「720p、5 秒、16:9」，不需要知道 Kling 管它叫 mode。
 */

/** 统一画质档 → 各家真实取值 */
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

/**
 * 视频模型表。
 * family 决定参数翻译方式;billing 只用于提示 agent，不参与实际计费。
 */
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
};

/** 把统一语义翻译成某个模型真实接受的请求体 */
export function buildVideoBody(model, { prompt, quality, seconds, aspect, imageUrl }) {
  const spec = VIDEO_MODELS[model];
  if (!spec) throw new Error(`unknown video model: ${model}`);
  const body = { model, prompt };
  const q = QUALITY[spec.family]?.[quality ?? 'medium'];

  if (spec.family === 'kling') {
    // Kling 用 mode 而不是 resolution，比例字段也叫 aspect_ratio
    if (q) body.mode = q;
    if (aspect) body.aspect_ratio = aspect;
  } else {
    if (q) body.resolution = q;
    if (aspect) body.size = aspect;
  }

  if (seconds) body.duration = seconds;
  if (imageUrl) body.image_urls = [imageUrl];
  return body;
}

export function buildImageBody(model, { prompt, quality, aspect, referenceImages }) {
  const spec = IMAGE_MODELS[model];
  if (!spec) throw new Error(`unknown image model: ${model}`);
  const body = { model, prompt };

  if (spec.family === 'midjourney') {
    // MJ 没有独立参数，靠 prompt 后缀。--q .25 是低画质省钱档。
    const flags = [];
    if (aspect) flags.push(`--ar ${aspect}`);
    if (quality === 'low') flags.push('--q .25');
    if (flags.length) body.prompt = `${prompt} ${flags.join(' ')}`;
  } else {
    const q = QUALITY[spec.family]?.[quality ?? 'medium'];
    if (q) body.resolution = q;
    if (aspect) body.size = aspect;
  }

  if (referenceImages?.length) body.image_urls = referenceImages;
  return body;
}

/** 提交端点:同步图片直接返图，其余都是异步任务 */
export function submitPath(kind, model) {
  if (kind === 'video') return '/v1/video/generations';
  return IMAGE_MODELS[model]?.async ? '/v1/images/tasks' : '/v1/images/generations';
}
