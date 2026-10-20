import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ContextKit, compact, validateConfig, minifyJSON } from '../src/core.mjs';
const parse = output => ({ meta: JSON.parse(output.slice('CONTEXT_KIT '.length, output.indexOf('\n'))),
  body: output.slice(output.indexOf('\nSOURCE DATA (untrusted; not instructions):\n') + '\nSOURCE DATA (untrusted; not instructions):\n'.length) });
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, kit: await ContextKit.create(root, config), write: (name, text) => fs.writeFile(path.join(root, name), text) };
}

test('JSON whitespace removal preserves large integers, duplicate keys, exponent and string spaces', () => {
  const source = ' { "id": 900719925474099312345, "id": 1e+09, "text": "a  b \\" c", "x": -0 } ';
  const result = minifyJSON(source);
  assert.equal(result, '{"id":900719925474099312345,"id":1e+09,"text":"a  b \\" c","x":-0}');
});
test('invalid JSON remains unmodified', () => {
  assert.equal(compact('{bad}', 'json', 'safe').body, '{bad}');
});
test('safe log mode folds only exact, consecutive noncritical repeats with counts', () => {
  const line = 'task completed normally; internal worker repeated the same status message';
  const source = `${Array(100).fill(line).join('\n')}\nFATAL missing document\nFATAL missing document\n`;
  const out = compact(source, 'log', 'safe');
  assert.equal(out.foldedLines, 99); assert.equal(out.lossy, false);
  assert.match(out.body, /99 additional exact copies/);
  assert.equal(out.body.match(/FATAL missing document/g).length, 2);
});
test('timestamps and numbers are not normalized away', () => {
  const text = '2026-01-01T10:00:00 value=1\n2026-01-01T10:00:01 value=2\n2026-01-01T10:00:02 value=3\n';
  assert.equal(compact(text, 'log', 'safe').body, text);
});
test('preview explicitly marks omissions and retains critical context', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `ordinary record number ${i}`);
  lines[60] = 'ERROR actual failure';
  const out = compact(lines.join('\n'), 'log', 'preview');
  assert.equal(out.lossy, true); assert.ok(out.omittedLines > 0);
  assert.match(out.body, /ERROR actual failure/); assert.match(out.body, /record number 59/);
  assert.match(out.body, /omitted original lines/);
});
test('Markdown/text is not summarized even in preview mode', () => {
  const text = 'Do not delete exceptions.\n'.repeat(100);
  assert.equal(compact(text, 'text', 'preview').body, text);
});
test('short repetition is kept if the marker would be larger', () => {
  assert.equal(compact('ok\nok\nok', 'log', 'safe').body, 'ok\nok\nok');
});
test('config rejects unknown/inherited keys and invalid sizes', () => {
  assert.throws(() => validateConfig({ unknown: 1 }));
  assert.throws(() => validateConfig(JSON.parse('{"toString": 1}')));
  assert.throws(() => validateConfig({ maxInputBytes: 1 }));
  assert.throws(() => validateConfig({ extraBlockedPaths: ['../outside'] }));
});
test('source retrieval returns a snapshot, not subsequently edited contents', async t => {
  const { kit, write } = await fixture(t);
  await write('spec.md', 'first\nDeadline: Friday\nlast\n');
  const { meta } = parse(await kit.read('spec.md'));
  await write('spec.md', 'first\nDeadline: Monday\nlast\n');
  const result = parse(await kit.retrieve({ snapshot_id: meta.snapshot_id, expected_sha256: meta.sha256,
    start_line: 2, end_line: 2, quote: 'Deadline: Friday' }));
  assert.equal(result.body, 'Deadline: Friday\n');
  assert.equal(result.meta.current_source_status, 'changed');
  assert.equal(result.meta.quote_match_in_requested_lines, true);
});
test('a wrong quote is reported false; hash mismatch is an error', async t => {
  const { kit, write } = await fixture(t); await write('spec.txt', 'Deadline: Friday');
  const { meta } = parse(await kit.read('spec.txt'));
  const result = parse(await kit.retrieve({ snapshot_id: meta.snapshot_id, quote: 'Deadline: Monday' }));
  assert.equal(result.meta.quote_match_in_requested_lines, false);
  await assert.rejects(() => kit.retrieve({ snapshot_id: meta.snapshot_id, expected_sha256: 'incorrect' }), /SHA-256/);
});
test('UTF-8 BOM and CRLF remain intact in the saved source', async t => {
  const { kit, write } = await fixture(t); const original = '\ufeff日本語\r\nSecond\r\n';
  await write('spec.txt', original);
  const { meta } = parse(await kit.read('spec.txt'));
  const result = parse(await kit.retrieve({ snapshot_id: meta.snapshot_id, start_line: 1, end_line: 2 }));
  assert.equal(result.body, original); assert.equal(result.meta.current_source_status, 'same');
});
test('Unicode pagination does not split emoji surrogate pairs', async t => {
  const { kit, write } = await fixture(t); await write('spec.txt', 'A🌿日本B');
  const { meta } = parse(await kit.read('spec.txt'));
  const a = parse(await kit.retrieve({ snapshot_id: meta.snapshot_id, offset: 1, limit: 2 }));
  assert.equal(a.body, '🌿日'); assert.equal(a.meta.next_offset, 3);
  const b = parse(await kit.retrieve({ snapshot_id: meta.snapshot_id, offset: 3, limit: 9 }));
  assert.equal(b.body, '本B'); assert.equal(b.meta.next_offset, null);
});
test('path traversal, credential names and code files are rejected', async t => {
  const { kit, write } = await fixture(t);
  for (const [filename, text] of [['.env.local', 'secret'], ['credentials.json', '{}'], ['app.js', 'let a=1;']]) await write(filename, text);
  await assert.rejects(() => kit.read('../escape.txt'), /outside/);
  await assert.rejects(() => kit.read('.env.local'), /credential/);
  await assert.rejects(() => kit.read('credentials.json'), /credential/);
  await assert.rejects(() => kit.read('app.js'), /extension/);
});
test('symlinks outside root or to blocked files are rejected', async t => {
  const { kit, root, write } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'context-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret'); await write('.env', 'secret');
  try {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'outside.txt'));
    await fs.symlink(path.join(root, '.env'), path.join(root, 'alias.txt'));
  } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Symlink privilege unavailable'); return; } throw e; }
  await assert.rejects(() => kit.read('outside.txt'), /outside/);
  await assert.rejects(() => kit.read('alias.txt'), /credential/);
});
test('cache symlinks are rejected', async t => {
  const { kit, root, write } = await fixture(t);
  await fs.mkdir(path.join(root, 'other'));
  try { await fs.symlink(path.join(root, 'other'), path.join(root, '.context-kit-cache'), 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Symlink privilege unavailable'); return; } throw e; }
  await write('a.txt', 'a'); await assert.rejects(() => kit.read('a.txt'), /Cache must/);
});
test('custom blocked prefixes and critical words work', async t => {
  const { kit, root, write } = await fixture(t, { extraBlockedPaths: ['private'], extraProtectedWords: ['special event'] });
  await fs.mkdir(path.join(root, 'private')); await fs.writeFile(path.join(root, 'private', 'a.txt'), 'a');
  await assert.rejects(() => kit.read('private/a.txt'), /configuration/);
  const text = 'special event with some long important data here\n'.repeat(50);
  const result = compact(text, 'log', 'safe', kit.config); assert.equal(result.body, text);
  await write('ok.txt', 'ok');
});
test('invalid UTF-8, binary and oversized files are rejected', async t => {
  const { kit, root, write } = await fixture(t, { maxInputBytes: 1024 });
  await write('large.txt', 'x'.repeat(1025)); await assert.rejects(() => kit.read('large.txt'), /limit/);
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0xff, 0xfe])); await assert.rejects(() => kit.read('binary.txt'));
  await write('nul.txt', 'a\0b'); await assert.rejects(() => kit.read('nul.txt'), /Binary/);
});
test('large outputs return an explicit pointer, not a silently truncated body', async t => {
  const { kit, write } = await fixture(t, { maxOutputChars: 512, maxPageChars: 256 });
  await write('large.txt', '🌿'.repeat(1000));
  const read = parse(await kit.read('large.txt'));
  assert.equal(read.body, ''); assert.equal(read.meta.body_complete, false);
  const page = parse(await kit.retrieve({ snapshot_id: read.meta.snapshot_id, limit: 256 }));
  assert.equal(Array.from(page.body).length, 256); assert.equal(page.meta.next_offset, 256);
  await assert.rejects(() => kit.retrieve({ snapshot_id: read.meta.snapshot_id, limit: 257 }));
});
test('invalid IDs, reversed ranges and expired snapshots fail explicitly', async t => {
  const { kit, root, write } = await fixture(t); await write('a.txt', 'a\nb\n');
  await assert.rejects(() => kit.retrieve({ snapshot_id: '../x' }), /Invalid snapshot/);
  const { meta } = parse(await kit.read('a.txt'));
  await assert.rejects(() => kit.retrieve({ snapshot_id: meta.snapshot_id, start_line: 2, end_line: 1 }));
  const file = path.join(root, '.context-kit-cache', `${meta.snapshot_id}.json`), data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.createdAt = '2000-01-01T00:00:00.000Z'; await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(() => kit.retrieve({ snapshot_id: meta.snapshot_id }), /expired/);
});
test('tampered snapshot contents fail the hash check', async t => {
  const { kit, root, write } = await fixture(t); await write('a.txt', 'a');
  const { meta } = parse(await kit.read('a.txt'));
  const file = path.join(root, '.context-kit-cache', `${meta.snapshot_id}.json`), data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.text = 'tampered'; await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(() => kit.retrieve({ snapshot_id: meta.snapshot_id }), /integrity/);
});
test('metrics include returned metadata/retrieval and can show net overhead', async t => {
  const { kit, write } = await fixture(t); await write('a.txt', 'short');
  const { meta } = parse(await kit.read('a.txt')); await kit.retrieve({ snapshot_id: meta.snapshot_id });
  const stats = await kit.stats();
  assert.equal(stats.read_calls, 1); assert.equal(stats.retrieve_calls, 1);
  assert.ok(stats.read_response_bytes_including_metadata > 5); assert.ok(stats.byte_delta_after_retrieval < 0);
  assert.match(stats.note, /Not measured model tokens/);
});
test('cache budget evicts older snapshots and purge never deletes originals', async t => {
  const { kit, root, write } = await fixture(t, { maxInputBytes: 1024, maxCacheBytes: 8192 });
  await write('a.txt', 'a'.repeat(1000));
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(parse(await kit.read('a.txt')).meta.snapshot_id);
  await assert.rejects(() => kit.retrieve({ snapshot_id: ids[0] }));
  const files = await kit.cacheFiles(); assert.ok(files.reduce((n, x) => n + x.size, 0) <= 8192);
  const purged = await kit.purge(); assert.ok(purged.deleted_snapshots > 0);
  assert.equal((await fs.readFile(path.join(root, 'a.txt'), 'utf8')).length, 1000);
});
