# 自律プレイヤーの隔離受け入れ検証

`tests/e2e/ai-player-live.ts` は、新しい既定アプリケーションを新規の Paper ワールドと実際の GPT に接続し、Issue #72 の受け入れ条件をゲーム内の結果で確認するための手動実行ハーネスです。API受付、発話、ユニットテストだけでは受け入れをpassにしません。各ケースは成功・失敗・未完了を記録し、未確認の動作を合格へ読み替えません。

新しい既定経路と責務の境界は[自律プレイヤー](autonomous-player.md)、操作・可視範囲の契約は[プレイヤー操作アダプター](player-body.md)、判断に使うゲーム内知識は[MC Bot Skills](mc-bot-skills.md)を参照してください。

## 隔離と公開境界

ハーネスはNode.jsの `os.tmpdir()` が返すOS一時領域の下に一時ディレクトリを作り、Paper 1.21.11 の新規flat worldだけを起動します。固定値 `720926` は合成fixtureのseedです。既存worldや利用者のMinecraft環境には接続しません。接続先はloopbackに限定し、RCONはfixtureの作成・状態確認専用です。`ops.json` は空で、AIプレイヤー、owner、guestの3接続は通常の非OPプレイヤーとして動きます。Console相当のfixture操作はハーネスだけが行います。server jarが初回起動時に既存のPaper依存を必要とする環境では、任意の`AI_PLAYER_E2E_SERVER_CACHE_DIR`を指定できます。そこから`libraries`、`versions`、`cache`だけを新しい一時serverへコピーします。コピー元のworldやprocessには触れず、コピー中はsymlinkを除外します。

受け入れケースはownerとguestの実Minecraftチャットを使い、AIプレイヤーの判断は既定runtimeから実際のGPTへ送ります。API keyは既存の環境変数またはローカルdotenvから読み、artifactや標準出力に書きません。Minecraftログ、会話本文、プレイヤー名、UUID、座標、Skill本文はartifactへ保存しません。artifactには合成seed、case結果、上限と計測usage、固定分類コードだけを記録します。結果JSONは、Node.js `os.tmpdir()` 以下の `ai-player-e2e-results/` にmode `0600`で保存します。Paper stdout/stderrは一時領域のmode `0600`のprivate logに記録し、artifactや標準出力へ本文を出しません。失敗・未完了時は診断用copyを同じ一時領域の `ai-player-e2e-private-diagnostics/` にmode `0600`で残し、固定の分類コードとpathだけを表示します。成功時のprivate logは既定で削除します。終了時に自分で起動したserver processを停止し、一時world・DB・Skill交換ファイルを削除します。子process終了、server/RCONのloopback listener閉鎖、一時world削除を確認し、どれかが確認できない場合はpassになりません。Body smoke用clientと既定applicationのspawn位置がずれる可能性を避けるため、位置baselineはapplication接続後に取り、ブロック・所持品のbaselineはsmoke操作より前の状態を使います。

## Issue #72 の機械的な確認範囲

| Issue受け入れ条件     | ケースと根拠                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身体操作の接続        | `body_operation_smoke` は非OPのPlayerBodyを直接使い、採掘・視点変更・かまど画面の開閉と入出庫をBody観測およびRCONで照合します。GPT受け入れは別に集計します。                                                                                |
| 既存層の見直し        | `runtime_contract` が既定アプリのplayer runtime evidenceと接続を確認し、`autonomous_life` がowner指示なしの実行を確認します。既存legacy経路との静的な責務確認はソース・設計文書も併せてレビューします。                                     |
| 自発的な生活          | `autonomous_life` はself由来の目標、GPT判断、成功した操作結果、RCONで観測する位置・所持品・fixture regionのいずれかの実変化を要求します。操作kindを`place`等に固定しません。                                                                |
| 未知の状況への対応    | `unknown_composite` は壁・水路・期限を組み合わせたfixtureで、実際の失敗、失敗後の再観測と行動判断、後続の成功、異なる操作kindまたは同種操作の条件変化、対象の取得・持帰りを確認します。                                                     |
| 擬似視覚と記憶        | `observation_boundary` は遮蔽したemerald入りchestをRCON oracleで確認し、runtimeの可視観測とownerへの返答に未確認の内容を出さないことを見ます。`persistent_memory_restart` は合成factをDB保存し、同じDBで再起動した後のGPT回答に照合します。 |
| 並行会話と行動変更    | `parallel_dialogue_stop` は進行中の操作へguestとownerが実際に話しかけ、guestの状態変更拒否、ownerの強い要請に対する目的解決とownerへ近づくRCON位置変化、停止ラッチと停止後の再開防止を確認します。                                          |
| 拒否境界の更新        | `game_action_discretion` はownerの依頼でfixture建築の穴を実際に埋めたことをRCON確認します。独立した建築fixtureで、建築の一律拒否やブロック単位の再承認が残っていないことを検証します。                                                      |
| Skillの必要時参照     | `learning_reuse` と`skill_compactness_and_knowledge_separation` は収集結果に結び付いたSkillの作成・後続相談と、限定された参照量、ゲームレジストリ知識の分離を確認します。                                                                   |
| 自己学習              | `learning_reuse` は一度の成功から作られた仮説、DB上のtrusted receipt/outcome、Skillの再利用と次回の版・証跡変化を照合します。                                                                                                               |
| 簡潔なSkillと知識分離 | `skill_compactness_and_knowledge_separation` は保存本文が8 KiB以内であること、全件ではないSkill参照、別のregistry知識APIを確認します。                                                                                                      |
| DBとMarkdownの往復    | `skill_exchange` はゲームチャットからのexport、合成追記したMarkdownのimport、DB版・receipt、同一ファイル再import時に実績が増えないことを照合します。                                                                                        |
| 統合した実ゲーム検証  | `integrated_result` は上記のGPT・Body・server oracleの各ケースがpassした場合だけ統合passにします。                                                                                                                                          |

