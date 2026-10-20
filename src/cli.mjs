import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_OPTIONS, parseArgs, openKit } from './options.mjs';
import { formatStats } from './report.mjs';
import { formatContextOverview } from './context.mjs';
const help = `Copilot Context Kit (Node.js 20+, no npm install needed)
  node src/cli.mjs read FILE [--mode safe|preview] [--root WORKSPACE]
  node src/cli.mjs source SNAPSHOT_ID [--start-line N --end-line N --offset N --limit N --sha256 HASH --quote TEXT]
  node src/cli.mjs stats [--format text|json] [--root WORKSPACE]
  node src/cli.mjs context [--format text|json] [--offset N --limit N] [--root WORKSPACE]
  node src/cli.mjs context-read DOCUMENT_ID [--root WORKSPACE]
  node src/cli.mjs purge [--root WORKSPACE]
  node src/cli.mjs config [--root WORKSPACE] [--format vscode|portable]
Optional: --config /absolute/path/to/config.json
Read/source commands write private local snapshots/metrics, never source files.
Config only PRINTS JSON. Merge it into existing settings; do not overwrite them.
Byte metrics are not model-token or billing measurements.`;
try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) console.log(help);
  else {
    const { options: o, positionals: p } = parseArgs(rest, COMMAND_OPTIONS[command], command);
    if (command === 'config') {
      if (p.length) throw new Error('config takes no positional arguments');
      await openKit(o);
      const server = { command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--root', path.resolve(o.root)] };
      if (o.config) server.args.push('--config', path.resolve(o.config));
      if (o.format && !['vscode', 'portable'].includes(o.format)) throw new Error('format must be vscode or portable');
      const output = o.format === 'portable' ? { mcpServers: { 'context-kit': server } } : { servers: { 'context-kit': { type: 'stdio', ...server } } };
      console.log(JSON.stringify(output, null, 2));
    } else {
      const kit = await openKit(o);
      if (command === 'read' && p.length === 1) console.log(await kit.read(p[0], o.mode ?? 'safe'));
      else if (command === 'source' && p.length === 1) console.log(await kit.retrieve({ snapshot_id: p[0],
        ...(o['start-line'] !== undefined ? { start_line: Number(o['start-line']) } : {}),
        ...(o['end-line'] !== undefined ? { end_line: Number(o['end-line']) } : {}),
        ...(o.offset !== undefined ? { offset: Number(o.offset) } : {}),
        ...(o.limit !== undefined ? { limit: Number(o.limit) } : {}),
        ...(o.sha256 !== undefined ? { expected_sha256: o.sha256 } : {}),
        ...(o.quote !== undefined ? { quote: o.quote } : {}) }));
      else if (command === 'context-read' && p.length === 1) console.log(await kit.context({ action: 'read', id: p[0] }));
      else if (command === 'context' && !p.length) {
        if (o.format && !['text', 'json'].includes(o.format)) throw new Error('context format must be text or json');
        const text = await kit.context({ action: 'list',
          ...(o.offset !== undefined ? { offset: Number(o.offset) } : {}),
          ...(o.limit !== undefined ? { limit: Number(o.limit) } : {}) });
        console.log(o.format === 'json' ? text : formatContextOverview(JSON.parse(text)));
      }
      else if (command === 'stats' && !p.length) {
        if (o.format && !['text', 'json'].includes(o.format)) throw new Error('stats format must be text or json');
        const stats = await kit.stats();
        console.log(o.format === 'text' ? formatStats(stats) : JSON.stringify(stats, null, 2));
      }
      else if (command === 'purge' && !p.length) console.log(JSON.stringify(await kit.purge(), null, 2));
      else throw new Error('Unknown command or wrong argument count. Run: node src/cli.mjs help');
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
