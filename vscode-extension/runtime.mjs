import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalServer } from './http.mjs';
import { HeadroomManager } from './headroom.mjs';

export function determineIntent(request) {
  if (request.command === 'setup' || /初期設定|セットアップ|はじめる|始める|\bsetup\b/i.test(request.prompt || '')) return 'setup';
  if (request.command === 'auth' || /再認証|認証を?(?:やり直|し直|する|して)|ログイン(?:し直|する|して)|github\s*(?:と|との|の)?連携|\bauth\b/i.test(request.prompt || '')) return 'proxyAuth';
  if (request.command === 'compress' || /自動圧縮.*(?:設定|導入|有効)/i.test(request.prompt || '')) return 'proxySetup';
  if (request.command === 'proxy' || /自動圧縮|プロキシ|\bproxy\b/i.test(request.prompt || '')) return 'proxy';
  if (request.command === 'stats' || /圧縮状況|統計|\bstats\b/i.test(request.prompt || '')) return 'stats';
  if (request.command === 'status' || /状況|状態|一覧|\bstatus\b/i.test(request.prompt || '')) return 'overview';
  return 'help';
}
export function httpDefinition(vscode, endpoint, token) {
  const label = 'Context Kit（拡張内蔵）', uri = vscode.Uri.parse(endpoint), headers = { Authorization: `Bearer ${token}` }, version = '0.5.6';
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
  headroomManager,
  createHeadroomManager = options => new HeadroomManager(options),
  exposeLifecycle = false,
} = {}) {
  const moduleAt = name => import(pathToFileURL(path.join(kitRoot, 'src', name)).href);
  const [{ ContextKit }, { createHandler }, { planSetup, applySetup, planDocumentRegistration, applyDocumentRegistration }, { formatContextOverview }, { formatStats }] = await Promise.all([
    moduleAt('core.mjs'), moduleAt('server.mjs'), moduleAt('setup.mjs'), moduleAt('context.mjs'), moduleAt('report.mjs'),
  ]);
  const changed = new vscode.EventEmitter();
  let root = null, kit = null, server = null, disposed = false, wizardRunning = false;
  const proxyConfiguration = vscode.workspace.getConfiguration?.('contextkit.proxy');
  const globalStoragePath = context.globalStorageUri?.fsPath;
  const headroom = headroomManager || (
    process.platform === 'darwin' && globalStoragePath
      ? createHeadroomManager({
        storagePath: globalStoragePath,
        command: proxyConfiguration?.get?.('headroomPath') || undefined,
        port: proxyConfiguration?.get?.('port') || undefined,
        root: vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
        appName: vscode.env.appName,
      })
      : null
  );
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
  const cancelled = message => ({ cancelled: true, message });
  const selectRoot = async () => {
    assertLocal(); const folders = localFolders();
    if (!folders.length) {
      const choice = await vscode.window.showInformationMessage('先に作業用フォルダをVS Codeで開いてください。その後「@contextkit 初期設定」をもう一度実行します。', 'フォルダを開く');
      if (choice === 'フォルダを開く') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '作業フォルダを開く' });
        if (picked?.[0]) await vscode.commands.executeCommand('vscode.openFolder', picked[0]);
      }
      return { message: '**作業フォルダが開かれていないため、初期設定を開始できませんでした。**\n\nVS Codeで設定したいプロジェクトのフォルダを開いてから、もう一度 **@contextkit 初期設定** と入力してください。' };
    }
    if (folders.length === 1) return { root: folders[0].uri.fsPath };
    const selected = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, value: f.uri.fsPath })), { title: '初期設定 1/3：対象のフォルダ', placeHolder: '資料を整理する作業フォルダを選びます' });
    return selected ? { root: selected.value } :
      { message: '**作業フォルダの選択を閉じたため、初期設定を保存していません。**\n\n再開するときは **@contextkit 初期設定** と入力してください。' };
  };
  const setup = async () => {
    if (wizardRunning) throw new Error('初期設定はすでに開いています。表示された入力欄を確認してください。');
    wizardRunning = true;
    try {
      const selection = await selectRoot(); if (!selection.root) return cancelled(selection.message);
      const selected = selection.root;
      let description = '', designPaths = [];
      const existing = await fs.lstat(path.join(selected, 'project-context/catalog.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!existing) {
        description = await vscode.window.showInputBox({ title: '初期設定 2/3：何をするプロジェクトですか？', prompt: '一言で入力してください。空欄でも進められます。正式な仕様ではなく、検討中のメモとして保存します。', placeHolder: '例：申込画面の改善を進めたい', validateInput: text => text.length > 2000 ? '2000文字以内で入力してください。' : undefined });
        if (description === undefined) return cancelled('**プロジェクト説明の入力欄を閉じたため、初期設定を保存していません。**\n\n説明は空欄でも進められます。再開するときは **@contextkit 初期設定** と入力してください。');
        const choice = await vscode.window.showQuickPick([{ label: '既存のMarkdown設計書を選ぶ', value: true }, { label: 'あとで記入する', value: false }], { title: '初期設定 3/3：設計書はありますか？' });
        if (!choice) return cancelled('**設計書の選択を閉じたため、初期設定を保存していません。**\n\n設計書がない場合は「あとで記入する」を選べます。再開するときは **@contextkit 初期設定** と入力してください。');
        if (choice.value) {
          const selectedFiles = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultUri: vscode.Uri.file(selected), filters: { Markdown: ['md'] }, openLabel: 'この設計書を登録する' });
          if (!selectedFiles) return cancelled('**設計書のファイル選択を閉じたため、初期設定を保存していません。**\n\n設計書を選ばず進める場合は、もう一度実行して「あとで記入する」を選んでください。');
          designPaths = selectedFiles.map(uri => uri.fsPath);
        }
      }
      const plan = await planSetup({ root: selected, templateRoot: kitRoot, description, designPaths });
      const summary = `対象: ${selected}\n新しく作るファイル: ${plan.changes.filter(c => c.action === 'create').length}件\n追記: ${plan.changes.filter(c => c.action === 'append').map(c => c.path).join(', ') || 'なし'}\n既存の資料・台帳・プロンプトは上書きしません。\n\n${plan.warnings.join('\n')}`;
      const approved = await vscode.window.showInformationMessage('この内容で初期設定しますか？', { modal: true, detail: summary }, '設定する');
      if (approved !== '設定する') return cancelled('**最終確認で「設定する」が選ばれなかったため、初期設定を保存していません。**\n\n内容を確認して再開するときは **@contextkit 初期設定** と入力してください。');
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
  const requireHeadroom = () => {
    if (!headroom) throw new Error('自動圧縮はmacOSのデスクトップ版VS Codeでのみ利用できます。');
    return headroom;
  };
  const proxyStatus = async () => {
    const status = await requireHeadroom().status();
    const message = status.running ? `Headroom自動圧縮は稼働中です（127.0.0.1:${status.port}）。` :
      status.leftover ? `以前のContext Kitが起動したHeadroomが127.0.0.1:${status.port}に残っています。「自動圧縮を開始」で引き継げます。` :
      status.portInUse ? `Context Kit以外のプロセスが127.0.0.1:${status.port}を使用しています。Context Kitは所有・停止しません。` :
      status.authenticated ? 'Headroomは停止中です。停止中はCopilotを迂回せず接続失敗になります。' :
      'Headroom認証が必要です。認証コマンドを実行してください。';
    vscode.window.showInformationMessage?.(message);
    return status;
  };
  const proxySetup = async () => {
    const manager = requireHeadroom();
    const approved = await vscode.window.showInformationMessage?.(
      'Context Kitの管理領域へHeadroom 0.41.0をインストールし、自動圧縮を有効にします。VSIXには同梱せず、PyPIから第三者Apache-2.0依存を取得します。約1GB弱の空き容量とネット接続が必要です。グローバルインストールは行いません。\n\nHeadroomはGitHub Device FlowとCopilot Chat用OAuthクライアントIDを使う外部連携で、GitHub公式のContext Kit統合ではありません。所属組織とGitHubの規約・ポリシーを確認してから同意してください。',
      { modal: true }, 'インストールする');
    if (approved !== 'インストールする') return { cancelled: true };
    await manager.install({ python: proxyConfiguration?.get?.('python') || 'python3' });
    const next = await vscode.window.showInformationMessage?.(
      'Headroomを管理領域へ導入しました。device flowで認証すると、自動圧縮を開始します。',
      'Headroomを認証', '後で');
    if (next === 'Headroomを認証') return proxyAuth();
    return { installed: true, authenticationRequired: true };
  };
  const proxyAuth = async () => {
    const manager = requireHeadroom();
    try {
      await manager.authenticate({
        onDeviceFlow: ({ url, code }) => {
          const open = 'コードをコピーしてGitHubを開く';
          const notice = vscode.window.showInformationMessage?.(
            `GitHubとの連携（Headroom認証）\n① 「${open}」を押す\n② 開いたGitHubのページにコード「${code}」を貼り付けて続行し、承認する\n③ このまま待つと自動で完了します（15分以内）\n\nページ: ${url}\nうまくいかない場合は「Context Kit: Headroomを認証」をもう一度実行すると、新しいコードで最初からやり直せます。`,
            open);
          void Promise.resolve(notice).then(async choice => {
            if (choice !== open) return;
            await Promise.resolve(vscode.env.clipboard?.writeText?.(code)).catch(() => {});
            await vscode.env.openExternal?.(vscode.Uri.parse(url));
            vscode.window.showInformationMessage?.(`コード「${code}」をコピーしました。GitHubのページに貼り付けて承認してください。完了すると自動で自動圧縮を開始します。`);
          }).catch(() => {});
        },
      });
    } catch (error) {
      if (error?.code === 'HEADROOM_AUTH_CANCELLED') return { cancelled: true, replaced: true };
      throw error;
    }
    // Restart so a proxy that was already running picks up the new credentials.
    const result = await manager.restart();
    await context.globalState.update('contextkit.proxy.enabled', true);
    vscode.window.showInformationMessage?.('Headroom認証が完了し、自動圧縮を開始しました。');
    return result;
  };
  const proxyStart = async () => {
    const result = await requireHeadroom().start();
    await context.globalState.update('contextkit.proxy.enabled', true);
    return result;
  };
  const proxyStop = async () => {
    const result = await requireHeadroom().stop();
    await context.globalState.update('contextkit.proxy.enabled', false);
    return result;
  };
  const proxyUninstall = async () => {
    const result = await requireHeadroom().unwrap();
    await context.globalState.update('contextkit.proxy.enabled', false);
    return result;
  };
  const registerDocuments = async kind => {
    const value = requireKit(), glossary = kind === 'glossary';
    const label = glossary ? '用語集' : '設計書';
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: !glossary,
      defaultUri: vscode.Uri.file(value.root),
      filters: { Markdown: ['md'] },
      openLabel: `この${label}を登録する`,
      title: `${label}を登録`,
    });
    if (!selected?.length) return { cancelled: true };
    const plan = await planDocumentRegistration({ root: value.root, kind, documentPaths: selected.map(uri => uri.fsPath) });
    const detail = `現在の登録:\n${plan.beforePaths.map(item => `- ${item}`).join('\n')}\n\n新しい登録:\n${plan.selectedPaths.map(item => `- ${item}`).join('\n')}\n\nファイル本体は変更しません。`;
    const approved = await vscode.window.showInformationMessage(`${label}の登録をこの内容に置き換えますか？`, { modal: true, detail }, '登録する');
    if (approved !== '登録する') return { cancelled: true };
    const result = await applyDocumentRegistration(plan);
    vscode.window.showInformationMessage(`${label}を${result.registered.length}件登録しました。`);
    return result;
  };
  const errorMessages = {
    UNSUPPORTED_PLATFORM: '自動圧縮はmacOSのデスクトップ版VS Codeでのみ利用できます。',
    UNSUPPORTED_APP: '自動圧縮MVPはmacOSのVisual Studio Code安定版でのみ利用できます。Insidersや派生版では利用できません。',
    HEADROOM_VERSION_MISMATCH: '対応するHeadroom 0.41.0が見つかりません。自動圧縮の設定をもう一度実行してください。',
    HEADROOM_AUTH_REQUIRED: 'Headroom認証が必要です。「Headroomを認証」を実行してください。',
    HEADROOM_AUTH_FAILED: 'Headroom認証を完了できませんでした。「Headroomを認証し直す」から最初からやり直してください。',
    HEADROOM_AUTH_TIMEOUT: 'Headroom認証の有効期限（15分）が切れました。「Headroomを認証し直す」から新しいコードでやり直してください。',
    HEADROOM_INSUFFICIENT_SPACE: 'Headroom導入に必要な空き容量が不足しています。約1GB弱を確保して再試行してください。',
    HEADROOM_PYTHON_NOT_FOUND: 'Python 3.10以上が見つかりません。設定にPythonの絶対パスを指定してください。',
    HEADROOM_UNHEALTHY: 'Headroomが正常なhealth応答を返しません。ポート競合または導入状態を確認してください。',
    HEADROOM_PORT_IN_USE: 'Context Kit以外のプロセスが自動圧縮用のポート（既定8787）を使用しています。Context Kitはそのプロセスを終了しません。そのプロセスを終了するか、設定「contextkit.proxy.port」を空いているポートに変えてから「自動圧縮を開始」を実行してください。',
  };
  const AUTH_RETRY_CODES = new Set(['HEADROOM_AUTH_REQUIRED', 'HEADROOM_AUTH_FAILED', 'HEADROOM_AUTH_TIMEOUT']);
  const AUTH_RETRY_LABEL = 'Headroomを認証し直す';
  const commandError = error => {
    const code = typeof error?.code === 'string' ? error.code : 'CONTEXTKIT_COMMAND_FAILED';
    return { code, message: errorMessages[code] || 'Context Kitの処理を完了できませんでした。設定と対象ファイルを確認してください。' };
  };
  const safeCommand = callback => async (...args) => {
    try { return await callback(...args); }
    catch (e) {
      const { code, message } = commandError(e);
      console.error(`Context Kit command failed: ${code}`);
      if (AUTH_RETRY_CODES.has(code)) {
        void Promise.resolve(vscode.window.showErrorMessage(message, AUTH_RETRY_LABEL)).then(choice => {
          if (choice === AUTH_RETRY_LABEL) return vscode.commands.executeCommand('contextkit.proxyAuth');
        }).catch(() => {});
      } else vscode.window.showErrorMessage(message);
      return { error: message, code };
    }
  };
  for (const [name, callback] of Object.entries({ setup, overview: showOverview, stats: showStats,
    registerGlossary: () => registerDocuments('glossary'), registerDesign: () => registerDocuments('design'),
    proxySetup, proxyAuth, proxyStart, proxyStop, proxyStatus, proxyUninstall,
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
        if (result.cancelled) {
          stream.markdown(result.message);
          stream.button({ command: 'contextkit.setup', title: '初期設定をもう一度開く' });
        }
        else {
          stream.markdown(`**初期設定を保存しました。接続確認は次の操作で行います。**\n\n新規作成 ${result.created.length}件、追記 ${result.updated.length}件。既存の資料は上書きしていません。\n\n${result.warnings.join('\n\n')}\n\n通常のCopilotには、対応するログ・JSON・テキスト・Markdownを読む際にkit_readを優先する指示を追加しました。モデル判断や実行許可によっては自動で呼ばれない場合があります。\n\nHeadroomを設定すると、macOSでは送信前にログ・JSON・反復ツール出力を自動圧縮できます。密な自然文は縮まらない場合があり、意味要約や決定事項の長期整理は既存のhandoff・資料管理が担当します。`);
          stream.button({ command: 'contextkit.proxySetup', title: '自動圧縮を設定する' });
          stream.markdown('\n\n「kit_contextで共通知識の一覧を見せて」と依頼し、接続とツール実行を確認してください。\n\n既存の用語集や設計書がある場合は、下のボタンから登録できます。');
          stream.button({ command: 'contextkit.registerGlossary', title: '用語集を登録する' });
          stream.button({ command: 'contextkit.registerDesign', title: '設計書を登録する' });
        }
      } else if (intent === 'overview') stream.markdown(fenced(formatContextOverview(JSON.parse(await requireKit().context()))));
      else if (intent === 'stats') stream.markdown(fenced(formatStats(await requireKit().stats())));
      else if (intent === 'proxySetup') {
        stream.progress('自動圧縮の設定画面を開きます。');
        const result = await proxySetup();
        stream.markdown(result.cancelled ? '**自動圧縮の設定をキャンセルしました。**' :
          result.authenticationRequired ? '**Headroomを導入しました。表示された案内から認証すると、自動圧縮を開始できます。**' :
          '**自動圧縮の設定が完了しました。**');
      } else if (intent === 'proxyAuth') {
        stream.progress('Headroom認証を最初からやり直します。表示される通知のURLとコードで認証してください。');
        const result = await proxyAuth();
        stream.markdown(result.cancelled ? '**新しい認証に切り替えたため、この認証は中止しました。**' : '**Headroom認証が完了し、自動圧縮を開始しました。**');
      } else if (intent === 'proxy') stream.markdown(fenced(JSON.stringify(await proxyStatus(), null, 2)));
      else { stream.markdown('初期設定専用の窓口です。**@contextkit /setup**、**@contextkit /compress**、**@contextkit /auth**、**@contextkit /status**、**@contextkit /stats** が使えます。一般の実装や相談は通常のCopilotへ戻って依頼してください。'); stream.button({ command: 'contextkit.setup', title: '初期設定を始める' }); stream.button({ command: 'contextkit.proxySetup', title: '自動圧縮を設定する' }); }
    } catch (e) {
      const { code, message } = commandError(e);
      console.error(`Context Kit chat failed: ${code}`);
      stream.markdown(`**${message}**`);
      if (AUTH_RETRY_CODES.has(code)) stream.button({ command: 'contextkit.proxyAuth', title: AUTH_RETRY_LABEL });
    }
    return {};
  });
  context.subscriptions.push(participant, changed);
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { if (root && !permittedRoot(root)) void stop(); }));
  if (context.workspaceState.get('contextkit.enabled')) {
    const saved = context.workspaceState.get('contextkit.root');
    if (saved && permittedRoot(saved) && vscode.workspace.isTrusted && !vscode.env.remoteName) await start(saved);
  }
  if (headroom && context.globalState?.get?.('contextkit.proxy.enabled')) {
    void headroom.start().catch(() => vscode.window.showErrorMessage?.('Headroom自動圧縮を再開できません。自動圧縮の状態を確認してください。'));
  }
  const dispose = async () => { if (disposed) return; disposed = true; await stop(); await headroom?.dispose(); };
  context.subscriptions.push({ dispose: () => { void dispose(); } });
  return exposeLifecycle ? { dispose, start, stop, proxySetup, proxyAuth, proxyStart, proxyStop, proxyStatus, proxyUninstall } : { dispose };
}
