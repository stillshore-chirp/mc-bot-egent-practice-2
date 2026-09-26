# 自律プレイヤー

既定の `createApplication()` は `createPlayerApplication()` を作成します。接続後に `PlayerRuntime` が起動し、チャットがなくても可視観測、persona、保存済みの関心・目標、記憶、技能候補から目的を選んで判断します。旧アプリケーションは `createLegacyApplication()` から明示的に作成できます。

## 既存機能の扱い

| 機能                                                                       | 既定アプリでの扱い     | 経路                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Minecraft接続と再接続                                                      | 再利用                 | `MineflayerClient` と `ConnectionManager`。接続設定、認証、retry policyを共有します。中断時の復旧も既存の再接続経路へ依頼します。             |
| 関係・生活状態・長期記憶                                                   | 再利用                 | `MemoryStore`。personaや関心、ownerとの関係、既往episodeをエージェントの文脈へ渡し、観測結果と目標を保存します。                              |
| Traceとdashboard                                                           | 再利用                 | `TraceService`、`TraceStore`、`DashboardHttpServer`。判断・toolのtraceとredactedな接続・health・runtime evidenceを提供します。                |
| Mineflayer身体                                                             | 新しい境界を使用       | `PlayerBody` が通常プレイヤーとして実行できる操作と可視観測を定義し、入力schemaと実際のゲーム内結果を検証します。                             |
| `ChatCoordinator`、既定Agent、`CompanionContextFactory`、旧 `ToolExecutor` | 既定経路では起動しない | これらを組み立てるのは明示的な `createLegacyApplication()` です。新しい会話・目的エージェントと同時には動きません。                           |
| `ReflexCoordinator` と決定的なゲームreflex                                 | 既定経路では起動しない | 新runtimeに並行した移動・採掘・危険回避を開始しません。必要な操作判断は一つのpurpose agentへ集約します。                                      |
| `src/runtime/` の共通処理                                                  | 用途ごとに区別         | retryやtimeoutの小さな共通処理は接続管理から利用できます。旧 `TaskRuntime` や `ActionArbiter` は新PlayerRuntimeの意思決定主体ではありません。 |
| 旧決定的skills・操作authorization wrappers                                 | 既定経路では実行しない | 旧アプリケーションの明示的なlegacy helperとして残ります。新runtimeでは許可済み操作schemaとMinecraft serverの実際のpermissionを境界にします。  |

## 会話、判断、身体の境界

所有者のMinecraft chatは独立した会話エージェントへ送られます。会話エージェントは返答、目的提案、明示的な停止・再開を扱います。目的提案はMindStoreへ先に保存され、行動中のbodyを直接変更しません。目的エージェントは現在の目的・proposal・観測・記憶を照らし、採用、妥協、辞退、別の自律目的を理由付きで選びます。owner以外のchatは受け付けません。

採用・妥協したproposalは元のtitleと意図を持つowner goalに結び付き、解決理由と一緒に以後の判断文脈へ残ります。activeとpausedのリンクgoalは直近goalの件数制限を越えて文脈に保持しますが、paused goalは自動再開しません。self由来の中間goalを完了しても、リンクされたowner intentは完了しません。owner intentの完了や放棄は明示的なgoal更新で判断し、提案を辞退した場合はgoalを自動生成しません。`locate_owner`はpending proposal、またはadopted/compromisedかつリンクgoalがactiveな時だけ所有者位置を観測します。proposal解決とgoal linkageは同じCAS transactionに入り、goal mirrorへも保存します。

目的エージェントには29種類のoperation kindと短い説明を提示します。`look`、`move_to`、`move_relative`、`dig`には現行schemaから生成した短い入力署名も添え、参照済みの現行schemaは直近4種・合計4,096文字以内で再提示します。未提示または引数が不明なschemaは必要時に `describe_operation` で取得します。最終的な `operationJson` はcommit時にも `playerOperationSchema` で検証し、既知kindの入力不正ならそのschemaを返して同じ判断内で修正できるようにします。`move_relative` は現在位置を起点とする有界な相対移動で、方角は分かるが目標座標が未観測の探索に使えます。指定offsetが到達許容range以下なら移動せずに到達済みと判定されうるため入力を拒否し、成功は実際のBody前後観測で到達と移動の両方を確認します。

