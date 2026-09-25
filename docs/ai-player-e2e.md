# 自律プレイヤーの隔離受け入れ検証

`tests/e2e/ai-player-live.ts` は、新しい既定アプリケーションを新規の Paper ワールドと実際の GPT に接続し、Issue #72 の受け入れ条件をゲーム内の結果で確認するための手動実行ハーネスです。API受付、発話、ユニットテストだけでは受け入れをpassにしません。各ケースは成功・失敗・未完了を記録し、未確認の動作を合格へ読み替えません。

新しい既定経路と責務の境界は[自律プレイヤー](autonomous-player.md)、操作・可視範囲の契約は[プレイヤー操作アダプター](player-body.md)、判断に使うゲーム内知識は[MC Bot Skills](mc-bot-skills.md)を参照してください。

## 隔離と公開境界

ハーネスはNode.jsの `os.tmpdir()` が返すOS一時領域の下に一時ディレクトリを作り、Paper 1.21.11 の新規flat worldだけを起動します。固定値 `720926` は合成fixtureのseedです。既存worldや利用者のMinecraft環境には接続しません。接続先はloopbackに限定し、RCONはfixtureの作成・状態確認専用です。`ops.json` は空で、AIプレイヤー、owner、guestの3接続は通常の非OPプレイヤーとして動きます。Console相当のfixture操作はハーネスだけが行います。server jarが初回起動時に既存のPaper依存を必要とする環境では、任意の`AI_PLAYER_E2E_SERVER_CACHE_DIR`を指定できます。そこから`libraries`、`versions`、`cache`だけを新しい一時serverへコピーします。コピー元のworldやprocessには触れず、コピー中はsymlinkを除外します。

`prepareWorld` はbaseline取得前にspawn周辺の水平視野全体へ5個の合成`oak_log`を分散して置き、自律caseの資源fixtureに使います。Body smokeの最後には、操作確認に使った近距離セルを一時的な`oak_log`へ置き換え、Bodyの視線をそのセルへ向けた新しい観測に同じセル・同じblock nameが含まれることを確認します。原木のRCON設置を先に確認し、観測後はbaseline取得前に空へ戻してreadbackします。fixtureや観測に失敗した場合は固定codeで停止し、GPTを起動しません。これは資源の可視性fixtureであり、owner指示や自律goalを追加しません。静的な資源fixtureは既存fixtureやsmoke targetと位置を重ねず、`autonomous_life`終了後に残った`oak_log`だけをRCONで除去してreadback確認してから後続caseへ進みます。これは自律caseの成功判定後に行うcleanupです。

受け入れケースはownerとguestの実Minecraftチャットを使い、AIプレイヤーの判断は既定runtimeから実際のGPTへ送ります。API keyは既存の環境変数またはローカルdotenvから読み、artifactや標準出力に書きません。Minecraftログ、会話本文、プレイヤー名、UUID、座標、Skill本文はartifactへ保存しません。artifactには合成seed、case結果、上限と計測usage、固定分類コードだけを記録します。結果JSONは、Node.js `os.tmpdir()` 以下の `ai-player-e2e-results/` にmode `0600`で保存します。Paper stdout/stderrは一時領域のmode `0600`のprivate logに記録し、artifactや標準出力へ本文を出しません。失敗・未完了時は診断用copyを同じ一時領域の `ai-player-e2e-private-diagnostics/` にmode `0600`で残し、固定の分類コードとpathだけを表示します。成功時のprivate logは既定で削除します。終了時に自分で起動したserver processを停止し、一時world・DB・Skill交換ファイルを削除します。子process終了、server/RCONのloopback listener閉鎖、一時world削除を確認し、どれかが確認できない場合はpassになりません。Body smoke用clientと既定applicationのspawn位置がずれる可能性を避けるため、位置baselineはapplication接続後に取り、ブロック・所持品のbaselineはsmoke操作より前の状態を使います。

