import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  '--test',
  'test/core.test.mjs', 'test/server.test.mjs', 'test/cli.test.mjs', 'test/stats.test.mjs',
  'test/context.test.mjs', 'test/setup.test.mjs', 'test/http.test.mjs', 'test/extension.test.mjs',
  'test/headroom.test.mjs',
], { encoding: 'utf8' });
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const value = label => output.match(new RegExp(`ℹ ${label} (\\d+)`))?.[1] ?? '0';
const commit = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();
const report = [
  '参考値。正はCI成果物。',
  `実行日時: ${new Date().toISOString()}`,
  `git commit: ${commit}`,
  `OS: ${os.platform()} ${os.release()} (${os.arch()})`,
  `Node: ${process.version}`,
  'コマンド: npm test',
  `tests: ${value('tests')}`,
  `pass: ${value('pass')}`,
  `fail: ${value('fail')}`,
  `skipped: ${value('skipped')}`,
  '',
].join('\n');
fs.writeFileSync('TEST-RESULTS.txt', report);
process.stdout.write(report);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
