import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
const MAX_BYTES = 65536;
export async function startLocalServer(handle) {
  const token = randomBytes(32).toString('base64url');
  let endpoint, queue = Promise.resolve();
  const respond = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body === null ? '' : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { respond(res, 401, { error: 'Unauthorized' }); req.resume(); return; }
    if (req.headers.host !== new URL(endpoint).host || (req.headers.origin && req.headers.origin !== new URL(endpoint).origin)) { respond(res, 403, { error: 'Host or origin rejected' }); req.resume(); return; }
    if (req.url !== '/mcp') { respond(res, 404, { error: 'Not found' }); req.resume(); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); respond(res, 405, { error: 'Stateless JSON POST only; no standalone SSE stream' }); req.resume(); return; }
    if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { respond(res, 415, { error: 'application/json required' }); req.resume(); return; }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      respond(res, 413, { error: 'Request too large' }); req.destroy(); return;
    }
    let size = 0, oversized = false; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) oversized = true;
        if (!oversized) chunks.push(chunk);
      }
      if (oversized) { respond(res, 413, { error: 'Request too large' }); req.destroy(); return; }
      let request;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      if (Array.isArray(request)) { respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } }); return; }
      const operation = queue.then(() => handle(request)); queue = operation.catch(() => {});
      const result = await operation;
      respond(res, result ? 200 : 202, result);
    } catch { if (!res.headersSent) respond(res, 500, { error: 'Local MCP error' }); else res.end(); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000; server.maxConnections = 10;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  let stopped = false;
  return { endpoint, token, close: async () => {
    if (stopped) return; stopped = true;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  } };
}
