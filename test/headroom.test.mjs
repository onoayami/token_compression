import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HEADROOM_VERSION,
  HeadroomManager,
  buildHeadroomEnvironment,
  headroomSettingsPath,
  isHeadroomAuthenticated,
  managedHeadroomPaths,
  parseHeadroomVersion,
} from '../vscode-extension/headroom.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  stdout = { resume() {} };
  stderr = { resume() {} };
  kill(signal) {
    this.signalCode = signal;
    this.exitCode = signal === 'SIGKILL' ? 137 : 0;
    this.emit('exit', this.exitCode, signal);
    return true;
  }
}

async function fixture(t, options = {}) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-headroom-'));
  t.after(() => fs.rm(storagePath, { recursive: true, force: true }));
  const paths = managedHeadroomPaths(storagePath, { platform: 'darwin' });
  if (options.authenticated !== false) {
    await fs.mkdir(path.dirname(paths.authFile), { recursive: true });
    await fs.writeFile(paths.authFile, '{}');
  }
  const calls = [];
  let child;
  const exec = async (command, args) => {
    calls.push({ type: 'exec', command, args });
    if (args[0] === '--version') return { stdout: options.version ?? 'headroom, version 0.41.0', stderr: '' };
    if (args[0] === 'copilot-auth') return { stdout: options.authOutput ?? 'Status: logged in', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const spawn = (command, args, spawnOptions) => {
    calls.push({ type: 'spawn', command, args, options: spawnOptions });
    child = new FakeChild();
    return child;
  };
  const manager = new HeadroomManager({
    command: '/managed/headroom',
    storagePath,
    settingsFile: '/Users/test/Library/Application Support/Code/User/settings.json',
    root: '/workspace',
    platform: 'darwin',
    exec,
    spawn,
    fetchImpl: async () => ({ ok: options.healthy !== false }),
  });
  return { manager, paths, calls, get child() { return child; } };
}

test('Headroom version and authentication parsing are fixed and non-sensitive', () => {
  assert.equal(parseHeadroomVersion('headroom, version 0.41.0'), HEADROOM_VERSION);
  assert.equal(parseHeadroomVersion('headroom, version 0.42.0'), '0.42.0');
  assert.equal(isHeadroomAuthenticated('Auth file: /private/token\nStatus: logged in'), true);
  assert.equal(isHeadroomAuthenticated('Status: not logged in'), false);
});

test('Headroom environment is an allowlist with privacy and stateless controls', async t => {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-headroom-env-'));
  t.after(() => fs.rm(storagePath, { recursive: true, force: true }));
  const env = buildHeadroomEnvironment({
    storagePath,
    platform: 'darwin',
    baseEnv: {
      HOME: '/home/test', PATH: '/unsafe', GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret',
      GITHUB_COPILOT_TOKEN: 'secret', HEADROOM_LOG_FILE: '/tmp/leak', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.invalid',
    },
  });
  assert.equal(env.HOME, '/home/test');
  assert.match(env.PATH, /\/usr\/bin:\/bin$/);
  assert.equal(env.HEADROOM_BEACON, 'off');
  assert.equal(env.DO_NOT_TRACK, '1');
  assert.equal(env.HEADROOM_TELEMETRY, 'off');
  assert.equal(env.HEADROOM_UPDATE_CHECK, 'off');
  assert.equal(env.HEADROOM_USAGE_REPORTING, '0');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.HEADROOM_DISABLE_KOMPRESS, '1');
  assert.equal(env.HEADROOM_MODE, 'token');
  assert.equal(env.HEADROOM_STATELESS, '1');
  assert.equal(env.HEADROOM_NO_SUBSCRIPTION_TRACKING, '1');
  assert.equal(env.HEADROOM_WORKSPACE_DIR, path.join(storagePath, 'headroom'));
  assert.ok(env.HEADROOM_COPILOT_AUTH_FILE.startsWith(path.join(storagePath, 'headroom')));
  assert.ok(env.GITHUB_COPILOT_TOKEN_FILE.startsWith(path.join(storagePath, 'headroom')));
  assert.match(env.GITHUB_COPILOT_KEYCHAIN_SERVICE, /^contextkit-disabled-/);
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_COPILOT_TOKEN', 'HEADROOM_LOG_FILE', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'HEADROOM_OFFLINE']) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
});

test('start gates exact version and dedicated auth before spawning', async t => {
  const wrongVersion = await fixture(t, { version: 'headroom, version 0.42.0' });
  await assert.rejects(() => wrongVersion.manager.start(), error => error.code === 'HEADROOM_VERSION_MISMATCH');
  assert.equal(wrongVersion.calls.filter(call => call.type === 'spawn').length, 0);

  const unauthenticated = await fixture(t, { authenticated: false });
  await assert.rejects(() => unauthenticated.manager.start(), error => error.code === 'HEADROOM_AUTH_REQUIRED');
  assert.equal(unauthenticated.calls.filter(call => call.type === 'spawn').length, 0);
});

test('start uses wrap vscode with explicit settings, health and privacy env', async t => {
  const state = await fixture(t);
  await state.manager.start();
  const launch = state.calls.find(call => call.type === 'spawn');
  assert.deepEqual(launch.args, ['wrap', 'vscode', '--port', '8787', '--settings-file', '/Users/test/Library/Application Support/Code/User/settings.json']);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.env.HEADROOM_STATELESS, '1');
  assert.equal(launch.options.env.HEADROOM_BEACON, 'off');
  assert.equal(launch.options.env.GITHUB_TOKEN, undefined);
  assert.equal(state.child.exitCode, null);
  await state.manager.stop();
  assert.equal(state.child.signalCode, 'SIGINT');
});

test('unwrap stops only the owned child and invokes Headroom unwrap', async t => {
  const state = await fixture(t);
  await state.manager.start();
  await state.manager.unwrap();
  const unwrap = state.calls.find(call => call.type === 'exec' && call.args[0] === 'unwrap');
  assert.deepEqual(unwrap.args, ['unwrap', 'vscode', '--settings-file', '/Users/test/Library/Application Support/Code/User/settings.json']);
});

test('settings path is the macOS stable user settings location', () => {
  assert.equal(headroomSettingsPath({ platform: 'darwin', home: '/Users/example' }), '/Users/example/Library/Application Support/Code/User/settings.json');
  assert.throws(() => headroomSettingsPath({ platform: 'linux', home: '/home/example' }), /macOS/);
});
