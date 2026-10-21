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
  isStableVisualStudioCode,
  managedHeadroomPaths,
  parsePythonVersion,
  parseHeadroomVersion,
} from '../vscode-extension/headroom.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  stdout = Object.assign(new EventEmitter(), { resume() {} });
  stderr = Object.assign(new EventEmitter(), { resume() {} });
  kill(signal) {
    this.signalCode = signal;
    this.exitCode = signal === 'SIGKILL' ? 137 : 0;
    this.emit('exit', this.exitCode, signal);
    return true;
  }
  crash(code = 1) {
    this.exitCode = code;
    this.emit('exit', code, null);
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
  let child, activeChild;
  let healthy = options.healthy !== false;
  const exec = async (command, args, execOptions) => {
    calls.push({ type: 'exec', command, args, options: execOptions });
    if (args[0] === '--version' && command.endsWith('python3')) return { stdout: options.pythonVersions?.[command] ?? options.pythonVersion ?? 'Python 3.12.0', stderr: '' };
    if (args[0] === '--version') return { stdout: options.version ?? 'headroom, version 0.41.0', stderr: '' };
    if (args[0] === 'copilot-auth') return { stdout: options.authOutput ?? 'Status: logged in', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const spawn = (command, args, spawnOptions) => {
    calls.push({ type: 'spawn', command, args, options: spawnOptions });
    child = new FakeChild();
    activeChild = child;
    child.once('exit', () => { if (activeChild === child) activeChild = null; });
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
    fetchImpl: async () => ({
      ok: (options.existingHealthy || activeChild) && healthy,
      json: async () => options.healthBody || {
        service: 'headroom-proxy',
        version: '0.41.0',
        status: 'healthy',
        ready: true,
        config: { mode: 'token', disable_kompress: true },
      },
    }),
    fsImpl: options.fsImpl || fs,
  });
  return { manager, paths, calls, setHealthy(value) { healthy = value; }, get child() { return child; } };
}

test('Headroom version and authentication parsing are fixed and non-sensitive', () => {
  assert.equal(parseHeadroomVersion('headroom, version 0.41.0'), HEADROOM_VERSION);
  assert.equal(parseHeadroomVersion('headroom, version 0.42.0'), '0.42.0');
  assert.equal(isHeadroomAuthenticated('Auth file: /private/token\nStatus: logged in'), true);
  assert.equal(isHeadroomAuthenticated('Status: not logged in'), false);
  assert.deepEqual(parsePythonVersion('Python 3.12.4'), { major: 3, minor: 12, patch: 4 });
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
  assert.match(env.PATH, /\/bin$/);
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

test('device-flow authentication uses the restricted environment and exposes only URL/code', async t => {
  const state = await fixture(t);
  const flow = [];
  const pending = state.manager.authenticate({ onDeviceFlow: value => flow.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  state.child.stdout.emit('data', 'debug token=hidden\nOpen: https://github.com/login/device\n');
  state.child.stderr.emit('data', 'ignored secret=hidden\nCode: ABCD-1234\n');
  assert.equal(state.calls.at(-1).type, 'spawn');
  assert.equal(state.calls.at(-1).args.join(' '), 'copilot-auth login');
  assert.equal(state.calls.at(-1).options.env.PATH, `${path.dirname(state.paths.command)}:/bin`);
  assert.equal(state.calls.at(-1).options.env.GITHUB_TOKEN, undefined);
  state.child.crash(0);
  await pending;
  assert.deepEqual(flow, [{ url: 'https://github.com/login/device', code: 'ABCD-1234' }]);
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
  assert.equal(isStableVisualStudioCode('Visual Studio Code'), true);
  assert.equal(isStableVisualStudioCode('Visual Studio Code - Insiders'), false);
});

test('install uses the managed venv and exact third-party version after space check', async t => {
  const state = await fixture(t, {
    fsImpl: { mkdir: async () => {}, access: async () => {}, statfs: async () => ({ bavail: 2_000_000, bsize: 1024 }) },
  });
  await state.manager.install({ python: '/usr/bin/python3' });
  const installs = state.calls.filter(call => call.type === 'exec');
  assert.equal(installs[0].command, '/usr/bin/python3');
  assert.deepEqual(installs[0].args, ['--version']);
  assert.deepEqual(installs[1].args, ['-m', 'venv', state.paths.venv]);
  assert.deepEqual(installs[2].args, [
    '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-input', 'headroom-ai[proxy]==0.41.0',
  ]);
  assert.equal(installs[2].command, state.paths.python);
  assert.match(installs[0].options.env.PATH, /\/usr\/bin:\/bin$/);
  assert.match(installs[1].options.env.PATH, /\/usr\/bin:\/bin$/);
  assert.match(installs[2].options.env.PATH, /\/usr\/bin:\/bin$/);
  assert.deepEqual(installs[3].args, ['--version']);
});

test('installation skips an incompatible first Python candidate', async t => {
  const state = await fixture(t, {
    fsImpl: { mkdir: async () => {}, access: async () => {}, statfs: async () => ({ bavail: 2_000_000, bsize: 1024 }) },
    pythonVersions: {
      '/opt/homebrew/bin/python3': 'Python 3.9.18',
      '/usr/local/bin/python3': 'Python 3.12.4',
    },
  });
  await state.manager.install();
  const probes = state.calls.filter(call => call.type === 'exec' && call.args[0] === '--version' && call.command.endsWith('python3'));
  assert.deepEqual(probes.map(call => call.command), ['/opt/homebrew/bin/python3', '/usr/local/bin/python3']);
  assert.equal(state.calls.find(call => call.type === 'exec' && call.args[0] === '-m' && call.args[1] === 'venv').command, '/usr/local/bin/python3');
});

test('installation stops with fixed guidance when managed storage is low on space', async t => {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-headroom-space-'));
  t.after(() => fs.rm(storagePath, { recursive: true, force: true }));
  const calls = [];
  const manager = new HeadroomManager({
    storagePath,
    platform: 'darwin',
    fsImpl: {
      mkdir: async () => {},
      statfs: async () => ({ bavail: 1, bsize: 1 }),
      access: fs.access,
    },
    exec: async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  });
  await assert.rejects(() => manager.install(), error => error.code === 'HEADROOM_INSUFFICIENT_SPACE' && /1GB弱/.test(error.message));
  assert.equal(calls.length, 0);
});

test('abnormal exits are restarted only within the bounded restart budget', async t => {
  const state = await fixture(t);
  await state.manager.start();
  for (let attempt = 0; attempt < 4; attempt++) {
    state.child.crash();
    await new Promise(resolve => setTimeout(resolve, attempt === 3 ? 50 : (attempt + 1) * 500 + 50));
  }
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 4);
  await state.manager.stop();
});

test('stopping during restart backoff prevents the delayed restart', async t => {
  const state = await fixture(t);
  await state.manager.start();
  state.child.crash();
  await state.manager.stop();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 1);
});

test('unrelated HTTP 200 responses are not accepted as Headroom health', async t => {
  const state = await fixture(t, { healthBody: { status: 'healthy' } });
  await assert.rejects(() => state.manager.start(), error => error.code === 'HEADROOM_UNHEALTHY');
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 1);
});

test('an already healthy port is reported as in use without spawning or killing it', async t => {
  const state = await fixture(t, { existingHealthy: true });
  await assert.rejects(() => state.manager.start(), error => error.code === 'HEADROOM_PORT_IN_USE');
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 0);
  const status = await state.manager.status();
  assert.equal(status.portInUse, true);
  assert.equal(status.owned, false);
});

test('a health-lost owned child is stopped before a replacement is spawned', async t => {
  const state = await fixture(t);
  await state.manager.start();
  const first = state.child;
  state.setHealthy(false);
  const replacement = state.manager.start();
  setTimeout(() => state.setHealthy(true), 10);
  await replacement;
  assert.equal(first.signalCode, 'SIGINT');
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 2);
  await state.manager.stop();
});

test('unstable VS Code variants are rejected before Headroom starts', async t => {
  const state = await fixture(t);
  const manager = new HeadroomManager({
    storagePath: state.paths.root,
    platform: 'darwin',
    appName: 'Visual Studio Code - Insiders',
    exec: state.manager,
  });
  await assert.rejects(() => manager.start(), error => error.code === 'UNSUPPORTED_APP');
});