経路追従はMineflayer pathfinderへ委ねます。`NavigationMovements`は平地の斜め移動で両脇の足元と頭上に通行空間を要求し、壁の角を抜ける実行不能な経路を避けます。Bodyは`path_update`の状態と経路長を座標なしの内部eventとして通知できます。このeventだけで到着や操作成功とは判定せず、Bodyの前後観測とサーバー側の確認を用います。

行動判断時のgoal変更、owner proposal解決、fact/uncertainty更新は、必要なものを`commit_action_decision.stateUpdates`へ含めると同じrevision CAS transactionで確定します。更新なしは`null`で表し、`commit_goal_state`と`update_understanding`も判断途中の単独更新用に残しています。`continue`と状態更新を同時に確定しても、進行中body操作の`actionRevision`は変わりません。goal mirrorの外部記憶保存に失敗した場合もMindStoreのcommitとaction dispatchは維持し、tool結果の`goalMemoryPersisted: false`で区別します。run13までの統合試験では自律生活の完了に至っておらず、各修正によるAPI呼び出し・token削減効果も比較条件を揃えて検証していません。

目的エージェントは `commit_action_decision` の永続commitが成功した時点で判断を完了し、余分な最終LLM roundを要求しません。CAS不一致はtool code `STALE_REVISION` と理由 `CAS_STALE`、停止は `STOPPED` で同じthought内の再試行を終え、次回の判断へ渡します。進行中操作がない`continue`とpendingでないproposalはそれぞれ `NO_ACTIVE_OPERATION`、`PROPOSAL_NOT_PENDING` として返し、同じthought内で修正できます。未commitのthoughtでは受領eventを消費せず、commit後にだけ消費します。会話エージェントは返答文を必要とするため、tool後の最終応答を引き続き取得します。

Bodyの結果、owner proposal、vitalsの変化など、判断を更新すべきイベントが思考中に届いた場合、未commitのResponses呼び出しを中断し、新しいsnapshotと未処理イベントで判断をやり直します。通常の周囲観測の変化は、思考中ならCAS revisionを進めずにイベントとして永続保存し、現在の判断が確定・終了してから次の判断へ渡します。これにより移動中の視界変化などで毎回進行中の思考を取り消さず、後続判断でも観測を失いません。commit済みの判断は通常イベントによる中断の対象にせず、行動の所有権と結果記録を維持します。owner proposalは優先して中断します。run67では未知状況case中に`CAS_STALE`を12件、先行中断後のrun68・69では`request_error`をそれぞれ13・19件観測しました。通常観測を後続判断へ送る変更を含むrun70では、未知状況で制御障害後の回復を観測し、`request_error`は11件でした。run69との行動・world条件が異なるため、使用量・達成率の改善は未確定です。中断や通信失敗でproviderのusageが返らないrequestは`usageUnknownCalls`へ計上し、token合計を下限として扱います。E2Eでは該当caseの使用量を未確定と判定します。

長いResponses tool loopではserver-side compactionを有効にし、各requestのrendered inputが16,000 tokenの閾値を超える時にcontextを圧縮します。この閾値は一requestのcontext用で、run全体の累積usage budgetとは別です。`store:false` を保ち、返されたopaque compaction itemは次requestへ引き継ぎます。tool処理済み境界で最新compactionより前をpruneし、call/outputが境界をまたぐ時は対になるcallまで保持します。system instructionsとtoolsは各requestに維持します。MindStoreの目的・停止・CAS stateは永続runtimeで管理し、圧縮結果で上書きしません。

