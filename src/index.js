#!/usr/bin/env node
/**
 * WanAPIs MCP server —— 让 Claude Code / Codex / Cursor 等 agent 用同一个
 * WanAPIs key 直接出图、出视频。
 *
 * 设计取舍:
 *
 * 1. **非阻塞**。视频生成要 100 秒以上，MCP 工具不能干等 —— 提交后立刻返回
 *    task_id，由 agent 调 check_task 轮询。这也是 kie-ai / mcp-video-gen 的
 *    成熟做法。
 *
 * 2. **只返回 URL，不返回 base64**。同步图片接口会返回 b64_json，直接塞进
 *    agent 上下文会把窗口撑爆。
 *
 * 3. **统一语义参数**。agent 只说 quality / aspect / seconds，各家真实字段
 *    (Kling 的 mode、Seedance 的 resolution)由 models.js 翻译。
 *
 * 4. **生成前可估价**。estimate_cost 是竞品都没有的 —— 按量付费场景下，
 *    让 agent 先知道这次要花多少钱很实在。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WanApisClient, extractMediaUrls, taskStatus } from './client.js';
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  buildImageBody,
  buildVideoBody,
  buildRegenerationBody,
  buildPromptOptimizationBody,
  submitPath,
} from './models.js';
import { parseCatalog, listCatalogModels } from './catalog.js';
import { estimateCost, normalizeEstimateOptions } from './pricing.js';

const client = new WanApisClient({
  apiKey: process.env.WANAPIS_API_KEY,
  baseUrl: process.env.WANAPIS_BASE_URL,
});

const isRemoteMedia = (value) => /^(https?:|data:)/i.test(value);

/**
 * A media string may be a public URL/data URI, an existing platform asset, or a
 * local file. Local files are uploaded once and replaced with an opaque asset
 * ID; subsequent uploads bind to the first asset so one request uses one
 * credential. The MCP server never forwards a local path to the gateway.
 */
async function resolveMediaValue(value, mediaType, state) {
  if (typeof value !== 'string' || !value) throw new Error('media must be a non-empty string');
  if (value.startsWith('asset_')) {
    state.binding ??= value;
    return value;
  }
  if (isRemoteMedia(value)) return value;
  const asset = await client.uploadAsset(value, mediaType, state.binding);
  state.binding ??= asset.id;
  return asset.id;
}

async function resolveMediaList(values, mediaType, state) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error('media list must be an array');
  const out = [];
  for (const value of values) out.push(await resolveMediaValue(value, mediaType, state));
  return out;
}

/**
 * Seedance upstreams only take public URLs. A local file is uploaded to the
 * gateway's temporary media relay once and replaced with its signed URL; the
 * MCP server never forwards a local path.
 */
async function resolveSeedanceMediaValue(value, mediaType, model) {
  if (typeof value !== 'string' || !value) throw new Error('media must be a non-empty string');
  if (value.startsWith('asset_')) throw new Error('Seedance does not accept H3 asset IDs; use a URL or a local file');
  if (isRemoteMedia(value)) return value;
  return (await client.uploadTemporaryMedia(value, mediaType, model)).url;
}

async function resolveSeedanceMediaList(values, mediaType, model) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error('media list must be an array');
  const out = [];
  for (const value of values) out.push(await resolveSeedanceMediaValue(value, mediaType, model));
  return out;
}

const QUALITY_ENUM = ['low', 'medium', 'high'];

/** 各家上游对"成功"的叫法不统一，全部归一到这里。 */
const DONE_OK = new Set(['success', 'succeeded', 'completed']);