実行caseの終了時に、そのcase内で最後に収集したPlayer snapshotの許可項目を、mode `0600`のrun別private JSONL sidecarへ1件保存します。収集元は`fresh_terminal`または`last_collected`として記録し、`last_collected`は失敗・停止後の状態を必ず表すものではありません。未実行caseにはsnapshotを割り当てず、公開artifactにはsidecar保持boolと固定書込失敗codeだけを出します。sidecar保存失敗は元のcase結果を変更しません。

`persistent_memory_restart` の失敗artifactは、記憶依頼へのconversation完了、`remember_owner_fact`の呼出しと固定結果分類、owner reply受信、DB保存のstageを示します。terminal conversationが保存toolを呼ばなければ`OWNER_FACT_TOOL_NOT_CALLED`、保存拒否なら`OWNER_FACT_SAVE_REJECTED`でcaseを未完了にし、その後の自律thoughtでcase予算を使い切る前に原因を分けます。再起動後のDB欠落と回答不一致は既存の固定failure codeで識別します。予算停止をpassへ変えず、DB保存・同一DB再起動・合成phrase回答の条件も変えません。事実本文、tool引数、会話本文はartifactへ出しません。

## Issue #72 の機械的な確認範囲

| Issue受け入れ条件     | ケースと根拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身体操作の接続        | `body_operation_smoke` は非OPのPlayerBodyを直接使い、採掘・視点変更・かまど画面の開閉と入出庫をBody観測およびRCONで照合します。最後に近距離へ置いた原木へ視線を向け、同一セルのBody観測とRCON設置・cleanup readbackを確認します。GPT受け入れは別に集計します。                                                                                                                                                                                                                                          |
| 既存層の見直し        | `runtime_contract` が既定アプリのplayer runtime evidenceと接続を確認し、`autonomous_life` がowner指示なしの実行を確認します。既存legacy経路との静的な責務確認はソース・設計文書も併せてレビューします。                                                                                                                                                                                                                                                                                                 |
| 自発的な生活          | `autonomous_life` はself由来の目標、GPT判断、成功した操作結果、RCONで観測する位置・所持品・fixture regionのいずれかの実変化を要求します。操作kindを`place`等に固定しません。                                                                                                                                                                                                                                                                                                                            |
| 未知の状況への対応    | `unknown_composite` は壁・水路・日没が近い状況を組み合わせ、実際の失敗、失敗後の再観測と行動判断、異なるkindまたは変化した条件での後続回復、server progress、対象の取得・持帰りを確認します。途中oracle診断は失敗の有無から独立して保存します。                                                                                                                                                                                                                                                         |
| 擬似視覚と記憶        | `observation_boundary` はfixture設置後に得た可視観測の時刻と、その後のbot返信受信時刻を照合し、RCONで隠しitemを確認しながらFOV・遮蔽・可視領域へのitem漏洩を検査します。返信本文はrun別のmode `0600` private sidecarだけに保存し、公開artifactには返信有無・限定的なheuristic分類・手動確認要否だけを記録します。heuristicは意味全体を判定しないため、Issue受け入れはsidecarの確認まで未確認です。`persistent_memory_restart` は会話からowner由来factを保存し、同じDBで再起動した後の回答と照合します。 |
| 並行会話と行動変更    | `parallel_dialogue_stop` は進行中の操作へguestとownerが実際に話しかけ、guestの状態変更拒否、ownerの強い要請に対する目的解決とownerへ近づくRCON位置変化、停止ラッチと停止後の再開防止を確認します。                                                                                                                                                                                                                                                                                                      |
| 拒否境界の更新        | `game_action_discretion` は視界内の板材壁にある目線の高さの穴を、ownerの通常依頼で修理します。GPT依頼前の新しいBody観測で壁材を確認し、配置の成功・world変化・穴が埋まったことをRCONで照合します。fixtureの向きと配置はRCONで確認し、終了時は合成ブロックだけを除去してreadbackします。建築の一律拒否やブロック単位の再承認が残っていないことを検証します。                                                                                                                                             |
| Skillの必要時参照     | `learning_reuse` と`skill_compactness_and_knowledge_separation` は収集結果に結び付いたSkillの作成・後続相談と、限定された参照量、ゲームレジストリ知識の分離を確認します。                                                                                                                                                                                                                                                                                                                               |
| 自己学習              | `learning_reuse` は一度の成功から作られた仮説、DB上のtrusted receipt/outcome、Skillの再利用と次回の版・証跡変化を照合します。                                                                                                                                                                                                                                                                                                                                                                           |
| 簡潔なSkillと知識分離 | `skill_compactness_and_knowledge_separation` は保存本文が8 KiB以内であること、全件ではないSkill参照、別のregistry知識APIを確認します。                                                                                                                                                                                                                                                                                                                                                                  |
| DBとMarkdownの往復    | `skill_exchange` はexportしたファイル名と同一Skill IDをimport活動・DBで照合し、合成編集marker、同IDの版・receipt更新、同じファイルの再import試行後に同IDの本文・版・receiptが変わらないことを確認します。                                                                                                                                                                                                                                                                                               |
| 統合した実ゲーム検証  | `integrated_result` は上記のGPT・Body・server oracleの各ケースがpassした場合だけ統合passにします。                                                                                                                                                                                                                                                                                                                                                                                                      |

