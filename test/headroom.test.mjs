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
  let existingHealthy = Boolean(options.existingHealthy);
  const alive = new Set(Object.keys(options.processes || {}).map(Number));
  const exec = async (command, args, execOptions) => {
    calls.push({ type: 'exec', command, args, options: execOptions });
    if (command === '/usr/sbin/lsof') {
      if (!options.listeners?.length) throw Object.assign(new Error('no listener'), { code: 1 });
      return { stdout: options.listeners.filter(pid => alive.has(pid)).join('\n'), stderr: '' };
    }
    if (command === '/bin/ps') {
      const pid = Number(args.at(-1));
      if (!alive.has(pid)) throw Object.assign(new Error('no process'), { code: 1 });
      return { stdout: `  ${options.processes[pid]}\n`, stderr: '' };
    }
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
    command: options.command || '/managed/headroom',
    storagePath,
    settingsFile: '/Users/test/Library/Application Support/Code/User/settings.json',
    root: '/workspace',
    platform: 'darwin',
    home: options.home || '/Users/test',
    exec,
    spawn,
    fetchImpl: async () => ({
      ok: (existingHealthy || activeChild) && healthy,
      json: async () => options.healthBody || {
        service: 'headroom-proxy',
        version: '0.41.0',
        status: 'healthy',
        ready: true,
        config: { mode: 'token', disable_kompress: true },
      },
    }),
    fsImpl: options.fsImpl || fs,
    kill: (pid, signal) => {
      if (!alive.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (signal === 0) return true;
      calls.push({ type: 'kill', pid, signal });
      if (!options.ignoreSignals) {
        alive.delete(pid);
        if (![...alive].some(other => options.listeners?.includes(other))) existingHealthy = false;
      }
      return true;
    },
  });
  return { manager, paths, calls, alive, setHealthy(value) { healthy = value; }, setExistingHealthy(value) { existingHealthy = value; }, get child() { return child; } };
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

