import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalServer } from './http.mjs';

export function determineIntent(request) {
  if (request.command === 'setup' || /初期設定|セットアップ|はじめる|始める|\bsetup\b/i.test(request.prompt || '')) return 'setup';
  if (request.command === 'stats' || /圧縮|統計|\bstats\b/i.test(request.prompt || '')) return 'stats';
  if (request.command === 'status' || /状況|状態|一覧|\bstatus\b/i.test(request.prompt || '')) return 'overview';
  return 'help';
}
export function httpDefinition(vscode, endpoint, token) {
  const label = 'Context Kit（拡張内蔵）', uri = vscode.Uri.parse(endpoint), headers = { Authorization: `Bearer ${token}` }, version = '0.4.0';
  // The stable API has used positional and object-shaped constructor variants.
  // Validate the constructed fields; do not silently register an unusable endpoint.
  for (const create of [
    () => new vscode.McpHttpServerDefinition({ label, uri, headers, version }),
    () => new vscode.McpHttpServerDefinition({ label, uri: endpoint, headers, version }),
    () => new vscode.McpHttpServerDefinition(label, uri, headers, version),
  ]) {
    try {
      const value = create();
      if (value.label === label && String(value.uri) === endpoint && value.headers?.Authorization === headers.Authorization) return value;
    } catch { /* Try the other documented constructor shape. */ }
  }
  throw new Error('MCP登録APIが利用できません。VS Codeを更新してください。');
}
const fenced = value => {
  const runs = value.match(/`+/g) || [], width = Math.max(3, ...runs.map(s => s.length + 1));
  const fence = '`'.repeat(width); return `${fence}text\n${value}\n${fence}\n`;
};
export async function activate(context, vscode, {
  kitRoot = path.join(context.extensionPath, 'kit'),
  startServer = startLocalServer,
  exposeLifecycle = false,
} = {}) {
  const moduleAt = name => import(pathToFileURL(path.join(kitRoot, 'src', name)).href);
  const [{ ContextKit }, { createHandler }, { planSetup, applySetup }, { formatContextOverview, ContextRegistry }, { formatStats }] = await Promise.all([
    moduleAt('core.mjs'), moduleAt('server.mjs'), moduleAt('setup.mjs'), moduleAt('context.mjs'), moduleAt('report.mjs'),
  ]);
  const changed = new vscode.EventEmitter();
  let root = null, kit = null, server = null, disposed = false, wizardRunning = false;
  const localFolders = () => (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
  const permittedRoot = value => localFolders().some(f => path.resolve(f.uri.fsPath) === path.resolve(value));
  const assertLocal = () => {
    if (!vscode.workspace.isTrusted) throw new Error('信頼済みの作業フォルダで実行してください。');
    if (vscode.env.remoteName) throw new Error('この簡単導入版はローカルのデスクトップ版VS Code向けです。WSL・SSH・Dev Containerは従来のCLI版をご利用ください。');
  };
  let transition = Promise.resolve();
  const stopNow = async () => { const current = server; server = null; kit = null; root = null; changed.fire(); await current?.close(); };
  const stop = () => {
    transition = transition.catch(() => {}).then(stopNow);
    return transition;
  };
  const startNow = async selected => {
    assertLocal(); if (!permittedRoot(selected)) throw new Error('現在開いている作業フォルダを選んでください。');
    if (root === selected && server) return;
    await stopNow();
    kit = await ContextKit.create(selected);
    const handle = createHandler(kit);
    server = await startServer(async request => {
      assertLocal();
      if (!permittedRoot(selected)) throw new Error('作業フォルダが閉じられました。');
      return handle(request);
    }); root = selected;
    try { httpDefinition(vscode, server.endpoint, server.token); }
    catch (e) { await stopNow(); throw e; }
    changed.fire();
  };
  const start = selected => {
    transition = transition.catch(() => {}).then(() => startNow(selected));
    return transition;
  };
  const requireKit = () => { assertLocal(); if (!kit) throw new Error('先にチャットで @contextkit 初期設定 と入力してください。'); return kit; };
  const selectRoot = async () => {
    assertLocal(); const folders = localFolders();
    if (!folders.length) {
      const choice = await vscode.window.showInformationMessage('先に作業用フォルダをVS Codeで開いてください。その後「@contextkit 初期設定」をもう一度実行します。', 'フォルダを開く');
      if (choice === 'フォルダを開く') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '作業フォルダを開く' });
        if (picked?.[0]) await vscode.commands.executeCommand('vscode.openFolder', picked[0]);
      }
      return null;
    }
    if (folders.length === 1) return folders[0].uri.fsPath;
    const selected = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, value: f.uri.fsPath })), { title: '初期設定 1/3：対象のフォルダ', placeHolder: '資料を整理する作業フォルダを選びます' });
    return selected?.value || null;
  };
  const setup = async () => {
    if (wizardRunning) throw new Error('初期設定はすでに開いています。表示された入力欄を確認してください。');
    wizardRunning = true;
    try {
      const selected = await selectRoot(); if (!selected) return { cancelled: true };
      let description = '', designPaths = [];
      const existing = await fs.lstat(path.join(selected, 'project-context/catalog.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!existing) {
        description = await vscode.window.showInputBox({ title: '初期設定 2/3：何をするプロジェクトですか？', prompt: '一言で入力してください。空欄でも進められます。正式な仕様ではなく、検討中のメモとして保存します。', placeHolder: '例：申込画面の改善を進めたい', validateInput: text => text.length > 2000 ? '2000文字以内で入力してください。' : undefined });
        if (description === undefined) return { cancelled: true };
        const choice = await vscode.window.showQuickPick([{ label: '既存のMarkdown設計書を選ぶ', value: true }, { label: 'あとで記入する', value: false }], { title: '初期設定 3/3：設計書はありますか？' });
        if (!choice) return { cancelled: true };
        if (choice.value) {
          const selectedFiles = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultUri: vscode.Uri.file(selected), filters: { Markdown: ['md'] }, openLabel: 'この設計書を登録する' });
          if (!selectedFiles) return { cancelled: true };
          designPaths = selectedFiles.map(uri => uri.fsPath);
        }
      }
      const plan = await planSetup({ root: selected, templateRoot: kitRoot, description, designPaths });
      const summary = `対象: ${selected}\n新しく作るファイル: ${plan.changes.filter(c => c.action === 'create').length}件\n追記: ${plan.changes.filter(c => c.action === 'append').map(c => c.path).join(', ') || 'なし'}\n既存の資料・台帳・プロンプトは上書きしません。\n\n${plan.warnings.join('\n')}`;
      const approved = await vscode.window.showInformationMessage('この内容で初期設定しますか？', { modal: true, detail: summary }, '設定する');
      if (approved !== '設定する') return { cancelled: true };
      const result = await applySetup(plan);
      await start(selected);
      await context.workspaceState.update('contextkit.root', selected);
      await context.workspaceState.update('contextkit.enabled', true);
      vscode.window.showInformationMessage('Context Kitの初期設定が完了しました。MCPの信頼確認が表示された場合は内容を確認してください。');
      return result;
    } finally { wizardRunning = false; }
  };
  const showOverview = async () => {
    const text = formatContextOverview(JSON.parse(await requireKit().context()));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: text })); return text;
  };
  const showStats = async () => {
    const text = formatStats(await requireKit().stats());
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: text })); return text;
  };
  const openDoc = async id => {
    const value = requireKit(), catalog = await new ContextRegistry(value).catalog();
    const entry = catalog?.documents.find(d => d.id === id);
    if (!entry) throw new Error('資料が登録されていません。');
    const filename = await value.sourcePath(entry.path);
    await vscode.window.showTextDocument(vscode.Uri.file(filename));
  };
  const safeCommand = callback => async (...args) => {
    try { return await callback(...args); }
    catch (e) {
      console.error(`Context Kit command failed: ${e.message}`);
      const message = 'Context Kitの処理を完了できませんでした。設定と対象ファイルを確認してください。';
      vscode.window.showErrorMessage(message);
      return { error: message };
    }
  };
  for (const [name, callback] of Object.entries({ setup, overview: showOverview, stats: showStats,
    openGlossary: () => openDoc('glossary'), openDesign: () => openDoc('design'),
    disable: async () => { await context.workspaceState.update('contextkit.enabled', false); await stop(); vscode.window.showInformationMessage('このフォルダで停止しました。資料ファイルは削除していません。'); } })) {
    context.subscriptions.push(vscode.commands.registerCommand(`contextkit.${name}`, safeCommand(callback)));
  }
  if (!vscode.lm?.registerMcpServerDefinitionProvider || !vscode.McpHttpServerDefinition || !vscode.chat?.createChatParticipant) throw new Error('必要なAPIがありません。デスクトップ版VS Codeを更新してください。');
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('contextkit.local', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: async () => server && root && vscode.workspace.isTrusted ? [httpDefinition(vscode, server.endpoint, server.token)] : [],
    resolveMcpServerDefinition: async definition => definition,
  }));
  const participant = vscode.chat.createChatParticipant('contextkit.assistant', async (request, _chat, stream) => {
    try {
      const intent = determineIntent(request);
      if (intent === 'setup') {
        stream.progress('初期設定の入力欄を開きます。'); const result = await setup();
        if (result.cancelled) stream.markdown('初期設定は保存せずに終了しました。再開するときは **@contextkit 初期設定** と入力してください。');
        else {
          stream.markdown(`**初期設定を保存しました。接続確認は次の操作で行います。**\n\n新規作成 ${result.created.length}件、追記 ${result.updated.length}件。既存の資料は上書きしていません。\n\n${result.warnings.join('\n\n')}\n\n今後は通常のCopilotエージェントチャットで「kit_contextで共通知識の一覧を見せて」と依頼できます。接続の信頼確認は内容を読んで承認してください。\n\n用語集や設計書は、下のボタンから開けます。`);
          stream.button({ command: 'contextkit.openGlossary', title: '用語集を開く' });
          stream.button({ command: 'contextkit.openDesign', title: '設計書を開く' });
        }
      } else if (intent === 'overview') stream.markdown(fenced(formatContextOverview(JSON.parse(await requireKit().context()))));
      else if (intent === 'stats') stream.markdown(fenced(formatStats(await requireKit().stats())));
      else { stream.markdown('初期設定専用の窓口です。**@contextkit 初期設定**、**@contextkit 状況**、**@contextkit 圧縮状況** が使えます。一般の実装や相談は通常のCopilotへ戻って依頼してください。'); stream.button({ command: 'contextkit.setup', title: '初期設定を始める' }); }
    } catch (e) {
      console.error(`Context Kit chat failed: ${e.message}`);
      stream.markdown('設定・確認を完了できませんでした。ファイルと設定を確認してから、もう一度実行してください。');
    }
    return {};
  });
  context.subscriptions.push(participant, changed);
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { if (root && !permittedRoot(root)) void stop(); }));
  if (context.workspaceState.get('contextkit.enabled')) {
    const saved = context.workspaceState.get('contextkit.root');
    if (saved && permittedRoot(saved) && vscode.workspace.isTrusted && !vscode.env.remoteName) await start(saved);
  }
  const dispose = async () => { if (disposed) return; disposed = true; await stop(); };
  context.subscriptions.push({ dispose: () => { void dispose(); } });
  return exposeLifecycle ? { dispose, start, stop } : { dispose };
}
