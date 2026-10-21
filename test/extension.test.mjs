import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activate, determineIntent, httpDefinition } from '../vscode-extension/runtime.mjs';
import { applySetup, planSetup } from '../src/setup.mjs';
const exec = promisify(execFile), kitRoot = fileURLToPath(new URL('../', import.meta.url));
const uri = filename => ({ scheme: 'file', fsPath: filename, toString: () => `file://${filename}` });
const deferred = () => {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};
const parseURI = value => ({ toString: () => value });
class EventEmitter {
  listeners = [];
  event = listener => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } }; };
  fire = value => { for (const listener of this.listeners) listener(value); };
  dispose() { this.listeners = []; }
}
class PositionalHttpDefinition {
  constructor(label, uri, headers = {}, version) { Object.assign(this, { label, uri, headers, version }); }
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-extension-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const commands = new Map(), values = new Map(Object.entries(options.state || {})), globalValues = new Map();
  const seen = { infos: [], errors: [], opened: [], quickPicks: [], inputs: [], openDialogs: [], executes: [], provider: null, participant: null };
  const foldersChanged = new EventEmitter();
  const context = { extensionPath: path.join(kitRoot, 'vscode-extension'), subscriptions: [], globalStorageUri: uri(path.join(root, 'global')),
    globalState: { get: key => globalValues.get(key), update: async (key, value) => { globalValues.set(key, value); } }, workspaceState: {
    get: key => values.get(key), update: async (key, value) => { values.set(key, value); },
  } };
  const vscode = {
    EventEmitter, McpHttpServerDefinition: PositionalHttpDefinition, Uri: { file: uri, parse: parseURI },     env: { remoteName: options.remoteName, appName: 'Visual Studio Code', openExternal: async value => value },
    workspace: { isTrusted: options.trusted !== false, workspaceFolders: options.noFolders ? [] :
      (options.workspaceFolders || [{ name: 'project', uri: uri(root) }]),
      openTextDocument: async value => value, onDidChangeWorkspaceFolders: foldersChanged.event,
      getConfiguration: () => ({ get: key => options.proxyConfiguration?.[key] }),
    },
    window: {
      showInputBox: async args => { seen.inputs.push(args); return Object.hasOwn(options, 'description') ? options.description : 'テスト用の申込画面'; },
      showQuickPick: async (items, args) => {
        seen.quickPicks.push(args);
        if (args.title.includes('対象')) return options.cancelRootSelection ? undefined : items[0];
        if (options.cancelDesignChoice) return undefined;
        return items.find(i => i.value === Boolean(options.chooseDesign));
      },
      showOpenDialog: async args => {
        seen.openDialogs.push(args);
        if (!args.canSelectFiles) return [];
        if (args.title?.includes('登録') && Object.hasOwn(options, 'registrationFiles')) return options.registrationFiles;
        return Object.hasOwn(options, 'selectedFiles') ? options.selectedFiles : [];
      },
      showInformationMessage: async (...args) => {
        seen.infos.push(args);
        return args[1]?.modal ? (options.confirm === false ? undefined : args.at(-1)) : undefined;
      },
      showErrorMessage: message => { seen.errors.push(message); }, showTextDocument: async value => { seen.opened.push(value); },
    },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; },
      executeCommand: async (...args) => { seen.executes.push(args); } },
    lm: { registerMcpServerDefinitionProvider: (id, provider) => { seen.providerId = id; seen.provider = provider; return { dispose() {} }; } },
    chat: { createChatParticipant: (id, handler) => { seen.participantId = id; seen.participant = handler; return { dispose() {} }; } },
  };
  const manager = await activate(context, vscode, {
    kitRoot, startServer: options.startServer, exposeLifecycle: options.exposeLifecycle,
    headroomManager: options.headroomManager,
  });
  t.after(async () => { await manager.dispose(); for (const disposable of context.subscriptions) disposable.dispose(); });
  const chat = async prompt => {
    const output = { markdown: [], progress: [], buttons: [] };
    await seen.participant({ prompt }, {}, { markdown: text => output.markdown.push(text), progress: text => output.progress.push(text), button: button => output.buttons.push(button) });
    return output;
  };
  return { root, context, vscode, seen, commands, values, globalValues, manager, chat, foldersChanged };
}
function delayedServerFactory() {
  const started = deferred(), release = deferred();
  const state = { starts: 0, closes: 0, started: started.promise, release: release.resolve };
  state.startServer = async () => {
    state.starts++;
    started.resolve();
    await release.promise;
    return {
      endpoint: `http://127.0.0.1:51234/mcp-${state.starts}`,
      token: 'test-token',
      close: async () => { state.closes++; },
    };
  };
  return state;
}
test('chat phrase routes only setup, status and stats; regular messages show help', () => {
  assert.equal(determineIntent({ prompt: '初期設定' }), 'setup');
  assert.equal(determineIntent({ command: 'setup' }), 'setup');
  assert.equal(determineIntent({ prompt: '圧縮状況' }), 'stats');
  assert.equal(determineIntent({ command: 'status' }), 'overview');
  assert.equal(determineIntent({ prompt: '一覧' }), 'overview');
  assert.equal(determineIntent({ prompt: 'アプリの開発を手伝って' }), 'help');
});
test('proxy status distinguishes an unowned process on the configured port', async t => {
  const headroomManager = {
    status: async () => ({ running: false, portInUse: true, authenticated: true, port: 8787 }),
    stop: async () => {},
    dispose: async () => {},
  };
  const { commands, seen } = await fixture(t, { headroomManager });
  await commands.get('contextkit.proxyStatus')();
  assert.match(seen.infos.at(-1)[0], /別プロセスが127\.0\.0\.1:8787で稼働/);
  assert.match(seen.infos.at(-1)[0], /所有・停止しません/);
});
test('MCP constructor compatibility validates both positional and object definitions and rejects unusable APIs', () => {
  const endpoint = 'http://127.0.0.1:51234/mcp', token = 'testing-token';
  for (const Class of [PositionalHttpDefinition, class ObjectDefinition { constructor(options) { Object.assign(this, options); } }]) {
    const definition = httpDefinition({ Uri: { parse: parseURI }, McpHttpServerDefinition: Class }, endpoint, token);
    assert.equal(String(definition.uri), endpoint); assert.equal(definition.headers.Authorization, `Bearer ${token}`);
  }
  assert.throws(() => httpDefinition({ Uri: { parse: parseURI }, McpHttpServerDefinition: class {} }, endpoint, token), /更新/);
});
test('confirmed chat wizard registers a real MCP endpoint, creates templates and exposes setup buttons', async t => {
  const { root, seen, chat, values, commands } = await fixture(t);
  assert.deepEqual(await seen.provider.provideMcpServerDefinitions(), []);
  const output = await chat('初期設定');
  assert.ok(output.markdown.join('').includes('初期設定を保存しました'));
  assert.ok(!output.markdown.join('').includes('接続確認済み'));
  assert.deepEqual(output.buttons, [
    { command: 'contextkit.proxySetup', title: '自動圧縮を設定する' },
    { command: 'contextkit.registerGlossary', title: '用語集を登録する' },
    { command: 'contextkit.registerDesign', title: '設計書を登録する' },
  ]);
  assert.equal(seen.inputs.length, 1);
  assert.equal(values.get('contextkit.root'), root); assert.equal(values.get('contextkit.enabled'), true);
  assert.match(await fs.readFile(path.join(root, '.github/copilot-instructions.md'), 'utf8'), /kit_read.*自動的に選ぶ/);
  assert.equal(seen.providerId, 'contextkit.local'); assert.equal(seen.participantId, 'contextkit.assistant');
  const [definition] = await seen.provider.provideMcpServerDefinitions();
  assert.equal(await seen.provider.resolveMcpServerDefinition(definition), definition);
  const endpoint = String(definition.uri), headers = { ...definition.headers, 'Content-Type': 'application/json' };
  const init = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
  assert.equal((await init.json()).result.serverInfo.name, 'copilot-context-kit');
  const read = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kit_context', arguments: {} } }) });
  const list = JSON.parse((await read.json()).result.content[0].text);
  assert.equal(list.documents.length, 6);
  const status = await chat('状況'); assert.ok(status.markdown.join('').includes('用語集'));
  const stats = await chat('圧縮状況'); assert.ok(stats.markdown.join('').includes('未計測'));
  await commands.get('contextkit.stats')(); assert.equal(seen.opened.at(-1).language, 'markdown');
  await commands.get('contextkit.disable')();
  assert.equal(values.get('contextkit.enabled'), false); assert.deepEqual(await seen.provider.provideMcpServerDefinitions(), []);
  await assert.rejects(() => fetch(endpoint));
  assert.ok(await fs.stat(path.join(root, 'project-context/catalog.json')));
});
test('setup cancellation identifies the exact step and produces no files or enabled state', async t => {
  const cases = [
    [{ confirm: false }, '最終確認'],
    [{ description: undefined }, 'プロジェクト説明'],
    [{ cancelDesignChoice: true }, '設計書の選択'],
    [{ chooseDesign: true, selectedFiles: undefined }, 'ファイル選択'],
    [{ workspaceFolders: [{ name: 'one', uri: uri('/one') }, { name: 'two', uri: uri('/two') }], cancelRootSelection: true }, '作業フォルダの選択'],
  ];
  for (const [options, expected] of cases) {
    const { root, chat, values, seen } = await fixture(t, options);
    const output = await chat('初期設定');
    assert.ok(output.markdown.join('').includes(expected));
    assert.deepEqual(output.buttons[0], { command: 'contextkit.setup', title: '初期設定をもう一度開く' });
    assert.deepEqual(await fs.readdir(root), []); assert.equal(values.get('contextkit.enabled'), undefined);
    assert.deepEqual(await seen.provider.provideMcpServerDefinitions(), []);
  }
});
test('setup in an untrusted workspace or remote environment is blocked without writing', async t => {
  for (const options of [{ trusted: false }, { remoteName: 'wsl' }]) {
    const { root, chat, seen } = await fixture(t, options); const output = await chat('初期設定');
    assert.ok(output.markdown.join('').includes('完了できませんでした'));
    assert.deepEqual(await fs.readdir(root), []); assert.deepEqual(await seen.provider.provideMcpServerDefinitions(), []);
  }
});
test('no-folder guidance and ordinary help do not create a project or send model requests', async t => {
  const { root, chat, seen } = await fixture(t, { noFolders: true });
  const setup = await chat('初期設定');
  assert.ok(setup.markdown.join('').includes('作業フォルダが開かれていない'));
  assert.equal(setup.buttons[0].command, 'contextkit.setup');
  assert.ok(seen.infos[0][0].includes('作業用フォルダ'));
  const help = await chat('実装を手伝って'); assert.ok(help.markdown.join('').includes('初期設定専用'));
  assert.equal(help.buttons[0].command, 'contextkit.setup'); assert.deepEqual(await fs.readdir(root), []);
});
test('existing catalog makes repeated wizard a confirmed reuse without asking to overwrite anything', async t => {
  const { root, chat, seen } = await fixture(t);
  await applySetup(await planSetup({ root, templateRoot: kitRoot }));
  await fs.writeFile(path.join(root, 'project-context/glossary.md'), 'USER GLOSSARY');
  const output = await chat('初期設定');
  assert.equal(seen.inputs.length, 0); assert.equal(seen.quickPicks.length, 0);
  assert.ok(output.markdown.join('').includes('新規作成 0件、追記 0件'));
  assert.equal(await fs.readFile(path.join(root, 'project-context/glossary.md'), 'utf8'), 'USER GLOSSARY');
});
test('chosen local Markdown design is registered during initial setup', async t => {
  const selectedFiles = [], { root, chat } = await fixture(t, { chooseDesign: true, selectedFiles });
  const design = path.join(root, 'my-design.md'); await fs.writeFile(design, '# MY DESIGN'); selectedFiles.push(uri(design));
  await chat('初期設定');
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'project-context/catalog.json'), 'utf8'));
  assert.equal(catalog.documents.find(document => document.kind === 'design').path, 'my-design.md');
  assert.equal(await fs.readFile(design, 'utf8'), '# MY DESIGN');
});
test('registration buttons open file selection and replace glossary and design registrations after confirmation', async t => {
  const registrationFiles = [], { root, chat, commands, seen } = await fixture(t, { registrationFiles });
  await chat('初期設定');
  const glossary = path.join(root, 'docs/glossary.md'), designOne = path.join(root, 'docs/design.md'), designTwo = path.join(root, 'docs/second.md');
  await fs.mkdir(path.dirname(glossary), { recursive: true });
  await Promise.all([
    fs.writeFile(glossary, '# GLOSSARY'),
    fs.writeFile(designOne, '# DESIGN'),
    fs.writeFile(designTwo, '# SECOND'),
  ]);
  registrationFiles.push(uri(glossary));
  await commands.get('contextkit.registerGlossary')();
  registrationFiles.splice(0, 1, uri(designOne), uri(designTwo));
  await commands.get('contextkit.registerDesign')();
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'project-context/catalog.json'), 'utf8'));
  assert.equal(catalog.documents.find(document => document.kind === 'glossary').path, 'docs/glossary.md');
  assert.deepEqual(catalog.documents.filter(document => document.kind === 'design').map(document => document.path), ['docs/design.md', 'docs/second.md']);
  assert.equal(seen.openDialogs.at(-2).openLabel, 'この用語集を登録する');
  assert.equal(seen.openDialogs.at(-1).openLabel, 'この設計書を登録する');
  assert.match(seen.infos.at(-1)[0], /設計書を2件登録/);
});
test('registering a document uses validated catalog errors instead of parser details', async t => {
  const registrationFiles = [], { root, commands, seen, chat } = await fixture(t, { registrationFiles });
  await chat('初期設定');
  const glossary = path.join(root, 'glossary-new.md'); await fs.writeFile(glossary, '# NEW'); registrationFiles.push(uri(glossary));
  await fs.writeFile(path.join(root, 'project-context/catalog.json'), '{broken');
  const result = await commands.get('contextkit.registerGlossary')();
  assert.match(result.error, /完了できませんでした/);
  assert.equal(seen.errors.at(-1), 'Context Kitの処理を完了できませんでした。設定と対象ファイルを確認してください。');
});
test('workspace removal stops the endpoint and trust loss blocks requests even before host reload', async t => {
  const { chat, vscode, seen, foldersChanged } = await fixture(t); await chat('初期設定');
  const [definition] = await seen.provider.provideMcpServerDefinitions();
  vscode.workspace.isTrusted = false;
  assert.deepEqual(await seen.provider.provideMcpServerDefinitions(), []);
  const response = await fetch(String(definition.uri), { method: 'POST', headers: { ...definition.headers, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(response.status, 500);
  vscode.workspace.workspaceFolders = []; foldersChanged.fire({ removed: [] });
  assert.deepEqual(await seen.provider.provideMcpServerDefinitions(), []);
});
test('enabled workspace configuration restores server on a later activation without rerunning file writes', async t => {
  const { root, context, vscode, seen, chat, manager } = await fixture(t); await chat('初期設定'); await manager.dispose();
  const before = await fs.readFile(path.join(root, 'project-context/overview.md'), 'utf8');
  const next = await activate(context, vscode, { kitRoot }); t.after(() => next.dispose());
  assert.equal((await seen.provider.provideMcpServerDefinitions()).length, 1);
  assert.equal(await fs.readFile(path.join(root, 'project-context/overview.md'), 'utf8'), before);
});
test('concurrent starts create one local server', async t => {
  const state = delayedServerFactory();
  const { root, manager } = await fixture(t, { startServer: state.startServer, exposeLifecycle: true });
  const first = manager.start(root), second = manager.start(root);
  await state.started; state.release();
  await Promise.all([first, second]);
  assert.equal(state.starts, 1);
  assert.equal(state.closes, 0);
});
test('a concurrent stop waits for start and closes the only local server', async t => {
  const state = delayedServerFactory();
  const { root, manager } = await fixture(t, { startServer: state.startServer, exposeLifecycle: true });
  const starting = manager.start(root);
  await state.started;
  const stopping = manager.stop();
  state.release();
  await Promise.all([starting, stopping]);
  assert.equal(state.starts, 1);
  assert.equal(state.closes, 1);
});
test('failed server registration closes the server and allows a later start', async t => {
  let starts = 0, closes = 0;
  const startServer = async () => {
    starts++;
    return {
      endpoint: `http://127.0.0.1:51234/failing-${starts}`,
      token: 'test-token',
      close: async () => { closes++; },
    };
  };
  const { root, vscode, manager } = await fixture(t, { startServer, exposeLifecycle: true });
  vscode.McpHttpServerDefinition = class BrokenHttpDefinition {
    constructor() { throw new Error('injected registration failure'); }
  };
  let timeoutId;
  const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('start timed out')), 250); });
  try {
    await assert.rejects(Promise.race([manager.start(root), timeout]), /MCP登録API|timed out/);
  } finally {
    clearTimeout(timeoutId);
  }
  assert.equal(closes, 1);
  vscode.McpHttpServerDefinition = PositionalHttpDefinition;
  await manager.start(root);
  assert.equal(starts, 2);
  assert.equal(closes, 1);
});
test('staging uses official-package layout, includes runtime/templates and excludes tests, caches and dependencies', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'context-kit-stage-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const out = path.join(temp, 'extension');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const { stdout } = await exec(python, ['scripts/stage-extension.py', '--out', out], { cwd: kitRoot });
  const rootPackage = JSON.parse(await fs.readFile(path.join(kitRoot, 'package.json'), 'utf8'));
  assert.match(stdout, new RegExp(`Staged extension: ${rootPackage.version.replaceAll('.', '\\.')}`));
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './extension.cjs'); assert.ok(await fs.stat(path.join(out, manifest.main)));
  assert.ok(await fs.stat(path.join(out, 'headroom.mjs')));
  assert.ok(await fs.stat(path.join(out, 'kit/src/setup.mjs'))); assert.ok(await fs.stat(path.join(out, 'kit/integration/prompts/context-handoff-save.prompt.md')));
  assert.ok(await fs.stat(path.join(out, 'kit/integration/copilot-instructions.snippet.md')));
  const paths = await fs.readdir(out, { recursive: true });
  assert.ok(!paths.some(p => /(^|[\\/])(test|node_modules|\.context-kit-cache|\.context-kit|dist)([\\/]|$)/.test(p)));
  assert.equal(manifest.contributes.chatParticipants[0].isSticky, false);
  assert.equal(manifest.version, rootPackage.version);
  await assert.rejects(() => exec(python, ['scripts/stage-extension.py', '--out', out], { cwd: kitRoot }), /Output exists/);
});
