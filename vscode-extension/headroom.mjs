import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

export const HEADROOM_VERSION = '0.41.0';
export const DEFAULT_HEADROOM_PORT = 8787;
export const MAX_RESTARTS = 3;
export const MIN_INSTALL_FREE_BYTES = 900 * 1024 * 1024;
export const MIN_PYTHON = Object.freeze({ major: 3, minor: 10 });

const execFile = promisify(nodeExecFile);
const PRIVACY_VALUES = Object.freeze({
  HEADROOM_BEACON: 'off',
  DO_NOT_TRACK: '1',
  HEADROOM_TELEMETRY: 'off',
  HEADROOM_UPDATE_CHECK: 'off',
  HEADROOM_USAGE_REPORTING: '0',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HEADROOM_DISABLE_KOMPRESS: '1',
  HEADROOM_MODE: 'token',
});
const SAFE_ENV_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function headroomSettingsPath({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'darwin') throw new Error('Headroom Copilot integration is supported on macOS only.');
  return path.posix.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
}

export function isStableVisualStudioCode(appName = 'Visual Studio Code') {
  return appName === 'Visual Studio Code';
}

export function managedHeadroomPaths(storagePath, { platform = process.platform } = {}) {
  if (!storagePath) throw new TypeError('Context Kit global storage is required.');
  const root = path.join(storagePath, 'headroom');
  const bin = platform === 'win32' ? path.join(root, 'venv', 'Scripts') : path.join(root, 'venv', 'bin');
  return {
    root,
    venv: path.join(root, 'venv'),
    command: path.join(bin, platform === 'win32' ? 'headroom.exe' : 'headroom'),
    python: path.join(bin, platform === 'win32' ? 'python.exe' : 'python'),
    authFile: path.join(root, 'copilot-auth.json'),
    missingTokenFile: path.join(root, '.contextkit-no-copilot-token'),
  };
}

export function buildHeadroomEnvironment({
  storagePath,
  baseEnv = process.env,
  platform = process.platform,
  delimiter = platform === 'win32' ? path.win32.delimiter : path.posix.delimiter,
  forInstall = false,
} = {}) {
  const paths = managedHeadroomPaths(storagePath, { platform });
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  const bin = path.dirname(paths.command);
  const systemPath = platform === 'win32'
    ? `${baseEnv.SystemRoot || 'C:\\Windows'}\\System32`
    : (forInstall ? '/usr/bin:/bin' : '/bin');
  env.PATH = `${bin}${delimiter}${systemPath}`;
  env.HEADROOM_COPILOT_AUTH_FILE = paths.authFile;
  env.GITHUB_COPILOT_TOKEN_FILE = paths.missingTokenFile;
  env.GITHUB_COPILOT_KEYCHAIN_SERVICE = `contextkit-disabled-${randomUUID()}`;
  env.GITHUB_COPILOT_KEYCHAIN_ACCOUNT = `contextkit-disabled-${randomUUID()}`;
  env.HEADROOM_STATELESS = '1';
  env.HEADROOM_NO_SUBSCRIPTION_TRACKING = '1';
  env.HEADROOM_WORKSPACE_DIR = paths.root;
  Object.assign(env, PRIVACY_VALUES);
  return env;
}

export function parseHeadroomVersion(output) {
  const match = String(output || '').match(/\b(?:headroom,\s*)?version\s+(\d+\.\d+\.\d+)\b/i) ||
    String(output || '').match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match?.[1] || null;
}

export function isHeadroomAuthenticated(output) {
  return /\bStatus:\s*logged in\b/i.test(String(output || ''));
}

export function parsePythonVersion(output) {
  const match = String(output || '').match(/\bPython\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) } : null;
}

function noOutputOptions(options) {
  return { ...options, shell: false, windowsHide: true, maxBuffer: 64 * 1024 };
}

export class HeadroomManager {
  #command;
  #storagePath;
  #settingsFile;
  #port;
  #root;
  #spawn;
  #exec;
  #fetch;
  #fs;
  #platform;
  #home;
  #appName;
  #onState;
  #child = null;
  #stopping = false;
  #enabled = false;
  #restartCount = 0;
  #transition = Promise.resolve();

  constructor({
    command,
    storagePath,
    settingsFile,
    port = DEFAULT_HEADROOM_PORT,
    root,
    spawn = nodeSpawn,
    exec = execFile,
    fetchImpl = globalThis.fetch,
    fsImpl = fs,
    platform = process.platform,
    home = os.homedir(),
    appName = 'Visual Studio Code',
    onState = () => {},
  } = {}) {
    if (!storagePath) throw new TypeError('Context Kit global storage is required.');
    this.#storagePath = storagePath;
    this.#command = command || managedHeadroomPaths(storagePath, { platform }).command;
    this.#settingsFile = settingsFile || headroomSettingsPath({ platform, home });
    this.#port = port;
    this.#root = root || process.cwd();
    this.#spawn = spawn;
    this.#exec = exec;
    this.#fetch = fetchImpl;
    this.#fs = fsImpl;
    this.#platform = platform;
    this.#home = home;
    this.#appName = appName;
    this.#onState = onState;
  }

