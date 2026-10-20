import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ContextKit } from '../src/core.mjs';
import { ContextRegistry, validateCatalog, mergeRanges } from '../src/context.mjs';
import { createHandler } from '../src/server.mjs';
const exec = promisify(execFile);
const meta = text => JSON.parse(text.split('\n')[0].slice('CONTEXT_KIT '.length));
const entry = (overrides = {}) => ({ id: 'glossary', title: '用語集', kind: 'glossary', path: 'project-context/glossary.md', status: 'draft', version: '1', scope: '全体', ...overrides });
async function setup(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project-context'));
  const catalog = { schemaVersion: 1, documents: [entry()] };
  const writeCatalog = async value => fs.writeFile(path.join(root, 'project-context/catalog.json'), JSON.stringify(value));
  await writeCatalog(catalog);
  const write = async text => fs.writeFile(path.join(root, 'project-context/glossary.md'), text);
  await write('# Glossary\nThis is PRIVATE-BODY-MARKER, not metadata.\n');
  const kit = await ContextKit.create(root, config);
  const list = async () => JSON.parse(await kit.context());
  return { root, kit, catalog, writeCatalog, write, list };
}

test('catalog validates declared status/version/scope without automatically formalizing templates', () => {
  const catalog = validateCatalog({ schemaVersion: 1, documents: [entry()] });
  assert.equal(catalog.documents[0].status, 'draft');
  assert.equal(validateCatalog({ schemaVersion: 1, documents: [entry({ status: 'official', version: '2026-10-approved' })] }).documents[0].status, 'official');
  assert.throws(() => validateCatalog({ schemaVersion: 1, documents: [entry({ status: 'official', version: '未設定' })] }), /explicit version/);
});
test('catalog rejects duplicate IDs/paths, unknown fields/status and invalid formats', () => {
  for (const documents of [[entry(), entry()], [entry(), entry({ id: 'other' })], [entry({ extra: true })], [entry({ status: 'confirmed-by-ai' })], [entry({ path: 'app.js' })]]) {
    assert.throws(() => validateCatalog({ schemaVersion: 1, documents }));
  }
  assert.throws(() => validateCatalog({ schemaVersion: 2, documents: [] }));
});
test('catalog rejects traversal, absolute paths and invalid official version', () => {
  for (const filename of ['../outside.md', '/tmp/outside.md', 'C:\\outside.md', 'docs/../x.md', 'docs//x.md']) {
    assert.throws(() => validateCatalog({ schemaVersion: 1, documents: [entry({ path: filename })] }));
  }
});
test('range merging preserves gaps and combines overlapping/adjacent intervals', () => {
  assert.deepEqual(mergeRanges([[10, 20], [0, 5], [4, 10], [30, 32], [7, 7]]), [[0, 20], [30, 32]]);
});
test('concurrent context output updates preserve every document record', async t => {
  const { root, kit } = await setup(t);
  const registry = new ContextRegistry(kit);
  const source = text => ({ text, source: 'project-context/glossary.md', sha256: 'a'.repeat(64), id: randomUUID(), createdAt: new Date().toISOString() });
  const docs = Array.from({ length: 10 }, (_, i) => entry({ id: `doc-${i}`, title: `Doc ${i}` }));
  await Promise.all(docs.map((doc, i) => registry.noteOutput(source(`body-${i}`), doc, { start: 0, end: 6, hasBody: true })));
  const ledger = await registry.readLedger();
  assert.equal(ledger.records.length, 10);
  assert.deepEqual(new Set(ledger.records.map(record => record.docId)), new Set(docs.map(doc => doc.id)));
});
test('context output update racing purge leaves a valid ledger or a cleanly purged state', async t => {
  const { kit } = await setup(t);
  const registry = new ContextRegistry(kit);
  const doc = entry();
  const source = { text: 'body', source: doc.path, sha256: 'b'.repeat(64), id: randomUUID(), createdAt: new Date().toISOString() };
  await Promise.all([
    registry.noteOutput(source, doc, { start: 0, end: 4, hasBody: true }),
    kit.purge(),
  ]);
  const ledger = await registry.readLedger();
  assert.equal(ledger.version, 1);
  assert.ok(Array.isArray(ledger.records));
});
test('listing hashes locally but never sends body or marks it as output', async t => {
  const { kit, list } = await setup(t); const overview = await list();
  assert.equal(overview.documents[0].output_state, 'registered');
  assert.equal(overview.documents[0].last_snapshot_id, null);
  assert.ok(!JSON.stringify(overview).includes('PRIVATE-BODY-MARKER'));
  const stats = await kit.stats();
  assert.equal(stats.read_calls, 0); assert.equal(stats.context_index_calls, 1);
  assert.ok(stats.returned_text.context_index_response_bytes > 0);
});
test('explicit read by ID includes declared metadata and full-output record', async t => {
  const { kit, list } = await setup(t);
  const result = await kit.context({ action: 'read', id: 'glossary' });
  const m = meta(result);
  assert.equal(m.context_document.id, 'glossary'); assert.equal(m.context_document.status, 'draft');
  assert.equal(m.context_output_tracking, 'recorded'); assert.match(result, /PRIVATE-BODY-MARKER/);
  const doc = (await list()).documents[0];
  assert.equal(doc.output_state, 'full'); assert.equal(doc.snapshot_available, true); assert.equal(doc.needs_recheck, false);
});
test('reading a registered path directly also records its body output', async t => {
  const { kit, list } = await setup(t); await kit.read('project-context/glossary.md');
  assert.equal((await list()).documents[0].output_state, 'full');
});
test('unregistered file reads do not mark registered documents as read', async t => {
  const { root, kit, list } = await setup(t); await fs.writeFile(path.join(root, 'other.md'), 'other');
  await kit.read('other.md'); assert.equal((await list()).documents[0].output_state, 'registered');
});
test('changed source is recheck-required until explicitly reread', async t => {
  const { kit, list, write } = await setup(t); await kit.context({ action: 'read', id: 'glossary' });
  await write('# Changed\nDifferent requirement.\n');
  let doc = (await list()).documents[0];
  assert.equal(doc.output_state, 'recheck'); assert.equal(doc.content_changed_since_output, true);
  await kit.context({ action: 'read', id: 'glossary' });
  doc = (await list()).documents[0]; assert.equal(doc.output_state, 'full'); assert.equal(doc.content_changed_since_output, false);
});
test('version/status/scope changes require recheck even with unchanged file bytes', async t => {
  const { kit, list, catalog, writeCatalog } = await setup(t); await kit.context({ action: 'read', id: 'glossary' });
  catalog.documents[0] = entry({ status: 'official', version: '2', scope: '管理画面のみ' }); await writeCatalog(catalog);
  const doc = (await list()).documents[0];
  assert.equal(doc.content_changed_since_output, false); assert.equal(doc.registration_changed_since_output, true);
  assert.equal(doc.output_state, 'recheck'); assert.equal(doc.status, 'official');
});
test('pointer-only and partial output are not mislabeled as full, pages can complete coverage', async t => {
  const { kit, list, write } = await setup(t, { maxOutputChars: 512, maxPageChars: 256 });
  await write('a'.repeat(1000)); const m = meta(await kit.context({ action: 'read', id: 'glossary' }));
  assert.equal((await list()).documents[0].output_state, 'pointer_only');
  await kit.retrieve({ snapshot_id: m.snapshot_id, limit: 100 });
  assert.equal((await list()).documents[0].output_state, 'partial');
  for (let offset = 100; offset < 1000; offset += 256) await kit.retrieve({ snapshot_id: m.snapshot_id, offset, limit: 256 });
  assert.equal((await list()).documents[0].output_state, 'full');
});
test('original line ranges with Unicode/CRLF accumulate correct coverage', async t => {
  const { kit, list, write } = await setup(t, { maxOutputChars: 512 });
  const lines = ['日本語🌿'.repeat(200) + '\r\n', 'second\r\n', '終\n']; await write(lines.join(''));
  const m = meta(await kit.context({ action: 'read', id: 'glossary' }));
  await kit.retrieve({ snapshot_id: m.snapshot_id, start_line: 2, end_line: 3 });
  assert.equal((await list()).documents[0].output_state, 'partial');
  await kit.retrieve({ snapshot_id: m.snapshot_id, start_line: 1, end_line: 1 });
  assert.equal((await list()).documents[0].output_state, 'full');
});
test('coverage for different content versions is never merged', async t => {
  const { kit, list, write } = await setup(t, { maxOutputChars: 512, maxPageChars: 256 });
  await write('a'.repeat(1000)); const a = meta(await kit.context({ action: 'read', id: 'glossary' }));
  await kit.retrieve({ snapshot_id: a.snapshot_id, offset: 0, limit: 256 });
  await write('b'.repeat(1000)); const b = meta(await kit.context({ action: 'read', id: 'glossary' }));
  await kit.retrieve({ snapshot_id: b.snapshot_id, offset: 256, limit: 256 });
  assert.equal((await list()).documents[0].output_state, 'partial');
  await kit.retrieve({ snapshot_id: a.snapshot_id, offset: 512, limit: 256 });
  assert.equal((await list()).documents[0].output_state, 'recheck');
});
test('expired or evicted snapshots are flagged, not silently verified', async t => {
  const { kit, root, list } = await setup(t); const m = meta(await kit.context({ action: 'read', id: 'glossary' }));
  const filename = path.join(root, '.context-kit-cache', `${m.snapshot_id}.json`);
  const saved = JSON.parse(await fs.readFile(filename, 'utf8')); saved.createdAt = '2000-01-01T00:00:00Z';
  await fs.writeFile(filename, JSON.stringify(saved));
  let doc = (await list()).documents[0]; assert.equal(doc.snapshot_available, false); assert.equal(doc.output_state, 'recheck');
  await fs.unlink(filename); doc = (await list()).documents[0]; assert.equal(doc.snapshot_available, false);
});
test('purge removes output records but never catalog or registered Markdown', async t => {
  const { kit, root, list } = await setup(t); await kit.context({ action: 'read', id: 'glossary' });
  const result = await kit.purge(); assert.equal(result.deleted_context_output_ledger, true);
  assert.equal((await list()).documents[0].output_state, 'registered');
  assert.match(await fs.readFile(path.join(root, 'project-context/glossary.md'), 'utf8'), /PRIVATE-BODY-MARKER/);
});
test('corrupt output ledger is shown as unknown, never a successful verification', async t => {
  const { kit, root, list } = await setup(t); await kit.ensureCache();
  await fs.writeFile(path.join(root, '.context-kit-cache/context-reads.json'), '{bad');
  assert.equal((await list()).documents[0].output_state, 'tracking_unknown');
  const m = meta(await kit.context({ action: 'read', id: 'glossary' }));
  assert.equal(m.context_output_tracking, 'failed');
});
test('ledger symlinks are not followed or overwritten', async t => {
  const { kit, root } = await setup(t); await kit.ensureCache();
  const target = path.join(root, 'keep.txt'); await fs.writeFile(target, 'keep');
  try { await fs.symlink(target, path.join(root, '.context-kit-cache/context-reads.json')); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Symlink privilege unavailable'); return; } throw e; }
  const m = meta(await kit.context({ action: 'read', id: 'glossary' })); assert.equal(m.context_output_tracking, 'failed');
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});
test('missing registered source is visible without leaking another file', async t => {
  const { root, list, kit } = await setup(t); await fs.unlink(path.join(root, 'project-context/glossary.md'));
  assert.equal((await list()).documents[0].output_state, 'unavailable');
  await assert.rejects(() => kit.context({ action: 'read', id: 'glossary' }));
});
test('source symlinks outside root stay unavailable and cannot be read', async t => {
  const { root, list, kit } = await setup(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-private-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.md'), 'OUTSIDE-SECRET'); await fs.unlink(path.join(root, 'project-context/glossary.md'));
  try { await fs.symlink(path.join(outside, 'outside.md'), path.join(root, 'project-context/glossary.md')); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Symlink privilege unavailable'); return; } throw e; }
  const data = await list(); assert.equal(data.documents[0].source_state, 'unavailable');
  assert.ok(!JSON.stringify(data).includes('OUTSIDE-SECRET'));
  await assert.rejects(() => kit.context({ action: 'read', id: 'glossary' }), /outside/);
});
test('ambiguous aliases do not assign an arbitrary authoritative registration', async t => {
  const { root, kit, catalog, writeCatalog } = await setup(t);
  try { await fs.symlink(path.join(root, 'project-context/glossary.md'), path.join(root, 'alias.md')); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Symlink privilege unavailable'); return; } throw e; }
  catalog.documents.push(entry({ id: 'alias', path: 'alias.md', status: 'archived' })); await writeCatalog(catalog);
  await assert.rejects(() => kit.context({ action: 'read', id: 'glossary' }), /multiple registrations/);
  const m = meta(await kit.read('project-context/glossary.md'));
  assert.equal(m.context_document, undefined); assert.match(m.context_registration_warning, /multiple registrations/);
});
test('metadata listing paginates, unknown IDs and mixed list/read parameters fail', async t => {
  const { kit, catalog, writeCatalog } = await setup(t);
  catalog.documents.push(entry({ id: 'second', path: 'second.md' })); await writeCatalog(catalog);
  const data = JSON.parse(await kit.context({ limit: 1 }));
  assert.equal(data.documents.length, 1); assert.equal(data.next_offset, 1);
  await assert.rejects(() => kit.context({ action: 'read', id: 'unknown' }), /unknown/);
  await assert.rejects(() => kit.context({ action: 'read', id: 'glossary', offset: 0 }), /pagination/);
  await assert.rejects(() => kit.context({ action: 'list', id: 'glossary' }));
  await assert.rejects(() => kit.context({ limit: 21 }));
});
test('empty Markdown can be fully output without inventing content or certainty', async t => {
  const { kit, list, write } = await setup(t); await write('');
  await kit.context({ action: 'read', id: 'glossary' }); const doc = (await list()).documents[0];
  assert.equal(doc.output_state, 'full'); assert.equal(doc.status, 'draft');
});
test('invalid catalog warns on plain reads and fails explicit catalog operations', async t => {
  const { kit, root } = await setup(t);
  await fs.writeFile(path.join(root, 'project-context/catalog.json'), '{bad');
  await assert.rejects(() => kit.context(), /valid JSON/);
  const result = await kit.read('project-context/glossary.md');
  assert.match(meta(result).context_registration_warning, /unavailable/);
  assert.equal(meta(result).context_document, undefined);
});
test('archived documents remain explicit history, not silently relabeled as current', async t => {
  const { kit, catalog, writeCatalog } = await setup(t);
  catalog.documents[0].status = 'archived'; await writeCatalog(catalog);
  assert.equal(meta(await kit.context({ action: 'read', id: 'glossary' })).context_document.status, 'archived');
});
test('absent catalog is reported as unconfigured, not a successful scan', async t => {
  const { kit, root } = await setup(t); await fs.unlink(path.join(root, 'project-context/catalog.json'));
  const data = JSON.parse(await kit.context()); assert.equal(data.configured, false); assert.equal(data.documents.length, 0);
});
test('CLI context list/read and MCP context list/read work without modifying documents', async t => {
  const { root, kit } = await setup(t); const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const shown = await exec(process.execPath, [cli, 'context', '--root', root, '--format', 'text']); assert.match(shown.stdout, /登録のみ/);
  const read = await exec(process.execPath, [cli, 'context-read', 'glossary', '--root', root]); assert.match(read.stdout, /PRIVATE-BODY-MARKER/);
  const handle = createHandler(kit);
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const reply = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kit_context', arguments: {} } });
  assert.equal(JSON.parse(reply.result.content[0].text).documents[0].output_state, 'full');
  const byId = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kit_context', arguments: { action: 'read', id: 'glossary' } } });
  assert.match(byId.result.content[0].text, /PRIVATE-BODY-MARKER/);
  assert.match(await fs.readFile(path.join(root, 'project-context/glossary.md'), 'utf8'), /PRIVATE-BODY-MARKER/);
});
test('registry output overhead is included in the reference comparison, not token savings', async t => {
  const { kit } = await setup(t); await kit.context(); const stats = await kit.stats();
  assert.equal(stats.context_index_calls, 1); assert.ok(stats.returned_text.context_index_response_bytes > 0);
  assert.equal(stats.content.original_bytes, 0); assert.equal(stats.model_tokens.status, 'not_measured');
  assert.ok(stats.byte_delta_after_retrieval < 0);
});
