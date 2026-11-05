// Preload for subprocess CLI tests: every request is handled locally.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args);
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/pricing') {
    if (new Headers(options.headers).has('authorization')) throw new Error('Public catalog leaked Authorization');
    return new Response(JSON.stringify(require('./catalog.cjs')));
  }
  if (url.origin !== 'https://offline.example') throw new Error('Unexpected external request');
  if (options.method === 'POST') {
    if (options.body instanceof FormData) {
      return new Response(JSON.stringify({ id: 'asset_fixture_1', media_type: options.body.get('media_type'), status: 'ready', bytes: 12 }));
    }
    const body = JSON.parse(options.body);
    if (url.pathname === '/v1/videos/prompt-optimizations') return new Response(JSON.stringify({ id: 'ir-fixture', object: 'prompt_optimization', status: 'queued' }));
    if (url.pathname.endsWith('/regenerations')) return new Response(JSON.stringify({ id: 'regen-fixture', task_id: 'regen-fixture', status: 'queued' }));
    if (process.env.EXPECT_BODY && JSON.stringify(body) !== process.env.EXPECT_BODY) {
      throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
    }
    if (body.model === 'minimax-h3') return new Response(JSON.stringify({ id: 'video-fixture', task_id: 'video-fixture', status: 'queued' }));
    return new Response(JSON.stringify({ data: { task_id: 'image-fixture' } }));
  }
  if (url.pathname === '/v1/videos/prompt-optimizations/ir-fixture') return new Response(JSON.stringify({ id: 'ir-fixture', object: 'prompt_optimization', status: 'completed', result: { text: 'Improved CLI prompt' }, billing: { status: 'settled', reserved_quota: 32500, charged_quota: 32500, refunded_quota: 0 } }));
  if (url.pathname === '/v1/video/generations/regen-fixture') return new Response(JSON.stringify({ data: { status: 'SUCCESS', quota: 156000, result_url: 'https://offline.example/regen.mp4', billing: { status: 'pending_usage', reserved_quota: 156000, refunded_quota: 0 } } }));
  if (url.pathname === '/v1/video/generations/video-fixture') return new Response(JSON.stringify({ data: { status: 'SUCCESS', quota: 234000, result_url: 'https://offline.example/result.mp4' } }));
  if (url.pathname === '/v1/images/tasks/image-fixture') return new Response(JSON.stringify({ data: { status: 'SUCCESS', data: { data: { result: { images: [{ url: ['https://cdn.example/image.png'] }] } } } } }));
  throw new Error(`Unexpected offline CLI path: ${url.pathname}`);
};
