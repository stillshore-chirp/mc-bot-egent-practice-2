# アーキテクチャ

この文書は初期完成版の設計契約を示します。コード上の unit / integration test と、実 Minecraft・実 OpenAI API による観測は別の証跡です。実環境で未確認の機能を、この文書だけで確認済みとは扱いません。

## 境界

アプリケーションは Node.js / TypeScript strict の単一プロセスです。Minecraft 操作は Mineflayer、永続化は SQLite、会話と tool calling は OpenAI Responses API を使います。Python process、独自 WebSocket bridge、別言語の重複した command 定義は導入しません。

## 技術選定

2026-08-25時点の一次情報とpackage metadataを確認し、次を固定しています。

- Node.jsは24 LTSを推奨し、依存packageが対応する22 / 24をCI matrixにする。[Node.js Releases](https://nodejs.org/en/about/previous-releases)
- Mineflayer 4.37.1はMinecraft 1.21.11対応をreleaseで明記しているため、既定versionを1.21.11にする。未releaseのMinecraft対応や互換proxyを前提にしない。[PrismarineJS/mineflayer 4.37.1](https://github.com/PrismarineJS/mineflayer/releases/tag/4.37.1)
- LLMは公式`openai` TypeScript SDKのResponses APIとstrict function callingを使い、既定modelは公式model catalogに掲載された`gpt-5.6-luna`とする。[OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)、[gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- 永続化は埋め込み型SQLiteとFTS5を使う。初期版でnetwork database、vector database、provider抽象化を追加しない。

依存versionは`package.json`と`package-lock.json`へ完全固定します。Mineflayerの認証推移から入るmoderate advisoryは実装成功と分けて追跡し、脆弱な旧Mineflayerへのdowngradeを自動修正として採用しません。

```text
authorized chat / task event
            |
            v
agent -> persona + memory context -> OpenAI Responses API
  |                                      |
  |                         typed function call only
  v                                      v
tools -> runtime -> skills -> minecraft adapter -> Minecraft server
  |         |           |             |
  |         |           +-> verification snapshots
  |         +-> cancellation / timeout / priority
  +-> schema validation / user-facing result

Minecraft observations -> reflexes -> runtime cancellation or safety action
all execution boundaries -> observability (correlation ID, redacted logs)
```

依存は高水準の会話・tool から低水準の runtime・Minecraft adapter へ向けます。`memory` と `persona` は agent が読む状態であり、Minecraft adapter に依存しません。`verification` は action 前後の snapshot を比較して結果を返し、LLM の自己申告を成功根拠にしません。

## 責務

| 領域            | 責務                                                                 | 境界                                                                       |
| --------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `minecraft`     | Mineflayer 接続、観測、移動、採掘、inventory、切断イベント           | 実際の server state だけを観測結果として返す                               |
| `runtime`       | 一つの主作業、状態遷移、優先順位、cancel、retry、timeout、checkpoint | `queued / running / suspended / completed / failed / cancelled` を区別する |
| `reflexes`      | 停止、空腹、危険、被ダメージ、stuck、切断への即時対応                | LLM を呼ばない                                                             |
| `tools`         | LLM に公開する高水準操作と input validation                          | schema 不正な引数を実行しない                                              |
| `skills`        | 複数操作を含む決定論的な実行単位                                     | precondition、cancel、timeout、retry、snapshot、success / failure を持つ   |
| `agent`         | 日本語会話、tool calling、検証済み結果の説明                         | 自然文を後段の keyword / regexp で命令へ変換しない                         |
| `persona`       | 安定した人格設定と context の生成                                    | repository 管理の設定を読む                                                |
| `memory`        | SQLite の保存、検索、訂正、再起動復元                                | 生の会話を無制限に再投入しない                                             |
| `verification`  | action 前後 snapshot と成功条件の照合                                | 未観測の成功を返さない                                                     |
| `config`        | 環境変数の parse、上限値、起動時 validation                          | credential 不足時は fail-fast                                              |
| `observability` | 相関 ID、構造化ログ、失敗分類、redaction                             | secret、会話全文、実識別子を出さない                                       |

## 実行ループ

### Reflex loop

Minecraft の高頻度観測を受け、次の優先順位で処理します。

1. 停止・緊急退避
2. 生存と安全
3. 指定利用者の明示指示
4. 進行中の主作業
5. 自律的な待機

停止は現在の移動、採掘、LLM 応答の完了を待ちません。空腹、落下、溺水、窒息、溶岩、炎、敵対 Mob、被ダメージ、経路詰まり、切断は決定論的に検出・処理します。敵対Mobからの退避は、観測した全hostileに対する走行線分上の最近接距離を比較し、環境hazardの退避とは分離します。経路探索の再試行は設定上限を超えず、上限到達時は失敗理由を残します。

### Deliberation loop

LLM を呼ぶ契機は、新しい利用者発話、tool内の作業完了、起動時の未完了約束・suspended作業、安全介入後、接続復旧後の再評価に限ります。Minecraft tick、移動の一歩、採掘の一打ごとに呼び出しません。runtime再評価はsingle-flight gateで直列化し、より新しい状態変化へまとめ、停止・shutdown後の古い生成結果を破棄します。再評価では観測と記憶参照toolだけを許可し、新しい移動・採取・記憶更新はownerの新しい明示指示まで開始しません。

1. 指定利用者かを判定し、会話参加と操作権限を分けます。
2. 現在 snapshot、関連する人格・記憶・主作業を最小範囲で集めます。
3. OpenAI へ公開済み function schema だけを渡します。
4. function call の name と引数を schema で検証します。不正な応答は推測実行せず、validation error として再要求または停止します。
5. tool と skill は実行前後の snapshot、結果、failure detail を runtime へ返します。
6. verification の結果を根拠に、利用者へ日本語で結果を説明します。

## Tool と skill

初期版で公開する tool は `observe_status`、`observe_surroundings`、`say`、`follow_player`、`stop_current_action`、`move_to`、`gather_resource`、`return_to_player`、`remember_player_fact`、`remember_location`、`recall_memory`、`set_commitment`、`complete_commitment` です。

各 tool は単一 schema から TypeScript 型、runtime validation、OpenAI function schema、test fixture、統一 failure detail を得ます。登録だけで実処理を持たない tool は置きません。原木収集による約束の完了は、同じ利用者のactiveな型付きfulfillment、resource / count、inventory差分、帰還距離、同一correlationを照合した一度限りのreceiptを必要とし、停止・失敗・cancelled作業からは発行しません。

各長時間 skill は、型付き input、precondition、実行、cancel、timeout、retry 条件と上限、前後 snapshot、success condition、failure classification、利用者向け summary を持ちます。追従はpathの`noPath`、timeout、stuck等を数え、設定上限で明示的に失敗します。`gather_resource` は原木探索・移動・採取・drop 回収・数量確認・依頼者の再観測位置への帰還を一つのskillで扱い、inventory差分と帰還距離のverificationで依頼を閉じます。採掘前に対象面へのline of sightと同一blockを再検証し、dropは破壊地点近傍の同一itemだけを追跡します。一過性の採掘経路失敗は上限内で再試行し、対象が変化した場合はresource探索へ戻ります。

## 設定・起動

設定は環境変数を strict に parse します。Minecraft host、bot username、owner username、OpenAI API key が不足・不正な場合は、Minecraft 接続または API 呼出しの前に設定エラーで停止します。値の上限は移動距離、採取数、task timeout、retry、追従距離、空腹しきい値、再接続、memory context に適用します。

接続情報と API key は `.env.local` に置き、SQLite・構造化ログ・例示文書に保存しません。設定名と既定値は [.env.example](../.env.example) を正本とします。

## 失敗・再起動

失敗は connection、observation、path、resource、inventory、authorization / permission、timeout、cancelled、LLM、persistence、safety、validation、internal に分類します。AsyncLocalStorageで保持する各主作業の相関 IDを構造化ログとtask recordへ渡し、利用者依頼、tool、skill、Minecraft操作、verificationを安全に追跡します。

graceful shutdown 時には、進行中taskをsuspendedへ遷移してcheckpointとmemoryを保存します。再起動時、完了を観測できないtaskは成功へ遷移させず、未完了の約束とともにread-onlyのdeliberationで再評価します。自動再開はせず、ownerの新しい指示を待ちます。切断時は設定回数・間隔で再接続し、上限後はconnection managerを`failed`へ遷移して安全な構造化ログとlive evidenceへ残します。復旧できた場合は、接続後の実snapshotを再評価してMinecraft chatへ報告します。
