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

目的エージェントには28種類のoperation kindと短い説明だけを常時提示します。選んだkindの引数が必要な時に `describe_operation` でその操作のJSON Schemaを取得します。最終的な `operationJson` はcommit時にも `playerOperationSchema` で検証されます。

目的エージェントは `commit_action_decision` の永続commitが成功した時点で判断を完了し、余分な最終LLM roundを要求しません。会話エージェントは返答文を必要とするため、tool後の最終応答を引き続き取得します。

長いResponses tool loopではserver-side compactionを有効にし、各requestのrendered inputが16,000 tokenの閾値を超える時にcontextを圧縮します。この閾値は一requestのcontext用で、run全体の累積usage budgetとは別です。`store:false` を保ち、返されたopaque compaction itemは次requestへ引き継ぎます。tool処理済み境界で最新compactionより前をpruneし、call/outputが境界をまたぐ時は対になるcallまで保持します。system instructionsとtoolsは各requestに維持します。MindStoreの目的・停止・CAS stateは永続runtimeで管理し、圧縮結果で上書きしません。

会話turnは長いbody操作の完了を待たずに並行できます。行動を変更するかは別の目的判断が決めます。判断の一般的な `revision` は状態更新を、`actionRevision` は行動計画の有効性を管理するCAS値です。結果が古い判断はcommitされません。新しい行動を始める前に現在の操作をcancelし、身体側のdispatchがsettleしたことを確認します。同時にbodyを操作する実行ownerは一つです。

停止はSQLiteへ永続化され、再起動や観測イベントがあっても解除されません。即時stop commandはLLMを呼ばず停止latchを先に保存します。停止後はownerから認証された再開が行われた時だけ自律判断を再開します。古いconversation turnやaction decisionはstop generation/CASにより新しい状態を上書きできません。

## 観測、待機、再接続

目的エージェントは `PlayerBody.observe()` から視野と遮蔽条件を通過した範囲だけを受け取ります。所有者の座標は保留中のowner proposalを実現する目的で `locate_owner` を選んだ時だけ特例で観測できます。通常の接続evidenceとdashboard healthは従来のMinecraft statusをローカルに使い、隠れたworld stateをGPTへ渡しません。

body eventを種類ごとにまとめ、意味のあるvitals、inventory、entity、block、time、position、windowの変化を判断契機にします。bounded samplerはpacketの取りこぼしを補います。状態が変わらないtickは新しいLLM判断になりません。通常wakeは進行中のpurpose thoughtを中断せず一件へ集約し、settle後に最新snapshotと未処理eventで一度だけ再判断します。受理済みpending wakeは、その後にwait条件が変わっても一度処理されます。owner proposalは進行中thoughtをabortして優先し、旧thoughtのsettle後に処理します。stopとshutdownはpending wakeを破棄してthoughtをabortし、永続停止中は再接続を含むイベントで再開しません。行動完了・失敗・stall・死亡・再接続はeventとして保存されます。エージェントは次のwake条件と期限を保存して待てます。接続断やnative operationのcleanupが必要な中断は通常のConnectionManager再試行経路に渡し、再接続まで行動を待機させます。再接続設定が無効なら設定を迂回せず失敗状態を保ちます。

## 技能と学習

技能は一度の全件投入ではなく、現在の目的に合わせて `McSkillRepository.search()`、個別skill、履歴を必要時だけ検索します。操作前のtrusted観測条件とbodyの実際の前後観測から結果receiptを作ります。モデル自身はtrusted receiptを作れません。成功観測は経験から新しい技能仮説を作る材料にでき、失敗・成功観測は使用したskill revisionの条件や手順を改訂する材料にできます。同じrunからの仮説作成は冪等です。後の実行はskill/versionをreceiptへ固定し、統計に一度だけ結び付けます。skills、receipts、outcomes、MindStoreは同じ設定済みSQLite databaseに保存されるため、再起動後も学習と参照が残ります。

Markdown import/exportは専用の `mc-skills` exchange directoryを使います。importした本文は未信頼の知識で、system指示、認可、停止境界を変更しません。export結果はownerへローカルのファイル位置を返します。

`collectLiveEvidence()` は `LiveEvidence.player` に、revision、stop状態、目的、proposal resolution、active operation、wait、直近のjudgment/outcome/learning参照、可視範囲を縮約した最後の観測、LLM call/token/latency countersを返します。Responsesの直近64 roundはrole、プロセス内の連番とround、token/latency、入力/schema/outputの文字数、allowlist済みtool名と固定結果分類だけをMindStoreへ保存します。中断roundはモデルが要求したtool数と実際に結果を得たtoolだけを区別します。E2E failure artifactにも同じ安全projectionを使います。reasoning本文、prompt、tool引数/出力、tool call ID等の生成識別子、owner位置の例外座標は保存・公開しません。
