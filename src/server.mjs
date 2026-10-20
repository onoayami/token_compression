import { assertSupportedNode } from './bin-check.mjs';

assertSupportedNode();
const runtime = await import('./server-runtime.mjs');

export const TOOLS = runtime.TOOLS;
export const PublicError = runtime.PublicError;
export const publicToolError = runtime.publicToolError;
export const createHandler = runtime.createHandler;
export const startServer = runtime.startServer;

if (runtime.isMainEntry(process.argv[1], import.meta.url)) await runtime.runServerCli();
