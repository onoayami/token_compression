import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ContextKit } from '../src/core.mjs';
import { createHandler, TOOLS } from '../src/server.mjs';
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-rpc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'spec.txt'), 'Deadline: Friday\n');
  return { root, handle: createHandler(await ContextKit.create(root)) };
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = handle => handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
test('MCP initialization, tool listing, ping and notification behavior', async t => {
  const { handle } = await setup(t);
  assert.equal((await handle(rpc(0, 'tools/list'))).error.code, -32000);
  assert.equal((await initialize(handle)).result.protocolVersion, '2025-06-18');
  assert.equal((await handle(rpc(2, 'tools/list'))).result.tools.length, 4);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await handle(rpc(3, 'ping'))).result, {});
});
test('MCP tool reads, retrieval, and failures stay structured', async t => {
  const { handle } = await setup(t); await initialize(handle);
  const read = await handle(rpc(2, 'tools/call', { name: 'kit_read', arguments: { path: 'spec.txt' } }));
  const text = read.result.content[0].text, meta = JSON.parse(text.split('\n')[0].slice('CONTEXT_KIT '.length));
  const result = await handle(rpc(3, 'tools/call', { name: 'kit_source', arguments: { snapshot_id: meta.snapshot_id, quote: 'Friday' } }));
  assert.match(result.result.content[0].text, /quote_match_in_requested_lines":true/);
  const bad = await handle(rpc(4, 'tools/call', { name: 'kit_read', arguments: { path: '../a.txt' } }));
  assert.equal(bad.result.isError, true);
});
test('MCP tool errors do not expose absolute paths', async t => {
  const { handle, root } = await setup(t); await initialize(handle);
  const original = console.error; const errors = [];
  console.error = message => errors.push(message);
  t.after(() => { console.error = original; });
  const result = await handle(rpc(5, 'tools/call', { name: 'kit_read', arguments: { path: 'missing.txt' } }));
  const text = result.result.content[0].text;
  assert.equal(text, 'FILE_NOT_FOUND: File not found');
  assert.ok(!text.includes(root)); assert.ok(!text.includes(os.tmpdir()));
  assert.ok(errors.some(message => message.includes(path.join(root, 'missing.txt'))));
});
test('MCP unknown methods, tools, parameters and invalid types are rejected', async t => {
  const { handle } = await setup(t); await initialize(handle);
  assert.equal((await handle(rpc(2, 'unknown'))).error.code, -32601);
  assert.equal((await handle(rpc(3, 'tools/call', { name: 'no' }))).error.code, -32602);
  assert.equal((await handle(rpc(4, 'tools/call', { name: 'kit_read', arguments: {} }))).error.code, -32602);
  assert.equal((await handle(rpc(5, 'tools/call', { name: 'kit_read', arguments: { path: 'spec.txt', extra: true } }))).error.code, -32602);
  assert.equal((await handle(rpc(6, 'tools/call', { name: 'kit_read', arguments: { path: 'spec.txt', mode: null } }))).error.code, -32602);
  assert.equal((await handle({ id: 1, method: 'ping' })).error.code, -32600);
});
test('tool schemas explicitly describe side effects and only four tools are exposed', () => {
  assert.equal(TOOLS.length, 4);
  for (const tool of TOOLS) { assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.inputSchema.additionalProperties, false); }
});
test('real stdio process speaks newline-delimited JSON-RPC with clean stdout', async t => {
  const { root } = await setup(t);
  const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [server, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const timer = setTimeout(() => child.kill(), 8000); t.after(() => clearTimeout(timer));
  child.stdin.end([
    rpc(1, 'initialize', { protocolVersion: '2025-03-26' }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc(2, 'tools/list'),
    rpc(3, 'tools/call', { name: 'kit_read', arguments: { path: 'spec.txt' } }),
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(await done, 0, stderr); assert.equal(stderr, '');
  const replies = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3]);
  assert.match(replies[2].result.content[0].text, /Deadline: Friday/);
});