/**
 * 生图作业登记表(仅内存)。
 *
 * 为什么图片也要异步:网关的 /v1/images/generations 是同步接口，但实测生图
 * 要 1–5 分钟(慢的渠道均值 288 秒)，而 **MCP 客户端自己的工具超时通常只有
 * 60 秒** —— 同步阻塞必然在客户端侧先断。更糟的是断开不会取消上游:实测客户
 * 端 180 秒放弃后，网关依然跑完并照扣了 ¥0.12。
 *
 * 所以这里先给一个短窗口等它自然完成(多数模型够用)，超时就把 fetch 留在
 * 后台继续跑、返回 job_id 让 agent 去轮询。请求只发一次，不会重复计费。
 *
 * 进程重启会丢作业 —— 可接受，重启意味着 agent 会话本身也没了。
 */
const jobs = new Map();
const FAST_WINDOW_MS = 50_000;
const JOB_TTL_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startImageJob(path, body) {
  const id = `img-${Math.random().toString(36).slice(2, 10)}`;
  const rec = { status: 'running', startedAt: Date.now() };
  rec.promise = client
    .submitSync(path, body)
    .then((res) => { rec.status = 'done'; rec.result = res; })
    .catch((e) => { rec.status = 'error'; rec.error = String(e?.message ?? e); });
  jobs.set(id, rec);

  pruneJobs();
  return { id, rec };
}

