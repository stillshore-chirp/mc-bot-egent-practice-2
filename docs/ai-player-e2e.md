# 自律プレイヤーの隔離受け入れ検証

`tests/e2e/ai-player-live.ts` は、新しい既定アプリケーションを新規の Paper ワールドと実際の GPT に接続し、Issue #72 の受け入れ条件をゲーム内の結果で確認するための手動実行ハーネスです。API受付、発話、ユニットテストだけでは受け入れをpassにしません。各ケースは成功・失敗・未完了を記録し、未確認の動作を合格へ読み替えません。

新しい既定経路と責務の境界は[自律プレイヤー](autonomous-player.md)、操作・可視範囲の契約は[プレイヤー操作アダプター](player-body.md)、判断に使うゲーム内知識は[MC Bot Skills](mc-bot-skills.md)を参照してください。

## 隔離と公開境界

ハーネスはNode.jsの `os.tmpdir()` が返すOS一時領域の下に一時ディレクトリを作り、Paper 1.21.11 の新規flat worldだけを起動します。固定値 `720926` は合成fixtureのseedです。既存worldや利用者のMinecraft環境には接続しません。接続先はloopbackに限定し、RCONはfixtureの作成・状態確認専用です。`ops.json` は空で、AIプレイヤー、owner、guestの3接続は通常の非OPプレイヤーとして動きます。Console相当のfixture操作はハーネスだけが行います。server jarが初回起動時に既存のPaper依存を必要とする環境では、任意の`AI_PLAYER_E2E_SERVER_CACHE_DIR`を指定できます。そこから`libraries`、`versions`、`cache`だけを新しい一時serverへコピーします。コピー元のworldやprocessには触れず、コピー中はsymlinkを除外します。自発行動fixtureの開始位置がspawnの乱数で変わらないよう、`minecraft:respawn_radius`を0へ設定・読み戻し、アプリ接続後のBot位置も確認します。

`prepareWorld` はbaseline取得前にspawn周辺の水平視野全体へ5個の合成`oak_log`を分散して置き、自律caseの資源fixtureに使います。Body smokeの最後には、操作確認に使った近距離セルを一時的な`oak_log`へ置き換え、Bodyの視線をそのセルへ向けた新しい観測に同じセル・同じblock nameが含まれることを確認します。原木のRCON設置を先に確認し、観測後はbaseline取得前に空へ戻してreadbackします。fixtureや観測に失敗した場合は固定codeで停止し、GPTを起動しません。これは資源の可視性fixtureであり、owner指示や自律goalを追加しません。静的な資源fixtureは既存fixtureやsmoke targetと位置を重ねず、`autonomous_life`終了後に残った`oak_log`だけをRCONで除去してreadback確認してから後続caseへ進みます。これは自律caseの成功判定後に行うcleanupです。

Body smokeでは非OP Botを隔離world内の固定された安全な開始位置へRCONで配置し、serverとBody双方の位置を確認します。採掘fixtureの対象セルが`air`であることを確認してから一時的な`stone`を置き、RCONで設置を読み戻してからBodyの可視・採掘条件を調べます。RCONはfixture設定だけに使い、Body操作の成功判定は従来どおりBot観測とserver oracleで行います。 最後に通常権限の相対移動を実行し、Bodyの到達判定とserver上の変位を別々に確かめてから開始位置へ戻します。

受け入れケースはownerとguestの実Minecraftチャットを使い、AIプレイヤーの判断は既定runtimeから実際のGPTへ送ります。API keyは既存の環境変数またはローカルdotenvから読み、artifactや標準出力に書きません。Minecraftログ、会話本文、プレイヤー名、UUID、座標、Skill本文はartifactへ保存しません。artifactには合成seed、case結果、上限と計測usage、固定分類コードだけを記録します。結果JSONは、Node.js `os.tmpdir()` 以下の `ai-player-e2e-results/` にmode `0600`で保存します。Paper stdout/stderrは一時領域のmode `0600`のprivate logに記録し、artifactや標準出力へ本文を出しません。失敗・未完了時は診断用copyを同じ一時領域の `ai-player-e2e-private-diagnostics/` にmode `0600`で残し、固定の分類コードとpathだけを表示します。成功時のprivate logは既定で削除します。終了時に自分で起動したserver processを停止し、一時world・DB・Skill交換ファイルを削除します。子process終了、server/RCONのloopback listener閉鎖、一時world削除を確認し、どれかが確認できない場合はpassになりません。Body smoke用clientと既定applicationのspawn位置がずれる可能性を避けるため、位置baselineはapplication接続後に取り、ブロック・所持品のbaselineはsmoke操作より前の状態を使います。

後段caseを切り分ける時は`AI_PLAYER_E2E_TARGET_CASE`に`game_action_discretion`、`unknown_composite`、`parallel_dialogue_stop`のいずれか一つを指定できます。新規Paper world、非OP Body smoke、既定runtime、実GPT、server oracleとcleanupは維持し、未選択caseは`CASE_NOT_SELECTED`の未完了としてartifactへ残します。`unknown_composite`だけは停止・再起動の前提である`autonomous_life`を実行し、その実測マイルストーンを引き継ぎます。障害物fixtureのRCON照会は各コマンドを2秒で打ち切り、応答遅延でfixture確認を飛ばしたり、復元不能を成功扱いにしたりしません。targeted run全体と`integrated_result`はpassにせず、Issue全体の受け入れには通常の全case runを必要とします。