`observation_boundary` は返信とoracleの確認後、合成の壁・チェストをRCONで除去し、空気のreadbackを確認して後続caseへ進みます。`learning_reuse` はbotの周囲4方向に合成`oak_log`を置き、初回・再利用の各配置後15秒以内に得た新しいBody観測で`oak_log`が見えることをowner依頼前に確認します。配置場所が塞がっている場合や見えない場合は固定codeで未完了停止し、GPT依頼を送りません。プレイヤーの向きは固定しません。初回と再利用の依頼はいずれも原木1本の採掘と結果確認を求め、RCONがfixture位置のうち少なくとも1か所から`oak_log`が消えたことを確かめます。成功操作とworld changeを記録した後、残りの合成原木だけをRCONで除去し、readbackしてから仮説確認・次のfixtureへ進みます。未完了時もcase終了後、後続caseの前に残った合成原木を同様に除去・readbackします。学習fixtureの成功判定後、初回の成功結果から新しい検証済み仮説が現れるまで、既存のcase/run期限と使用量上限の範囲内で最大30秒だけ確認します。確認できなければ固定codeで未完了停止します。

`learning_reuse` 開始後に未完了停止したartifactには、最後に確認した段階を固定enumの `learningReuseStage` として記録します（初回fixture可視、初回dig確認、仮説作成、再利用fixture可視、再利用結果確認、版・receipt更新確認）。この値は進捗の診断だけを示し、既存のBody・DB・RCON条件を満たしたpass判定は変えません。Skill本文・IDや会話内容は含めません。

`unknown_composite` の固定診断には失敗・回復操作のkindと、課題送信後に初めて得た可視観測で青い羊毛・水・壁材(stone)が現れたかを含めます。この観測は課題送信時点の視界を示すとは限らず、可視観測が得られない場合はvisibilityを`unknown`として保持します。現在の保存用観測はブロック名のみで一般ブロックの位置を持たないため、stoneの有無は壁そのものの視認証明ではなく、壁材名の検出です。これらの診断は既存の達成・回復判定を変更しません。

課題送信後に成功した既存oracleサンプルだけから、開始位置からの最大移動距離bucket、標的への最短距離bucket、近づいた観測の有無、blocks・position・inventoryの進捗種別を上限付き集計で保存します。生座標や時系列は保存しません。有効サンプルがない場合は`not_sampled`または`unavailable`、一部読取失敗を含む集計は`partial`として扱います。これらは観測差分の診断で、成功操作やbot起因の進捗を証明しません。特にblock差分には自然な水流変化が含まれる可能性があります。取得・帰還の成功条件は従来どおり別のoracleで判定します。

