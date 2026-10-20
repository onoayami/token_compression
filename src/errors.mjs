export const PUBLIC_CODES = new Set([
  'FILE_NOT_FOUND', 'ACCESS_DENIED', 'BLOCKED', 'TOO_LARGE', 'INVALID_ARGUMENT',
  'UNSUPPORTED_ENCODING', 'SOURCE_CHANGED', 'CONTEXT_KIT_ERROR',
]);

const SAFE_MESSAGES = Object.freeze({
  FILE_NOT_FOUND: 'File not found',
  ACCESS_DENIED: 'Access denied',
  BLOCKED: 'Path blocked by policy',
  TOO_LARGE: 'Input exceeds configured size limit',
  INVALID_ARGUMENT: 'Invalid argument',
  UNSUPPORTED_ENCODING: 'Input encoding is unsupported. Use UTF-8 or UTF-16 with a BOM and retry.',
  SOURCE_CHANGED: 'The file changed while it was being read. Copy it to a temporary file and retry.',
  CONTEXT_KIT_ERROR: 'Operation failed',
});

export class PublicError extends Error {
  constructor(code, detail = SAFE_MESSAGES[code]) {
    if (!PUBLIC_CODES.has(code)) throw new Error('Invalid public error code');
    super(detail);
    this.name = 'PublicError';
    this.code = code;
    this.publicCode = code;
    this.publicMessage = SAFE_MESSAGES[code];
  }
}

export const publicMessage = code => SAFE_MESSAGES[code] ?? SAFE_MESSAGES.CONTEXT_KIT_ERROR;