未知状況と並行会話のowner依頼は目標の大まかな方角だけを伝えます。遮蔽された対象や迂回路、採取手順はBotが観測と判断で見つける必要があり、fixtureの座標や固定手順は会話へ渡しません。

実行caseの終了時に、そのcase内で最後に収集したPlayer snapshotの許可項目を、mode `0600`のrun別private JSONL sidecarへ1件保存します。収集元は`fresh_terminal`または`last_collected`として記録し、`last_collected`は失敗・停止後の状態を必ず表すものではありません。未実行caseにはsnapshotを割り当てず、公開artifactにはsidecar保持boolと固定書込失敗codeだけを出します。sidecar保存失敗は元のcase結果を変更しません。

`game_action_discretion` が予算・期限で停止した場合、case artifactには最後のsnapshotに残る範囲の`place`判断・結果数、本文を保存しない占有失敗数、占有失敗後の配置判断数を追加します。履歴が途中で切れた場合の件数は下限であり、0件は試行がなかった証明にはなりません。失敗summaryや時刻が欠けた場合は欠損件数を記録し、占有判定・時系列判定を未知として扱います。runtime snapshotは操作引数を保持しないため、fixtureの穴との一致と同じ位置の再試行は既知件数0・未知件数として記録します。位置や操作IDをartifactへ加えず、判定できない値を推測で埋めません。この診断は既存のpass条件やworld oracleを変更しません。

`game_action_discretion` がLLM予算超過でfixture判定中に停止した場合は、cleanup前に対象穴をbounded RCONで読み、artifactへ`oak_planks`、`air`、`unknown`の固定enumを記録します。`learning_reuse` のfixture可視失敗では、initial/reuse段階、RCONで確認した配置数、新しいBody観測を得たか、その観測で`oak_log`が一度でも見えたかを記録します。これらは原因切り分け用で、座標・本文・ID・生RCON返信は含まず、合格条件を変更しません。

再利用依頼後は、新しいowner proposalが記録されたことを短い待機窓で確かめます。owner返信後もproposalが増えない場合は固定code `LEARNING_REUSE_OWNER_PROPOSAL_MISSING` で未完了にし、学習結果が出るまで漫然とLLM予算を使い続けません。合格には従来どおりSkill参照、採掘のゲーム内結果、版とreceiptの更新を要求します。

再利用した採掘結果が出た直後、学習評価とDB改訂が非同期で続くことがあります。版とreceiptがその時点で見えない場合は最大30秒だけ観測を続け、対象Skillの新しい版とreceipt増加を両方確認します。Skill交換のexport/import依頼にも新しいowner proposalの短いreadbackを設け、会話側で目的提案に渡されない場合は固定codeで未完了にします。

Skill交換caseが停止した時は、export依頼・export確認・import依頼・同一Skillのimport確認・重複import依頼・重複不変性確認の最後の段階を固定enumで保存します。重複import依頼もowner proposalのreadbackを要求します。run42でimport tool成功までに10万tokensを少し超えたため、同caseの上限を15万tokensに設定し、run全体の80万tokens上限は維持します。予算増加自体を成功根拠にはしません。

連続caseで以前のowner提案がまだpendingなら、`game_action_discretion`のfixture準備前に最大45秒だけ自然な解決を待ちます。残れば固定code `PRIOR_OWNER_PROPOSALS_UNRESOLVED` で未完了とし、新しい修理依頼を重ねません。対象は既に存在するproposalの状態だけで、ハーネスが採用・辞退やgoal完了を代理で決めることはありません。待機中のusageもrun全体の上限に含めます。

設置操作ではMineflayerのnative place完了後、対象セルへ期待したブロック名のサーバー更新が届くまで最大5秒待ってからBody結果を確定します。更新packetとクライアントの読取状態が一致しなければ従来どおり`unverified`です。E2EのRCON readbackは別のgame oracleであり、Bodyの未検証結果を自動的に成功へ変えません。

`persistent_memory_restart` の失敗artifactは、記憶依頼へのconversation完了、`remember_owner_fact`の呼出しと固定結果分類、owner reply受信、DB保存のstageを示します。terminal conversationが保存toolを呼ばなければ`OWNER_FACT_TOOL_NOT_CALLED`、保存拒否なら`OWNER_FACT_SAVE_REJECTED`でcaseを未完了にし、その後の自律thoughtでcase予算を使い切る前に原因を分けます。再起動後のDB欠落と回答不一致は既存の固定failure codeで識別します。予算停止をpassへ変えず、DB保存・同一DB再起動・合成phrase回答の条件も変えません。事実本文、tool引数、会話本文はartifactへ出しません。

`parallel_dialogue_stop`が未完了の場合は、操作開始、guestの状態不変、owner依頼の解決、ownerへの接近、停止ラッチを固定boolで記録します。接近の照会回数と距離短縮の区分だけをartifactへ載せ、プレイヤー座標や会話本文は保存しません。guest依頼はBody開始済みの操作中に送り、500ms後の状態を確認します。その操作が自然終了した場合は次のBody開始済み操作を待ち、owner依頼は稼働中の操作へ送ります。後から届いたowner提案の採用・妥協を解決とし、どちらの場合も実際の接近を別に要求します。

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