unknown fixtureは壁と対象をspawnの+X側に配置するため、停止中にJava版のyaw -90°・pitch 0°を設定し、RCONのRotation readbackで向きを確認してからresumeします（Java yawは0°が南、負の90°が東）。向き確認後、課題送信前に取得できた観測receiptだけを別の`unknownPreTask...`項目へ記録します。向き設定後のreceiptが無い場合は`unknown`とし、課題後の`unknownTask...`可視観測とは混ぜません。この診断は対象座標をagentへ渡さず、fixtureや達成条件も変更しません。向き変更とpre-task分類は静的検証段階で、実Minecraftでは未測定です。

これらは代表ケースです。全操作の網羅、すべてのMinecraft環境・mod・protocol差、死亡を含むすべての結果を証明しません。未実装と判断した操作はありません。確認していない能力や環境差は未検証として残します。

## 操作群の検証状態

| 能力群                 | 操作                                                                                                                                 | ソース上の接続                        | fixture経由のハーネス確認                                                                                         | 実GPTの受け入れ・実測                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 移動・視線・入力       | `move_to`, `look`, `control`                                                                                                         | 28操作schemaとBody dispatchを静的確認 | run5で`look`成功と対象stone可視性を確認                                                                           | run10は`autonomous_life` pass・position進展、run11は成功`look`後もworld進展なしで未完了。passの再現性は未確認 |
| ブロックと制作         | `attack`, `dig`, `place`, `craft`                                                                                                    | 同上                                  | run6の非OP `dig`成功とRCONの空気化確認。`place`・`craft`の直接smokeは未実施                                       | run10のposition進展からブロック操作は確認できず、owner依頼の建築も未実施                                      |
| 装備・使用・所持品     | `equip`, `use`, `consume`, `toss`, `transfer`                                                                                        | 同上                                  | run9・run10のfurnace `window_transfer`投入・返却を確認。他の所持品操作は未確認                                    | GPT経由の操作は未実行・未網羅                                                                                 |
| 画面と設備             | `open_window`, `window_click`, `window_transfer`, `window_close`                                                                     | 同上                                  | run9・run10でfurnace可視化、open、投入、返却、closeがすべてpass。投入はBody・RCON双方を確認。run8失敗原因は未特定 | GPTによる設備操作は未実行                                                                                     |
| 活動・乗り物・専門画面 | `fish`, `sleep`, `wake`, `mount`, `dismount`, `move_vehicle`, `elytra_fly`, `trade`, `enchant`, `anvil`, `write_book`, `update_sign` | 同上                                  | 専用fixture smokeなし                                                                                             | run10・run11の予算停止後caseは未実行                                                                          |

「ソース上の接続」は実ゲーム実行の証明ではありません。fixture smokeはGPTの自律判断と別case・別usageで記録します。直接のfixture smokeがないことを非対象化や未実装の断定に使いません。能力別の結果はartifactと統合後の受け入れ記録で更新してください。

## 実行条件と上限

実行にはNode.js環境、Java 21、Paper 1.21.11 jar、利用者が同意済みのEULAファイル、利用可能な`OPENAI_API_KEY`が必要です。ユーザーが実API・server実行を指定した節目に、専用環境で次のように呼び出します。

```sh
AI_PLAYER_E2E_CONFIRMED=YES \
AI_PLAYER_E2E_EULA_FILE=/path/to/accepted-eula.txt \
AI_PLAYER_E2E_SERVER_JAR=/path/to/Paper-1.21.11.jar \
JAVA_HOME=/path/to/java-21 \
./node_modules/.bin/tsx tests/e2e/ai-player-live.ts
```

