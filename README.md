# Copilot Context Kit — 友人に渡して改造するための試作版

**会話の引き継ぎ ＋ 読む資料の整理 ＋ 要点から原文へ戻る足掛かり。**
VS Code の GitHub Copilot を想定した小さなスターターです。Headroom のクローンではなく、ソースコードを流用せず独立に実装しています。

## インストールだけで使える？

**VS Codeの拡張機能ストアから入れる完成品ではなく、初回設定が必要な試作版です。**
ただし、このリポジトリ自体を開いて試すための接続設定と4つのプロンプトは同梱しています。

1. Node.js 20以上をインストール（入っていれば不要）。VS CodeとGitHub Copilotを利用できる状態にする。
2. GitHubの「Code → Download ZIP」で取得・展開し、`package.json` と `README.md` があるフォルダをVS Codeで開く。
3. 同梱 `.vscode/mcp.json` の context-kit サーバーを確認して起動。信頼・実行許可は内容を確認してから承認する。
4. Copilotのエージェントチャットで「kit_readで examples/sample.log をsafeで読んで」と依頼する。
5. `/context-stats` で圧縮状況を確認する。プロンプトが出なければ「kit_statsで統計を見せて」と依頼する。

`npm install` は不要です。組織ポリシーやVS Codeの版によって追加設定が必要になることがあります。
このフォルダでの確認と、友人の**別の開発プロジェクトへ組み込む作業**は別です。後者は以下の接続手順を使ってください。

## 何が入っているか

| 部品 | 役割 |
| --- | --- |
| 引き継ぎ用プロンプト | Copilot が現在の会話から、確定事項・未解決事項・根拠付きのメモを作る |
| 再開用プロンプト | 利用者が開いた新しいチャットで、メモと必要な原文だけを読む |
| ローカル MCP | ログの重複・JSONの余分な空白を整理してから Copilot に渡す |
| 圧縮状況レポート | 圧縮前後のサイズ・削減率・説明や原文再取得を含めた参考差を表示 |
| 原文保存・照合 | 保存版ID、SHA-256、原文行範囲、引用一致、現在のファイルからの変更を確認する |

**大切：Copilot 内部の会話履歴を、このプログラムが自動で置き換えるわけではありません。**
引き継ぎメモを確認 → 利用者が新しいチャットを開く → メモから再開、という流れです。
同じチャットに要約を追加するだけでは、元の履歴は減りません。Copilot 標準の会話圧縮と併用しても構いません。

## 費用と環境

- Node.js **20 以上**。追加パッケージ不要。`npm install` は不要です。
- このプログラムは外部のAI APIやネットワークへ接続しません。APIキーも不要です。
- **要約・原文確認を行う Copilot の利用は、通常どおり Copilot の利用量に含まれます。無料・無制限になるものではありません。**
- OS依存を小さくした実装ですが、実際にテストしたのは Linux / Node.js 24 です。Windows・macOS・実際の VS Code 接続はご友人の環境で確認してください。

## 最初に：単体で動かす

ZIPを展開し、`package.json` のあるフォルダを VS Code で開いてターミナルで実行します。

```sh
node --version
node --test test/core.test.mjs test/server.test.mjs test/cli.test.mjs test/stats.test.mjs
node src/cli.mjs read examples/sample.log
```

先頭の `CONTEXT_KIT` 行に保存版の `snapshot_id` と `sha256` が表示されます。
表示された**実際の値**を使って原文の1〜8行を確認できます。

```sh
node src/cli.mjs source <snapshot_id> --start-line 1 --end-line 8
node src/cli.mjs stats
```

`<snapshot_id>` は説明用の置き場所です。山括弧ごと入力せず、実際のIDへ置き換えてください。
不要になったデモの保存版を削除するには、同じルートを指定して `node src/cli.mjs purge` を使います。元ファイルは消えません。

## VS Code / Copilot へ接続する

