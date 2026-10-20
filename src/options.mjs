import fs from 'node:fs/promises';
import path from 'node:path';
import { ContextKit } from './core.mjs';
export const COMMAND_OPTIONS = Object.freeze({
  read: new Set(['root', 'config', 'mode']),
  source: new Set(['root', 'config', 'offset', 'limit', 'start-line', 'end-line', 'sha256', 'quote']),
  stats: new Set(['root', 'config', 'format']),
  purge: new Set(['root', 'config']),
  config: new Set(['root', 'config', 'format']),
  context: new Set(['root', 'config', 'format', 'offset', 'limit']),
  'context-read': new Set(['root', 'config']),
});
export function parseArgs(args, allowed = new Set(['root', 'config', 'mode', 'format', 'offset', 'limit', 'start-line', 'end-line', 'sha256', 'quote']), command = 'command') {
  const options = { root: process.cwd() }, positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positionals.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option for ${command}: --${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
    options[key] = args[++i];
  }
  return { options, positionals };
}
export async function openKit(options) {
  let config = {};
  if (options.config) {
    const filename = path.resolve(options.config);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Config must be a JSON file under 64 KiB');
    config = JSON.parse(await fs.readFile(filename, 'utf8'));
  }
  return ContextKit.create(options.root, config);
}