Paper cache copyを使う場合は、上の環境変数行へ次を加えます。

```sh
AI_PLAYER_E2E_SERVER_CACHE_DIR=/path/to/paper-cache
```

既定上限は45分、160回のGPT呼び出し、合計800,000 tokensです。case上限は合計162 calls / 915,000 tokensで、各caseに独立したdeadlineがあります。`autonomous_life` は18 calls / 100,000 tokens、case deadlineは5分です。run18では11 calls・input 63,832・output 2,607・計66,439 tokensで旧60,000-token上限を超え、最後に記録された`commit_action_decision`はokでした。その後のsnapshotはusage gateでpredicate評価前に止まり、最後のsafe player診断と自律milestone進捗は異なる観測時点を示しています。artifact上のfollow-up判断未確認は「判断がなかった」証拠ではなく、判断時刻と成功outcome時刻の詳細はsafe artifactにありません。100,000 tokens / 18 callsは、run18の計測点から次の有限な判断・観測一巡を測る余裕（最大33,561追加tokens・7 calls）として設定します。これは測定上限でありIssueの達成条件ではありません。`unknown_composite` は32 calls / 200,000 tokens、case deadlineは7分です。run17では125,200 tokens消費時点で最低2つのterminal actionが不足していました。直近のround規模（1 actionあたり2–3 round、最大約8,500 input tokens）から、残る2 actionに約34,000–51,000 tokensが必要と見積もり、200,000を一回の測定に使う上限として設定しました。この見積もりは達成保証ではなく、上限まで消費する再試行や追加拡張の根拠にはしません。case上限のtoken合計はrun上限を115,000超え、calls合計も2回超えるため、run全体の上限を維持したままでは後続caseがglobal budgetで未完了停止する場合があります。成功条件とrun全体160/800,000/45分の上限は変更しません。`AI_PLAYER_E2E_MAX_DURATION_MINUTES`、`AI_PLAYER_E2E_MAX_LLM_CALLS`、`AI_PLAYER_E2E_MAX_TOTAL_TOKENS`で既定値以下へ下げられます。上限の超過やdeadlineはrun/caseを未完了にし、そこで停止します。偶然passするまで同じ高コストcaseを反復しません。GPT usageが取得できなかったAPI失敗や中断を0消費とはみなさず、既知合計と`partial_or_unknown`を分けます。

実行順は`runtime_contract`、`autonomous_life`、`observation_boundary`、`persistent_memory_restart`、`learning_reuse`、`skill_compactness_and_knowledge_separation`、`skill_exchange`、`game_action_discretion`、`unknown_composite`、`parallel_dialogue_stop`、`integrated_result`です。unknownのcase budget/deadlineでrunが停止する前に独立した6 caseを測り、unknown handoff後の停止検証をparallelのまま最後に保ちます。同一runtime・DB・goal/skill履歴を引き継ぐため、unknown開始前に蓄積する判断履歴は従来順と異なります。各caseのpredicate・fixture・予算は変えません。unknownまでの各caseがそれぞれ上限まで消費した場合、parallelに残るのは22 calls / 5,000 tokensのみです。unknownがbudget/deadline停止すれば`parallel_dialogue_stop`と、それら全結果を要求する`integrated_result`は未実行のままです。

artifactのrun/case duration、runtime報告call/token/latency、case status、fixture seedを使って結果を再現・比較します。API受付やGPT応答だけではpassにならず、成功caseはDB・Body観測・独立したRCON world oracleなど、ケースごとの結果条件を満たす必要があります。全caseがpassしcleanupも確認できた時だけrun全体をpassとします。

## 現在の検証状況

run6対象HEAD `daab18f`のCI 7 jobsと、この診断差分のserver typecheck・対象Lint・整形確認は成功しています。隔離Paperと実GPTを使うrunも実施済みです。run4では`runtime_contract`がpassしましたが、`autonomous_life`はGPTを11回呼び出し、60,055 tokensを消費してcase上限60,000を超えたため未完了です。残りのcaseもこの予算超過による停止で未実施となり、shutdown後の証跡収集失敗によりrun全体も未完了でした。

