import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ContextKit } from './core.mjs';
import { validateCatalog } from './context.mjs';
import { stripBOM } from './json.mjs';
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const DOCS = ['overview.md', 'glossary.md', 'requirements.md', 'design/overview.md', 'decisions.md', 'questions.md'];
const PROMPTS = ['context-handoff-save', 'context-handoff-resume', 'context-read', 'context-stats', 'context-overview', 'context-question-propose'];
const REQUIRED_IGNORES = ['.context-kit-cache/', '.context-kit/'];
export async function renameWithRetry(rename, from, to, { attempts = 5, delay = 100 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('ファイルを閉じて再実行してください。', { cause: lastError });
}
function relativeName(name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || /^[a-z]:/i.test(name) || name.includes('\\') || name.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Unsafe setup path');
  return name;
}
async function safeTarget(root, name) {
  const relative = relativeName(name), parts = relative.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const filename = path.join(root, ...parts.slice(0, i));
    try {
      const info = await fs.lstat(filename);
      if (info.isSymbolicLink() || (i < parts.length && !info.isDirectory()) || (i === parts.length && !info.isFile())) throw new Error(`Unsafe existing setup path: ${relative}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return path.join(root, ...parts);
}
async function existingText(root, name, limit = 2 * 1024 * 1024) {
  const filename = await safeTarget(root, name);
  try {
    const info = await fs.stat(filename); if (info.size > limit) throw new Error(`Setup file too large: ${name}`);
    const buffer = await fs.readFile(filename); if (buffer.length > limit) throw new Error(`Setup file too large: ${name}`);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function planSetup({ root, templateRoot, description = '', designPaths = [] }) {
  root = path.resolve(root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Select a local project folder');
  if (typeof description !== 'string' || description.length > 2000 || description.includes('\0')) throw new Error('Project description must be at most 2000 characters');
  if (!Array.isArray(designPaths) || designPaths.length > 10) throw new Error('Choose at most 10 Markdown design files');
  const changes = [], preserved = [], warnings = [];
  const queueMissing = async (relative, text) => {
    if (await existingText(root, relative) === null) changes.push({ path: relative, action: 'create', text });
    else preserved.push(relative);
  };
  for (const doc of DOCS) {
    const relative = `project-context/${doc}`;
    let text = await fs.readFile(path.join(templateRoot, relative), 'utf8');
    if (doc === 'overview.md' && description.trim()) {
      const replaced = text.replace(/## 何を作るか\r?\n未記入/, `## 何を作るか\n${description.trim()}`);
      if (replaced === text) warnings.push('概要テンプレートの説明欄を置換できませんでした。overview.mdを確認してください。');
      text = replaced;
    }
    await queueMissing(relative, text);
  }
  const catalogName = 'project-context/catalog.json';
  const currentCatalog = await existingText(root, catalogName, 65536);
  if (currentCatalog !== null) {
    try { validateCatalog(JSON.parse(stripBOM(currentCatalog))); }
    catch { throw new Error('project-context/catalog.json is invalid JSON; check BOM, trailing commas and UTF-8 encoding'); }
    preserved.push(catalogName);
    if (designPaths.length) warnings.push('既存の台帳は変更しません。追加の設計書は台帳へ別途登録してください。');
    if (description.trim() && preserved.includes('project-context/overview.md')) warnings.push('既存のプロジェクト概要は上書きしていません。');
  } else {
    const catalog = validateCatalog(JSON.parse(stripBOM(await fs.readFile(path.join(templateRoot, catalogName), 'utf8'))));
    if (designPaths.length) {
      const kit = await ContextKit.create(root), selected = [], seen = new Set();
      for (const requested of designPaths) {
        if (typeof requested !== 'string' || !requested.toLowerCase().endsWith('.md')) throw new Error('Choose Markdown (.md) files only');
        const relativeRequested = path.isAbsolute(requested) ? path.relative(root, requested) : requested;
        if (!relativeRequested || relativeRequested.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRequested))
          throw new Error('Design path is outside workspace');
        const actual = await kit.sourcePath(relativeRequested); // Workspace, extension, secret-path and symlink checks.
        const info = await fs.stat(actual);
        if (!info.isFile() || info.size > kit.config.maxInputBytes) throw new Error('Design file must be a regular file within the input byte limit');
        const actualReal = await fs.realpath(actual);
        if (seen.has(actualReal)) continue;
        seen.add(actualReal);
        selected.push(path.relative(kit.realRoot, actualReal).replaceAll(path.sep, '/'));
      }
      if (selected.length) {
        const first = catalog.documents.find(d => d.id === 'design'); first.path = selected[0];
        for (let i = 1; i < selected.length; i++) catalog.documents.push({ ...first, id: `design-${i + 1}`, title: `設計書 ${i + 1}`, path: selected[i] });
      }
    }
    validateCatalog(catalog);
    changes.push({ path: catalogName, action: 'create', text: JSON.stringify(catalog, null, 2) + '\n' });
  }
  for (const name of PROMPTS) {
    const relative = `.github/prompts/${name}.prompt.md`;
    await queueMissing(relative, await fs.readFile(path.join(templateRoot, 'integration', 'prompts', `${name}.prompt.md`), 'utf8'));
  }
  const ignore = await existingText(root, '.gitignore', 65536);
  const lines = ignore === null ? [] : ignore.split(/\r?\n/).map(line => line.trim().replace(/^\//, ''));
  const meaningful = lines.map((line, index) => ({ line, index })).filter(({ line }) => line && !line.startsWith('#'));
  const requiredIndexes = REQUIRED_IGNORES.map(line => meaningful.findLast(item => item.line === line)?.index);
  const lastRequired = Math.max(...requiredIndexes.filter(index => index !== undefined), -1);
  const negationAfter = meaningful.some(({ line, index }) => index > lastRequired && line.startsWith('!'));
  const missing = requiredIndexes.every(index => index !== undefined) && !negationAfter ? [] : REQUIRED_IGNORES;
  if (missing.length) {
    const eol = ignore?.includes('\r\n') ? '\r\n' : '\n';
    const text = (ignore || '') + (ignore && !ignore.endsWith('\n') ? eol : '') + missing.join(eol) + eol;
    changes.push({ path: '.gitignore', action: ignore === null ? 'create' : 'append', text, ...(ignore !== null ? { beforeHash: digest(ignore) } : {}) });
  } else preserved.push('.gitignore');
  const attributes = await existingText(root, '.gitattributes', 65536);
  if (attributes === null) changes.push({ path: '.gitattributes', action: 'create', text: '*.md text eol=lf\n' });
  else preserved.push('.gitattributes');
  const mcp = await existingText(root, '.vscode/mcp.json', 65536);
  if (mcp && /"context-kit"\s*:/.test(mcp)) warnings.push('旧版の context-kit 接続設定があります。拡張版との重複を避けるには、VS CodeのMCP一覧で旧版を停止してください。既存設定は変更しません。');
  return { root, changes, preserved, warnings };
}
export async function applySetup(plan) {
  const root = await fs.realpath(plan.root), created = [], createdDirs = [], updated = [];
  for (const change of plan.changes) {
    const current = await existingText(root, change.path);
    if ((change.action === 'create' && current !== null) || (change.action === 'append' && (current === null || digest(current) !== change.beforeHash))) throw new Error(`Setup target changed; review the plan again: ${change.path}`);
    if (!['create', 'append'].includes(change.action) || (change.action === 'append' && change.path !== '.gitignore')) throw new Error('Unsupported setup operation');
  }
  try {
    for (const change of plan.changes.filter(c => c.action === 'create')) {
      const filename = await safeTarget(root, change.path);
      const missingDirs = [];
      let current = path.dirname(filename);
      while (current !== root) {
        try { await fs.lstat(current); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; missingDirs.push(current); current = path.dirname(current); }
      }
      await fs.mkdir(path.dirname(filename), { recursive: true });
      createdDirs.push(...missingDirs);
      await safeTarget(root, change.path);
      await fs.writeFile(filename, change.text, { flag: 'wx', mode: 0o600 }); created.push(change);
    }
    for (const change of plan.changes.filter(c => c.action === 'append')) {
      const filename = await safeTarget(root, change.path), current = await existingText(root, change.path);
      if (current === null || digest(current) !== change.beforeHash) throw new Error(`Setup target changed: ${change.path}`);
      const temporary = path.join(root, `.contextkit-setup-${randomUUID()}.tmp`), mode = (await fs.stat(filename)).mode & 0o777;
      try {
        await fs.writeFile(temporary, change.text, { flag: 'wx', mode });
        if (process.platform !== 'win32') await fs.chmod(temporary, mode);
        const latest = await existingText(root, change.path);
        if (latest === null || digest(latest) !== change.beforeHash) throw new Error('Gitignore changed during setup');
        await renameWithRetry(fs.rename, temporary, filename);
        updated.push(change.path);
      } finally {
        try { await fs.unlink(temporary); }
        catch (error) { if (error.code !== 'ENOENT') console.error(`Setup temporary cleanup failed: ${error.message}`); }
      }
    }
    return { root, created: created.map(c => c.path), updated, preserved: plan.preserved, warnings: plan.warnings };
  } catch (e) {
    for (const change of created.reverse()) {
      const current = await existingText(root, change.path).catch(() => null);
      if (current !== null && digest(current) === digest(change.text)) {
        try { await fs.unlink(path.join(root, change.path)); }
        catch (cleanupError) { console.error(`Setup rollback cleanup failed: ${cleanupError.message}`); }
      }
    }
    for (const directory of [...new Set(createdDirs)].sort((a, b) => b.length - a.length)) {
      try { await fs.rmdir(directory); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code))
          console.error(`Setup directory cleanup failed: ${error.message}`);
      }
    }
    throw e;
  }
}
