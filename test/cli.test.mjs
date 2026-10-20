import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function rootFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const call = args => run(process.execPath, [cli, ...args]);
test('CLI config prints a VS Code stdio setup without changing workspace files', async t => {
  const root = await rootFor(t); await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
  const { stdout, stderr } = await call(['config', '--root', root]);
  const config = JSON.parse(stdout), entry = config.servers['context-kit'];
  assert.equal(entry.type, 'stdio'); assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args.slice(-2), ['--root', root]);
  assert.equal(stderr, ''); assert.deepEqual(await fs.readdir(root), ['keep.txt']);
});
test('CLI portable config uses mcpServers and no unsupported cwd/input variables', async t => {
  const root = await rootFor(t);
  const { stdout } = await call(['config', '--root', root, '--format', 'portable']);
  const config = JSON.parse(stdout), entry = config.mcpServers['context-kit'];
  assert.ok(entry); assert.equal(entry.cwd, undefined); assert.equal(config.servers, undefined);
  assert.ok(!stdout.includes('${input:'));
});
test('CLI read, quote verification, stats and purge work end-to-end', async t => {
  const root = await rootFor(t); await fs.writeFile(path.join(root, 'spec.md'), 'Deadline: Friday\nExcept on a holiday.\n');
  const result = await call(['read', 'spec.md', '--root', root]);
  const meta = JSON.parse(result.stdout.split('\n')[0].slice('CONTEXT_KIT '.length));
  const source = await call(['source', meta.snapshot_id, '--root', root, '--start-line', '1', '--end-line', '2', '--sha256', meta.sha256, '--quote', 'Deadline: Friday']);
  assert.match(source.stdout, /quote_match_in_requested_lines":true/);
  const stats = JSON.parse((await call(['stats', '--root', root])).stdout);
  assert.equal(stats.read_calls, 1); assert.equal(stats.retrieve_calls, 1);
  const purged = JSON.parse((await call(['purge', '--root', root])).stdout);
  assert.equal(purged.deleted_snapshots, 1);
  assert.match(await fs.readFile(path.join(root, 'spec.md'), 'utf8'), /Friday/);
});
test('CLI unsupported files and malformed flags have nonzero exit status', async t => {
  const root = await rootFor(t); await fs.writeFile(path.join(root, 'app.js'), 'const x=1;');
  await assert.rejects(() => call(['read', 'app.js', '--root', root]), e => e.code === 1 && /extension/.test(e.stderr) && e.stdout === '');
  await assert.rejects(() => call(['config', '--unknown', 'yes']), e => e.code === 1);
  await assert.rejects(() => call(['config', '--format', 'other']), e => e.code === 1);
});
test('config validates the root and configuration without creating a cache', async t => {
  const root = await rootFor(t);
  const config = path.join(root, 'settings.json');
  await fs.writeFile(config, JSON.stringify({ extraBlockedPaths: ['private'] }));
  const out = JSON.parse((await call(['config', '--root', root, '--config', config])).stdout);
  assert.deepEqual(out.servers['context-kit'].args.slice(-2), ['--config', config]);
  assert.deepEqual(await fs.readdir(root), ['settings.json']);
  await fs.writeFile(config, JSON.stringify({ nonsense: true }));
  await assert.rejects(() => call(['config', '--root', root, '--config', config]), e => e.code === 1 && /Unknown config/.test(e.stderr));
  await assert.rejects(() => call(['config', '--root', path.join(root, 'missing')]), e => e.code === 1);
  await assert.rejects(() => call(['config', '--config', path.join(root, 'missing.json')]), e => e.code === 1);
});
test('handoff workflow includes source identity, unverified status and manual new-chat boundary', async () => {
  const save = await fs.readFile(new URL('../integration/prompts/context-handoff-save.prompt.md', import.meta.url), 'utf8');
  const resume = await fs.readFile(new URL('../integration/prompts/context-handoff-resume.prompt.md', import.meta.url), 'utf8');
  for (const text of ['snapshot_id', 'sha256', '原文の行範囲', '利用者確認待ち', '同じチャットでメモを追加しただけでは']) assert.ok(save.includes(text));
  for (const text of ['expected_sha256', 'current_source_status', '期限切れ', '新しいチャットを開く操作は利用者']) assert.ok(resume.includes(text));
});
