# アーキテクチャ

この文書の従来のagent / tool / runtime / skill記述はlegacy helper経路の設計記録です。既定のAIプレイヤー／行動系GPTの経路は `src/player` と `src/app/player-application.ts`、判断知識を担うMC Bot Skillsは `src/mc-skills` です。PlayerBodyは判断されたゲーム操作を実行します。旧 `src/skills`、`src/decision`、`src/reflexes`、tool executionはhelperとして残ります。新しい設計は[自律プレイヤー](autonomous-player.md)と[PlayerBody](player-body.md)を参照してください。コード上のunit / integration testと、実Minecraft・実OpenAI APIによる観測は別の証跡です。実環境で未確認の機能を、この文書だけで確認済みとは扱いません。

AIプレイヤー／行動系GPTが、危険や死亡を伴う行動と自律的な建築を含めて判断し、強いowner要求に応じて選択を変えます。MC Bot Skillsはその判断知識を担い、PlayerBodyは判断結果のゲーム操作を実行します。通常のBukkit・サーバー権限とownerの永続停止を守り、credential、shell、任意コード、server admin accessを公開しません。

## 境界

アプリケーションは Node.js / TypeScript strict の単一プロセスです。Minecraft 操作は Mineflayer、永続化は SQLite、会話と tool calling は OpenAI Responses API を使います。Python process、独自 WebSocket bridge、別言語の重複した command 定義は導入しません。

## 技術選定

一次情報とpackage metadataを確認し、次を固定しています。