// 完成结果保留到 TTL，允许先查状态再下载；查询时也清理，避免过期结果仍可读。
function pruneJobs() {
  for (const [id, rec] of jobs) {
    if (rec.status !== 'running' && Date.now() - rec.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** 从同步生图响应里取 URL;拿不到 URL(返回 b64)时不塞进上下文。 */
function syncImageUrls(res) {
  return (res?.data ?? []).map((d) => d?.url).filter((u) => typeof u === 'string');
}

const modelList = (m) =>
  Object.entries(m)
    .map(([id, s]) => `${id} (${s.note})`)
    .join('; ');

const TOOLS = [
  {
    name: 'wanapis_generate_image',
    description:
      'Generate an image with WanAPIs. Returns image URLs directly if it finishes quickly, ' +
      'otherwise a job_id to poll with wanapis_check_task (generation can take 1-5 minutes). ' +
      'Image 2.5 returns an async task_id; quality and resolution are independent and default to low/1k/1 image. ' +
      'Midjourney returns 4 images per call (its 2x2 grid, split). ' +
      `Models: ${modelList(IMAGE_MODELS)}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate.' },
        model: { type: 'string', enum: Object.keys(IMAGE_MODELS), default: 'gpt-image-2' },
        quality: {
          type: 'string',
          enum: [...QUALITY_ENUM, 'xhigh', 'max'],
          description: 'Image 2.5: native quality, default low; resolution is independent. Other models: low/medium/high mapped to resolution, default medium.',
        },
        aspect: { type: 'string', description: 'Aspect ratio, e.g. 1:1, 16:9, 9:16.' },
        size: { type: 'string', description: 'Image 2.5 only: native size/aspect; do not conflict with aspect.' },
        resolution: { type: 'string', enum: ['1k', '2k', '4k'], description: 'Image 2.5 only: independent resolution, default 1k.' },
        count: { type: 'integer', minimum: 1, description: 'Image 2.5 image count, default 1. Other models accept only 1.' },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Image URLs for image-to-image.',
        },
      },
      additionalProperties: false,
      required: ['prompt'],
    },
  },
  {
    name: 'wanapis_generate_video',
    description:
      'Start a video generation. Returns a task_id immediately — video takes ~100s, ' +
      'so poll wanapis_check_task until status is completed. ' +
      'MiniMax H3 defaults to 4 seconds, 768P, 9:16, fast_mode=false and IR enabled; use resolution instead of quality. ' +
      'H3 accepts up to 9 images (reference/first/last frame), 3 reference videos and 3 audio clips; ' +
      'local file paths are uploaded automatically (H3 as opaque assets, Seedance as a temporary signed URL). ' +
      `Models: ${modelList(VIDEO_MODELS)}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string', enum: Object.keys(VIDEO_MODELS), default: 'seedance-2.0' },
        quality: { type: 'string', enum: QUALITY_ENUM, description: 'Legacy models only, default medium. For H3 use resolution.' },
        seconds: { type: 'number', description: 'Legacy default 5. H3 default 4; integer 4–30, or 4–15 at 2K.' },
        aspect: { type: 'string', description: 'e.g. 16:9, 9:16, 1:1; H3 alias for ratio.' },
        ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], description: 'H3 only; default 9:16.' },
        resolution: { type: 'string', enum: ['480p', '768P', '1080p', '2K'], description: 'H3 only; default 768P.' },
        fast_mode: { type: 'boolean', description: 'H3 priority mode, default false; doubles the video fee.' },
        context_ir_enabled: { type: 'boolean', description: 'H3 IR, default true; adds a per-request fee.' },
        generate_audio: { type: 'boolean', description: 'Seedance: generate a synchronized audio track (upstream default true).' },
        return_last_frame: { type: 'boolean', description: 'Seedance: include the last frame URL in the result.' },
        seed: { type: 'integer', minimum: 0, description: 'Seedance: randomness seed.' },
        image_url: { type: 'string', description: 'Legacy single opening-frame/reference image URL. Use reference_images for multiple inputs.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'H3/Seedance reference images. Both accept URL/data/local path; H3 also accepts asset_id. Up to 9 images including frames.' },
        first_frame: { type: 'string', description: 'H3/Seedance explicit first-frame image (URL/data/local path).' },
        last_frame: { type: 'string', description: 'H3/Seedance explicit last-frame image (URL/data/local path).' },
        reference_videos: { type: 'array', items: { type: 'string' }, description: 'H3/Seedance reference videos (URL/local path; H3 also accepts data/asset_id). Up to 3.' },
        reference_audio: { type: 'array', items: { type: 'string' }, description: 'H3/Seedance reference audio (URL/local path; H3 also accepts data/asset_id). Up to 3.' },
      },
      additionalProperties: false,
      required: ['prompt'],
    },
  },
  {
    name: 'wanapis_upload_media',
    description:
      'Upload one local image, video or audio file for H3 or Seedance. ' +
      'H3 returns an opaque asset_id that can be reused; Seedance returns a temporary signed public URL (valid for a few hours). ' +
      'Uploading is free and does not create a generation task.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local file path.' },
        media_type: { type: 'string', enum: ['image', 'video', 'audio'] },
        model: { type: 'string', description: 'Target model; default minimax-h3. Use a seedance-* model to get a temporary public URL instead of asset_id.' },
        binding_asset_id: { type: 'string', description: 'H3 only: optional existing asset_id whose channel/credential this upload should reuse.' },
      },
      additionalProperties: false,
      required: ['path', 'media_type'],
    },
  },
  {
    name: 'wanapis_regenerate_video',
    description:
      'Create a 2K regeneration from one of your successful 768P MiniMax H3 source tasks. ' +
      'mode=source uses the source task directly when the account/channel enables it. ' +
      'mode=content requires the original final prompt and every original reference material, exactly as submitted; ' +
      'local paths are uploaded automatically. Regeneration is a new paid task; the original generation remains billed.',
    inputSchema: {
      type: 'object',
      properties: {
        source_task_id: { type: 'string', description: 'Your public WanAPIs task ID of a successful 768P minimax-h3 original.' },
        mode: { type: 'string', enum: ['source', 'content'], default: 'content' },
        prompt: { type: 'string', description: 'content mode only: the original final prompt.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'content mode: the original reference images.' },
        first_frame: { type: 'string' }, last_frame: { type: 'string' },
        reference_videos: { type: 'array', items: { type: 'string' } },
        reference_audio: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
      required: ['source_task_id'],
    },
  },
  {
    name: 'wanapis_optimize_prompt',
    description:
      'Create a standalone H3 prompt-optimization task. The result is text, not a video; ' +
      'poll wanapis_check_task with kind="prompt". It is a separate paid request. ' +
      'When using the returned prompt for a video, set context_ir_enabled=false to avoid a second IR charge.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        seconds: { type: 'number', description: 'Planned video duration 4–15, default 4.' },
        ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], description: 'Planned video ratio, default 9:16.' },
      },
      additionalProperties: false,
      required: ['prompt'],
    },
  },
  {
    name: 'wanapis_check_task',
    description:
      'Check an async generation task. Returns status, progress, billing (reserved/charged/refunded CNY), ' +
      'the real cost once settled, and media URLs or prompt text when done. ' +
      'IMPORTANT: media URLs require your WanAPIs key — opening one in a browser returns 401, ' +
      'so do not hand the raw URL to a user. Pass save_dir to download the files locally instead. ' +
      'H3 billing may remain pending_usage after the result succeeds; the reserved amount is not the final charge. ' +
      'URLs also stop working once the upstream result expires (~24h).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video', 'prompt'], default: 'video' },
        save_dir: {
          type: 'string',
          description:
            'Directory to download finished media into. Use this to give the user a real file — ' +
            'the URLs alone are not shareable.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'wanapis_estimate_cost',
    description:
      'Estimate a generation budget using public live pricing and an assumed group multiplier. ' +
      'This does not determine your key\'s billing route or final charge. Image 2.5 estimates are tier precharges. ' +
      'H3 with reference media returns a reservation upper bound (reference-video seconds are reserved before verified usage).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        quality: { type: 'string', enum: [...QUALITY_ENUM, 'xhigh', 'max'], description: 'Image 2.5 native quality (default low); legacy models low/medium/high (default medium); omit for H3.' },
        resolution: { type: 'string', description: 'Image 2.5: 1k/2k/4k. H3: 480p/768P/1080p/2K.' },
        seconds: { type: 'number', description: 'Video only; H3 defaults to 4.' },
        count: { type: 'integer', minimum: 1, description: 'Number of images, default 1.' },
        aspect: { type: 'string' }, size: { type: 'string' }, ratio: { type: 'string' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'H3 images/frames for the reservation estimate; URLs or asset IDs. Image 2.5 references can increase actual usage.' },
        first_frame: { type: 'string' }, last_frame: { type: 'string' },
        reference_videos: { type: 'array', items: { type: 'string' }, description: 'H3 reference videos; the estimate reserves the protocol input upper bound.' },
        reference_audio: { type: 'array', items: { type: 'string' }, description: 'H3 reference audio; no material fee.' },
        image_url: { type: 'string', description: 'Legacy single image; H3 sends one input_reference object.' },
        fast_mode: { type: 'boolean', description: 'H3 only, default false.' },
        context_ir_enabled: { type: 'boolean', description: 'H3 only, default true.' },
        group_ratio: { type: 'number', minimum: 0, description: 'Budget assumption only; default 1. Does not change the generation group or billing.' },
      },
      additionalProperties: false,
      required: ['model'],
    },
  },
  {
    name: 'wanapis_list_models',
    description: 'List public catalog models with verified MCP adapters, native options and live pricing. Public visibility does not prove your key\'s permissions or operational availability.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['image', 'video', 'all'], default: 'all' } },
    },
  },
];