`observation_boundary` は返信とoracleの確認後、合成の壁・チェストをRCONで除去し、空気のreadbackを確認して後続caseへ進みます。`learning_reuse` はbot周囲の8方位から空気の配置先を個別に探し、視野角を覆う位置に合成`oak_log`を置き、初回・再利用の各配置後15秒以内に得た新しいBody観測で`oak_log`が見えることをowner依頼前に確認します。配置場所が塞がっている場合や見えない場合は固定codeで未完了停止し、GPT依頼を送りません。各段階でRCONから位置とRotationを読み、位置と現在のyawを保ったtpでpitchのみを少し下向きに設定し、Position/Rotationを再読込して確認します。原木候補の高さはBot実位置の足元levelから選び、各setblock直前にもairを再確認します。初回と再利用の依頼はいずれも原木1本の採掘と結果確認を求め、RCONがfixture位置のうち少なくとも1か所から`oak_log`が消えたことを確かめます。成功操作とworld changeを記録した後、残りの合成原木だけをRCONで除去し、readbackしてから仮説確認・次のfixtureへ進みます。未完了時もcase終了後、後続caseの前に残った合成原木を同様に除去・readbackします。学習fixtureの成功判定後、初回の成功結果から新しい検証済み仮説が現れるまで、既存のcase/run期限と使用量上限の範囲内で最大30秒だけ確認します。確認できなければ固定codeで未完了停止します。

run36では配置先の占有、run37では配置確認後のBody可視条件未成立で未完了でした。run37の観測は占有が解消していたことを示しますが、pitch・高さ・遮蔽・観測時機のどれが原因かは区別できません。位置/yawを維持したpitch調整と高さ追従は次の検証に向けた仮説であり、実機では未確認です。新しいBody観測、RCON world判定、cleanup readbackの条件は維持します。

run38は最初のRotation読取で固定code `LEARNING_LOG_FIXTURE_ROTATION_READBACK_UNAVAILABLE` となり、GPT呼び出し前に停止しました。安全artifactにRCON返信原文がないため、指数表記などの形式差か一時的な読取失敗かは未確定です。parserは有限な指数表記とNBT数値suffixを扱い、読み取りは限定回数だけ再試行します。raw返信はartifactに保存せず、再試行後も解釈できない場合は未完了のまま停止し、0度を仮定しません。この対応は次の実機runまで未検証です。

`learning_reuse` 開始後に未完了停止したartifactには、最後に確認した段階を固定enumの `learningReuseStage` として記録します（初回fixture可視、初回dig確認、仮説作成、再利用fixture可視、再利用結果確認、版・receipt更新確認）。この値は進捗の診断だけを示し、既存のBody・DB・RCON条件を満たしたpass判定は変えません。Skill本文・IDや会話内容は含めません。

隔離実行で初回の成功と仮説作成を確認し、再利用用fixtureの可視確認までに学習caseが約16万トークンを使用したため、このcaseの上限を30 calls / 30万トークンにしています。run全体の80万トークン上限と、ゲーム内結果・Skill版・receiptのpass条件は維持します。

run40（HEAD `7466742`）はCI 7/7成功、隔離PaperでBody、runtime、自律行動、観測境界、永続記憶の5 caseがpassしました。学習fixtureは再利用段階で8個の原木設置、更新後のBody観測と原木可視性を確認しましたが、再利用結果を確認する前に学習caseの30 calls上限を31 callsで超え、約25.0万トークンで未完了でした。run全体は42 calls・304,653 tokensでusageは`partial_or_unknown`です。後続caseは未実施、server・listener・一時worldのcleanupは3/3確認済みです。終了時snapshotではowner proposalは初回依頼の1件だけで、再利用依頼後の新規proposalを確認できませんでした。この事実から再利用依頼が目的提案として伝わらなかった可能性が高いものの、LLM内部の理由は未確認です。

run41（HEAD `a18b351`）はCI 7/7成功、隔離PaperでBody、runtime、自律行動、観測境界、永続記憶、Skill本文・参照量の6 caseがpassしました。再利用依頼では新しいowner proposalを確認し、Skillを参照した採掘とRCON上の結果まで成立しました。採掘後約3秒のDB読取では版・receipt更新を確認できず、学習caseは17 calls・102,857 tokensで未完了です。その後のactivityに学習tool成功が現れましたが、対象Skillの版とreceiptはまだ照合できていません。Skill交換caseはexport活動を観測できないまま9 calls・102,205 tokensで10万tokens上限を超えました。終了時snapshotのproposalは学習用の2件で、Skill export依頼の新規提案は確認できません。run全体は41 calls・288,498 tokens、usage `partial_or_unknown`、cleanup 3/3です。後続のゲーム行動・未知状況・並行会話・統合caseは未実施です。

run42（HEAD `d7b9c4a`）はCI 7/7成功、隔離Paperで学習再利用とSkill本文・参照量を含む7 caseがpassしました。Skill交換ではexport tool成功2回とimport tool成功1回を記録しましたが、caseは12 calls・104,973 tokensで10万tokens上限を超えました。tool成功だけでは編集済みMarkdownが同じSkill ID・版・receiptへ反映されたか、重複importが不変かを証明できません。run全体は38 calls・244,985 tokens、usage `partial_or_unknown`、cleanup 3/3です。ゲーム行動・未知状況・並行会話・統合caseは未実施です。

