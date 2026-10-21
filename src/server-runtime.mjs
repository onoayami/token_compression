import { parseArgs, openKit } from './options.mjs';
import { PublicError } from './errors.mjs';
import { isMainEntry } from './bin-check.mjs';

export const TOOLS = [
  {
    name: 'kit_read',
    description: 'Prefer this automatically when reading a workspace log/JSON/text/Markdown file. It reduces repetition/JSON whitespace locally and retains an original snapshot. safe is default. preview is lossy and for logs only. Does not read chat history or intercept other tools. Use kit_source to obtain original line citations.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      mode: { type: 'string', enum: ['safe', 'preview'], default: 'safe' },
    }, required: ['path'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'kit_source',
    description: 'Retrieve original source line ranges from a saved snapshot, with SHA-256 and current-file change status. Optional quote verifies a literal match, not semantic support. Use for important numbers/conditions and source-backed handoffs. Large ranges use Unicode-character pagination.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      snapshot_id: { type: 'string' }, expected_sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
      start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 },
      quote: { type: 'string', minLength: 1, maxLength: 1000 },
    }, required: ['snapshot_id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];
TOOLS.push({
  name: 'kit_stats',
  description: 'Show local content before/after byte and Unicode-character counts, reduction percentages, returned metadata/source-lookup overhead, and lossy/paging counts. NOT Copilot model tokens or billing. Empty/legacy histories are marked, not guessed.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
TOOLS.push({
  name: 'kit_context',
  description: 'List registered Markdown project documents with declared official/draft/archived status, version, scope, output records and change/recheck flags without sending bodies. Or explicitly read one document by id. Registration/output do not prove truth or AI understanding. Unknowns/conflicts stay unresolved.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['list', 'read'], default: 'list' },
    id: { type: 'string', minLength: 1, maxLength: 64 },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
  }, required: [] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
});
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
export { PublicError };
export function publicToolError(error) {
  const code = error instanceof PublicError ? error.publicCode :
    error?.code === 'ENOENT' ? 'FILE_NOT_FOUND' :
    ['EACCES', 'EPERM'].includes(error?.code) ? 'ACCESS_DENIED' :
    'CONTEXT_KIT_ERROR';
  const message = error instanceof PublicError ? error.publicMessage :
    code === 'FILE_NOT_FOUND' ? 'File not found' :
    code === 'ACCESS_DENIED' ? 'Access denied' : 'Operation failed';
  return `${code}: ${message}`;
}
export function createHandler(kit) {
  let initialized = false;
  return async request => {
    const hasID = request && Object.hasOwn(request, 'id');
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
        (hasID && typeof request.id !== 'string' && !Number.isInteger(request.id))) return error(null, -32600, 'Invalid JSON-RPC request');
    if (!hasID) return null; // No replies to notifications, including cancellation.
    const { id, method } = request, params = request.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) return error(id, -32602, 'Params must be an object');
    const ok = result => ({ jsonrpc: '2.0', id, result });
    if (method === 'ping') return ok({});
    if (method === 'initialize') {
      initialized = true;
      return ok({ protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} }, serverInfo: { name: 'copilot-context-kit', version: '0.4.2' } });
    }
    if (!initialized) return error(id, -32000, 'Initialize first');
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return error(id, -32602, 'Unknown tool');
      const a = params.arguments ?? {};
      if (!a || typeof a !== 'object' || Array.isArray(a) ||
          Object.keys(a).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) ||
          tool.inputSchema.required.some(key => !Object.hasOwn(a, key))) return error(id, -32602, 'Invalid tool arguments');
      for (const [key, value] of Object.entries(a)) {
        const rule = tool.inputSchema.properties[key];
        if ((rule.type === 'string' && typeof value !== 'string') ||
            (rule.type === 'integer' && !Number.isInteger(value)) ||
            (rule.enum && !rule.enum.includes(value)) ||
            (rule.pattern && (typeof value !== 'string' || !new RegExp(rule.pattern).test(value))) ||
            (rule.minimum !== undefined && value < rule.minimum) ||
            (rule.maximum !== undefined && value > rule.maximum) ||
            (rule.minLength !== undefined && Array.from(value).length < rule.minLength) ||
            (rule.maxLength !== undefined && Array.from(value).length > rule.maxLength))
          return error(id, -32602, 'Invalid tool argument type or range');
      }
      try {
        const text = params.name === 'kit_read' ? await kit.read(a.path, a.mode ?? 'safe') :
          params.name === 'kit_source' ? await kit.retrieve(a) :
          params.name === 'kit_context' ? await kit.context(a) : JSON.stringify(await kit.stats());
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        console.error(`Tool error: ${e?.message ?? String(e)}`);
        return ok({ isError: true, content: [{ type: 'text', text: publicToolError(e) }] });
      }
    }
    return error(id, -32601, 'Method not found');
  };
}
export async function startServer(options) {
  const kit = await openKit(options), handle = createHandler(kit);
  let buffer = '', sequence = Promise.resolve();
  const send = value => { if (value) process.stdout.write(`${JSON.stringify(value)}\n`); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let at, start = 0;
    while ((at = buffer.indexOf('\n', start)) !== -1) {
      const line = buffer.slice(start, at).replace(/\r$/, ''); start = at + 1;
      sequence = sequence.then(async () => {
        if (!line.trim()) return;
        if (Buffer.byteLength(line) > 65536) { send(error(null, -32600, 'Request too large')); return; }
        let request;
        try { request = JSON.parse(line); } catch { send(error(null, -32700, 'Parse error')); return; }
        send(await handle(request));
      }).catch(e => { console.error(`Server error: ${e.message}`); send(error(null, -32603, 'Internal error')); });
    }
    if (start) buffer = buffer.slice(start);
    if (Buffer.byteLength(buffer) > 65536) { console.error('Unterminated request too large'); process.exitCode = 1; process.stdin.destroy(); }
  });
  process.stdin.on('end', () => { sequence.then(() => {
    if (buffer.trim()) { send(error(null, -32700, 'Messages must end with a newline')); process.exitCode = 1; }
  }); });
}
export async function runServerCli() {
  try {
    const { options, positionals } = parseArgs(process.argv.slice(2), new Set(['root', 'config']), 'server');
    if (positionals.length) throw new Error('Unexpected server arguments');
    await startServer(options);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
export { isMainEntry };