  get command() { return this.#command; }
  get port() { return this.#port; }
  get settingsFile() { return this.#settingsFile; }
  get enabled() { return this.#enabled; }
  #environment(options = {}) {
    return buildHeadroomEnvironment({ storagePath: this.#storagePath, platform: this.#platform, ...options });
  }

  #assertSupportedApp() {
    if (this.#platform === 'darwin' && !isStableVisualStudioCode(this.#appName)) {
      throw Object.assign(new Error('Stable Visual Studio Code is required for Headroom Copilot integration.'), { code: 'UNSUPPORTED_APP' });
    }
  }

  async #run(args) {
    return this.#exec(this.#command, args, noOutputOptions({ cwd: this.#root, env: this.#environment() }));
  }

  async #version() {
    const result = await this.#run(['--version']);
    return parseHeadroomVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
  }

  async #assertVersion() {
    const version = await this.#version().catch(() => null);
    if (version !== HEADROOM_VERSION) {
      const error = new Error(`Headroom ${HEADROOM_VERSION} is required.`);
      error.code = 'HEADROOM_VERSION_MISMATCH';
      throw error;
    }
  }

  async #authenticated() {
    const paths = managedHeadroomPaths(this.#storagePath, { platform: this.#platform });
    await this.#fs.access(paths.authFile).catch(() => { throw Object.assign(new Error('Headroom authentication is required.'), { code: 'HEADROOM_AUTH_REQUIRED' }); });
    const result = await this.#run(['copilot-auth', 'status']).catch(() => null);
    if (!result || !isHeadroomAuthenticated(`${result.stdout || ''}\n${result.stderr || ''}`)) {
      throw Object.assign(new Error('Headroom authentication is required.'), { code: 'HEADROOM_AUTH_REQUIRED' });
    }
  }

  async #healthy() {
    if (typeof this.#fetch !== 'function') return false;
    try {
      const response = await this.#fetch(`http://127.0.0.1:${this.#port}/health`, { signal: AbortSignal.timeout(1000) });
      if (!response?.ok || typeof response.json !== 'function') return false;
      const health = await response.json();
      return health?.service === 'headroom-proxy' &&
        health?.version === HEADROOM_VERSION &&
        health?.status === 'healthy' &&
        health?.ready === true &&
        health?.config?.mode === 'token' &&
        health?.config?.disable_kompress === true;
    } catch {
      return false;
    }
  }

  async #waitForHealth(child) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null && child.exitCode !== undefined) break;
      if (await this.#healthy()) return;
      await delay(250);
    }
    throw Object.assign(new Error('Headroom did not become healthy.'), { code: 'HEADROOM_UNHEALTHY' });
  }