run43（HEAD `c151088`）はCI 7/7成功、隔離PaperでSkill交換を含む8 caseがpassしました。交換は同じSkill IDへの編集反映と重複import後の版・本文・receipt不変性を照合しました。修理caseは8 calls・123,932 tokensで10万tokens上限を超え、最後のsnapshot内の`place`判断・結果は0件、cleanup前の対象穴はRCONで`air`でした。Skill交換で生じた3件のpending owner提案が次のcaseへ残り、修理依頼もpendingのまま終了しました。最後の判断の5 roundにはResponsesのcompaction itemが各1件含まれましたが、報告されたround inputは16,281から25,496 tokensへ増え、効率改善は実証できていません。run全体は62 calls・534,334 tokens、usage `partial_or_unknown`、cleanup 3/3です。未知複合状況・並行会話・統合caseは未実施です。

同じHEAD `7f8b272` のrun44はBody smokeの`look`がsuccessfulでも対象stoneが5秒以内のBody観測に現れず、GPTを呼ばず未完了でした。直後の同HEAD run45ではBody smokeはpassしたため、run44の失敗は再現しませんでした。run45は自発生活caseが16 calls・108,667 tokensで10万tokens上限を超え、修理caseに未到達です。両runともCI 7/7成功、cleanup 3/3です。修理caseの持ち越し提案を待つ新しい境界はまだ実ゲームで未検証です。

run46（HEAD `9c94326`）は後段の修理caseだけを選び、非OP Body smokeはpass、未選択10 caseと統合結果は未完了として保存しました。CI 7/7成功です。修理caseでは先行pending提案0件、`place`判断・結果各1件を記録し、cleanup前の穴はRCONで`oak_planks`でした。しかしBodyの`place`結果は`unverified`で、16 calls・103,883 tokensで10万tokens上限を超えたためcaseは未完了です。private診断の固定分類はnative place受付後の効果未観測で、timeoutではありません。設置のサーバー更新待機を加え、遅延更新なら成功、クライアント内だけの変更なら未検証のままとする単体テストを追加しました。新しい待機は次の実ゲームrunまで未検証です。run46のcleanupは3/3です。

run47（HEAD `c90d40b`）はBody smoke中に`look`が成功した一方、採掘対象セルのBody観測が`chest`であり、`stone`のfixture確認前に停止しました。GPT呼び出しは0、cleanup 3/3です。乱数を含むspawn位置から対象セルを決めていたため、隔離world内の既設宝箱へ重なる場合がありました。固定開始位置と空セル・設置readbackの変更はこの結果に対応します。設置後のサーバー更新待機はrun47では未実施です。

run48（HEAD `b05a58b`）の対象case実行では、修理用資材の設置をBodyとRCONの双方で確認し、ゲーム行動caseがpassしました。run59（HEAD `c11516c`）の対象case実行では、Body操作中のowner依頼変更、guestによる無権限変更の不成立、serverで確認した接近と即時停止を確認し、並行会話caseがpassしました。どちらも未選択caseを含む統合passではありません。run60（同HEAD）の未知複合caseでは自律行動caseがpassし、botは標的へ近づいて壁を掘りましたが、課題の採集・帰還・失敗後の回復はcase上限内で成立せず未完了です。障害物の準備中にbotが移動したため、制御された失敗の注入も適格性を失いました。いずれの実行も一時server・listener・worldのcleanupは3/3です。

未知複合caseでは、障害物のbackup・設置・readback中だけtickを停止し、安全な立ち位置を確認してからtickを再開します。失敗は再開時点で既知の操作と結果を除いた新しいBody操作の結果だけを数え、例外時もtickの再開をreadbackで確認します。fixtureの壁・水路・標的の距離も短縮し、遮蔽と水越えを保ったまま有限のcase予算で採集と帰還を測ります。

run61（HEAD `5cc1c25`）ではtickの停止・再開をreadbackで確認しましたが、停止前に取得した位置と障害物の準備中の実位置が一致せず、同一操作・立ち位置の適格性を失って注入はskipされました。未知複合caseは30 calls・210,977 tokensで上限を超え、標的の採集・持ち帰りと失敗後の回復は未達です。自律行動caseはpass、CIは7/7成功、cleanupは3/3です。

run62（HEAD `58ecd8a`）ではtick停止後の位置と安全な立ち位置を確認できましたが、障害物を置く前の最初の適格性確認で対象Body操作は既に終了しており、注入はskipされました。未知複合caseは25 calls・200,387 tokensで上限を超え、標的の採集・持ち帰りと失敗後の回復は未達です。自律行動caseはpass、CIは7/7成功、cleanupは3/3です。同じ操作の継続を障害物設置の条件にせず、安全な立ち位置で障害物を設置した後にtickを再開し、再開時点で既知だった操作・結果を除外した新しいBody失敗だけを数えるよう変更しました。障害物の適格性、復元、失敗後の再判断と課題達成は次の実ゲーム測定まで未確認です。

`unknown_composite` の固定診断には失敗・回復操作のkindと、課題送信後に初めて得た可視観測で青い羊毛・水・壁材(stone)が現れたかを含めます。この観測は課題送信時点の視界を示すとは限らず、可視観測が得られない場合はvisibilityを`unknown`として保持します。現在の保存用観測はブロック名のみで一般ブロックの位置を持たないため、stoneの有無は壁そのものの視認証明ではなく、壁材名の検出です。これらの診断は既存の達成・回復判定を変更しません。