目的判断はイベントごとに新しいResponses会話を始めるため、上記のserver-side compactionだけでは次の判断へ渡す初期入力の増加を抑えられません。初期入力では直近の判断・結果を各4件に絞り、MindStoreが保持する直近履歴から省いた件数を示します。古い移動結果は直近8件に限り、操作種別・成否・観測時に保存した相対変位へ縮約し、迂回を考える材料として残します。変位は結果文を読み直して作らず、Bodyの前後観測から直接保存します。旧保存データに変位がなければ補いません。直近の保存済み結果に含まれる移動変位は`recentMovement`へ正味の概数としてまとめ、activeなowner goalがあれば対応proposal受付後の結果だけを数えます。この値は保持中の結果履歴に限られ、対象への距離や経路の成否を示しません。MindStoreの履歴自体は削除しません。最新の結果、進行中操作、継続中のowner goalと対応proposal、現在のfact・uncertaintyは別フィールドで保持します。pending proposalはruntime内の一箇所だけに載せます。可視ブロックは全件と座標、距離、状態プロパティ、看板文字を維持し、各ブロックで繰り返すdimension（観測全体のdimensionと同一）と内部数値stateIdだけを初期入力から省きます。元のBody観測は記録経路へ渡し、Body toolの観測結果も変更しません。この削減がAPI使用量や目的達成率を改善するかは同条件の実ゲーム比較では未確認です。

会話turnは長いbody操作の完了を待たずに並行できます。行動を変更するかは別の目的判断が決めます。判断の一般的な `revision` は状態更新を、`actionRevision` は行動計画の有効性を管理するCAS値です。結果が古い判断はcommitされません。新しい行動を始める前に現在の操作をcancelし、身体側のdispatchがsettleしたことを確認します。同時にbodyを操作する実行ownerは一つです。

`activeOperation.startedAt` は行動判断のcommit時刻で、`bodyStartedAt` はPlayerBodyから実operation開始eventを受けた時だけ記録します。E2E診断は両者を区別して開始後の介入を判定できます。既存の `startedAt` は互換性のためbody開始時にも更新され、旧保存データでは `bodyStartedAt` を省略できます。

停止はSQLiteへ永続化され、再起動や観測イベントがあっても解除されません。即時stop commandはLLMを呼ばず停止latchを先に保存します。停止後はownerから認証された再開が行われた時だけ自律判断を再開します。古いconversation turnやaction decisionはstop generation/CASにより新しい状態を上書きできません。

## 観測、待機、再接続

目的エージェントは `PlayerBody.observe()` から視野と遮蔽条件を通過した範囲だけを受け取ります。所有者の座標はpending proposal、またはadopted/compromisedかつactiveなowner-linked goalを進めるために `locate_owner` を選んだ時だけ特例で観測できます。辞退済みproposalや明示的に完了・放棄したowner goalはこの例外を許可しません。通常の接続evidenceとdashboard healthは従来のMinecraft statusをローカルに使い、隠れたworld stateをGPTへ渡しません。

目的判断用の観測にはMinecraft座標軸（東が`+x`、西が`-x`、南が`+z`、北が`-z`）と、可視判定と同じyawから導いた現在の方角を添えます。これは自身の向きと可視ブロックの絶対座標を解釈する補助で、遮蔽された対象の座標や経路の成否は追加しません。

目的判断で実際に見たブロックは、現在と過去6視点まで、ブロック名ごとの可視位置範囲・自分の立ち位置・向き・観測時刻へ縮約して別のSQLite表に保存します。同じ視点と可視範囲の反復は1件へまとめ、現在の全観測と重複する視点は判断入力から除きます。過去の範囲は可視部分だけを示し、同名ブロックが範囲内で連続していることや、今も通れる経路を保証しません。所有者位置の例外値、会話、未観測の地形は保存せず、公開用runtime snapshotにもこの位置履歴を含めません。

body eventを種類ごとにまとめ、意味のあるvitals、inventory、entity、block、time、position、windowの変化を判断契機にします。bounded samplerはpacketの取りこぼしを補います。状態が変わらないtickは新しいLLM判断になりません。通常wakeは一件へ集約します。body結果やvitalsなど判断を更新すべきイベントは未commitのthoughtを中断し、最新snapshotで再判断します。通常の周囲観測は現在のthoughtを完了させてから次の判断に渡します。commit済みのthoughtは通常wakeでは中断しません。受理済みpending wakeは、その後にwait条件が変わっても一度処理されます。owner proposalは進行中thoughtをabortして優先し、旧thoughtのsettle後に処理します。stopとshutdownはpending wakeを破棄してthoughtをabortし、永続停止中は再接続を含むイベントで再開しません。行動完了・失敗・stall・死亡・再接続はeventとして保存されます。エージェントは次のwake条件と期限を保存して待てます。目的をcompleteしたcommitは、MindStoreに完了eventを同じtransactionで永続化し、single-flightへ次の自己目的判断を一度渡します。意味のあるgoal変更、新しい操作、実際の操作結果を経た次のcompleteは再び一度wakeします。同じgoalの説明だけを更新した場合や進捗のないcomplete再送では重複wakeしません。未処理の完了eventは再起動後に優先処理し、停止中は保持してownerの明示resumeまで実行しません。接続断やnative operationのcleanupが必要な中断は通常のConnectionManager再試行経路に渡し、再接続まで行動を待機させます。再接続設定が無効なら設定を迂回せず失敗状態を保ちます。

