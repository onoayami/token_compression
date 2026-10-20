import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSetup, applySetup } from '../src/setup.mjs';
const templateRoot = fileURLToPath(new URL('../', import.meta.url));
const exists = async filename => fs.access(filename).then(() => true, () => false);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = options => planSetup({ root, templateRoot, ...options });
  const read = name => fs.readFile(path.join(root, name), 'utf8');
  const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
  return { root, plan, read, write };
}
test('setup planning is read-only and creates only the missing draft shelf and six prompts after approval', async t => {
  const { root, plan, read } = await fixture(t);
  const proposed = await plan({ description: '  申込画面を改善する  ' });
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(proposed.changes.length, 14); assert.equal(proposed.preserved.length, 0);
  const result = await applySetup(proposed);
  assert.equal(result.created.length, 14); assert.equal(result.updated.length, 0);
  assert.match(await read('project-context/overview.md'), /## 何を作るか\n申込画面を改善する/);
  const catalog = JSON.parse(await read('project-context/catalog.json'));
  assert.equal(catalog.documents.length, 6);
  assert.ok(catalog.documents.every(d => d.status === 'draft' && d.version === '未設定'));
  assert.equal((await fs.readdir(path.join(root, '.github/prompts'))).length, 6);
  assert.equal(await exists(path.join(root, '.vscode/mcp.json')), false);
  assert.equal(await exists(path.join(root, '.context-kit-cache')), false);
  assert.equal(await read('.gitignore'), '.context-kit-cache/\n.context-kit/\n');
});
test('repeated setup preserves all existing documents, catalog and prompts and becomes a no-op', async t => {
  const { plan, read, write } = await fixture(t); await applySetup(await plan());
  await write('project-context/overview.md', '# USER CONTENT\n');
  await write('.github/prompts/context-read.prompt.md', 'MY PROMPT\n');
  const catalog = await read('project-context/catalog.json');
  const repeated = await plan({ description: 'DO NOT OVERWRITE' });
  assert.equal(repeated.changes.length, 0); assert.equal(repeated.preserved.length, 14);
  assert.ok(repeated.warnings.some(w => w.includes('上書き')));
  await applySetup(repeated);
  assert.equal(await read('project-context/overview.md'), '# USER CONTENT\n');
  assert.equal(await read('.github/prompts/context-read.prompt.md'), 'MY PROMPT\n');
  assert.equal(await read('project-context/catalog.json'), catalog);
});
test('existing Markdown designs are registered by path without copying or modifying their content', async t => {
  const { root, plan, write, read } = await fixture(t);
  await write('docs/design.md', '# EXISTING\n'); await write('docs/second.md', '# TWO\n');
  const proposed = await plan({ designPaths: [path.join(root, 'docs/design.md'), 'docs/design.md', 'docs/second.md'] });
  assert.deepEqual((await fs.readdir(root)).sort(), ['docs']);
  await applySetup(proposed);
  const designs = JSON.parse(await read('project-context/catalog.json')).documents.filter(d => d.kind === 'design');
  assert.deepEqual(designs.map(d => [d.id, d.path, d.status]), [['design', 'docs/design.md', 'draft'], ['design-2', 'docs/second.md', 'draft']]);
  assert.equal(await read('docs/design.md'), '# EXISTING\n');
});
test('existing catalog is not changed by newly supplied design paths', async t => {
  const { plan, read } = await fixture(t); await applySetup(await plan());
  const before = await read('project-context/catalog.json');
  const proposed = await plan({ designPaths: ['missing.md'] });
  assert.ok(proposed.warnings.some(w => w.includes('既存の台帳')));
  await applySetup(proposed); assert.equal(await read('project-context/catalog.json'), before);
});
test('gitignore appending preserves existing text, CRLF and permissions, protects against earlier negations', async t => {
  const { root, plan, write, read } = await fixture(t);
  const original = '# 自分の設定\r\n.context-kit-cache/\r\n.context-kit/\r\n!.context-kit-cache/**';
  await write('.gitignore', original); await fs.chmod(path.join(root, '.gitignore'), 0o640);
  const proposed = await plan(); const change = proposed.changes.find(c => c.path === '.gitignore');
  assert.equal(change.action, 'append');
  await applySetup(proposed);
  assert.equal(await read('.gitignore'), original + '\r\n.context-kit-cache/\r\n.context-kit/\r\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, '.gitignore'))).mode & 0o777, 0o640);
  assert.equal((await plan()).changes.length, 0);
});
test('manual MCP config is only inspected for duplicates, never changed', async t => {
  const { plan, write, read } = await fixture(t);
  const mcp = '{"servers":{"context-kit":{"command":"node"}},"OTHER":"KEEP"}\n';
  await write('.vscode/mcp.json', mcp);
  const proposed = await plan(); assert.ok(proposed.warnings.some(w => w.includes('旧版')));
  await applySetup(proposed); assert.equal(await read('.vscode/mcp.json'), mcp);
});
test('invalid descriptions, outside paths, non-Markdown, blocked credentials, oversized or directory designs are rejected before writes', async t => {
  const { root, plan, write } = await fixture(t);
  await write('file.txt', 'text'); await write('secret.md', 'secret');
  await write('large.md', 'x'.repeat(2 * 1024 * 1024 + 1)); await fs.mkdir(path.join(root, 'folder.md'));
  await assert.rejects(() => plan({ description: 'x'.repeat(2001) }));
  await assert.rejects(() => plan({ description: 'x\0y' }));
  for (const filename of ['../outside.md', 'file.txt', 'secret.md', 'large.md', 'folder.md']) {
    await assert.rejects(() => plan({ designPaths: [filename] }), error => !error.message.includes(filename) && !error.message.includes(root));
  }
  assert.equal(await exists(path.join(root, 'project-context')), false);
  assert.equal(await exists(path.join(root, '.github')), false);
});
test('invalid catalog is not silently replaced and creates nothing', async t => {
  const { root, plan, write, read } = await fixture(t);
  await write('project-context/catalog.json', '{invalid');
  await assert.rejects(() => plan());
  assert.deepEqual(await fs.readdir(path.join(root, 'project-context')), ['catalog.json']);
  assert.equal(await read('project-context/catalog.json'), '{invalid');
});
test('symlinked setup directories and gitignore are rejected, not followed', async t => {
  const { root, plan, write, read } = await fixture(t); await fs.mkdir(path.join(root, 'elsewhere'));
  try { await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'project-context'), 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Symlink privilege unavailable'); return; } throw e; }
  await assert.rejects(() => plan(), /Unsafe existing setup path/);
  assert.deepEqual(await fs.readdir(path.join(root, 'elsewhere')), []);
  await fs.unlink(path.join(root, 'project-context')); await write('keep.txt', 'KEEP');
  await fs.symlink(path.join(root, 'keep.txt'), path.join(root, '.gitignore'));
  await assert.rejects(() => plan(), /Unsafe existing setup path/);
  assert.equal(await read('keep.txt'), 'KEEP');
});
test('a newly created or changed setup target after preview aborts preflight without partial writes', async t => {
  const { root, plan, write, read } = await fixture(t);
  const proposed = await plan(); await write('.github/prompts/context-stats.prompt.md', 'KEEP');
  await assert.rejects(() => applySetup(proposed), /target changed/);
  assert.equal(await exists(path.join(root, 'project-context')), false);
  assert.equal(await read('.github/prompts/context-stats.prompt.md'), 'KEEP');
  await write('.gitignore', 'BEFORE\n'); const next = await plan(); await write('.gitignore', 'AFTER\n');
  await assert.rejects(() => applySetup(next), /target changed/);
  assert.equal(await exists(path.join(root, 'project-context')), false);
  assert.equal(await read('.gitignore'), 'AFTER\n');
});
test('partial failure rolls back only new files and retains user data', async t => {
  const { root, plan, write, read } = await fixture(t); await write('keep.txt', 'KEEP');
  const proposed = await plan();
  // A bad payload fails after the first successful create. The public UI only emits strings.
  proposed.changes[1].text = null;
  await assert.rejects(() => applySetup(proposed));
  assert.equal(await exists(path.join(root, 'project-context/overview.md')), false);
  assert.equal(await read('keep.txt'), 'KEEP');
});