課題送信後に成功した既存oracleサンプルだけから、開始位置からの最大移動距離bucket、標的への最短距離bucket、近づいた観測の有無、blocks・position・inventoryの進捗種別を上限付き集計で保存します。生座標や時系列は保存しません。有効サンプルがない場合は`not_sampled`または`unavailable`、一部読取失敗を含む集計は`partial`として扱います。これらは観測差分の診断で、成功操作やbot起因の進捗を証明しません。特にblock差分には自然な水流変化が含まれる可能性があります。取得・帰還の成功条件は従来どおり別のoracleで判定します。

unknown fixtureは壁と対象をspawnの+X側に配置するため、停止中にJava版のyaw -90°・pitch 0°を設定し、RCONのRotation readbackで向きを確認してからresumeします（Java yawは0°が南、負の90°が東）。向き確認後、課題送信前に取得できた観測receiptだけを別の`unknownPreTask...`項目へ記録します。向き設定後のreceiptが無い場合は`unknown`とし、課題後の`unknownTask...`可視観測とは混ぜません。この診断は対象座標をagentへ渡さず、fixtureや達成条件も変更しません。向き変更とpre-task分類は静的検証段階で、実Minecraftでは未測定です。

これらは代表ケースです。全操作の網羅、すべてのMinecraft環境・mod・protocol差、死亡を含むすべての結果を証明しません。未実装と判断した操作はありません。確認していない能力や環境差は未検証として残します。

## 操作群の検証状態

| 能力群                 | 操作                                                                                                                                 | ソース上の接続                        | fixture経由のハーネス確認                                                                                         | 実GPTの受け入れ・実測                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 移動・視線・入力       | `move_to`, `move_relative`, `look`, `control`                                                                                        | 29操作schemaとBody dispatchを静的確認 | run5で`look`成功と対象stone可視性を確認                                                                           | run10は`autonomous_life` pass・position進展、run11は成功`look`後もworld進展なしで未完了。passの再現性は未確認 |
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

既定上限は45分、160回のGPT呼び出し、合計800,000 tokensです。case上限は合計162 calls / 1,065,000 tokensで、各caseに独立したdeadlineがあります。`autonomous_life` は18 calls / 100,000 tokens、case deadlineは5分です。run18では11 calls・input 63,832・output 2,607・計66,439 tokensで旧60,000-token上限を超え、最後に記録された`commit_action_decision`はokでした。その後のsnapshotはusage gateでpredicate評価前に止まり、最後のsafe player診断と自律milestone進捗は異なる観測時点を示しています。artifact上のfollow-up判断未確認は「判断がなかった」証拠ではなく、判断時刻と成功outcome時刻の詳細はsafe artifactにありません。100,000 tokens / 18 callsは、run18の計測点から次の有限な判断・観測一巡を測る余裕（最大33,561追加tokens・7 calls）として設定します。これは測定上限でありIssueの達成条件ではありません。`unknown_composite` は32 calls / 200,000 tokens、case deadlineは7分です。run17では125,200 tokens消費時点で最低2つのterminal actionが不足していました。直近のround規模（1 actionあたり2–3 round、最大約8,500 input tokens）から、残る2 actionに約34,000–51,000 tokensが必要と見積もり、200,000を一回の測定に使う上限として設定しました。この見積もりは達成保証ではなく、上限まで消費する再試行や追加拡張の根拠にはしません。case上限のtoken合計はrun上限を265,000超え、calls合計も2回超えるため、run全体の上限を維持したままでは後続caseがglobal budgetで未完了停止する場合があります。成功条件とrun全体160/800,000/45分の上限は変更しません。`AI_PLAYER_E2E_MAX_DURATION_MINUTES`、`AI_PLAYER_E2E_MAX_LLM_CALLS`、`AI_PLAYER_E2E_MAX_TOTAL_TOKENS`で既定値以下へ下げられます。上限の超過やdeadlineはrun/caseを未完了にし、そこで停止します。偶然passするまで同じ高コストcaseを反復しません。GPT usageが取得できなかったAPI失敗や中断を0消費とはみなさず、既知合計と`partial_or_unknown`を分けます。

実行順は`runtime_contract`、`autonomous_life`、`observation_boundary`、`persistent_memory_restart`、`learning_reuse`、`skill_compactness_and_knowledge_separation`、`skill_exchange`、`game_action_discretion`、`unknown_composite`、`parallel_dialogue_stop`、`integrated_result`です。unknownのcase budget/deadlineでrunが停止する前に独立した6 caseを測り、unknown handoff後の停止検証をparallelのまま最後に保ちます。同一runtime・DB・goal/skill履歴を引き継ぐため、unknown開始前に蓄積する判断履歴は従来順と異なります。各caseのpredicate・fixtureはこの順序変更では変えません。学習caseの予算変更は前述の実測に基づきます。unknownまでの各caseがそれぞれ上限まで消費した場合、parallelの前にrun全体のtoken上限へ達します。unknownがbudget/deadline停止すれば`parallel_dialogue_stop`と、それら全結果を要求する`integrated_result`は未実行のままです。

artifactのrun/case duration、runtime報告call/token/latency、case status、fixture seedを使って結果を再現・比較します。API受付やGPT応答だけではpassにならず、成功caseはDB・Body観測・独立したRCON world oracleなど、ケースごとの結果条件を満たす必要があります。全caseがpassしcleanupも確認できた時だけrun全体をpassとします。後続runのsafe activityではrequest_errorの固定原因分類を保存し、思考中断と通信・provider失敗を区別します。過去runにこの分類を遡って補いません。

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

