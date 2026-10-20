import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_NODE_MAJOR = 20;

export function nodeVersionError(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR
    ? null
    : `Node.js ${MIN_NODE_MAJOR}以上が必要です。Node.js ${MIN_NODE_MAJOR}以上へ更新してください。 Node.js ${MIN_NODE_MAJOR}+ is required.`;
}

export function assertSupportedNode(version = process.versions.node) {
  const message = nodeVersionError(version);
  if (message) {
    const error = new Error(message);
    error.code = 'UNSUPPORTED_NODE';
    throw error;
  }
}

export function isMainEntry(argvPath, moduleUrl) {
  try {
    return Boolean(argvPath) &&
      fs.realpathSync(path.resolve(argvPath)) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
