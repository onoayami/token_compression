# Copilot Context Kit — 友人に渡して改造するための試作版

**会話の引き継ぎ ＋ 読む資料の整理 ＋ 要点から原文へ戻る足掛かり。**
VS Code の GitHub Copilot を想定した小さなスターターです。Headroom のクローンではなく、ソースコードを流用せず独立に実装しています。

## 非エンジニア向け：かんたん導入版

**VS Code用の拡張ファイル（VSIX）を入れて、チャットに `@contextkit 初期設定` と入力する方式を追加しました。**
**今回の実装作業時点では、ソース反映済み・VSIX未公開です。自動配布設定の追加がGitHub接続の権限エラーで停止しました。** 公開状況はReleasesで確認してください。この説明は自動更新されません。 管理者向けの [初回公開手順](docs/FIRST-RELEASE.md) と設定テンプレートを用意しました。以下はVSIX公開後の導入方法です。

Marketplaceには未公開です。配布ファイルは [GitHub Releases](https://github.com/onoayami/token_compression/releases/latest) に掲載します。まだ表示されない場合、ビルド・公開は完了していません。`Source code.zip` はインストール用ファイルではありません。

1. Releasesの **contextkit.vsix** をダウンロード。
2. VS Codeの拡張機能画面 → 「…」→ **VSIXからのインストール** → ダウンロードしたファイルを選ぶ。
3. 自分の作業フォルダをVS Codeで開く。
4. Copilotのチャットに **`@contextkit 初期設定`** と入力。
5. 「何をするプロジェクトか」を一言で入力し、既存のMarkdown設計書があれば選ぶ。後で記入しても構いません。
6. 作成・追記の一覧を確認して **設定する**。MCPの信頼確認が表示された場合も内容を確認する。

拡張版では**外部Node.jsのインストール・ターミナル操作・MCP設定JSONの手編集が不要になる構成**です。
既存の資料・台帳・プロンプトは上書きせず、不足分を作成します。キャッシュ等のGit混入防止のため、`.gitignore` には確認後に除外ルールを追記します。

- ローカルのデスクトップ版VS Code **1.102以降**と、利用可能なGitHub Copilotが前提。
- WSL・SSH・Dev Container・ブラウザー版は、この簡単導入版の対応対象外。下記のCLI方式を使ってください。
- 本体の自動テストと拡張APIの模擬テストは実施していますが、**実際のVS Code画面・Copilot接続は未検証**です。
- 初期設定後は通常のCopilotエージェントチャットで「kit_contextで共通知識の一覧を見せて」と依頼し、実際のツール実行を確認してください。
- `@contextkit` は初期設定・状況確認専用です。一般の相談・実装は通常のCopilotに戻って依頼します。
- 旧版の手動MCP接続がある場合は重複警告を出します。自動削除せず、MCP一覧で旧接続を停止します。

詳しくは [拡張版の操作ガイド](vscode-extension/README.md)。ソースを改造したい方・リモート開発の方は、以下の従来方式も使えます。

## 何が入っているか

| 部品 | 役割 |
| --- | --- |
| かんたん初期設定拡張 | 決まった合図から入力欄を開き、資料の棚・プロンプト・MCP接続を確認付きで用意 |
| 引き継ぎ用プロンプト | Copilot が現在の会話から、確定事項・未解決事項・根拠付きのメモを作る |
| 再開用プロンプト | 利用者が開いた新しいチャットで、メモと必要な原文だけを読む |
| ローカル MCP | ログの重複・JSONの余分な空白を整理してから Copilot に渡す |
| 共通知識の棚 | Markdownの用語集・要件・設計書・判断理由・未確認事項を登録し、必要な資料だけ選んで読む |
| 資料の状態管理 | 正式／検討中／過去版、版・範囲、本文出力記録、変更後の再確認を区別 |
| 圧縮状況レポート | 圧縮前後のサイズ・削減率・説明や原文再取得を含めた参考差を表示 |
| 原文保存・照合 | 保存版ID、SHA-256、原文行範囲、引用一致、現在のファイルからの変更を確認する |

**大切：Copilot 内部の会話履歴を、このプログラムが自動で置き換えるわけではありません。**
引き継ぎメモを確認 → 利用者が新しいチャットを開く → メモから再開、という流れです。
同じチャットに要約を追加するだけでは、元の履歴は減りません。Copilot 標準の会話圧縮と併用しても構いません。

## 費用と環境

- 拡張版はVS Code内蔵のNode実行環境を利用します。外部Nodeの追加インストールは不要です。
- CLI版・ソースの改造はNode.js **20以上**。実行時の追加パッケージや `npm install` は不要です。
- 独自の外部AI API・クラウドサービスへは接続しません。拡張版はPC内の127.0.0.1で認証付きのMCP接続を提供し、CLI版はstdioを使います。独自APIキーは不要です。
- **要約・原文確認を行う Copilot の利用は、通常どおり Copilot の利用量に含まれます。無料・無制限になるものではありません。**
- OS依存を小さくした実装ですが、実際にローカル確認したのは macOS / Node.js 24 です。Linux・Windows・Node.js 20/22/24はCIで検証する構成ですが、CI実行結果がない環境を確認済みとは扱いません。実際のVS Code接続も未検証です。

## 開発者・CLI向け：単体で動かす

ZIPを展開し、`package.json` のあるフォルダを VS Code で開いてターミナルで実行します。

```sh
node --version
npm test
node src/cli.mjs read examples/sample.log
```

同梱の `.vscode/mcp.json` と `integration/mcp.vscode.example.json` は、`PATH` に `node` がある環境向けの設定例です。環境依存を避ける場合は `node src/cli.mjs config` で生成した設定を使ってください。

先頭の `CONTEXT_KIT` 行に保存版の `snapshot_id` と `sha256` が表示されます。
表示された**実際の値**を使って原文の1〜8行を確認できます。

```sh
node src/cli.mjs source <snapshot_id> --start-line 1 --end-line 8
node src/cli.mjs stats
node src/cli.mjs context --format text
```

`<snapshot_id>` は説明用の置き場所です。山括弧ごと入力せず、実際のIDへ置き換えてください。
保存ファイル内のSHA-256は偶発的な破損検出に使う自己申告値です。改ざん対策には `kit_read` が返したSHA-256を呼び出し側で保持し、`kit_source` の `expected_sha256`（CLIでは `--sha256`）へ指定してください。照合できた場合は `integrity_status` が `matched-external-expected-hash`、指定しない場合は `self-reported-only` です。
不要になったデモの保存版を削除するには、同じルートを指定して `node src/cli.mjs purge` を使います。元ファイルは消えません。

## CLI方式でVS Code / Copilot へ接続する

拡張版で初期設定した方は、この手動接続手順は不要です。重複登録しないでください。

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

Node が見つからない場合は `node --version` と `node -p "process.execPath"` で、実行環境と絶対パスを確認してください。

### 困ったとき

- UTF-8以外のログ、NULを含むファイル、読み取り中に変化するファイルは拒否されます。ログを一時コピーしてから読み、必要ならUTF-8へ変換してください。
- 出力記録が壊れた場合は、他の処理が動いていないことを確認して `node src/cli.mjs purge --root "/absolute/path/to/project"` を実行し、必要な資料を読み直してください。
- Windowsで長いパスが必要な場合は、管理者の方針を確認したうえでレジストリの `LongPathsEnabled` を有効にし、再起動後に再実行してください。組織管理下の端末では変更できない場合があります。

### 3. 引き継ぎ用プロンプトを配置

`integration/prompts/` の6ファイルを、開発プロジェクトの `.github/prompts/` にコピーします。
既存の同名ファイルがあれば比較してから追加してください。対応する VS Code のチャットで次が使えます。

- `/context-handoff-save`：現在の会話から引き継ぎメモを作る
- `/context-handoff-resume`：新しいチャットで再開する
- `/context-read`：今回指定した資料を整理して読む
- `/context-stats`：圧縮前後のサイズ・削減率・追加分を確認する
- `/context-overview`：共通知識の登録・状態・出力記録を一覧で見る
- `/context-question-propose`：未確認事項・矛盾を記録する案を作る（承認前は書き込まない）

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
CLI方式ではプロジェクト直下の `.gitignore` に、次の2行を追記してください。CLIは自動追記しません。拡張版では初期設定の確認後に不足分を追記します。

```gitignore
.context-kit-cache/
.context-kit/
```

これはGitへの混入防止であり、暗号化・バックアップ停止・クラウド同期の停止ではありません。

## 用語集や設計書をセットする

拡張版の初期設定で `project-context/` に入力用テンプレートと登録台帳を用意します。ソースにも同じ雛形を含めています。最初はすべて「検討中・未設定」です。

```text
project-context/
  catalog.json          場所・正式性・版・適用範囲
  overview.md           プロジェクト概要
  glossary.md           用語集
  requirements.md       要件・完了条件
  design/overview.md    設計書の入口
  decisions.md          決定と理由
  questions.md          未確認事項・矛盾
```

別の開発プロジェクトへ組み込む場合は、`project-context/` をそのプロジェクトの直下へ配置してください。すでに台帳や資料がある場合は上書きせず比較・統合します。キットを `tools/` 配下へ置いただけでは、プロジェクト直下の台帳は作られません。

既存のMarkdown設計書は、コピーを増やさず catalog.json にワークスペース内の場所を登録できます。
`/context-overview` または「kit_contextで一覧を見せて」と依頼して登録状況だけ確認し、必要な資料をidで選びます。

```text
kit_contextで action=read、id=glossary を指定し、用語集だけ読んでください。
```

登録のみ・場所のみ返却・本文の一部／全体の出力記録・要再確認を分けます。内容または台帳の版や範囲の変更、根拠切れは再確認として表示します。
**一覧を見ただけでは本文を出力済みにしません。「出力記録あり」はAIの理解・内容の正しさ・人の承認の保証でもありません。**
要件・設計を正式扱いするかは利用者が決め、矛盾は勝手に解決せず questions.md へ確認案を残します。
詳しい登録方法と注意点は [共通知識の棚のガイド](docs/PROJECT-CONTEXT.md) を参照してください。

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

拡張版では **`@contextkit 圧縮状況`**。通常のCopilotでは `/context-stats`、または「kit_statsで統計を見せて」と依頼します。
ターミナルでも読めます。

```sh
node src/cli.mjs stats --format text
```

別の開発プロジェクトを対象にした場合は、同じ `--root` を指定してください。

- **資料そのもの**：圧縮前後の文字数・UTF-8バイト数・削減率。
- **追加分込みの参考比較**：説明情報・原文の再取得・共通知識一覧の返却分も含め、元資料全文と比べたバイト差。
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

- [共通知識の棚の使い方](docs/PROJECT-CONTEXT.md)
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