その後の隔離実ゲーム検証では、run43で自発生活からSkill再利用・Markdown往復までの8 case、run48で設置を伴う修理、run59で身体操作中の会話・owner要請後の接近・停止を確認しました。これらはそれぞれの実行で観測した範囲の結果で、全caseを一度にpassした証拠ではありません。

HEAD `0bd7656` の対象試験run65では、非OP Bodyの`move_relative`到達とサーバー上の変位、自発生活を確認しました。未知複合状況は26 calls・既知211,202 tokensで予算停止し、GPTは`move_relative`を選ばず、標的への接近・採集・持帰りは未確認でした。HEAD `f4db801` のrun66では判断初期入力の履歴・可視ブロック重複を縮約した状態で、Body smokeと自発生活がpassしました。未知複合状況ではGPTが`move_relative`を選び、実操作の失敗、後続判断と別の成功操作を観測しました。一方、標的への接近は確認できず、31 calls・既知203,916 tokensで予算停止しました。caseのusageはどちらも`partial_or_unknown`で、cleanupは双方3/3です。run65/66の初期入力文字数は同じ履歴・world状態で比較したものではないため、圧縮による使用量・達成率の改善は未確定です。

HEAD `57d9385` の対象試験run67では、圧縮後の古い移動結果を短い履歴として渡しました。Body smokeと自発生活はpassし、未知複合状況では標的方向への距離短縮をサーバー観測で確認しました。標的は未採集で、28 calls・既知205,800 tokensで予算停止です。障害物の介入は適格条件を満たさず、失敗後の回復は未確認でした。case usageは`partial_or_unknown`、cleanupは3/3です。run66と行動・world状態は異なるため、履歴追加の効果と断定しません。その後、古い移動履歴の相対変位を結果文から抽出する実装に偽の形式文字列を拾う余地を見つけ、観測時に保存した構造化値だけを使うよう修正しました。

HEAD `a1f844d` の対象試験run68では、構造化変位の履歴と未確定思考の新イベントによる先行中断を含む状態で、Body smokeと自発生活がpassしました。未知複合状況は33 calls・既知169,389 input / 9,686 output tokensでcase呼び出し上限となり、標的の破壊・取得は未確認です。サーバー上の位置とworldには変化がありましたが、標的への距離短縮は未確認でした。safe activityでは`commit_action_decision`の拒否0件、`request_error`13件を記録しました。run67の拒否12件・`request_error`4件から思考中断による改善とは判断できず、provider usage不明の呼び出しもあるため費用の比較はできません。結果上は`move_relative`のsuccessful outcomeが3件ありましたが、保存されたBody前後変位はいずれも0.2ブロック未満でした。このため、開始時点で到達済みとみなされる相対移動入力を拒否し、相対移動の成功には実移動を要求する修正を追加しました。この修正はユニット検証済みで、実ゲームでは未検証です。run68のusageは`partial_or_unknown`、cleanupは3/3です。

HEAD `d360a76` の対象試験run69では、空振りの相対移動を成功と扱わない修正を含む状態でBody smokeと自発生活がpassしました。未知複合状況は33 calls・既知114,843 input / 6,631 output tokensでcase呼び出し上限となり、標的の破壊・取得は未確認です。相対移動のsuccessful outcome 2件はいずれも保存したBody前後変位が1ブロック以上で、サーバー観測でも標的への距離短縮を確認しました。失敗後の回復は未確認です。safe activityには`commit_action_decision`拒否2件と`request_error`19件があり、先行中断の効率改善は主張できません。run68とは行動とworld状態が異なり、既知token量だけで修正の費用効果も断定できません。case usageは`partial_or_unknown`、cleanupは3/3です。同じ高コストcaseの反復はここで止め、思考中断の頻度と進捗の関係を次の設計判断に使います。

HEAD `058735f` の対象試験run70では、通常観測を進行中思考の後へ繰り越す変更を含む状態でBody smokeと自発生活がpassしました。未知複合状況では制御した障害による`move_to`失敗、障害の復元後に行われた新しい行動判断、別IDの`move_relative`成功をゲーム内で確認しました。サーバー観測では標的への距離短縮も確認しましたが、標的の破壊・取得は未確認です。33 calls・既知162,571 input / 12,444 output tokensでcase呼び出し上限となりました。safe activityの`request_error`は11件、`commit_action_decision`拒否は1件です。run69の19件・2件より少ないものの、world状態と行動経路が異なるため、観測繰り越しによる削減とは断定しません。case usageは`partial_or_unknown`、cleanupは3/3です。

HEAD `dc72c09` の対象試験run71では、検索結果に限定したSkill本文プレビューを追加した状態でBody smokeと自発生活がpassしました。未知複合状況では`search_skills`と`read_skill`をそれぞれ1回実行し、Skill本文へ到達する経路を確認しました。サーバー観測では標的への距離短縮とworld変化を確認しましたが、標的は見えず、破壊・取得も未確認です。障害物の介入は適格条件を満たさず、失敗後の回復は確認できませんでした。34 calls・既知108,066 input / 7,740 output tokensでcase呼び出し上限となりました。safe activityの`request_error`は19件で、プレビューによる達成率・使用量改善は断定できません。case usageは`partial_or_unknown`、cleanupは3/3です。

