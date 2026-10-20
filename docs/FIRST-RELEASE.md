# 最初のVSIX公開：リポジトリ管理者の1回だけの操作

## 現在の状態

v0.4.0の拡張ソースと初期設定機能はGitHubへ反映済み、自動テスト98件合格です。
**インストール用のVSIXはまだ公開していません。** GitHub接続から `.github/workflows/` を追加する操作が403で拒否されました。通常のソースファイルの保存は成功しています。
権限を迂回して実行はしません。以下は、リポジトリ管理者が内容を確認し、自分の権限で初回公開を承認するための手順です。

## 方法A：接続の権限を確認してAIに続行を依頼

GitHub接続に、対象リポジトリのContents（書き込み）だけでなく、**Workflows（書き込み）**の権限があるか確認してください。
Fine-grained PATならWorkflowsのRead and write、従来型PATならworkflowスコープが該当します。組織の制限など、他の原因もあり得ます。
**アクセストークンをチャットへ貼る必要はありません。** 適切な接続経由で権限を設定した後、「VSIXの公開を続けて」と依頼してください。

## 方法B：管理者がGitHub画面から設定を登録

この方法でも、管理者自身にワークフローを追加する権限が必要です。コードの内容を確認してから承認してください。

1. [用意済みの自動配布設定](../integration/release-vsix.workflow.yml) を開き、Copy raw fileボタンなどで全文をコピー。
2. [GitHubで新しい設定ファイルを作る](https://github.com/onoayami/token_compression/new/main?filename=.github%2Fworkflows%2Frelease-vsix.yml)。ログインし、対象が自分のリポジトリであることを確認。
3. ファイル名が `.github/workflows/release-vsix.yml` であることを確認して、コピーした内容を貼る。内容を確認し、mainへCommit changes。
4. [Actions](https://github.com/onoayami/token_compression/actions) で「Build and release easy-install VSIX」の完了を待つ。リポジトリ側でActionsが無効なら、管理者が方針を確認して有効化する必要があります。
5. 成功したら [Releases](https://github.com/onoayami/token_compression/releases/latest) に **contextkit.vsix** と検証用のSHA-256ファイルが現れます。

設定が行うのは、テスト→コードと空の雛形の取りまとめ→公式 `@vscode/vsce` によるVSIX作成→Releaseへの添付です。
GitHubの標準GITHUB_TOKENに `contents: write` を指定し、公開版の作成に使用します。追加の秘密情報は不要です。Marketplaceへの公開、他のリポジトリの変更は行いません。
公開済みの同じ版は上書きしません。再配布時は版を上げてください。

## VSIXが公開された後：利用者の導入

1. **contextkit.vsix** をダウンロード（Source code.zipではありません）。
2. VS Codeの拡張機能画面の「…」→「VSIXからのインストール」。
3. 自分の作業フォルダを開き、チャットに **@contextkit 初期設定**。
4. 目的とMarkdown設計書を選び、「設定する」で確定。

拡張利用者はNode.jsやPythonを追加で入れる必要がない構成です。実際のVS Code上のUI・Copilot接続はまだ未検証なので、[受け入れチェック](VERIFICATION.md) で確認してください。
