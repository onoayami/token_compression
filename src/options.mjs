import fs from 'node:fs/promises';
import path from 'node:path';
import { ContextKit } from './core.mjs';
import { stripBOM } from './json.mjs';
export const COMMAND_OPTIONS = Object.freeze({
  read: new Set(['root', 'config', 'mode']),
  source: new Set(['root', 'config', 'offset', 'limit', 'start-line', 'end-line', 'sha256', 'quote']),
  stats: new Set(['root', 'config', 'format']),
  purge: new Set(['root', 'config']),
  config: new Set(['root', 'config', 'format']),
  context: new Set(['root', 'config', 'format', 'offset', 'limit']),
  'context-read': new Set(['root', 'config']),
});
const NUMERIC_OPTIONS = new Set(['offset', 'limit', 'start-line', 'end-line']);
export function parseArgs(args, allowed = new Set(['root', 'config', 'mode', 'format', 'offset', 'limit', 'start-line', 'end-line', 'sha256', 'quote']), command = 'command') {
  const options = { root: process.cwd() }, positionals = [], seen = new Set();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positionals.push(args[i]); continue; }
    const equals = args[i].indexOf('=');
    const key = (equals < 0 ? args[i].slice(2) : args[i].slice(2, equals));
    if (!allowed.has(key)) throw new Error(`Unknown option for ${command}: --${key}`);
    if (equals >= 0) {
      if (seen.has(key)) throw new Error(`Duplicate option: --${key}`);
      seen.add(key);
      const value = args[i].slice(equals + 1);
      if (NUMERIC_OPTIONS.has(key) && !/^\d+$/.test(value)) throw new Error(`Invalid numeric option: --${key}`);
      options[key] = value;
      continue;
    }
    if (args[i + 1] === undefined || args[i + 1].startsWith('--'))
      throw new Error(`Invalid option: ${args[i]} (use --${key}=VALUE for values beginning with --)`);
    if (seen.has(key)) throw new Error(`Duplicate option: --${key}`);
    seen.add(key);
    const value = args[++i];
    if (NUMERIC_OPTIONS.has(key) && !/^\d+$/.test(value)) throw new Error(`Invalid numeric option: --${key}`);
    options[key] = value;
  }
  return { options, positionals };
}
export async function openKit(options) {
  let config = {};
  if (options.config) {
    const filename = path.resolve(options.config);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Config must be a JSON file under 64 KiB');
    try { config = JSON.parse(stripBOM(await fs.readFile(filename, 'utf8'))); }
    catch { throw new Error('Config is invalid JSON; check BOM, trailing commas and UTF-8 encoding'); }
  }
  return ContextKit.create(options.root, config);
}
