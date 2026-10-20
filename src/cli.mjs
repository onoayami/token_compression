import { assertSupportedNode, isMainEntry } from './bin-check.mjs';

assertSupportedNode();
if (isMainEntry(process.argv[1], import.meta.url)) await import('./cli-runtime.mjs').then(runtime => runtime.runCli());
