import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ContextKit } from '../src/core.mjs';
import { formatStats } from '../src/report.mjs';
import { createHandler } from '../src/server.mjs';
const run = promisify(execFile);
const metadata = text => JSON.parse(text.split('\n')[0].slice('CONTEXT_KIT '.length));
async function setup(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-stats-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, kit: await ContextKit.create(root, config), write: (file, text) => fs.writeFile(path.join(root, file), text) };
}
test('empty statistics are unmeasured, not invented 0 or 100 percent', async t => {
  const { kit } = await setup(t); const stats = await kit.stats();
  assert.equal(stats.content.reduction_percent_by_bytes, null);
  assert.equal(stats.content.reduction_percent_by_characters, null);
  assert.equal(stats.returned_text.reference_reduction_percent_vs_original_full_text, null);
  assert.match(formatStats(stats), /未計測/);
});
test('per-read statistics measure full transformed content and Unicode characters', async t => {
  const { kit, write } = await setup(t);
  const text = '正常です🌿 repeated status with a sufficiently long identical message\n'.repeat(100);
  await write('a.log', text);
  const meta = metadata(await kit.read('a.log'));
  assert.equal(meta.original_bytes, Buffer.byteLength(text));
  assert.equal(meta.original_characters, Array.from(text).length);
  assert.ok(meta.compacted_content_bytes < meta.original_bytes);
  assert.ok(meta.content_byte_reduction_percent > 0);
  const stats = await kit.stats();
  assert.equal(stats.content.original_bytes, meta.original_bytes);
  assert.equal(stats.content.compacted_bytes, meta.compacted_content_bytes);
  assert.equal(stats.content.reduction_percent_by_bytes, meta.content_byte_reduction_percent);
});
test('source lookup counts against reference byte difference, never content compression', async t => {
  const { kit, write } = await setup(t);
  await write('a.log', 'long repeated successful notification for synthetic testing\n'.repeat(100));
  const meta = metadata(await kit.read('a.log'));
  const before = await kit.stats();
  await kit.retrieve({ snapshot_id: meta.snapshot_id, start_line: 1, end_line: 10 });
  const after = await kit.stats();
  assert.deepEqual(after.content, before.content);
  assert.ok(after.returned_text.retrieval_response_bytes_including_metadata > 0);
  assert.ok(after.returned_text.reference_byte_delta_vs_original_full_text < before.returned_text.reference_byte_delta_vs_original_full_text);
});
test('omitting a large body for paging is not reported as 100 percent compression', async t => {
  const { kit, write } = await setup(t, { maxOutputChars: 512 });
  await write('a.txt', 'z'.repeat(2000));
  const meta = metadata(await kit.read('a.txt')); const stats = await kit.stats();
  assert.equal(meta.body_complete, false);
  assert.equal(stats.content.reduction_percent_by_bytes, 0);
  assert.equal(stats.content.compacted_bytes, 2000);
  assert.equal(stats.coverage.body_omitted_for_paging_calls, 1);
});
test('short input overhead is shown as a negative reference difference', async t => {
  const { kit, write } = await setup(t); await write('a.txt', 'a'); await kit.read('a.txt');
  const stats = await kit.stats();
  assert.equal(stats.content.reduction_percent_by_bytes, 0);
  assert.ok(stats.returned_text.reference_reduction_percent_vs_original_full_text < 0);
  assert.equal(stats.model_tokens.status, 'not_measured');
  assert.equal(stats.copilot_billing.status, 'not_measured');
  assert.match(formatStats(stats), /マイナス/);
});
test('legacy rows are excluded from content rates and clearly counted', async t => {
  const { kit, root } = await setup(t); await kit.ensureCache();
  await fs.writeFile(path.join(root, '.context-kit-cache', 'metrics.jsonl'), JSON.stringify({ type: 'read', inputBytes: 100, responseBytes: 50 }) + '\n');
  const stats = await kit.stats();
  assert.equal(stats.content.legacy_unmeasured_read_calls, 1);
  assert.equal(stats.content.measured_read_calls, 0);
  assert.equal(stats.content.reduction_percent_by_bytes, null);
  assert.equal(stats.returned_text.reference_byte_delta_vs_original_full_text, 50);
});
test('lossy previews are identified instead of implying quality preservation', async t => {
  const { kit, write } = await setup(t);
  await write('a.log', Array.from({ length: 150 }, (_, i) => `ordinary synthetic notification ${i}`).join('\n'));
  await kit.read('a.log', 'preview'); const stats = await kit.stats();
  assert.equal(stats.coverage.lossy_preview_calls, 1);
  assert.ok(stats.coverage.omitted_original_lines_in_preview > 0);
});
test('kit_stats is callable from MCP and reports empty history honestly', async t => {
  const { kit } = await setup(t); const handle = createHandler(kit);
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const reply = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kit_stats', arguments: {} } });
  const stats = JSON.parse(reply.result.content[0].text);
  assert.equal(stats.read_calls, 0); assert.equal(stats.model_tokens.reduction_percent, null);
});
test('CLI supports readable text and JSON statistics and rejects unsupported formats', async t => {
  const { root } = await setup(t);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const text = await run(process.execPath, [cli, 'stats', '--root', root, '--format', 'text']);
  assert.match(text.stdout, /資料そのもの/); assert.match(text.stdout, /Copilot全体のトークン数/);
  const json = await run(process.execPath, [cli, 'stats', '--root', root, '--format', 'json']);
  assert.equal(JSON.parse(json.stdout).read_calls, 0);
  await assert.rejects(() => run(process.execPath, [cli, 'stats', '--root', root, '--format', 'html']), /stats format/);
});
test('trial configuration and all four slash prompts are included without auto-approval', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'mcp.json'), 'utf8'));
  assert.equal(config.servers['context-kit'].command, 'node');
  assert.equal(config.servers['context-kit'].args[0], '${workspaceFolder}/src/server.mjs');
  assert.ok(!JSON.stringify(config).toLowerCase().includes('autoapprove'));
  const names = (await fs.readdir(path.join(root, 'integration', 'prompts'))).filter(n => n.endsWith('.prompt.md'));
  assert.equal(names.length, 4);
  for (const name of names) assert.equal(await fs.readFile(path.join(root, '.github', 'prompts', name), 'utf8'), await fs.readFile(path.join(root, 'integration', 'prompts', name), 'utf8'));
});