### 1. ファイルを配置

実際の開発プロジェクトの `tools/copilot-context-kit/` にこのフォルダを置く方法を推奨します。
別の場所に置いても、下記の設定生成で絶対パスを使えば動作する設計です。
WSL・Dev Container・Remote SSH の場合は、Node とパスが**サーバーを実行する側**に存在することを確認してください。

### 2. MCP設定を生成・追加

このキットのフォルダで、対象プロジェクトの絶対パスを指定します。

```sh
node src/cli.mjs config --root "/absolute/path/to/project" --format vscode
```

このコマンドは設定JSONを**表示するだけ**で、既存設定は変更しません。
生成した `context-kit` 項目を、プロジェクトの `.vscode/mcp.json` の `servers` に追加してください。
**既存のファイルを丸ごと上書きしないでください。**

VS Code の版や選択中のエージェントによって `.mcp.json`（`mcpServers` 形式）を使う場合は、次の生成結果を使ってください。両方へ重複登録する必要はありません。

```sh
node src/cli.mjs config --root "/absolute/path/to/project" --format portable
```

設定先が不明なら VS Code の `MCP: Add Server` で Command (stdio) を選び、生成結果の command と args を登録します。
起動時の信頼確認・ツール実行許可は、内容を読んでから承認してください。組織の管理設定で MCP が制限される場合もあります。

### 3. 引き継ぎ用プロンプトを配置

`integration/prompts/` の4ファイルを、開発プロジェクトの `.github/prompts/` にコピーします。
既存の同名ファイルがあれば比較してから追加してください。対応する VS Code のチャットで次が使えます。

- `/context-handoff-save`：現在の会話から引き継ぎメモを作る
- `/context-handoff-resume`：新しいチャットで再開する
- `/context-read`：今回指定した資料を整理して読む
- `/context-stats`：圧縮前後のサイズ・削減率・追加分を確認する

プロンプトファイルが使えないエージェント／版では、ファイルの YAML ヘッダーを除いた本文をチャットへ貼って実行できます。自動で毎回適用するものではありません。

### 4. 読み取りの接続を確認

Copilot のエージェントチャットで、対象プロジェクトにある機密でないファイルを指定します。

```text
context-kit の kit_read を使い、examples/requirements.md を safe で読んでください。
その後 kit_source で原文の4〜6行を確認し、申込期限と例外条件を教えてください。
コードや設定は変更しないでください。
```

キットを `tools/` 配下に置いた場合は、例のパスを `tools/copilot-context-kit/examples/requirements.md` へ変更してください。
ツール実行欄を展開し、**本当に kit_read と kit_source が呼ばれ、出力が返ったか**を確認します。
もっともらしい回答が出るだけでは接続確認になりません。

### 5. 引き継ぐ

1. 作業の区切りで `/context-handoff-save` を実行。
2. `.context-kit/handoff.md` の確定事項・根拠・未確認事項を人が確認。
3. 利用者が新しいチャットを開く。
4. `/context-handoff-resume` を実行し、今回必要な根拠だけ確認して再開。

**キット内の `.gitignore` はプロジェクト直下のファイルを保護しません。**
プロジェクト直下の `.gitignore` に、次の2行を追記してください。自動で追記はしません。

```gitignore
.context-kit-cache/
.context-kit/
```

これはGitへの混入防止であり、暗号化・バックアップ停止・クラウド同期の停止ではありません。

## 「根拠へ戻れる」仕組み

要約の末尾に出典一覧があるだけでなく、**重要な要点ごとに `[S1]` などを付け、出典台帳に保存版と原文位置を記録**します。

```text
要点 D1：申込期限は金曜日。ただし祝日は前の営業日。[S1]
状態：原文参照済（意味の確認は別途必要）

S1：元ファイル、保存版ID、SHA-256、取得日時、原文4〜5行、短い引用
```