これらは代表ケースです。全操作の網羅、すべてのMinecraft環境・mod・protocol差、死亡を含むすべての結果を証明しません。未実装と判断した操作はありません。確認していない能力や環境差は未検証として残します。

## 操作群の検証状態

| 能力群                 | 操作                                                                                                                                 | ソース上の接続                        | fixture経由のハーネス確認                                                                         | 実GPTの受け入れ・実測                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 移動・視線・入力       | `move_to`, `look`, `control`                                                                                                         | 28操作schemaとBody dispatchを静的確認 | run5の`look`成功と対象stone可視性を確認。run6はfurnaceのlook/open段階に到達したがlook結果は未記録 | run4の`autonomous_life`は予算超過で未完了       |
| ブロックと制作         | `attack`, `dig`, `place`, `craft`                                                                                                    | 同上                                  | run6の非OP `dig`成功とRCONの空気化確認。`place`・`craft`の直接smokeは未実施                       | run4の自律生活は未完了。owner依頼の建築は未実施 |
| 装備・使用・所持品     | `equip`, `use`, `consume`, `toss`, `transfer`                                                                                        | 同上                                  | 直接fixture smokeなし                                                                             | 未実行・未網羅                                  |
| 画面と設備             | `open_window`, `window_click`, `window_transfer`, `window_close`                                                                     | 同上                                  | run6でfurnace windowを観測できず未完了。今回、RCON・Body可視状態・操作結果の診断を追加            | GPTによる設備操作は未実行                       |
| 活動・乗り物・専門画面 | `fish`, `sleep`, `wake`, `mount`, `dismount`, `move_vehicle`, `elytra_fly`, `trade`, `enchant`, `anvil`, `write_book`, `update_sign` | 同上                                  | 専用fixture smokeなし                                                                             | 未実行・環境差も未確認                          |

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

既定上限は45分、160回のGPT呼び出し、合計800,000 tokensです。case上限は合計148 calls / 795,000 tokensで、各caseに独立したdeadlineがあります。`AI_PLAYER_E2E_MAX_DURATION_MINUTES`、`AI_PLAYER_E2E_MAX_LLM_CALLS`、`AI_PLAYER_E2E_MAX_TOTAL_TOKENS`で既定値以下へ下げられます。上限の超過やdeadlineはrun/caseを未完了にし、そこで停止します。偶然passするまで同じ高コストcaseを反復しません。GPT usageが取得できなかったAPI失敗や中断を0消費とはみなさず、既知合計と`partial_or_unknown`を分けます。

artifactのrun/case duration、runtime報告call/token/latency、case status、fixture seedを使って結果を再現・比較します。API受付やGPT応答だけではpassにならず、成功caseはDB・Body観測・独立したRCON world oracleなど、ケースごとの結果条件を満たす必要があります。全caseがpassしcleanupも確認できた時だけrun全体をpassとします。

## 現在の検証状況

run6対象HEAD `daab18f`のCI 7 jobsと、この診断差分のserver typecheck・対象Lint・整形確認は成功しています。隔離Paperと実GPTを使うrunも実施済みです。run4では`runtime_contract`がpassしましたが、`autonomous_life`はGPTを11回呼び出し、60,055 tokensを消費してcase上限60,000を超えたため未完了です。残りのcaseもこの予算超過による停止で未実施となり、shutdown後の証跡収集失敗によりrun全体も未完了でした。

run5では非OP Bodyの`look`が成功し、対象stoneが視界内に入ったことを確認しました。続く`dig`は`action_timeout`で未確認となり、独立したRCON確認でもブロックの空気化を確認できずcase failです。fail-fastにより既定アプリとGPTは起動せず、GPT usageは0でした。server process、loopback listener、一時worldのcleanupはすべて確認済みです。furnace操作にも到達していません。

run6では非OP `dig`がsuccessfulとなり、serverとRCONの双方で対象ブロックの空気化を確認しました。furnace smokeではwindowを観測できず未完了となり、fail-fastでGPTは起動していません。cleanupは確認済みです。run6 artifactにはfurnaceのopen操作結果が保存されていないため、原因は特定できませんでした。今回のハーネス差分はRCONでfurnace fixtureを確認し、look後にBodyが対象furnaceを実際に観測するまで最大5秒の条件待ちを行い、open前後の状態と操作結果を安全な分類値で記録します。この診断差分自体は実ゲーム未確認です。

したがってIssue #72全体の受け入れは未達です。runtime contract以外の受け入れ条件はまだpassしておらず、自律生活、未知状況、観測境界、再起動、並行会話と停止、建築依頼、Skill学習・交換の実測が残っています。未実行の能力群や環境差も未検証のままです。