test('installation discovers a compatible pyenv shim before the old macOS system Python', async t => {
  const pyenvPython = '/Users/test/.pyenv/shims/python3';
  const state = await fixture(t, {
    fsImpl: {
      mkdir: async () => {},
      access: async candidate => {
        if (![pyenvPython, '/usr/bin/python3'].includes(candidate)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      statfs: async () => ({ bavail: 2_000_000, bsize: 1024 }),
    },
    pythonVersions: {
      [pyenvPython]: 'Python 3.12.14',
      '/usr/bin/python3': 'Python 3.9.6',
    },
  });
  await state.manager.install();
  const probes = state.calls.filter(call => call.type === 'exec' && call.args[0] === '--version' && call.command.endsWith('python3'));
  assert.deepEqual(probes.map(call => call.command), [pyenvPython]);
  assert.equal(state.calls.find(call => call.type === 'exec' && call.args[0] === '-m' && call.args[1] === 'venv').command, pyenvPython);
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
  t.after(() => state.manager.stop());
  await state.manager.start();
  const waitForSpawnCount = async expected => {
    const deadline = Date.now() + 5_000;
    while (state.calls.filter(call => call.type === 'spawn').length < expected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state.calls.filter(call => call.type === 'spawn').length, expected);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    state.child.crash();
    await waitForSpawnCount(attempt + 2);
  }
  state.child.crash();
  await new Promise(resolve => setTimeout(resolve, 100));
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

const SETTINGS = '/Users/test/Library/Application Support/Code/User/settings.json';
const leftoverProxy = {
  existingHealthy: true,
  listeners: [4321],
  processes: {
    4321: `999 /managed/python3.12 /managed/headroom wrap vscode --port 8787 --settings-file ${SETTINGS}`,
  },
};

test('a proxy left behind by an earlier Context Kit host is taken over instead of reported as a conflict', async t => {
  const state = await fixture(t, leftoverProxy);
  const before = await state.manager.status();
  assert.equal(before.leftover, true);
  assert.equal(before.portInUse, false);
  const result = await state.manager.start();
  assert.equal(result.started, true);
  assert.deepEqual(state.calls.filter(call => call.type === 'kill').map(call => [call.pid, call.signal]), [[4321, 'SIGINT']]);
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 1);
  await state.manager.stop();
});

test('re-authentication restart takes over a leftover proxy', async t => {
  const state = await fixture(t, leftoverProxy);
  await state.manager.restart();
  assert.equal(state.calls.filter(call => call.type === 'kill').length, 1);
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 1);
  await state.manager.stop();
});

test('the managed wrapper is found through the parent of the listening process', async t => {
  const state = await fixture(t, {
    existingHealthy: true,
    listeners: [5000],
    processes: {
      5000: '4321 /managed/venv/bin/python3.12 -m uvicorn headroom.proxy:app --port 8787',
      4321: `1 /managed/python3.12 /managed/headroom wrap vscode --port 8787 --settings-file ${SETTINGS}`,
    },
  });
  await state.manager.start();
  assert.deepEqual(state.calls.filter(call => call.type === 'kill').map(call => call.pid).sort(), [4321, 5000]);
  await state.manager.stop();
});

test('an orphaned proxy whose wrapper already exited is recognised by the managed venv command', async t => {
  const command = '/Users/test/Library/Application Support/Code/User/globalStorage/x/headroom/venv/bin/headroom';
  const state = await fixture(t, {
    command,
    existingHealthy: true,
    listeners: [39115],
    processes: { 39115: `1 ${path.posix.dirname(command)}/python -m headroom.cli proxy --port 8787 --workers 1 --mode token` },
  });
  assert.equal((await state.manager.status()).leftover, true);
  await state.manager.restart();
  assert.deepEqual(state.calls.filter(call => call.type === 'kill').map(call => call.pid), [39115]);
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 1);
  await state.manager.stop();
});

test('foreign or differently configured processes on the port are never killed', async t => {
  for (const command of [
    '1 /usr/local/bin/headroom wrap vscode --port 8787',
    '1 /managed/headroom wrap vscode --port 87870',
    '1 /usr/bin/python3 -m http.server 8787',
    '1 /other/venv/bin/python -m headroom.cli proxy --port 8787 --mode token',
    '1 /managed/python -m headroom.cli proxy --port 87870',
  ]) {
    const state = await fixture(t, { existingHealthy: true, listeners: [4321], processes: { 4321: command } });
    await assert.rejects(() => state.manager.start(), error => error.code === 'HEADROOM_PORT_IN_USE');
    await state.manager.stop();
    assert.equal(state.calls.filter(call => call.type === 'kill').length, 0, command);
    assert.equal(state.calls.filter(call => call.type === 'spawn').length, 0, command);
    assert.equal((await state.manager.status()).portInUse, true);
  }
});

test('stop is fail-closed for a leftover proxy but closing a window leaves it for other windows', async t => {
  const disposed = await fixture(t, leftoverProxy);
  await disposed.manager.dispose();
  assert.equal(disposed.calls.filter(call => call.type === 'kill').length, 0);
  const stopped = await fixture(t, leftoverProxy);
  await stopped.manager.stop();
  assert.deepEqual(stopped.calls.filter(call => call.type === 'kill').map(call => call.signal), ['SIGINT']);
});

test('automatic restarts share a proxy another window started instead of killing it', async t => {
  const state = await fixture(t, { ...leftoverProxy, existingHealthy: false });
  await state.manager.start();
  state.setExistingHealthy(true);
  state.child.crash(1);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(state.calls.filter(call => call.type === 'kill').length, 0);
  assert.equal(state.calls.filter(call => call.type === 'spawn').length, 1);
  await state.manager.dispose();
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

test('a new authentication replaces an unfinished device flow instead of reporting busy', async t => {
  const state = await fixture(t);
  const first = state.manager.authenticate();
  await new Promise(resolve => setImmediate(resolve));
  const firstChild = state.child;
  assert.equal((await state.manager.status()).authenticating, true);
  const second = state.manager.authenticate();
  await assert.rejects(first, error => error.code === 'HEADROOM_AUTH_CANCELLED');
  assert.equal(firstChild.signalCode, 'SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(state.child, firstChild);
  state.child.crash(0);
  assert.deepEqual(await second, { authenticated: true });
  assert.equal((await state.manager.status()).authenticating, false);
  assert.equal(state.calls.filter(call => call.type === 'spawn' && call.args[0] === 'copilot-auth').length, 2);
});

test('authentication can be redone while the owned proxy keeps running', async t => {
  const state = await fixture(t);
  t.after(() => state.manager.stop());
  await state.manager.start();
  const proxy = state.child;
  const pending = state.manager.authenticate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(proxy.exitCode, null);
  state.child.crash(0);
  assert.deepEqual(await pending, { authenticated: true });
  await state.manager.restart();
  assert.equal(proxy.signalCode, 'SIGINT');
  assert.deepEqual(state.calls.filter(call => call.type === 'spawn').map(call => call.args[0]), ['wrap', 'copilot-auth', 'wrap']);
});

test('an abandoned device flow times out, stops the login process and allows a retry', async t => {
  const state = await fixture(t);
  const pending = state.manager.authenticate({ timeoutMs: 20 });
  await new Promise(resolve => setImmediate(resolve));
  const abandoned = state.child;
  await assert.rejects(pending, error => error.code === 'HEADROOM_AUTH_TIMEOUT');
  assert.equal(abandoned.signalCode, 'SIGINT');
  assert.equal((await state.manager.status()).authenticating, false);
  const retry = state.manager.authenticate();
  await new Promise(resolve => setImmediate(resolve));
  state.child.crash(0);
  assert.deepEqual(await retry, { authenticated: true });
});

test('disposing cancels an unfinished authentication', async t => {
  const state = await fixture(t);
  const pending = state.manager.authenticate();
  await new Promise(resolve => setImmediate(resolve));
  await state.manager.dispose();
  await assert.rejects(pending, error => error.code === 'HEADROOM_AUTH_CANCELLED');
  assert.equal(state.child.signalCode, 'SIGINT');
});