HEAD `41319ff` のrun72は`request_error`の原因分類を読むため、全体の上限を24 calls・150,000 tokensへ下げた診断試験です。Body smokeと自発生活はpassしました。未知複合状況は18 calls・既知103,155 input / 7,131 output tokensで全体予算に達し、標的への進展、破壊、取得、帰還を確認できませんでした。safe activityの`request_error`4件は`body_outcome`2件、`stop`1件、`owner_proposal`1件で、`request_failed`は0件です。これは序盤の分類だけで、run71後半のエラー原因を示しません。同じ18 callsで`describe_operation`5件と判断入力の最大13,570文字を観測しました。後続の基本操作向け短い入力署名は、この実行結果に含まれず、呼び出し数や費用の改善は未検証です。run全体の既知使用量は139,004 tokens、usageは`partial_or_unknown`、cleanupは3/3です。

HEAD `a1d1ff7` のrun73では基本4操作の短い入力署名を現行schemaから提示し、Body smokeと自発生活がpassしました。未知複合状況は30 calls・既知196,599 tokensで全体予算に達しました。別々の`move_relative`成功とサーバー上の位置変化を確認しましたが、標的への距離短縮、可視化、破壊・取得、取得物を持った帰還は未確認です。`search_skills`2件、`read_skill`3件、`describe_operation`5件を記録し、署名による照会削減は確認できませんでした。`commit_action_decision`拒否2件はこのHEADのsafe activityでは原因コードを残さず、1回の判断で6 roundを使いました。`request_error`8件は`body_outcome`4件、`stop`1件、`owner_proposal`1件、`state_changed`2件で、記録範囲に`request_failed`はありません。制御障害は適格な`move_to`が始まらず未実施です。run全体は39 calls・既知250,539 tokens、usageは`partial_or_unknown`、cleanupは3/3です。この結果だけで入力署名の費用効果や未知状況の達成を主張しません。

HEAD `8a9dd4a` のrun74ではBody smokeと自発生活がpassしました。未知複合状況は33 calls・既知197,271 tokensで上限に達し、run全体は39 calls・既知220,352 tokens、usageは`partial_or_unknown`、cleanupは3/3です。成功した移動操作を複数確認しましたが、サーバー判定では標的への距離短縮、採集、帰還を確認できず、障害物注入と失敗後の回復も未実施です。`commit_action_decision`は9件で拒否0件、`describe_operation`は3件、`propose_skill_learning`は4件で版照合拒否1件でした。`request_error`10件は`body_outcome`6件、`stop`1件、`owner_proposal`1件、`state_changed`2件で、記録範囲に`request_failed`はありません。前runとは世界内の進路が異なるため、照会数やtoken数の差を実装変更の効果とは断定しません。終了時の保存状態では、1件の妥協したowner proposalからactiveなowner goalが2件作られ、片方だけがproposalへ紐付いていました。異なる題名の妥協案を同時に保存すると重複する経路を特定して修正し、両commit経路の単体テストを追加しました。この修正後の実ゲーム結果は未確認です。

HEAD `b0a6312` のrun75ではBody smokeと自発生活がpassしました。未知複合状況は33 calls・既知158,765 tokens、run全体は41 calls・既知195,994 tokensで全体calls上限となり、usageは`partial_or_unknown`、cleanupは3/3です。1件の採用されたowner proposalに紐付くactive owner goalは1件で、紐付かないowner goalは0件となり、run74で見つかった重複保存の解消を隔離実環境でも確認しました。`move_to`成功5件とサーバー上の移動はありましたが、採集対象への距離短縮・破壊・取得・帰還は未確認です。最初の課題後観測では壁材だけが見え、標的と水は見えていませんでした。制御障害は適格条件を満たさずskipされ、失敗後の回復は未確認です。`describe_operation`4件、判断commit成功11件、学習提案成功2件を記録しました。対象へ近づかなかった理由はこの診断だけでは確定できず、同条件の再試行を完了証拠にはしません。

HEAD `4f87077` のrun76では現在の方角と座標軸を判断入力へ加え、Body smokeと自発生活がpassしました。未知複合状況は33 calls・既知199,751 tokens、run全体は41 calls・既知245,487 tokensで全体calls上限となり、usageは`partial_or_unknown`、cleanupは3/3です。複数の相対移動成功とサーバー上で開始地点から10ブロック以上の移動を確認しましたが、標的への距離短縮、破壊・取得・帰還は未確認です。最初の課題後観測では壁材は見え、標的と水は見えませんでした。制御障害は適格な操作が始まらず未実施です。方角の提示が進捗を改善したとは主張しません。

HEAD `9deb9b0` のrun77では過去の可視位置を最大6視点まで判断入力に加え、Body smokeと自発生活がpassしました。未知複合状況は32 calls・既知27,979 tokens、run全体は41 calls・既知76,862 tokensで全体calls上限となり、usageは`partial_or_unknown`、cleanupは3/3です。サーバー上で標的への距離短縮を一度確認しましたが、標的の破壊・取得・帰還は未確認です。run終了時のsafe activityでは41 round中28 roundが中断され、原因分類は`state_changed`24件、`body_outcome`2件、`stop`1件、`owner_proposal`1件でした。行動commit成功は3件に留まりました。過去視点の効果と中断増加の原因はこの1試行から断定できません。状態変化で判断が繰り返し中断される条件を調査し、同条件の再試行は増やしません。

