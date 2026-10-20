import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CATALOG_PATH = 'project-context/catalog.json';
const LEDGER = 'context-reads.json';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const points = text => Array.from(text).length;
const byteLength = text => Buffer.byteLength(text, 'utf8');
const STATUS_LABEL = { official: '正式（利用者の宣言）', draft: '検討中', archived: '過去版' };
const STATE_LABEL = { registered: '登録のみ・本文未出力', pointer_only: '原文の場所のみ出力・本文未出力',
  partial: '本文の一部を出力した記録あり', full: '本文全体を出力した記録あり',
  recheck: '要再確認', unavailable: '元ファイルを確認できません', tracking_unknown: '出力記録を確認できません' };
const KINDS = ['overview', 'glossary', 'requirements', 'design', 'decisions', 'questions'];
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const normalize = value => value.replaceAll('\\', '/');
const same = (a, b) => normalize(a) === normalize(b);
const fail = message => { throw new Error(`Context catalog: ${message}`); };

function textField(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(`invalid ${name}`);
  return value;
}
export function validateCatalog(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 ||
      Object.keys(input).some(k => !['schemaVersion', 'documents'].includes(k)) ||
      !Array.isArray(input.documents) || input.documents.length > 50) fail('expected schemaVersion 1 and at most 50 documents');
  const ids = new Set(), paths = new Set();
  const documents = input.documents.map(raw => {
    const keys = ['id', 'title', 'kind', 'path', 'status', 'version', 'scope'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(raw, k))) fail('document fields must be id/title/kind/path/status/version/scope');
    if (typeof raw.id !== 'string' || !ID.test(raw.id) || ids.has(raw.id)) fail('invalid or duplicate document id');
    if (!KINDS.includes(raw.kind) || !Object.hasOwn(STATUS_LABEL, raw.status)) fail('invalid kind or status');
    const filename = normalize(textField(raw.path, 'path', 1024));
    if (filename.startsWith('/') || /^[a-z]:/i.test(filename) || filename.split('/').some(s => !s || s === '.' || s === '..') ||
        !filename.toLowerCase().endsWith('.md') || paths.has(filename.toLowerCase())) fail('paths must be unique workspace-relative Markdown files, without dot segments');
    const doc = { id: raw.id, title: textField(raw.title, 'title', 100), kind: raw.kind, path: filename,
      status: raw.status, version: textField(raw.version, 'version', 80), scope: textField(raw.scope, 'scope') };
    if (doc.status === 'official' && ['未設定', '未記入', 'unknown', 'unversioned'].includes(doc.version.trim().toLowerCase())) fail('official documents need an explicit version');
    ids.add(doc.id); paths.add(filename.toLowerCase());
    return doc;
  });
  return { schemaVersion: 1, documents };
}
export const documentFingerprint = doc => hash(JSON.stringify(doc));
export function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => b > a).map(r => [...r]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export class ContextRegistry {
  constructor(kit) { this.kit = kit; }
  async catalog() {
    let text;
    try { ({ text } = await this.kit.localText(CATALOG_PATH, 65536)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return validateCatalog(JSON.parse(text)); }
    catch (e) { if (e.message.startsWith('Context catalog:')) throw e; fail('catalog.json is not valid JSON'); }
  }
  publicDocument(doc) {
    return { ...doc, status_label: STATUS_LABEL[doc.status], metadata_sha256: documentFingerprint(doc),
      authority_notice: 'Status is declared by the user, not verified truth. Newer modification time does not resolve conflicts.' };
  }
  async registration(sourceRelative) {
    const catalog = await this.catalog();
    if (!catalog) return null;
    const sourceActual = await fs.realpath(path.resolve(this.kit.root, sourceRelative));
    const matches = [];
    for (const doc of catalog.documents) {
      try {
        const actual = await this.kit.sourcePath(doc.path);
        if (same(await fs.realpath(actual), sourceActual)) matches.push(doc);
      } catch { /* Unavailable entries are shown in the catalog, not trusted. */ }
    }
    if (matches.length > 1) fail('multiple registrations point to the same source; resolve the ambiguity before assigning authority');
    return matches[0] || null;
  }
  async readLedger() {
    await this.kit.ensureCache();
    const filename = path.join(this.kit.cache, LEDGER);
    let text;
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Invalid context output ledger');
      text = await fs.readFile(filename, 'utf8');
      if (byteLength(text) > 1024 * 1024) throw new Error('Context ledger exceeds size limit');
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, records: [] }; throw e; }
    const data = JSON.parse(text), ids = new Set();
    if (!data || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 50) throw new Error('Invalid context output ledger');
    for (const r of data.records) {
      if (!r || typeof r.docId !== 'string' || !ID.test(r.docId) || ids.has(r.docId) || typeof r.sourcePath !== 'string' ||
          !HEX.test(r.sourceHash) || !HEX.test(r.metadataHash) || !Number.isInteger(r.charCount) || r.charCount < 0 ||
          typeof r.lastSnapshotId !== 'string' || !Number.isFinite(Date.parse(r.lastOutputAt)) ||
          !Array.isArray(r.ranges) || r.ranges.length > 1000 || typeof r.emptyBodyReturned !== 'boolean' ||
          r.ranges.some(x => !Array.isArray(x) || x.length !== 2 || !Number.isInteger(x[0]) || !Number.isInteger(x[1]) || x[0] < 0 || x[1] < x[0] || x[1] > r.charCount)) throw new Error('Invalid context output record');
      ids.add(r.docId);
    }
    return data;
  }
  async writeLedger(data) {
    await this.kit.ensureCache();
    const filename = path.join(this.kit.cache, LEDGER);
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid context output ledger');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const serialized = JSON.stringify(data);
    if (byteLength(serialized) > 1024 * 1024) throw new Error('Context output ledger exceeds size limit; coverage cannot be recorded');
    const temporary = path.join(this.kit.cache, `context-ledger-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, filename);
    } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async noteOutput(source, doc, { start = 0, end = 0, hasBody = false } = {}) {
    if (!doc) return;
    await this.kit.withCacheLock(async () => {
      const ledger = await this.readLedger(), total = points(source.text), fingerprint = documentFingerprint(doc);
      const old = ledger.records.find(r => r.docId === doc.id);
      const compatible = old && old.sourceHash === source.sha256 && old.metadataHash === fingerprint && old.charCount === total;
      let ranges = mergeRanges([...(compatible ? old.ranges : []), ...(hasBody ? [[start, end]] : [])]);
      let coverageLimited = compatible && !!old.coverageLimited;
      if (ranges.length > 1000) { ranges = []; coverageLimited = true; }
      const record = { docId: doc.id, sourcePath: source.source, sourceHash: source.sha256, metadataHash: fingerprint,
        charCount: total, ranges, emptyBodyReturned: (compatible && old.emptyBodyReturned) || (hasBody && total === 0),
        coverageLimited, lastSnapshotId: source.id, lastOutputAt: new Date().toISOString() };
      const records = [...ledger.records.filter(r => r.docId !== doc.id), record].slice(-50);
      await this.writeLedger({ version: 1, records });
    });
  }
  async describe(doc, ledger, trackingError) {
    const { authority_notice, ...publicDoc } = this.publicDocument(doc);
    let sourceState = 'available', currentHash = null;
    try { currentHash = hash((await this.kit.localText(doc.path)).text); }
    catch (e) { sourceState = e.code === 'ENOENT' ? 'missing' : 'unavailable'; }
    const record = ledger.records.find(r => r.docId === doc.id);
    let snapshotAvailable = null, snapshotMatches = null;
    if (record) {
      try {
        const saved = await this.kit.load(record.lastSnapshotId);
        snapshotAvailable = true;
        snapshotMatches = saved.sha256 === record.sourceHash && same(saved.source, record.sourcePath) && points(saved.text) === record.charCount;
      } catch { snapshotAvailable = false; }
    }
    const contentChanged = record && currentHash ? record.sourceHash !== currentHash : null;
    const registrationChanged = record ? record.metadataHash !== publicDoc.metadata_sha256 : null;
    const reasons = [];
    if (trackingError) reasons.push('output_tracking_unavailable');
    if (sourceState !== 'available') reasons.push('source_unavailable');
    if (contentChanged) reasons.push('content_changed');
    if (registrationChanged) reasons.push('registration_changed');
    if (snapshotAvailable === false) reasons.push('snapshot_unavailable');
    if (snapshotMatches === false) reasons.push('snapshot_record_mismatch');
    if (record?.coverageLimited) reasons.push('coverage_tracking_limited');
    const ranges = record ? mergeRanges(record.ranges) : [];
    const full = !!record && !record.coverageLimited && (record.charCount === 0 ? record.emptyBodyReturned : ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === record.charCount);
    let state = !record ? 'registered' : full ? 'full' : ranges.length ? 'partial' : 'pointer_only';
    if (reasons.length) state = trackingError ? 'tracking_unknown' : sourceState !== 'available' ? 'unavailable' : 'recheck';
    return { ...publicDoc, source_state: sourceState, output_state: state, output_state_label: STATE_LABEL[state],
      needs_recheck: reasons.length > 0, recheck_reasons: reasons,
      content_changed_since_output: contentChanged, registration_changed_since_output: registrationChanged,
      last_output_at: record?.lastOutputAt || null, last_snapshot_id: record?.lastSnapshotId || null,
      saved_version_fully_output: record ? full : false, snapshot_available: snapshotAvailable };
  }
  async overview({ offset = 0, limit = 10 } = {}) {
    const catalog = await this.catalog();
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) fail('list offset/limit is invalid');
    if (!catalog) return { configured: false, catalog_path: CATALOG_PATH, total_documents: 0, documents: [], next_offset: null,
      notice: 'No catalog is configured. Copy project-context templates into the workspace or register existing workspace-relative Markdown paths. Bodies are not automatically loaded.' };
    if (offset > catalog.documents.length) fail('offset exceeds document count');
    let ledger = { version: 1, records: [] }, trackingError = null;
    try { ledger = await this.readLedger(); } catch (e) {
      console.error(`Context ledger read failed: ${e.message}`);
      trackingError = 'Context output tracking unavailable';
    }
    const selected = catalog.documents.slice(offset, offset + limit), documents = [];
    for (const doc of selected) documents.push(await this.describe(doc, ledger, trackingError));
    return { configured: true, catalog_path: CATALOG_PATH, total_documents: catalog.documents.length,
      offset, next_offset: offset + selected.length < catalog.documents.length ? offset + selected.length : null,
      documents, ...(trackingError ? { tracking_error: trackingError } : {}),
      policy: 'List sends registration/status metadata only. Local hashing checks changes but does not send Markdown bodies. Output records show prepared tool/CLI output, not proof of AI receipt, understanding or verification. Read selected IDs explicitly; never treat catalog status as proof of truth, resolve conflicts automatically, or infer that no unanswered questions exist from an empty template.' };
  }
  async readById(id) {
    const catalog = await this.catalog();
    if (!catalog) fail('no catalog is configured');
    const doc = catalog.documents.find(d => d.id === id);
    if (!doc) fail('unknown document id');
    const actual = await this.kit.sourcePath(doc.path);
    const registration = await this.registration(path.relative(this.kit.root, actual));
    if (!registration || registration.id !== id) fail('ambiguous or changed registration');
    return this.kit.read(doc.path, 'safe');
  }
}

export function formatContextOverview(data) {
  if (!data.configured) return `共通知識の台帳がありません。${CATALOG_PATH} を設定してください。`;
  const lines = ['共通知識の棚（本文を自動で全部読み込むことはありません）', `登録資料: ${data.total_documents}件`];
  for (const doc of data.documents) {
    lines.push('', `${doc.id}: ${doc.title}`, `  ${doc.status_label} / 版: ${doc.version} / 範囲: ${doc.scope}`,
      `  ${doc.output_state_label}`, `  場所: ${doc.path}`);
    if (doc.recheck_reasons.length) lines.push(`  要確認: ${doc.recheck_reasons.join(', ')}`);
  }
  if (data.next_offset !== null) lines.push('', `続きがあります: --offset ${data.next_offset}`);
  if (data.tracking_error) lines.push('', '出力記録の読み取りに問題があります。確認済みとして扱わないでください。');
  lines.push('', '「出力記録あり」は、AIの理解・内容の正しさ・利用者の承認を保証しません。',
    '正式／検討中／過去版は利用者の宣言です。矛盾は勝手に解消せず、未確認事項に残します。');
  return lines.join('\n');
}
