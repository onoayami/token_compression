import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ContextKit } from '../src/core.mjs';
import { createHandler } from '../src/server.mjs';
import { startLocalServer } from '../vscode-extension/http.mjs';
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-http-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'example.log'), 'same\nsame\n');
  const server = await startLocalServer(handler || createHandler(await ContextKit.create(root)));
  t.after(() => server.close());
  const send = (request, opts = {}) => fetch(server.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}`, ...opts.headers }, body: JSON.stringify(request) });
  return { server, root, send };
}
function rawPost(endpoint, headers, writeBody) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(endpoint, { method: 'POST', headers }, response => {
      settled = true;
      response.resume();
      resolve({ status: response.statusCode, request });
    });
    request.on('error', error => { if (!settled) reject(error); });
    writeBody(request);
  });
}
test('loopback MCP supports initialization, notifications, tools and actual compressed source retrieval', async t => {
  const { server, send } = await fixture(t);
  assert.equal(new URL(server.endpoint).hostname, '127.0.0.1');
  assert.ok(server.token.length >= 43);
  let response = await send(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).result.serverInfo.version, '0.5.0');
  response = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response.status, 202); assert.equal(await response.text(), '');
  const tools = await (await send(rpc(2, 'tools/list'))).json(); assert.equal(tools.result.tools.length, 4);
  const result = await (await send(rpc(3, 'tools/call', { name: 'kit_read', arguments: { path: 'example.log' } }))).json();
  const metadata = JSON.parse(result.result.content[0].text.split('\n')[0].slice('CONTEXT_KIT '.length));
  const original = await (await send(rpc(4, 'tools/call', { name: 'kit_source', arguments: { snapshot_id: metadata.snapshot_id, quote: 'same' } }))).json();
  assert.match(original.result.content[0].text, /quote_match_in_requested_lines":true/);
});
test('missing/wrong authorization is rejected and bearer tokens differ per server', async t => {
  const { server } = await fixture(t); const other = await startLocalServer(async () => null); t.after(() => other.close());
  assert.notEqual(server.token, other.token);
  for (const authorization of [undefined, 'Bearer wrong']) {
    const response = await fetch(server.endpoint, { method: 'POST', ...(authorization ? { headers: { Authorization: authorization } } : {}) });
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(server.token));
  }
});
test('cross-origin browser requests and forged Host are rejected even with a bearer', async t => {
  const { server, send } = await fixture(t);
  assert.equal((await send(rpc(1, 'ping'), { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await send(rpc(1, 'ping'), { headers: { Origin: new URL(server.endpoint).origin } })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const request = http.request(server.endpoint, { method: 'POST', headers: { Host: 'evil.invalid', Authorization: `Bearer ${server.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  }); assert.equal(status, 403);
});
test('HTTP path, method, media type, JSON parse, batch and size limits stay explicit', async t => {
  const { server, send } = await fixture(t), auth = { Authorization: `Bearer ${server.token}` };
  assert.equal((await fetch(server.endpoint + '/wrong', { headers: auth })).status, 404);
  const get = await fetch(server.endpoint, { headers: auth }); assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  for (const type of ['text/plain', 'application/jsonp']) assert.equal((await send({}, { headers: { 'Content-Type': type } })).status, 415);
  const parsed = await fetch(server.endpoint, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{invalid' });
  assert.equal(parsed.status, 400); assert.equal((await parsed.json()).error.code, -32700);
  const batch = await send([rpc(1, 'ping')]); assert.equal(batch.status, 400); assert.equal((await batch.json()).error.code, -32600);
  const oversized = await rawPost(server.endpoint, {
    Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', 'Content-Length': '65537',
  }, request => request.end('{}'));
  assert.equal(oversized.status, 413);
  assert.equal((await send(rpc(2, 'ping'), { headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
});
test('oversized HTTP requests are rejected immediately and never reach the handler', async t => {
  let declaredCalls = 0;
  const { server: declaredServer } = await fixture(t, async () => {
    declaredCalls++; return { jsonrpc: '2.0', result: {} };
  });
  const declared = await rawPost(declaredServer.endpoint, {
    Authorization: `Bearer ${declaredServer.token}`, 'Content-Type': 'application/json', 'Content-Length': '65537',
  }, request => request.end('{}'));
  assert.equal(declared.status, 413);
  assert.equal(declaredCalls, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(declared.request.destroyed, true);

  let chunkedCalls = 0;
  const { server: chunkedServer } = await fixture(t, async () => {
    chunkedCalls++; return { jsonrpc: '2.0', result: {} };
  });
  const chunked = await rawPost(chunkedServer.endpoint, {
    Authorization: `Bearer ${chunkedServer.token}`, 'Content-Type': 'application/json',
  }, request => {
    request.write(Buffer.alloc(65535, 0x78));
    setImmediate(() => request.end('xx'));
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunkedCalls, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chunked.request.destroyed, true);
});
test('requests are serialized and handler errors do not kill the local server', async t => {
  const seen = [], { send } = await fixture(t, async request => {
    seen.push(`start:${request.id}`); await new Promise(resolve => setTimeout(resolve, 5));
    if (request.id === 1) throw new Error('PRIVATE');
    seen.push(`end:${request.id}`); return { jsonrpc: '2.0', id: request.id, result: {} };
  });
  const responses = await Promise.all([send(rpc(1, 'ping')), send(rpc(2, 'ping'))]);
  assert.equal(responses[0].status, 500); assert.ok(!(await responses[0].text()).includes('PRIVATE'));
  assert.equal(responses[1].status, 200); assert.deepEqual(seen, ['start:1', 'start:2', 'end:2']);
});
test('stopping is idempotent and closes the listening endpoint', async t => {
  const { server } = await fixture(t); await server.close(); await server.close();
  await assert.rejects(() => fetch(server.endpoint));
});