HEAD `469ddca` のrun78では通常の呼吸や入水を緊急な状態変化と分け、Body smokeと自発生活がpassしました。未知複合状況は27 calls・既知207,109 tokens、run全体は34 calls・既知247,241 tokensでcase上限となり、usageは`partial_or_unknown`、cleanupは3/3です。safe activityの中断6件に`state_changed`はなく、`body_outcome`4件、`stop`1件、`owner_proposal`1件でした。行動commit成功14件とサーバー上の標的への距離短縮を一度確認しましたが、破壊・取得・取得物を持った帰還は未確認です。進行中操作への`continue`判断が9件あり、移動の完了前に再判断が繰り返されました。単一試行から原因や変更の効果を断定しません。

HEAD `b5cd1ec` のrun79では移動中のstall判定を本人の有意な移動に限定し、同種の可視ブロックの変化を最短距離帯へ集約しました。Body smokeと自発生活がpassし、未知複合状況は32 calls・既知205,583 tokens、run全体は37 calls・既知228,186 tokensでcase上限となりました。usageは`partial_or_unknown`、cleanupは3/3です。safe activityの中断8件は`body_outcome`6件、`stop`1件、`owner_proposal`1件で、`state_changed`は0件でした。保存済み判断では`continue`2件、行動commit成功12件、複数の相対移動成功を確認しました。サーバー上では標的への距離短縮を一度確認しましたが、最大変位は2以上5未満の区分で、標的の破壊・取得・持帰りは未確認です。障害物注入は適格条件がなく未実施、失敗後の回復も未確認です。run78と行動経路が異なり、再判断回数やtoken数の差を実装修正の効果とは断定しません。

HEAD `d46f9fd` のrun80は受け入れartifactを生成する前に経路探索中の未捕捉例外で終了したため、caseの成功・失敗として集計しません。`NavigationMovements`が未読み込みセルを名前のあるブロックと仮定し、ドア判定時に例外を起こす経路を特定しました。隔離runのserver processがないことと一時directoryに開いたfileがないことを確認し、このrunの一時worldだけを削除しました。HEAD `a0caf7d` で名前のないセルを通行不可のまま扱う修正と回帰テストを追加し、局所単体5件・server型検査・変更fileのlint・formatが成功しました。

HEAD `9995d7b` のrun81はrun80の例外なく受け入れartifactとcleanupを生成しました。Body smokeと自発生活がpassし、未知複合状況は31 calls・既知203,739 tokens、run全体は38 calls・既知241,451 tokensでcase上限となりました。usageは`partial_or_unknown`、cleanupは3/3です。safe activityの中断9件は`body_outcome`3件、`operation_stalled`3件、`stop`1件、`owner_proposal`1件、`manual`1件でした。サーバー上の標的への距離短縮と複数の相対移動成功は確認しましたが、最大変位は2以上5未満の区分で、標的の破壊・取得・取得物を持った帰還は未確認です。課題直後と終了時の保存状態では可視候補の打ち切りがあり、標的は見えていません。視線遮蔽との区別はできず、候補探索修正の実ゲーム上の効果は未確認です。障害物注入と失敗後の回復も未実施です。同じ条件での反復は増やしません。

run81の保存済み判断・結果を要約すると、相対移動中の停止通知を受けて別の相対移動へ切り替え、東への累積進捗は小さいままでした。壁・水路・標的を模したローカルのブロック集合では、既存`NavigationMovements`とpathfinderのA*がスポーンから標的隣接位置まで経路を返しました。これは簡略化した探索の確認であり、隔離Paper上でその経路を実際に歩けることやGPTが選ぶことの証拠ではありません。run81では制御障害の対象を`move_to`に限定していましたが、実行中は`move_relative`が主でした。次の受け入れ実行に向けて両方を対象とし、障害設置前の二度の資格確認で同じ開始済み操作IDが残ることを必須にしました。変更後の実ゲーム試験は未実施です。

この経路についてGPTを呼ばない隔離Paper probeを追加しました。角抜け修正前は、Botとサーバー双方の開始位置が一致していても、pathfinderは長い経路を12回`success`と報告し、Botは横へ移動する一方で東へ進まず、20秒で中断しました。pathfinderの斜め経路が壁の角を通り抜ける一歩を含むことを簡略地形で確認し、`NavigationMovements`の平地斜め移動では両脇の足元・頭上に通行空間がある場合だけ候補を残しました。修正後の同じprobeはBodyの移動が`successful`で、サーバー側の位置が標的近傍に到達し、API呼び出し0回、cleanup 3/3でした。このprobeは経路追従の実ゲーム確認であり、GPTによる採集・持帰りや失敗からの回復を証明しません。

HEAD `4a7874f` の未知複合状況だけを対象にした実GPT runでは、Body smokeと自発生活がpassしました。未知状況は32 calls・既知210,590 tokensでcase上限、run全体は39 calls・既知249,291 tokens、usageは`partial_or_unknown`、cleanup 3/3です。相対移動は複数回`successful`でしたが、最大変位は5以上10未満、標的への距離短縮・破壊・取得・帰還は未確認です。保存済み結果の正味移動は主に北・西で、迂回後に東へ戻る前に上限へ達しました。制御障害は開始済み操作IDの再確認時に適格性を失い、安全のため設置を見送りました。失敗後の回復は未確認です。基礎「移動」Skillには、方角が分かる時の相対経路探索と、横への迂回後に元の目的方向へ戻る判断材料を追加しました。このSkill改訂後の実ゲーム効果はまだ測定していません。

Issue #72全体の受け入れは未達です。`unknown_composite`の採集・持帰りと全caseを通した統合結果は未確認です。対象試験の後続caseをpassへ読み替えません。
