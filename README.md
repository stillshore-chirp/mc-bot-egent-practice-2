# mc-bot-egent-practice-2

Minecraft Java Edition の世界に一人のプレイヤーとして接続し、指定利用者と日本語で会話しながら、観測したゲーム状態に基づいて安全に行動する AI コンパニオンです。

## プロジェクトの目的

AI コンパニオンが、Minecraft で観測した状況と利用者との継続的な関係を基に、安全に会話・判断・行動できる状態を実環境で成立させます。成功・失敗の正本は LLM の自己申告ではなく、Minecraft で確認した状態です。

## 目指す理想

- 安定した名前、人格、価値観、話し方を持つ。
- 利用者との関係、共有体験、約束、世界内の場所や経験を継続的に記憶する。
- 再起動や session をまたいでも、同じ存在として振る舞う。
- 行動は中断可能で、安全境界と失敗時の回復手段を持つ。
- LLM は会話と高水準の判断に使い、即時性・安全性が必要な処理は決定論的な実行機構で扱う。

## 初期目標

- Minecraft への接続と指定利用者との日本語会話
- 利用者への追従と即時停止
- 空腹、危険、被ダメージ、経路詰まり、切断への即時対応
- 利用者情報、場所、約束、共有体験の永続記憶
- 複数工程を含む原木収集依頼の実行と観測状態による結果検証

## 現在の状態

初期完成版の製品コード、unit / integration test、設定例、運用文書を実装しています。2026-08-25に、許可済みのローカルLAN test world、Minecraft Java Edition 1.21.11、実OpenAI Responses APIを使い、[実環境E2Eの12項目](docs/testing.md#2026-08-25-実施結果)を追跡可能な一連のrunで確認しました。最終対話式runnerは12件pass、fail / skipなし、終了code 0でした。

確認範囲は単一のローカル環境です。remote / managed server、異なるworld条件、認証構成の網羅、複数hostile配置での修正後退避、長時間連続soak、他OSは未確認です。依存経路の既知のmoderate advisoryはIssue #4で追跡し、high / criticalを品質gateにしています。

初期完成版では次を一続きの体験として扱います。

- 指定利用者の日本語チャットを受け取り、型付き tool を通じて行動する。
- 追従、即時停止、空腹、危険、被ダメージ、経路詰まり、切断を決定論的な実行層で扱う。
- 人格、利用者との関係、明示された事実、場所、約束、共有体験、作業結果を SQLite へ構造化して保存する。
- 指定種類・指定数の原木を集め、依頼者へ戻り、inventory の観測値から完了または失敗を報告する。

製品経路には固定応答の会話実装、fake Minecraft、fake LLM、書込みを省略するmemory fallbackを含めません。外部境界のtest doubleは`tests/`内だけに置き、製品buildから除外します。

## 非目標

旧リポジトリとの互換レイヤ、複数 bot、複数 LLM provider、MCP、LangGraph、VPT、MineDojo、Paper plugin、Web dashboard、音声会話、クラウド常駐、汎用 plugin 基盤、Minecraft サーバー管理機能は初期完成版の範囲外です。LLM に shell、任意コード、任意ファイル操作、サーバー管理コマンドは公開しません。

## 必要環境

- Node.js 24 を推奨します。Node.js 22 以上を CI で検証します。
- npm と、ローカルへ書込み可能な SQLite の保存先。
- 実 E2E 時のみ、Mineflayer が直接対応する Minecraft Java Edition サーバー、許可された bot 接続情報、指定利用者、実 OpenAI API の利用資格とネットワーク到達性。

Minecraft の接続先、player 名、API key、token、world seed、私的座標、会話、実記憶データを repository、Issue、PR、log 要約へ保存しません。

## 最短のローカル起動手順

```bash
npm ci
cp .env.example .env.local
```

`.env.local` の必須値を、その環境で許可された実値に設定します。`OPENAI_API_KEY`、Minecraft 接続情報、`OWNER_USERNAME` が不足または不正な場合、アプリケーションは接続や tool 実行の前に設定エラーとして停止する必要があります。

```bash
npm run dev
```

実 OpenAI API と実 Minecraft server を操作する前に、対象 server、world、bot account、許可された操作範囲を確認してください。実環境の詳細手順は [docs/testing.md](docs/testing.md#実環境-e2e) と [docs/operations.md](docs/operations.md) にあります。

指定利用者はMinecraft chatから、例えば次のように依頼します。文面を後段の正規表現でcommandへ変換せず、OpenAI Responses APIが公開済みのstrict tool schemaから操作を選びます。

```text
ついてきて。距離は3ブロック、1分まで。
oak_logを4個集めて、ここへ戻ってきて。
停止
この場所を「川沿いの拠点」、用途を「帰還場所」として覚えて。
```

`停止`、`停止して`、`止まって`、`止めて`、`ストップ`、`やめて`、`中止`、`中断`はLLM待ちを経ず、ownerの完全一致chatとして即時処理します。

## 設定

[.env.example](.env.example) は設定名、必須性、既定値だけを示します。実値は無視対象の `.env.local` にだけ保存します。

| 区分      | 必須設定                                                 | 既定設定                                                                         |
| --------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Minecraft | `MINECRAFT_HOST`、`MINECRAFT_USERNAME`、`OWNER_USERNAME` | port `25565`、auth `microsoft`、version `1.21.11`                                |
| OpenAI    | `OPENAI_API_KEY`                                         | model `gpt-5.6-luna`                                                             |
| 永続化    | なし                                                     | `DATABASE_PATH=data/companion.sqlite`                                            |
| 安全上限  | なし                                                     | 移動距離、採取数、timeout、retry、追従距離、空腹しきい値は `.env.example` を参照 |
| live E2E  | なし                                                     | `LIVE_E2E_CONFIRMED=false`。許可済みtest worldでだけ`true`にする                 |

人格の安定した設定は [config/persona.example.json](config/persona.example.json) にあります。利用中に変化する関係・記憶・約束は SQLite に保存します。

## 開発・検証

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:high
```

GitHub Actions は Node.js 22 と 24 の両方で上記の品質確認を実行します。live E2E は API key や Minecraft 接続情報を CI に渡さないため自動実行しません。

```bash
npm run test:e2e
```

この command は実環境用です。必須設定・利用権限・安全な test world が揃わない場合は接続や API 呼出しを行わず、明確な設定エラーとして終了させます。手順と受け入れ項目は [docs/testing.md](docs/testing.md#実環境-e2e) を参照してください。
対話式runnerは`.env.local`の`LIVE_E2E_CONFIRMED=true`を追加の安全gateとし、12項目すべてに実worldの観測に基づく`pass`が入力された場合だけ成功終了します。項目ごとに接続、health / food / oxygen、task state、原木収集数、ローカル追跡用の相関IDをJSONとして出力し、記憶復元項目の前にはapplicationを実際に再生成・再接続します。runnerの原文は実環境情報を含み得るため、repository、Issue、PRへ保存しません。

## 文書

- [アーキテクチャ](docs/architecture.md)
- [人格と記憶](docs/memory.md)
- [テストと実環境 E2E](docs/testing.md)
- [運用](docs/operations.md)
- [エージェント作業契約](AGENTS.md)