呼吸中に酸素値が1段階下がるたびに目的判断を中断しないよう、通常の入水状態と酸素の正常・不明状態は周囲変化として次の判断へ送ります。体力・食料の変化、低酸素への移行、火・溶岩・窒息は引き続き即時のvitals変化として扱います。

## 技能と学習

技能は一度の全件投入ではなく、現在の目的に合わせて `McSkillRepository.search()`、個別skill、履歴を必要時だけ検索します。検索結果には本文の先頭240文字・最大960 byteまでをプレビューとして含め、詳しい条件や全文が必要なら個別Skillを読みます。検索したSkillの本文も未検証の仮説として扱います。操作前のtrusted観測条件とbodyの実際の前後観測から結果receiptを作ります。モデル自身はtrusted receiptを作れません。未登録で他の場面にも使える方法を得た成功なら、一度の成功だけで仮説Skillを作成し、同じ仕事を無検討に続ける前に保存します。真に一度限りの操作や同等の既存Skillは除き、重複・日誌的な技能を避けます。作成した仮説Skillを後の操作で使った場合は、そのskill/versionに一致する次のtrusted receiptの成功・失敗を反映して改訂します。同じrunからの仮説作成は冪等です。後の実行はskill/versionをreceiptへ固定し、統計に一度だけ結び付けます。skills、receipts、outcomes、MindStoreは同じ設定済みSQLite databaseに保存されるため、再起動後も学習と参照が残ります。

Markdown import/exportは専用の `mc-skills` exchange directoryを使います。importした本文は未信頼の知識で、system指示、認可、停止境界を変更しません。export結果はownerへローカルのファイル位置を返します。

`collectLiveEvidence()` は `LiveEvidence.player` に、revision、stop状態、目的、proposal resolution、active operation、wait、直近のjudgment/outcome/learning参照、可視範囲を縮約した最後の観測、LLM call/token/latency countersを返します。act judgmentの既存summaryには、toolが返した最大400文字の短い選択理由を保存し、次のpurpose inputにも渡します。reasonが空または旧形式のdecisionでは汎用summaryを維持します。この短いreasonは既存のMindStore judgment/snapshot内だけにあり、Responses activity projectionには別フィールドを加えません。Responsesの直近64 roundはrole、プロセス内の連番とround、token/latency、入力/schema/outputの文字数、allowlist済みtool名・固定結果分類とaction commitの固定拒否理由enumだけをMindStoreへ保存します。拒否理由は `CAS_STALE`、`STOPPED`、`NO_ACTIVE_OPERATION`、`PROPOSAL_NOT_PENDING` に限り、任意tool codeは記録しません。中断roundはモデルが要求したtool数と実際に結果を得たtoolだけを区別します。request_errorには、既知のwake種別、停止、その他の中断、通信・provider失敗の固定原因分類だけを任意で付け、例外本文は保存しません。E2E failure artifactには同じsafe activity projectionを使います。内部推論本文、prompt、tool引数/出力、tool call ID等の生成識別子、owner位置の例外座標は保存・公開しません。

`move_to`と`control`の前後Body観測が両方ある場合は、操作結果の短い要約に自己位置の相対変位を含め、次の目的判断へ渡します。観測が欠ける場合やdimensionが変わった場合は変位を推定しません。これは進路を見直す材料であり、対象物の発見やowner goalの達成を示す判定ではありません。