// 低层 Server 只验证 tools/call 信封，不会执行工具声明的 inputSchema。
const schemaValidator = new AjvJsonSchemaValidator();
const inputValidators = new Map(TOOLS.map((tool) => [tool.name, schemaValidator.getValidator(tool.inputSchema)]));

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({
  content: [{ type: 'text', text: JSON.stringify({ error: String(msg) }, null, 2) }],
  isError: true,
});

async function loadCatalog() {
  return parseCatalog(await client.pricing());
}

const server = new Server(
  { name: 'wanapis-mcp', version: '0.1.3' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    const validate = inputValidators.get(name);
    if (!validate) return fail(`unknown tool: ${name}`);
    const validation = validate(a);
    if (!validation.valid) return fail(`invalid arguments: ${validation.errorMessage}`);
    pruneJobs();

    if (name === 'wanapis_generate_image') {
      const model = a.model ?? 'gpt-image-2';
      const body = buildImageBody(model, {
        prompt: a.prompt,
        quality: a.quality, resolution: a.resolution, count: a.count, size: a.size,
        aspect: a.aspect, referenceImages: a.reference_images,
      });
      const path = submitPath('image', model);
      if (IMAGE_MODELS[model]?.async) {
        const { taskId, raw } = await client.submit(path, body);
        if (!taskId) return fail(`no task_id in response: ${JSON.stringify(raw).slice(0, 300)}`);
        return ok({
          task_id: taskId,
          status: 'submitted',
          next: 'poll wanapis_check_task with kind="image"',
        });
      }
      const { id, rec } = startImageJob(path, body);
      await Promise.race([rec.promise, sleep(FAST_WINDOW_MS)]);

      if (rec.status === 'error') return fail(rec.error);
      if (rec.status === 'running') {
        return ok({
          job_id: id,
          status: 'running',
          note: `still generating after ${FAST_WINDOW_MS / 1000}s; it keeps running in the background`,
          next: `poll wanapis_check_task with task_id="${id}"`,
        });
      }

      const urls = syncImageUrls(rec.result);
      jobs.delete(id);
      if (!urls.length) {
        return ok({
          note: 'model returned inline data rather than URLs; omitted to protect context',
          raw_keys: Object.keys(rec.result ?? {}),
        });
      }
      return ok({ images: urls });
    }

    if (name === 'wanapis_generate_video') {
      const model = a.model ?? 'seedance-2.0';
      let options = {
        prompt: a.prompt,
        quality: a.quality, seconds: a.seconds, resolution: a.resolution,
        ratio: a.ratio, aspect: a.aspect, imageUrl: a.image_url,
        fast_mode: a.fast_mode, context_ir_enabled: a.context_ir_enabled,
      };
      if (VIDEO_MODELS[model]?.family === 'h3') {
        const state = {};
        const referenceImages = await resolveMediaList(a.reference_images, 'image', state);
        const firstFrame = a.first_frame === undefined ? undefined : await resolveMediaValue(a.first_frame, 'image', state);
        const lastFrame = a.last_frame === undefined ? undefined : await resolveMediaValue(a.last_frame, 'image', state);
        const referenceVideos = await resolveMediaList(a.reference_videos, 'video', state);
        const referenceAudio = await resolveMediaList(a.reference_audio, 'audio', state);
        let imageUrl = a.image_url;
        if (imageUrl !== undefined) {
          if (imageUrl.startsWith('asset_')) {
            referenceImages.unshift(imageUrl);
            imageUrl = undefined;
          } else if (!isRemoteMedia(imageUrl)) {
            referenceImages.unshift(await resolveMediaValue(imageUrl, 'image', state));
            imageUrl = undefined;
          }
        }
        options = {
          ...options, imageUrl,
          ...(referenceImages.length ? { referenceImages } : {}),
          ...(firstFrame ? { firstFrame } : {}),
          ...(lastFrame ? { lastFrame } : {}),
          ...(referenceVideos.length ? { referenceVideos } : {}),
          ...(referenceAudio.length ? { referenceAudio } : {}),
        };
      } else if (model.startsWith('seedance-')) {
        const referenceImages = await resolveSeedanceMediaList(a.reference_images, 'image', model);
        const referenceVideos = await resolveSeedanceMediaList(a.reference_videos, 'video', model);
        const referenceAudio = await resolveSeedanceMediaList(a.reference_audio, 'audio', model);
        const firstFrame = a.first_frame === undefined ? undefined : await resolveSeedanceMediaValue(a.first_frame, 'image', model);
        const lastFrame = a.last_frame === undefined ? undefined : await resolveSeedanceMediaValue(a.last_frame, 'image', model);
        const imageUrl = a.image_url === undefined ? undefined : await resolveSeedanceMediaValue(a.image_url, 'image', model);
        options = {
          ...options,
          imageUrl,
          ...(referenceImages !== undefined ? { referenceImages } : {}),
          ...(firstFrame !== undefined ? { firstFrame } : {}),
          ...(lastFrame !== undefined ? { lastFrame } : {}),
          ...(referenceVideos !== undefined ? { referenceVideos } : {}),
          ...(referenceAudio !== undefined ? { referenceAudio } : {}),
          ...(a.generate_audio !== undefined ? { generateAudio: a.generate_audio } : {}),
          ...(a.return_last_frame !== undefined ? { returnLastFrame: a.return_last_frame } : {}),
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
        };
      }
      const body = buildVideoBody(model, options);
      const { taskId, raw } = await client.submit(submitPath('video', model), body);
      if (!taskId) return fail(`no task_id in response: ${JSON.stringify(raw).slice(0, 300)}`);
      return ok({
        task_id: taskId,
        status: 'submitted',
        note: VIDEO_MODELS[model]?.family === 'h3'
          ? 'H3 reserves the maximum input allowance before submission; successful usage settles lower and refunds the difference. Reference-video metering may keep billing pending_usage.'
          : 'video usually takes 60-150s',
        next: 'poll wanapis_check_task with kind="video"',
      });
    }

    if (name === 'wanapis_upload_media') {
      const targetModel = a.model ?? 'minimax-h3';
      if (targetModel === 'minimax-h3') {
        const asset = await client.uploadAsset(a.path, a.media_type, a.binding_asset_id);
        return ok({
          asset_id: asset.id,
          media_type: asset.media_type,
          status: asset.status,
          bytes: asset.bytes,
          note: 'Reuse this asset_id in reference_images/reference_videos/reference_audio. Uploading is free.',
        });
      }
      if (targetModel.startsWith('seedance-')) {
        if (a.binding_asset_id) return fail('binding_asset_id is H3-only');
        const media = await client.uploadTemporaryMedia(a.path, a.media_type, targetModel);
        return ok({
          url: media.url,
          media_type: media.media_type,
          bytes: media.bytes,
          expires_at: media.expires_at,
          note: 'Pass this URL in reference_images/reference_videos/reference_audio. It expires automatically; upload again for a new generation after expiry.',
        });
      }
      return fail('model must be minimax-h3 or a seedance-* model');
    }

    if (name === 'wanapis_regenerate_video') {
      const state = {};
      const referenceImages = await resolveMediaList(a.reference_images, 'image', state);
      const firstFrame = a.first_frame === undefined ? undefined : await resolveMediaValue(a.first_frame, 'image', state);
      const lastFrame = a.last_frame === undefined ? undefined : await resolveMediaValue(a.last_frame, 'image', state);
      const referenceVideos = await resolveMediaList(a.reference_videos, 'video', state);
      const referenceAudio = await resolveMediaList(a.reference_audio, 'audio', state);
      const body = buildRegenerationBody({
        mode: a.mode ?? 'content',
        prompt: a.prompt,
        ...(referenceImages.length ? { referenceImages } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(referenceVideos.length ? { referenceVideos } : {}),
        ...(referenceAudio.length ? { referenceAudio } : {}),
      });
      const { taskId, raw } = await client.submitRegeneration(a.source_task_id, body);
      if (!taskId) return fail(`no task_id in response: ${JSON.stringify(raw).slice(0, 300)}`);
      return ok({
        task_id: taskId,
        status: 'submitted',
        mode: a.mode ?? 'content',
        note: 'Regeneration is a new paid 2K task; the original generation remains billed. Content mode requires the original final prompt and every original reference material. Billing may remain pending_usage until usage is verified.',
        next: 'poll wanapis_check_task with kind="video"',
      });
    }

    if (name === 'wanapis_optimize_prompt') {
      const body = buildPromptOptimizationBody({ prompt: a.prompt, seconds: a.seconds, ratio: a.ratio });
      const { taskId, raw } = await client.submitPromptOptimization(body);
      if (!taskId) return fail(`no task_id in response: ${JSON.stringify(raw).slice(0, 300)}`);
      return ok({
        task_id: taskId,
        status: 'submitted',
        object: 'prompt_optimization',
        note: 'Text task, not a video. Poll wanapis_check_task with kind="prompt". This is a separate paid request.',
        next: 'poll wanapis_check_task with kind="prompt"',
      });
    }

    if (name === 'wanapis_check_task') {
      // 没有 id 就直说。否则 undefined 会被拼进 URL 打给上游，换回一个
      // 看着像服务端故障的 "task_not_exist"，把排查带偏。
      if (typeof a.task_id !== 'string' || !a.task_id) {
        return fail('task_id is required — use the task_id or job_id returned by the generate tool');
      }

      // 本地生图作业:同步接口没有 task_id，所以用自己发的 img-xxx 代号。
      if (a.task_id.startsWith('img-')) {
        const rec = jobs.get(a.task_id);
        if (!rec) return fail(`unknown job ${a.task_id} (expired, or the server restarted)`);
        if (rec.status === 'running') {
          return ok({
            status: 'running',
            elapsed_s: Math.round((Date.now() - rec.startedAt) / 1000),
            note: 'image generation typically takes 1-5 minutes',
          });
        }
        if (rec.status === 'error') { jobs.delete(a.task_id); return fail(rec.error); }
        const urls = syncImageUrls(rec.result);
        let saved;
        if (a.save_dir && urls.length) {
          saved = [];
          for (const [i, url] of urls.entries()) {
            const base = urls.length > 1 ? `${a.task_id}-${i + 1}` : a.task_id;
            try { saved.push(await client.download(url, a.save_dir, base)); }
            catch (e) { saved.push({ url, error: String(e?.message ?? e) }); }
          }
        }
        return ok({ status: 'success', images: urls, saved });
      }

      if (a.kind === 'prompt') {
        const payload = await client.fetchTask('prompt', a.task_id);
        const st = taskStatus(payload);
        return ok({
          ...st,
          text: payload?.result?.text ?? st.text ?? null,
          note: st.billing?.status === 'pending_usage'
            ? 'The prompt text is available, but billing is still awaiting verified usage.'
            : undefined,
        });
      }

      const payload = await client.fetchTask(a.kind ?? 'video', a.task_id);
      const st = taskStatus(payload);
      const urls = extractMediaUrls(payload);

      // 只在任务真的成功后才下载 —— 失败/进行中的 result_url 取回来是错误页。
      let saved;
      if (a.save_dir && urls.length && DONE_OK.has(st.status)) {
        saved = [];
        for (const [i, url] of urls.entries()) {
          const base = urls.length > 1 ? `${a.task_id}-${i + 1}` : a.task_id;
          try {
            saved.push(await client.download(url, a.save_dir, base));
          } catch (e) {
            saved.push({ url, error: String(e.message ?? e) });
          }
        }
      }

      return ok({
        ...st,
        media: urls,
        saved,
        media_note: urls.length
          ? 'URLs need the WanAPIs key (browser access returns 401) and expire with the upstream result. Pass save_dir to download.'
          : undefined,
      });
    }

    if (name === 'wanapis_estimate_cost') {
      const options = {
        ...a,
        imageUrl: a.image_url,
        referenceImages: a.reference_images,
        firstFrame: a.first_frame,
        lastFrame: a.last_frame,
        referenceVideos: a.reference_videos,
        referenceAudio: a.reference_audio,
      };
      normalizeEstimateOptions(a.model, options);
      return ok(estimateCost(await loadCatalog(), a.model, options));
    }

    if (name === 'wanapis_list_models') {
      const catalog = await loadCatalog();
      return ok({
        models: listCatalogModels(catalog, a.kind ?? 'all'), pricing_version: catalog.pricing_version,
        group_ratio: catalog.group_ratio,
        note: 'Public catalog intersected with verified adapters; key permissions and channel availability are checked by the gateway when submitting.',
      });
    }

    return fail(`unknown tool: ${name}`);
  } catch (e) {
    return fail(e?.message ?? e);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