run5では非OP Bodyの`look`が成功し、対象stoneが視界内に入ったことを確認しました。続く`dig`は`action_timeout`で未確認となり、独立したRCON確認でもブロックの空気化を確認できずcase failです。fail-fastにより既定アプリとGPTは起動せず、GPT usageは0でした。server process、loopback listener、一時worldのcleanupはすべて確認済みです。furnace操作にも到達していません。

run6では非OP `dig`がsuccessfulとなり、serverとRCONの双方で対象ブロックの空気化を確認しました。furnace smokeではwindowを観測できず未完了となり、fail-fastでGPTは起動していません。cleanupは確認済みです。run6 artifactにはfurnaceのopen操作結果が保存されていないため、原因は特定できませんでした。その後のハーネス差分はRCONでfurnace fixtureを確認し、look後にBodyが対象furnaceを実際に観測するまで最大5秒の条件待ちを行い、open前後の状態と操作結果を安全な分類値で記録します。この配置確認とopen診断はrun7で実行しました。

run7ではRCON readback、Body可視状態、`open_window`成功まで確認しました。続く投入はBodyの入力欄とサーバーの双方に原料があることを確認する条件が未成立で、未完了となり、GPT呼び出しは0、cleanupは3/3確認済みです。artifactにはその失敗後の個別transfer診断がなく原因を絞れませんでした。当時の差分ではRCON投入物が実際のtransfer sourceとなるBody window inventoryへ反映されるまで最大5秒待ってfixture状態を判定し、投入・取り出し・closeのstatus、固定detail分類、Bodyの`raw_iron`個数、RCON確認boolを保存するよう変更しました。

run8でも投入のBody・RCON確認条件が成立せず停止しました。続くno-GPT probe2は単独の一試行で投入後のBody入力欄とRCON `minecraft:raw_iron`を確認し、続くreadbackもcanonical itemとして分類しました。probe2からrun8失敗の原因を遅延・packet拒否・RCON判定差のいずれかに特定することはできません。run9では初回・最終RCON replyの固定分類と存在確認bool、Body個数、window source/input/cursorを記録する条件待ちを実行しました。

run9はHEAD `7acf150`で実施し、Body fixture smoke全体がpassしました。投入は最初のreadbackでBody入力0個・RCON空、117ms後にBody入力1個とcanonical itemを確認しました。取り出し後はwindow内inventoryが1個、inputとcursorが0個でRCON空、closeも成功しました。`runtime_contract`はpassしましたが、`autonomous_life`は目標・行動設定後に`look`が2回成功したもののworld進展がなく、13 calls・input 62,528・output 1,805・合計64,333 tokensで`CASE_LLM_BUDGET_EXCEEDED`となりました。usageは`partial_or_unknown`です。後続caseは未実行、server・loopback listener・一時worldのcleanupは3/3確認済みです。

run10はHEAD `1d585dd`で実施し、Body fixture smoke、`runtime_contract`、`autonomous_life`がpassしました。Body投入は初回RCONがempty list・Body input 0個、114ms後にcanonical item・Body input 1個を確認しました。`autonomous_life`は12 calls・58,635 tokensで、serverのposition進展を観測しましたが、case evidenceに成功操作のkindはなく、具体的な操作は特定できません。`unknown_composite`は25 calls・125,134 tokensで`CASE_LLM_BUDGET_EXCEEDED`となり未完了、後続caseも未実行です。run全体は37 calls・183,769 tokens、usage `partial_or_unknown`、cleanupは3/3確認済みです。failure evidenceのagent activityは37件（purpose 35、conversation 2）で、9件が`request_error`かつ`interrupted`、compaction itemは0件、1 roundの最大inputは8,890 tokensでした。request_errorの原因、run9との差に対する診断追加の効果はいずれも未特定です。