- Node.jsは24 LTSを推奨し、依存packageが対応する22 / 24をCI matrixにする。[Node.js Releases](https://nodejs.org/en/about/previous-releases)
- 本リポジトリで固定するMineflayer 4.37.1はMinecraft 1.21.11対応をreleaseで明記しているため、既定のBot接続先を1.21.11にする。[PrismarineJS/mineflayer 4.37.1](https://github.com/PrismarineJS/mineflayer/releases/tag/4.37.1) 26.1クライアントを使う検証では、[サーバー側の互換構成](minecraft-26-1.md)を別に指定する。Botの`MINECRAFT_VERSION`をクライアント版に合わせて変更しない。
- LLMは公式`openai` TypeScript SDKのResponses APIとstrict function callingを使い、既定modelは`gpt-6-luna`とする。[OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)、[gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- 永続化は埋め込み型SQLiteとFTS5を使う。初期版でnetwork database、vector database、provider抽象化を追加しない。

依存versionは`package.json`と`package-lock.json`へ完全固定します。Mineflayerの認証推移から入るmoderate advisoryは実装成功と分けて追跡し、脆弱な旧Mineflayerへのdowngradeを自動修正として採用しません。

次の図と後続の責務表はlegacy helperの構造です。既定PlayerBodyのruntime図ではありません。

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

旧Bot helperの体力・空腹・酸素・水中状態は、`observedAt`、`subject: "bot"`、`source: "minecraft"` を持つ同一の観測として扱います。`observe_status` と `observe_surroundings` は `requesterVitals: "unobserved"` を返し、利用者の体調をBotの値から推測しません。酸素の低下は同じ観測の `inWater` と `oxygenState` を使って判定し、範囲外または取得できない値は `unknown` として発話や低酸素の断定に使いません。旧reflex helperが介入した場合は、開始観測、終了観測、介入結果、失敗分類を記録します。

## Legacy helperの責務

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

### Legacy reflex loop

Minecraft の高頻度観測を受け、次の優先順位で処理します。

1. 停止・緊急退避
2. 生存と安全
3. 指定利用者の明示指示
4. 進行中の主作業
5. 自律的な待機

旧reflex helperではownerの停止を現在の移動、採掘、LLM応答の完了を待たずに処理し、空腹、落下、溺水、窒息、溶岩、炎、敵対Mob、被ダメージ、経路詰まり、切断への反応を実装しています。この危険回避優先順位は既定PlayerBodyの禁止規則ではありません。PlayerBodyでもownerの永続停止は即時に反映します。

### Legacy deliberation loop

以下はlegacy helperの呼出し契約です。既定AIプレイヤー／行動系GPTの自律判断は[自律プレイヤー](autonomous-player.md)に従い、PlayerBodyはそこで選ばれた操作を実行します。

1. 指定利用者かを判定し、会話参加と操作権限を分けます。
2. 現在 snapshot、関連する人格・記憶・主作業を最小範囲で集めます。
3. OpenAI へ公開済み function schema だけを渡します。
4. function call の name と引数を schema で検証します。不正な応答は推測実行せず、validation error として再要求または停止します。
5. tool と skill は実行前後の snapshot、結果、failure detail を runtime へ返します。
6. verification の結果を根拠に、利用者へ日本語で結果を説明します。

## Legacy tool と skill

この節のtool一覧と制約は旧agent/runtime helperだけに適用されます。`plan_safe_action`、resource候補、数量上限、建築・設置の専用認可は既定AIプレイヤー／行動系GPTの判断を制限する共通policyではありません。

旧helperが公開するtoolは `observe_status`、`observe_surroundings`、`plan_safe_action`、`select_safe_resource`、`say`、`follow_player`、`stop_current_action`、`move_to`、`gather_resource`、`return_to_player`、`remember_player_fact`、`remember_location`、`recall_memory`、`set_commitment`、`complete_commitment` です。旧 `plan_safe_action` は利用者の目的に対して観測プロバイダが返した候補を選び、上限付き手順を順に実行します。残量がある場合は数量差分を確認してから同じtool処理内で再観測・再計画します。段階ごとのtool検証、再観測、数量差分確認が失敗した場合は後続手順を開始しません。1回の計画は最大8段階、再計画は最大64回、全体の実行時間は最大120秒（設定値が短い場合はその値）で、AbortSignalを各段階で確認します。期限signalは停止signalと結合し、期限到達時はMinecraft操作を中断して確認できた部分だけをfailure receiptとして返します。`select_safe_resource` は互換用に残し、原木の保護判定済み候補から選びます。候補観測に失敗した場合は推測実行せず停止し、具体的な確認を返します。

所有者の高水準な資源目標は、その依頼メッセージから数量と許可されたcanonical resource IDを取り出して現在のtool contextへ一時的に結び付けます。数量が不足している場合は、同じ所有者の次の一発話にある単独の数量回答だけを、5分以内の短命pending goalへ結び付けます。別依頼や陳述は認可として扱わず、ownerのpending goalを消費または新しい目的へ置き換えます。第三者にはpending goalを渡しません。runtime再評価は読み取りだけでpendingを消費せず、停止とshutdownでは破棄します。Minecraftのregistryまたはproviderがブロックのdrop・recipeから最終inventory itemを確認できる候補だけを実行対象にし、未知の出力名は具体的な最終アイテム確認を一度だけ返します。認可済みのbounded resource計画は同じrequest contextから一度だけ起動でき、実行結果で確認した数量だけを残量として記録します。採掘した鉱石やraw素材は中間進捗として記録しますが、最終目標itemの所持品差分へ加算せず、中間素材の累積量も目標数を超えて増やしません。

各 tool は単一 schema から TypeScript 型、runtime validation、OpenAI function schema、test fixture、統一 failure detail を得ます。登録だけで実処理を持たない tool は置きません。原木収集による約束の完了は、同じ利用者のactiveな型付きfulfillment、resource / count、inventory差分、帰還距離、同一correlationを照合した一度限りのreceiptを必要とし、停止・失敗・cancelled作業からは発行しません。

各長時間 skill は、型付き input、precondition、実行、cancel、timeout、retry 条件と上限、前後 snapshot、success condition、failure classification、利用者向け summary を持ちます。追従はpathの`noPath`、timeout、stuck等を数え、設定上限で明示的に失敗します。`gather_resource` は原木探索・移動・採取・drop 回収・数量確認・依頼者の再観測位置への帰還を一つのskillで扱い、inventory差分と帰還距離のverificationで依頼を閉じます。採掘前に対象面へのline of sightと同一blockを再検証し、dropは破壊地点近傍の同一itemだけを追跡します。一過性の採掘経路失敗は上限内で再試行し、対象が変化した場合はresource探索へ戻ります。

## Legacy helperの設定・起動

設定は環境変数を strict に parse します。Minecraft host、bot username、owner username、OpenAI API key が不足・不正な場合は、Minecraft 接続または API 呼出しの前に設定エラーで停止します。値の上限は移動距離、採取数、task timeout、retry、追従距離、空腹しきい値、再接続、memory context に適用します。

接続情報と API key は `.env.local` に置き、SQLite・構造化ログ・例示文書に保存しません。設定名と既定値は [.env.example](../.env.example) を正本とします。

## Legacy helperの失敗・再起動

失敗は connection、observation、path、resource、inventory、authorization / permission、timeout、cancelled、LLM、persistence、safety、validation、internal に分類します。AsyncLocalStorageで保持する各主作業の相関 IDを構造化ログとtask recordへ渡し、利用者依頼、tool、skill、Minecraft操作、verificationを安全に追跡します。

graceful shutdown 時には、進行中taskをsuspendedへ遷移してcheckpointとmemoryを保存します。再起動時、完了を観測できないtaskは成功へ遷移させず、未完了の約束とともにread-onlyのdeliberationで再評価します。自動再開はせず、ownerの新しい指示を待ちます。切断時は設定回数・間隔で再接続し、上限後はconnection managerを`failed`へ遷移して安全な構造化ログとlive evidenceへ残します。復旧できた場合は、接続後の実snapshotを再評価してMinecraft chatへ報告します。

## Legacy helperの原木保護

[legacy helper向け建築保護](building-protection.md)は、旧Bot採掘の許可根拠をPaper補助で再確認する契約です。TreeGuardのイベント制限は `legacy-bot-action-guard.enabled: true` を明示した時だけ有効です。既定PlayerBodyではTreeGuardを必要とせず、通常のサーバー権限と保護を使います。
