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
  submitPath,
} from './models.js';
import { parseCatalog, listCatalogModels } from './catalog.js';
import { estimateCost, normalizeEstimateOptions } from './pricing.js';

const client = new WanApisClient({
  apiKey: process.env.WANAPIS_API_KEY,
  baseUrl: process.env.WANAPIS_BASE_URL,
});

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
        image_url: { type: 'string', description: 'First-frame image URL. H3 sends one input_reference object.' },
      },
      additionalProperties: false,
      required: ['prompt'],
    },
  },
  {
    name: 'wanapis_check_task',
    description:
      'Check an async generation task. Returns status, progress, the real cost once billed, ' +
      'and media URLs when done. ' +
      'IMPORTANT: media URLs require your WanAPIs key — opening one in a browser returns 401, ' +
      'so do not hand the raw URL to a user. Pass save_dir to download the files locally instead. ' +
      'URLs also stop working once the upstream result expires (~24h).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video'], default: 'video' },
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
      'This does not determine your key\'s billing route or final charge. Image 2.5 estimates are tier precharges; actual usage can cost more.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        quality: { type: 'string', enum: [...QUALITY_ENUM, 'xhigh', 'max'], description: 'Image 2.5 native quality (default low); legacy models low/medium/high (default medium); omit for H3.' },
        resolution: { type: 'string', description: 'Image 2.5: 1k/2k/4k. H3: 480p/768P/1080p/2K.' },
        seconds: { type: 'number', description: 'Video only; H3 defaults to 4.' },
        count: { type: 'integer', minimum: 1, description: 'Number of images, default 1.' },
        aspect: { type: 'string' }, size: { type: 'string' }, ratio: { type: 'string' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Image references can increase actual usage above the tier precharge.' },
        image_url: { type: 'string', description: 'First-frame image; H3 supports at most one.' },
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
  { name: 'wanapis-mcp', version: '0.1.2' },
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
      const body = buildVideoBody(model, {
        prompt: a.prompt,
        quality: a.quality, seconds: a.seconds, resolution: a.resolution,
        ratio: a.ratio, aspect: a.aspect, imageUrl: a.image_url,
        fast_mode: a.fast_mode, context_ir_enabled: a.context_ir_enabled,
      });
      const { taskId, raw } = await client.submit(submitPath('video', model), body);
      if (!taskId) return fail(`no task_id in response: ${JSON.stringify(raw).slice(0, 300)}`);
      return ok({
        task_id: taskId,
        status: 'submitted',
        note: 'video usually takes 60-150s',
        next: 'poll wanapis_check_task with kind="video"',
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
      const options = { ...a, imageUrl: a.image_url, referenceImages: a.reference_images };
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