run11はHEAD `6f0b2f9`で実施し、Body fixture smokeと`runtime_contract`はpassしました。`autonomous_life`は11 calls・input 64,357・output 2,352・合計66,709 tokensで`CASE_LLM_BUDGET_EXCEEDED`となり未完了です。目標・活動・成功操作とsuccessful `look`を観測しましたが、world進展を確認できませんでした。run10では同caseがpassしposition進展を観測したため、両runで結果に差があり、passの再現性は確認できていません。agent activityは11件すべてpurposeで、`request_error`・`interrupted`・compactionはいずれも0件、最大round inputは7,383 tokensでした。1回目は5 round（`observe_body`、`describe_operation`、`commit_goal_state`、`update_understanding`、`commit_action_decision`）、2・3回目は各3 roundで`observe_body`→`update_understanding`→`commit_action_decision`となり、`describe_operation`の再呼び出しはありませんでした。run全体は11 calls・66,709 tokens、usage `partial_or_unknown`、後続case未実行、cleanup 3/3確認済みです。この結果から原因や性能改善は推定しません。

run12はHEAD `8f119c9`で実施し、3 roundで最初の判断が確定、successful `dig`を記録しました。自律生活のoracleでは進展を確認できず、9 calls・62,361 tokensで予算停止しました。次のthoughtでcommit拒否が2回記録されましたが、その理由はartifactにありません。API schema error・request errorは観測されていません。

run12後のno-GPT world-oracle probe1–3は、cloneの書式、scoreboard readback、単数形forceload replyの分類不足でclone前に停止し、各回cleanupは4/4でした。この診断を受け、harnessは `clone ... replace force` を使い、source・baselineの必要chunkをforceload後5秒以内に個別確認します。clone block数、初期同一性、0/1のscore readbackを検証し、syntax・未読込・readback異常をregion不一致へ変換せずincompleteにします。fixtureブロック判定も同じRCON oracleを通します。Body smoke終了時に実位置周辺のregionをfixture cleanup後、bot切断前にbaseline化します。位置基準は接続後snapshotのため、app接続中の移動が比較から抜ける可能性があります。

続くno-GPT probe4–6ではPaper 1.21.11上のsource fixtureとmutation応答分類で停止しました。probe4・5は既にairの領域へのfill応答を失敗扱いし、probe6はclone、初期一致、同じbaselineの再確立までpassした後、setblock応答の分類で停止しました。probe7ではfill/setblockの返信文型を成功判定に使わず、RCON command完了後にsourceのstone・air各9 blockとmutation blockを共通 `blockIs` helperで読み戻しました。clone count、初期一致、再baseline一致、mutation後のregion差分をすべて確認し、cleanupは4/4でした。probe artifactsはprivate mode `0600`です。この測定はno-GPT RCON world oracleの証跡で、Issue全体やGPT受け入れcaseのpassを示しません。

run13はHEAD `638ebdc`で実施し、Body fixture smokeと`runtime_contract`がpassしました。`autonomous_life`は10 calls・input 59,551・output 2,596・合計62,147 tokensでcase予算を超過し、`CASE_LLM_BUDGET_EXCEEDED`となりました。成功outcomeは3件、action revisionは3で、いずれも`look`でしたがworld進展は確認できませんでした。5 sequenceは各2 roundで、`commit_action_decision`はok 3件・rejected 2件、拒否理由は記録されていません。activityは10件でrequest error・interrupted・compactionは0件、最大round inputは6,670 tokensでした。usageは`partial_or_unknown`、後続9 caseは未実行、cleanupは3/3確認済みです。

