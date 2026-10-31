// Tests launch the real stdio server with this preload. Every HTTP request is
// handled here; unexpected requests fail instead of reaching a paid endpoint.
const realSetTimeout = global.setTimeout;
const realNow = Date.now;
let clockOffset = 0;
let imageResolve;
let imageReject;
let downloadAttempts = 0;

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
  process.send({ type: 'http-request', path: url.pathname, method: options.method || 'GET', body: options.body });
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/images/generations') {
    return new Promise((resolve, reject) => { imageResolve = resolve; imageReject = reject; });
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/v1/video/generations') {
    return new Response(JSON.stringify({ data: { task_id: 'video-offline-1' } }));
  }
  if (url.origin === 'https://offline.example' && url.pathname === '/api/pricing') {
    return new Response(JSON.stringify({ data: [] }));
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