  async #stopNow() {
    const child = this.#child;
    this.#child = null;
    this.#stopping = true;
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
    const exited = new Promise(resolve => child.once?.('exit', resolve));
    try { child.kill?.('SIGINT'); } catch { /* The process may have exited between the check and signal. */ }
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null || child.exitCode === undefined) {
      try { child.kill?.('SIGTERM'); } catch { /* Best effort shutdown of our own child only. */ }
      await Promise.race([exited, delay(2000)]);
    }
    if (child.exitCode === null || child.exitCode === undefined) {
      try { child.kill?.('SIGKILL'); } catch { /* Best effort shutdown of our own child only. */ }
    }
  }

  async #startNow() {
    if (this.#platform !== 'darwin') throw Object.assign(new Error('Automatic compression is supported on macOS only.'), { code: 'UNSUPPORTED_PLATFORM' });
    this.#assertSupportedApp();
    if (this.#child) {
      if (await this.#healthy()) return { started: false, reused: true, port: this.#port };
      await this.#stopNow();
    }
    await this.#assertVersion();
    await this.#authenticated();
    if (!this.#child && await this.#healthy()) {
      throw Object.assign(new Error('Headroom port is already in use by another process.'), { code: 'HEADROOM_PORT_IN_USE' });
    }
    const env = this.#environment();
    const child = this.#spawn(this.#command, ['wrap', 'vscode', '--port', String(this.#port), '--settings-file', this.#settingsFile], {
      cwd: this.#root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdout?.resume?.();
    child.stderr?.resume?.();
    this.#child = child;
    this.#stopping = false;
    child.once?.('exit', () => {
      if (this.#child === child) this.#child = null;
      if (!this.#stopping && this.#enabled && this.#restartCount < MAX_RESTARTS) {
        this.#restartCount++;
        void delay(this.#restartCount * 500).then(() => {
          if (this.#enabled) void this.start();
        });
      }
      this.#onState({ state: 'stopped', code: child.exitCode ?? null });
    });
    try {
      await this.#waitForHealth(child);
      this.#onState({ state: 'running', port: this.#port });
      return { started: true, reused: false, port: this.#port };
    } catch (error) {
      await this.#stopNow();
      throw error;
    }
  }

  start() {
    this.#enabled = true;
    this.#transition = this.#transition.catch(() => {}).then(() => this.#startNow());
    return this.#transition;
  }

  stop() {
    this.#enabled = false;
    this.#restartCount = 0;
    this.#transition = this.#transition.catch(() => {}).then(() => this.#stopNow()).then(() => {
      this.#onState({ state: 'stopped', failClosed: true });
      return { stopped: true, failClosed: true };
    });
    return this.#transition;
  }

  async status() {
    const authenticated = await this.#authenticated().then(() => true).catch(() => false);
    const running = Boolean(this.#child) && await this.#healthy();
    const portInUse = !this.#child && await this.#healthy();
    return { authenticated, running, portInUse, owned: running, enabled: this.#enabled, port: this.#port };
  }

  async unwrap() {
    this.#assertSupportedApp();
    await this.stop();
    await this.#assertVersion();
    await this.#run(['unwrap', 'vscode', '--settings-file', this.#settingsFile]);
    this.#onState({ state: 'unwrapped' });
    return { unwrapped: true };
  }

  async authenticate({ onDeviceFlow = () => {} } = {}) {
    if (this.#platform !== 'darwin') throw Object.assign(new Error('Headroom authentication is supported on macOS only.'), { code: 'UNSUPPORTED_PLATFORM' });
    this.#assertSupportedApp();
    await this.#assertVersion();
    if (this.#child) throw Object.assign(new Error('Headroom is already running.'), { code: 'HEADROOM_BUSY' });
    const child = this.#spawn(this.#command, ['copilot-auth', 'login'], {
      cwd: this.#root, env: this.#environment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    this.#child = child;
    let buffer = '', pendingUrl = null, pendingCode = null, flowShown = false;
    const inspect = chunk => {
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const url = line.match(/\bOpen:\s*(https?:\/\/\S+)/i)?.[1];
        const code = line.match(/\bCode:\s*([A-Z0-9-]{4,})\b/i)?.[1];
        if (url) pendingUrl = url;
        if (code) pendingCode = code;
        if (!flowShown && pendingUrl && pendingCode) {
          flowShown = true;
          onDeviceFlow({ url: pendingUrl, code: pendingCode });
        }
      }
    };
    child.stdout?.on?.('data', inspect);
    child.stderr?.on?.('data', inspect);
    child.stdout?.resume?.();
    child.stderr?.resume?.();
    const exitCode = await new Promise(resolve => child.once?.('exit', code => resolve(code ?? 0)));
    if (this.#child === child) this.#child = null;
    if (exitCode !== 0) throw Object.assign(new Error('Headroom authentication did not complete.'), { code: 'HEADROOM_AUTH_FAILED' });
    return { authenticated: true };
  }

  async install({ python = 'python3' } = {}) {
    if (this.#platform !== 'darwin') throw Object.assign(new Error('Headroom installation is supported on macOS only.'), { code: 'UNSUPPORTED_PLATFORM' });
    this.#assertSupportedApp();
    await this.#fs.mkdir(this.#storagePath, { recursive: true });
    if (typeof this.#fs.statfs === 'function') {
      const stats = await this.#fs.statfs(this.#storagePath);
      const freeBytes = Number(stats?.bavail || 0) * Number(stats?.bsize || 0);
      if (freeBytes < MIN_INSTALL_FREE_BYTES) {
        throw Object.assign(new Error('空き容量が不足しています。約1GB弱の空き容量を確保してから再試行してください。'), { code: 'HEADROOM_INSUFFICIENT_SPACE' });
      }
    }
    const paths = managedHeadroomPaths(this.#storagePath, { platform: this.#platform });
    const env = this.#environment({ forInstall: true });
    const pathApi = this.#platform === 'win32' ? path.win32 : path.posix;
    const candidates = pathApi.isAbsolute(python) ? [python] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
    let pythonPath = null;
    for (const candidate of candidates) {
      if (!await this.#fs.access(candidate).then(() => true).catch(() => false)) continue;
      const result = await this.#exec(candidate, ['--version'], noOutputOptions({ cwd: this.#root, env })).catch(() => null);
      const version = parsePythonVersion(`${result?.stdout || ''}\n${result?.stderr || ''}`);
      if (version && (version.major > MIN_PYTHON.major || version.major === MIN_PYTHON.major && version.minor >= MIN_PYTHON.minor)) {
        pythonPath = candidate;
        break;
      }
    }
    if (!pythonPath) throw Object.assign(new Error('Headroom対応のPython 3.10以上が見つかりません。Pythonの絶対パスを設定して再試行してください。'), { code: 'HEADROOM_PYTHON_NOT_FOUND' });
    await this.#exec(pythonPath, ['-m', 'venv', paths.venv], noOutputOptions({ cwd: this.#root, env }));
    await this.#exec(paths.python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-input', `headroom-ai[proxy]==${HEADROOM_VERSION}`], { ...noOutputOptions({ cwd: this.#root, env }), maxBuffer: 2 * 1024 * 1024 });
    await this.#assertVersion();
    return { installed: true };
  }

  async dispose() {
    await this.stop();
  }
}