run13後のハーネス差分では、`unknown_composite`のtarget・item・帰還・daytime oracleを失敗前から定期取得し、未読取と既知falseを区別するsafe診断を失敗artifactにも残します。自然失敗が先に観測されない場合は、`bodyStartedAt`のある`move_to`を一度だけ候補にし、同じoperation ID、プレイヤーの立ち位置、足元・頭上の空間、近傍entityの不在を再確認した場合だけ、床と内部を保護する5×3×5の障害を注入します。注入中に同じoperation IDの実際のfailed outcomeと内側の位置を観測し、障害領域をsnapshotへ復元してreadback一致を確認してから回復判定へ進みます。operation終了・位置逸脱・近傍entity・読戻し失敗は注入しないか未完了として残し、LLM outcomeを作りません。復元はbudget例外を含む全終了経路で実行します。observer client用の足場は各platform chunkをforce-load・loaded確認した後に設置し、位置をreadbackします。この差分はsource/static確認段階で、MC/GPT実行はしていません。

run14はHEAD `855d39a`で実施し、Body smokeと`runtime_contract`がpassしました。`autonomous_life`も3 calls・16,947 tokensでpassし、position進展を観測しました。`unknown_composite`は19 calls・125,313 tokensでcase予算停止となり、後続9 caseは未実行、cleanupは3/3確認済みです。

run15はHEAD `1d60721`で実施し、Body smokeと`runtime_contract`がpassしました。`autonomous_life`ではself goal・activity・successful outcome・RCON world progressを確認し、successful `look` 1件、action revision 2、最後の判断`continue`、観測時点のactive operation `move_to`を記録しました。10 calls・60,198 tokensでcase上限を超え未完了となり、後続9 caseは未実行、cleanupは3/3確認済みです。active operationが残ったままmilestone相当の証拠が揃ったため、run15を遡ってpassにはしていません。

今回のharness差分では、自律milestoneにsuccessful outcomeの後の新しいjudgmentを要求し、操作がactiveという理由だけではmilestoneを保留しません。次のunknown fixture境界ではowner停止後、実Body開始済みの停止前operationだけ同IDの終端outcomeを確認します。実行前のpending operationは停止後に消えたことを安全診断へ記録します。その後app shutdownとBot切断を確認し、同じDB・configで再起動して停止ラッチを照合し、停止中にfixtureとoracleを準備してからowner明示resumeと未知課題を送ります。unknown scenarioのoutcome基準は再開後・課題送信直前のsnapshotに置き、stop/handoffの終端outcomeを自然失敗に含めません。停止・再起動・再開は成功証拠にせず、artifactには段階bool、Body開始有無と経過bucketを残します。この差分は静的検証段階で、実Minecraft/GPT未実施です。

handoffが明示resume確認前に失敗した場合は、runtimeを停止状態のまま保ち、後続caseのbodyを起動せず`UNKNOWN_HANDOFF_DEPENDENCY_FAILED`として未実行境界を記録します。

unknown fixtureのbaseline準備では、sourceとclone先のchunkを先にforce-loadし、最大6回の500ms比較窓から連続2回一致する組を要求します。各窓はbaseline clone、tick進行、sourceとの比較で構成し、一致が得られた後にtick freezeをreadback確認してbaselineを再cloneし、もう一度比較します。未一致・freeze/unfreeze未確認はいずれも未完了として残り、依存blockを解除しません。独立GPT0 probe2ではfreeze/query、clone比較、unfreeze/queryの往復を確認しましたが、統合harnessの実機実行は未実施です。連続一致は有限窓での比較再現性を示すだけで、sourceとclone先が同時に自然更新する可能性や、その後の水流変化を排除しません。既存region差分の進捗診断に自然な水変化が含まれる余地があり、target cleared・item returned・spawn returnの条件は引き続き別に確認します。

Issue #72全体の受け入れは未達です。`unknown_composite`と後続caseは未完了で、自律生活のpassはrun10・14、予算未完了はrun11・13・15と差があります。case遷移の新しい停止・再起動境界も実ゲームでは未検証です。