上記は形式の例であって、実際の確認結果ではありません。
`kit_source` の quote オプションで「引用がその原文範囲に文字列として存在するか」を確認できます。
**引用一致・ハッシュ一致は、主張の正しさ・解釈・最新性・要約の完全性を保証しません。**
戻れない会話の発言番号やURLを作らず、「会話由来・利用者確認待ち」と明記します。

## 圧縮する／しない

- `safe`（既定）：ログの**完全一致する連続行**を回数付きで集約。数字・時刻を丸めたり、異なる行を同一扱いしたりしません。検出したエラー・警告の行は集約しません。
- JSON：文字列の外側の空白だけを削除。大きい整数・重複キー・数値表記・文字列内の空白はそのままです。行の抽出やレコードの間引きはしません。
- `.txt` / `.md` / `.jsonl` / `.ndjson`：この最小版では本文を自動要約しません。保存版とページ取得を提供します。
- `preview`：ログだけを先頭・末尾・検出した重要行の周辺へ絞る**情報落ちのある表示**。省略範囲を明示します。未知の重要表現は見逃し得るため、全件確認・仕様確認には使いません。
- 上限を超える本文は黙って途中で切らず、「本文未表示」と保存版IDを返します。必要箇所を `kit_source` で取得します。
- ソースコードのAST圧縮、自然文の学習モデル圧縮、任意コマンドの実行、Copilot通信の代理・認証変更は実装していません。

## 圧縮できた量を見る

Copilotでは `/context-stats`、または「kit_statsで統計を見せて」と依頼します。
ターミナルでも読めます。

```sh
node src/cli.mjs stats --format text
```

別の開発プロジェクトを対象にした場合は、同じ `--root` を指定してください。

- **資料そのもの**：圧縮前後の文字数・UTF-8バイト数・削減率。
- **追加分込みの参考比較**：説明情報と原文の再取得も含め、元資料全文と比べたバイト差。
- **確認範囲**：previewの回数、本文未表示・ページ取得、集約した繰り返し行数。
- **未計測**：Copilot全体の実トークン数・料金・会話の要約に使った消費・正確さ。

上限のため本文を表示しなかったことを「100%圧縮」とは数えません。
短い入力では説明・根拠確認分が上回ることもあり、マイナスの参考差もそのまま表示します。
旧バージョンの統計に圧縮後サイズがない場合は、その分を未計測として分けます。

## 効果を見るときの注意

`stats` は**UTF-8バイト数**を記録します。返却メタ情報と原文再取得分も含めて確認でき、短い入力なら差分がマイナスになる場合もあります。
モデルのトークン数・料金・品質を測定した結果ではありません。MCPツール定義・プロンプト・統計の呼び出し・通信の外枠・モデルが同じ文脈を繰り返し読むコストも別にかかります。
要約作成と原文確認にも消費があるため、削減率やハルシネーション低減率は保証しません。

## 追加資料

- [友人向け：改造ポイント](docs/CUSTOMIZE.md)
- [安全性と限界](docs/SECURITY.md)
- [検証の範囲](docs/VERIFICATION.md)
- [設定例](config.example.json)
- [空の引き継ぎテンプレート](examples/handoff-template.md)

## 参考にした公式公開資料

- [Headroom 公開リポジトリ](https://github.com/headroomlabs-ai/headroom)：内容別圧縮・原文再取得という考え方の参考。公開READMEではOSSとEnterpriseを区別しています。
- [Headroom LICENSE](https://github.com/headroomlabs-ai/headroom/blob/main/LICENSE)：公開リポジトリのApache 2.0を確認。別配布モデル等の条件まで一律に保証するものではありません。
- [Copilot のコンテキスト管理](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management)
- [VS Code MCP 設定](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [VS Code のプロンプトファイル](https://code.visualstudio.com/docs/copilot/customization/prompt-files)

このキット自体は MIT License です。Headroom のソースコード・モデル・ライセンス文書は組み込んでいません。
