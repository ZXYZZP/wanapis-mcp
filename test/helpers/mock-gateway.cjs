// Tests launch the real stdio server with this preload. Every HTTP request is
// handled here; unexpected requests fail instead of reaching a paid endpoint.
const realSetTimeout = global.setTimeout;
const realNow = Date.now;
let clockOffset = 0;
let imageResolve;
let imageReject;
let downloadAttempts = 0;
let uploadCount = 0;

Date.now = () => realNow() + clockOffset;
global.setTimeout = (callback, delay, ...args) => {
  if (delay === 50_000) return realSetTimeout(callback, 0, ...args);
  const timer = realSetTimeout(callback, delay, ...args);
  // Client request timeouts must not keep the test child alive after shutdown.
  if (delay === 420_000) timer.unref();
  return timer;
};

process.on('message', (message) => {
  if (message.type === 'flush-requests') {
    // The IPC channel preserves ordering with prior http-request messages.
    process.send({ type: 'requests-flushed' });
  }
  if (message.type === 'finish-image') {
    if (message.error) imageReject(new Error(message.error));
    else imageResolve(new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] })));
    process.send({ type: 'image-finished' });
  }
  if (message.type === 'advance-clock') {
    clockOffset += message.ms;
    process.send({ type: 'clock-advanced' });
  }
});

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  let recordedBody = options.body;
  if (recordedBody instanceof FormData) {
    const fields = {};
    for (const [key, value] of recordedBody.entries()) {
      fields[key] = typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size };
    }
    recordedBody = fields;
  }
  process.send({ type: 'http-request', path: url.pathname, method: options.method || 'GET', body: recordedBody, headers: Object.fromEntries(new Headers(options.headers)) });
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/videos/assets') {
    if (!(options.body instanceof FormData)) throw new Error('upload fixture expected multipart');
    uploadCount += 1;
    return new Response(JSON.stringify({ id: `asset_offline_${uploadCount}`, media_type: options.body.get('media_type'), status: 'ready', bytes: 12 }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/media') {
    if (!(options.body instanceof FormData)) throw new Error('temporary media fixture expected multipart');
    uploadCount += 1;
    return new Response(JSON.stringify({
      id: `media_offline_${uploadCount}`,
      url: `https://offline.example/v1/media/media_offline_${uploadCount}?expires=9999999999&signature=offline`,
      media_type: options.body.get('media_type'),
      bytes: options.body.get('file')?.size ?? 0,
      expires_at: 9999999999,
    }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/videos/video-offline-1/regenerations') {
    return new Response(JSON.stringify({ id: 'regen-offline-1', task_id: 'regen-offline-1', status: 'queued', operation: 'regenerate' }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/videos/prompt-optimizations') {
    return new Response(JSON.stringify({ id: 'ir-offline-1', object: 'prompt_optimization', status: 'queued' }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/videos/prompt-optimizations/ir-offline-1') {
    return new Response(JSON.stringify({ id: 'ir-offline-1', object: 'prompt_optimization', status: 'completed',
      result: { text: 'Improved offline prompt' },
      billing: { status: 'settled', currency: 'CNY', quota_per_unit: 500000, reserved_quota: 32500, charged_quota: 32500, refunded_quota: 0 } }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/images/generations') {
    return new Promise((resolve, reject) => { imageResolve = resolve; imageReject = reject; });
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/video/generations') {
    if (JSON.parse(options.body).model === 'minimax-h3') return new Response(JSON.stringify({ id: 'video-offline-1', task_id: 'video-offline-1', status: 'queued' }));
    return new Response(JSON.stringify({ data: { task_id: 'video-offline-1' } }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/api/pricing') {
    if (process.env.CATALOG_SCENARIO === 'http-error') return new Response('{"message":"offline pricing unavailable"}', { status: 503 });
    if (process.env.CATALOG_SCENARIO === 'malformed') return new Response('{"success":true,"data":{}}');
    if (process.env.CATALOG_SCENARIO === 'empty') return new Response('{"success":true,"data":[]}');
    if (process.env.CATALOG_SCENARIO === 'abort') throw new Error('offline catalog connection failed');
    const catalog = structuredClone(require('./catalog.cjs'));
    if (process.env.CATALOG_SCENARIO === 'missing-h3-meta') delete catalog.data.find((r) => r.model_name === 'minimax-h3').video_pricing_meta;
    return new Response(JSON.stringify(catalog));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/video/generations/video-offline-1') {
    const pending = process.env.TASK_PENDING === '1';
    return new Response(JSON.stringify({ code: 'success', data: {
      task_id: 'video-offline-1', status: process.env.TASK_FAILURE === '1' ? 'FAILURE' : 'SUCCESS',
      fail_reason: process.env.TASK_FAILURE === '1' ? 'offline render failed' : '', quota: 266500,
      result_url: 'https://offline.example/v1/videos/video-offline-1/content',
      billing: { status: pending ? 'pending_usage' : 'settled', currency: 'CNY', quota_per_unit: 500000,
        reserved_quota: 266500, ...(pending ? {} : { charged_quota: 266500 }), refunded_quota: 0 },
    } }));
  }
  if (url.href === 'https://offline.example/v1/videos/video-offline-1/content') {
    return new Response('offline video fixture', { headers: { 'Content-Type': 'video/mp4' } });
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/images/tasks') {
    return new Response(JSON.stringify({ data: [{ task_id: 'image-offline-1' }] }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/images/tasks/image-offline-1') {
    // Public API docs: task.data preserves the entire upstream code/data envelope.
    return new Response(JSON.stringify({
      code: 'success',
      data: {
        task_id: 'image-offline-1', status: 'SUCCESS', progress: '100%',
        data: {
          code: 200,
          data: {
            status: 'completed',
            result: { images: [{ url: ['https://cdn.example/image.png'] }] },
          },
        },
      },
    }));
  }
  if (url.href === 'https://cdn.example/image.png') {
    downloadAttempts += 1;
    if (process.env.FAIL_FIRST_DOWNLOAD === '1' && downloadAttempts === 1) {
      throw new TypeError('fixture download interrupted');
    }
    return new Response(Buffer.from('offline image fixture'), { headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error(`Unexpected offline-test request: ${url.origin}${url.pathname}`);
};
