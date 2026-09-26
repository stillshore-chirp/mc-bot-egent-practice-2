# 自律プレイヤーの隔離受け入れ検証

`tests/e2e/ai-player-live.ts` は、新しい既定アプリケーションを新規の Paper ワールドと実際の GPT に接続し、Issue #72 の受け入れ条件をゲーム内の結果で確認するための手動実行ハーネスです。API受付、発話、ユニットテストだけでは受け入れをpassにしません。各ケースは成功・失敗・未完了を記録し、未確認の動作を合格へ読み替えません。

## Issue #72 の受け入れ方針（2026-09-27）

各必須動作は隔離Paperと実GPTを使い、ゲーム内結果で判定します。各部分runは独立したruntime・DBを持ち、そのrun内で複数能力の接続を確認します。複数runは重なりのある能力証拠で統合を支えますが、run間のDB永続性は主張しません。全caseを一度の長時間runで連続passさせる耐久評価は #76、開始時に遮蔽された目標の探索は #77 で扱います。

新しい既定経路と責務の境界は[自律プレイヤー](autonomous-player.md)、操作・可視範囲の契約は[プレイヤー操作アダプター](player-body.md)、判断に使うゲーム内知識は[MC Bot Skills](mc-bot-skills.md)を参照してください。

## 隔離と公開境界

ハーネスはNode.jsの `os.tmpdir()` が返すOS一時領域の下に一時ディレクトリを作り、Paper 1.21.11 の新規flat worldだけを起動します。固定値 `720926` は合成fixtureのseedです。既存worldや利用者のMinecraft環境には接続しません。接続先はloopbackに限定し、RCONはfixtureの作成・状態確認専用です。`ops.json` は空で、AIプレイヤー、owner、guestの3接続は通常の非OPプレイヤーとして動きます。Console相当のfixture操作はハーネスだけが行います。server jarが初回起動時に既存のPaper依存を必要とする環境では、任意の`AI_PLAYER_E2E_SERVER_CACHE_DIR`を指定できます。そこから`libraries`、`versions`、`cache`だけを新しい一時serverへコピーします。コピー元のworldやprocessには触れず、コピー中はsymlinkを除外します。自発行動fixtureの開始位置がspawnの乱数で変わらないよう、`minecraft:respawn_radius`を0へ設定・読み戻し、アプリ接続後のBot位置も確認します。

`prepareWorld` はbaseline取得前にspawn周辺の水平視野全体へ5個の合成`oak_log`を分散して置き、自律caseの資源fixtureに使います。Body smokeの最後には、操作確認に使った近距離セルを一時的な`oak_log`へ置き換え、Bodyの視線をそのセルへ向けた新しい観測に同じセル・同じblock nameが含まれることを確認します。原木のRCON設置を先に確認し、観測後はbaseline取得前に空へ戻してreadbackします。fixtureや観測に失敗した場合は固定codeで停止し、GPTを起動しません。これは資源の可視性fixtureであり、owner指示や自律goalを追加しません。静的な資源fixtureは既存fixtureやsmoke targetと位置を重ねず、`autonomous_life`終了後に残った`oak_log`だけをRCONで除去してreadback確認してから後続caseへ進みます。これは自律caseの成功判定後に行うcleanupです。

Body smokeでは非OP Botを隔離world内の固定された安全な開始位置へRCONで配置し、serverとBody双方の位置を確認します。採掘fixtureの対象セルが`air`であることを確認してから一時的な`stone`を置き、RCONで設置を読み戻してからBodyの可視・採掘条件を調べます。RCONはfixture設定だけに使い、Body操作の成功判定は従来どおりBot観測とserver oracleで行います。 最後に通常権限の相対移動を実行し、Bodyの到達判定とserver上の変位を別々に確かめてから開始位置へ戻します。

受け入れケースはownerとguestの実Minecraftチャットを使い、AIプレイヤーの判断は既定runtimeから実際のGPTへ送ります。API keyは既存の環境変数またはローカルdotenvから読み、artifactや標準出力に書きません。Minecraftログ、会話本文、プレイヤー名、UUID、座標、Skill本文はartifactへ保存しません。artifactには合成seed、case結果、上限と計測usage、固定分類コードだけを記録します。結果JSONは、Node.js `os.tmpdir()` 以下の `ai-player-e2e-results/` にmode `0600`で保存します。Paper stdout/stderrは一時領域のmode `0600`のprivate logに記録し、artifactや標準出力へ本文を出しません。失敗・未完了時は診断用copyを同じ一時領域の `ai-player-e2e-private-diagnostics/` にmode `0600`で残し、固定の分類コードとpathだけを表示します。成功時のprivate logは既定で削除します。終了時に自分で起動したserver processを停止し、一時world・DB・Skill交換ファイルを削除します。子process終了、server/RCONのloopback listener閉鎖、一時world削除を確認し、どれかが確認できない場合はpassになりません。Body smoke用clientと既定applicationのspawn位置がずれる可能性を避けるため、位置baselineはapplication接続後に取り、ブロック・所持品のbaselineはsmoke操作より前の状態を使います。

後段caseを切り分ける時は`AI_PLAYER_E2E_TARGET_CASE`に`food_intent_continuity`、`game_action_discretion`、`learning_reuse`、`unknown_composite`、`parallel_dialogue_stop`のいずれか一つを指定できます。新規Paper world、非OP Body smoke、既定runtime、実GPT、server oracleとcleanupは維持し、未選択caseは`CASE_NOT_SELECTED`の未完了としてartifactへ残します。`food_intent_continuity`は前提caseなしで対象caseだけを実行します。`learning_reuse`と`unknown_composite`は前提として`autonomous_life`だけを実行し、その実測runtime履歴を引き継ぎます。targeted runのcase結果は対応する受け入れ条件の根拠にできますが、それだけでrun全体やIssue全体をpassにしません。統合条件には共通runtime・DBを引き継ぐ重なりのある部分runを用い、長時間の全case連続耐久は #76 で確認します。障害物fixtureのRCON照会は各コマンドを2秒で打ち切り、応答遅延でfixture確認を飛ばしたり、復元不能を成功扱いにしたりしません。

`food_intent_continuity`では新規worldの満腹20から開始し、RCONで一時hunger effectを設定して、500ms間隔・最大60秒でfoodLevelが12〜15になるまで待ちます。範囲を外れた場合と期限切れは未完了にし、effectを解除して`active_effects`でreadbackします。先行発話は「Bot自身がパンを持っている」という事実だけを伝え、短い代名詞付き依頼ではpurpose判断に加え、successful consume、パン1個の減少、foodLevel上昇をすべて必須にします。
consume後のfoodLevelが20未満なら、満腹段階を作るためにRCONで`effect give <bot> minecraft:saturation 1 20 true`を一度だけ使い、3秒以内のfoodLevel 20 readbackとeffect解除を要求します。readbackできない場合は未完了で、consume成功や満腹成立を推定しません。finallyでもeffect解除を試し、解除を確認できない場合は後続caseを停止します。このsaturation commandとPaper上の返信形式は実環境未検証です。満腹20・パン1個を確認後、別のowner依頼に対する満腹説明・wait/complete判断・所持品とfoodLevel不変を照合します。
case上限は26 LLM calls / 180,000 tokens、case deadlineは8分です。観測窓は最大345秒（空腹準備60秒、先行返信45秒、consume段階150秒、満腹段階90秒）で、RCON・snapshot処理を含む全体を8分で打ち切ります。
初回対象run（HEAD `14931d9`）は食事case 45,424ms・13 calls・73,625 input / 2,389 output / 既知76,014 tokensで旧12-call上限に達し、consume結果の記録前に停止しました。安全activity集計は開始時purpose 6 calls / 50,714 tokens、ownerとの2ターンのconversation 3 / 13,191 tokens、proposal後のpurpose照会2 / 12,109 tokens、既知tokenなしの割込み2 callsでした。
2回目（HEAD `941d60a`）は食事case 57,294ms・14 case calls（run全体15 calls）・既知98,331 tokensで`FOOD_INTENT_HUNGRY_FOLLOWUP_DID_NOT_CONSUME`となり、run全体は92,167ms、cleanup 3/3でした。安全分類ではowner proposal declined、RCON foodLevel 19・bread 1、最後の判断はact / move_toでした。これは旧fixtureが20から19へ下がった時点でeffectを解除していたため、食事判断に十分な空腹状態を作れていなかった証拠として扱います。
2回目のcase usageは`partial_or_unknown`です。現上限からの名目残りは12 case calls / 81,669 known tokensですが、usage不明分で先に停止する場合があります。残るconsume成功＋server oracleと満腹説明＋不変確認の2段階に上限を限定し、run全体の160 calls / 800,000 tokens / 45分も維持します。過去runで準備時のhunger effect、foodLevel、inventory readbackは通りましたが、consume後・満腹段階のRCON oracleとsaturation commandは未確認です。artifactには固定booleanだけを残し、RCON返信や会話本文は保存しません。

未知状況と並行会話のowner依頼は目標の大まかな方角だけを伝えます。遮蔽された対象や迂回路、採取手順はBotが観測と判断で見つける必要があり、fixtureの座標や固定手順は会話へ渡しません。

実行caseの終了時に、そのcase内で最後に収集したPlayer snapshotの許可項目を、mode `0600`のrun別private JSONL sidecarへ1件保存します。収集元は`fresh_terminal`または`last_collected`として記録し、`last_collected`は失敗・停止後の状態を必ず表すものではありません。未実行caseにはsnapshotを割り当てず、公開artifactにはsidecar保持boolと固定書込失敗codeだけを出します。sidecar保存失敗は元のcase結果を変更しません。

`game_action_discretion` が予算・期限で停止した場合、case artifactには最後のsnapshotに残る範囲の`place`判断・結果数、本文を保存しない占有失敗数、占有失敗後の配置判断数を追加します。履歴が途中で切れた場合の件数は下限であり、0件は試行がなかった証明にはなりません。失敗summaryや時刻が欠けた場合は欠損件数を記録し、占有判定・時系列判定を未知として扱います。runtime snapshotは操作引数を保持しないため、fixtureの穴との一致と同じ位置の再試行は既知件数0・未知件数として記録します。位置や操作IDをartifactへ加えず、判定できない値を推測で埋めません。この診断は既存のpass条件やworld oracleを変更しません。

`game_action_discretion` がLLM予算超過でfixture判定中に停止した場合は、cleanup前に対象穴をbounded RCONで読み、artifactへ`oak_planks`、`air`、`unknown`の固定enumを記録します。`learning_reuse` のfixture可視失敗では、initial/reuse段階、RCONで確認した配置数、新しいBody観測を得たか、その観測で`oak_log`が一度でも見えたかを記録します。これらは原因切り分け用で、座標・本文・ID・生RCON返信は含まず、合格条件を変更しません。

再利用依頼後は、新しいowner proposalが記録されたことを短い待機窓で確かめます。owner返信後もproposalが増えない場合は固定code `LEARNING_REUSE_OWNER_PROPOSAL_MISSING` で未完了にし、学習結果が出るまで漫然とLLM予算を使い続けません。初回digはsuccessful outcomeに加え、RCON world snapshotの変化を必須にします。そのうえで、初回receipt/runから派生したtrusted hypothesis、初回digで使った既存trusted-derived Skill、または初回digと同じ成功receipt・既存Skill・使用versionを指す`mc_bot_skill_evidence_revisions`を確認します。既存Skill改訂経路では、新しいSkill IDが作られていないこと、使用版と改訂版の両方がimmutable revision historyにあること、conditions・body・expected outcome・confidenceの少なくとも一つが実質的に変わっていることを要求します。revision履歴の追加だけでは通しません。

再利用時も、新しいowner proposal、同じSkillへの新規consultation、successful dig、RCON world snapshotの変化を確認します。続けて、そのdigのtrusted receiptに結び付いた同じSkill・使用version・新しい改訂versionを`mc_bot_skill_evidence_revisions`から確認し、使用版から上記4項目のいずれかが実質的に変わったこと、再利用段階で新しいSkill IDが作られていないことを要求します。学習counter、receipt総数、version総数の増加だけでは受け入れません。dig直後にそのreceipt-linked revisionがまだ見えない場合だけ最大30秒観測します。Skill交換のexport/import依頼にも新しいowner proposalの短いreadbackを設け、会話側で目的提案に渡されない場合は固定codeで未完了にします。

Skill交換caseが停止した時は、export依頼・export確認・import依頼・同一Skillのimport確認・重複import依頼・重複不変性確認の最後の段階を固定enumで保存します。重複import依頼もowner proposalのreadbackを要求します。run42でimport tool成功までに10万tokensを少し超えたため、同caseの上限を19万tokensに設定し、run全体の80万tokens上限は維持します。予算増加自体を成功根拠にはしません。

連続caseで以前のowner提案がまだpendingなら、`game_action_discretion`のfixture準備前に最大45秒だけ自然な解決を待ちます。残れば固定code `PRIOR_OWNER_PROPOSALS_UNRESOLVED` で未完了とし、新しい修理依頼を重ねません。対象は既に存在するproposalの状態だけで、ハーネスが採用・辞退やgoal完了を代理で決めることはありません。待機中のusageもrun全体の上限に含めます。

設置操作ではMineflayerのnative place完了後、対象セルへ期待したブロック名のサーバー更新が届くまで最大5秒待ってからBody結果を確定します。更新packetとクライアントの読取状態が一致しなければ従来どおり`unverified`です。E2EのRCON readbackは別のgame oracleであり、Bodyの未検証結果を自動的に成功へ変えません。

`persistent_memory_restart` の失敗artifactは、記憶依頼へのconversation完了、`remember_owner_fact`の呼出しと固定結果分類、owner reply受信、DB保存のstageを示します。terminal conversationが保存toolを呼ばなければ`OWNER_FACT_TOOL_NOT_CALLED`、保存拒否なら`OWNER_FACT_SAVE_REJECTED`でcaseを未完了にし、その後の自律thoughtでcase予算を使い切る前に原因を分けます。再起動後のDB欠落と回答不一致は既存の固定failure codeで識別します。予算停止をpassへ変えず、DB保存・同一DB再起動・合成phrase回答の条件も変えません。事実本文、tool引数、会話本文はartifactへ出しません。

`parallel_dialogue_stop`が未完了の場合は、操作開始、guestの状態不変、owner依頼の解決、ownerへの接近、停止ラッチを固定boolで記録します。接近の照会回数と距離短縮の区分だけをartifactへ載せ、プレイヤー座標や会話本文は保存しません。guest依頼はBody開始済みの操作中に送り、500ms後の状態を確認します。その操作が自然終了した場合は次のBody開始済み操作を待ち、owner依頼は稼働中の操作へ送ります。後から届いたowner提案の採用・妥協を解決とし、どちらの場合も実際の接近を別に要求します。

## Issue #72 の機械的な確認範囲

### 現行#72の7受け入れ基準と後続Issue

7基準は、代表身体操作と既存層、自発生活、未知状況、擬似視覚と再起動記憶、必要時のSkill参照と経験学習、行動中の基本会話と停止、統合実ゲーム検証と配送です。基礎受け入れは #72 に残し、owner目標変更から接近までの連続性は #78、Skill Markdown往復は #79、Skill選択性と事実知識分離は #80 で追跡します。全case連続耐久は #76、遮蔽目標探索は #77 です。統合実ゲーム検証と配送は未完了です。

| Issue受け入れ条件     | ケースと根拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身体操作の接続        | `body_operation_smoke` は非OPのPlayerBodyを直接使い、採掘・視点変更・かまど画面の開閉と入出庫をBody観測およびRCONで照合します。最後に近距離へ置いた原木へ視線を向け、同一セルのBody観測とRCON設置・cleanup readbackを確認します。GPT受け入れは別に集計します。                                                                                                                                                                                                                                          |
| 既存層の見直し        | `runtime_contract` が既定アプリのplayer runtime evidenceと接続を確認し、`autonomous_life` がowner指示なしの実行を確認します。既存legacy経路との静的な責務確認はソース・設計文書も併せてレビューします。                                                                                                                                                                                                                                                                                                 |
| 自発的な生活          | `autonomous_life` はself由来の目標、GPT判断、成功した操作結果、RCONで観測する位置・所持品・fixture regionのいずれかの実変化を要求します。操作kindを`place`等に固定しません。                                                                                                                                                                                                                                                                                                                            |
| 未知の状況への対応    | `unknown_composite` は乾地の壁障害と地上dropを組み合わせ、実GPTの失敗後の再観測・再判断、別種または変更条件での回復、RCONで確認するworld進捗・対象所持・spawn帰還を確認します。途中oracle診断は失敗の有無から独立して保存します。                                                                                                                                                                                                                                                                       |
| 擬似視覚と記憶        | `observation_boundary` はfixture設置後に得た可視観測の時刻と、その後のbot返信受信時刻を照合し、RCONで隠しitemを確認しながらFOV・遮蔽・可視領域へのitem漏洩を検査します。返信本文はrun別のmode `0600` private sidecarだけに保存し、公開artifactには返信有無・限定的なheuristic分類・手動確認要否だけを記録します。heuristicは意味全体を判定しないため、Issue受け入れはsidecarの確認まで未確認です。`persistent_memory_restart` は会話からowner由来factを保存し、同じDBで再起動した後の回答と照合します。 |
| 食事依頼の会話継続    | `food_intent_continuity` はBot自身がパンを持つ事実をownerが先に伝えた後、短い代名詞付きfollow-upでsuccessful consumeを要求します。hunger effectで安全な空腹域を作り、purpose判断、RCON上のパン減少、foodLevel上昇を照合します。続く独立段階では満腹20・パン1個を確認した上で、満腹説明、wait/complete判断、所持品とfoodLevel不変を要求します。会話本文はartifactへ保存しません。                                                                                                                        |
| 並行会話と行動変更    | `parallel_dialogue_stop` は進行中の操作へguestとownerが実際に話しかけ、guestの状態変更拒否、ownerの強い要請に対する目的解決とownerへ近づくRCON位置変化、停止ラッチと停止後の再開防止を確認します。                                                                                                                                                                                                                                                                                                      |
| 拒否境界の更新        | `game_action_discretion` は視界内の板材壁にある目線の高さの穴を、ownerの通常依頼で修理します。GPT依頼前の新しいBody観測で壁材を確認し、配置の成功・world変化・穴が埋まったことをRCONで照合します。fixtureの向きと配置はRCONで確認し、終了時は合成ブロックだけを除去してreadbackします。建築の一律拒否やブロック単位の再承認が残っていないことを検証します。                                                                                                                                             |
| Skillの必要時参照     | `learning_reuse` と`skill_compactness_and_knowledge_separation` は収集結果に結び付いたSkillの作成・後続相談と、限定された参照量、ゲームレジストリ知識の分離を確認します。                                                                                                                                                                                                                                                                                                                               |
| 自己学習              | `learning_reuse` は初回digのsuccessful receiptからDB上で導いた仮説、または開始前から存在するtrusted-derived Skill IDを初回dig outcomeが使い、その使用versionが現行のimmutable revision historyにあることを確認します。その候補が次のdigで再consultされ、ゲーム内結果、後続revision version、trusted receipt増加まで続くことを照合します。                                                                                                                                                               |
| 簡潔なSkillと知識分離 | `skill_compactness_and_knowledge_separation` は保存本文が8 KiB以内であること、全件ではないSkill参照、別のregistry知識APIを確認します。                                                                                                                                                                                                                                                                                                                                                                  |
| DBとMarkdownの往復    | `skill_exchange` はexportしたファイル名と同一Skill IDをimport活動・DBで照合し、合成編集marker、同IDの版・receipt更新、同じファイルの再import試行後に同IDの本文・版・receiptが変わらないことを確認します。                                                                                                                                                                                                                                                                                               |
| 統合した実ゲーム検証  | `integrated_result` は上記のGPT・Body・server oracleの各ケースがpassした場合だけ統合passにします。                                                                                                                                                                                                                                                                                                                                                                                                      |

現在の#72 fixtureは乾地で、壁が直進経路を妨げる一方、標的は開始時から視界に入る構成です。対象とその直下のstone床はRCONで確認します。開始時に遮蔽された目標の探索は #77 の対象です。過去の水中drop課題・実行・probeは#74の検討対象へ切り分け、run履歴は監査用に残しますが#72の受け入れ根拠には数えません。問題文は対象物・空の所持品・帰還先と失敗後の見直しを伝え、障害物の位置や解法は示しません。`unknown_composite`の48 calls / 390,000 tokens / 7分の上限は据え置きで、旧fixtureの測定を新fixtureの受け入れ証拠へ流用しません。`AI_PLAYER_E2E_RETURN_PATH_PROBE_ONLY`はGPTなしの診断であり、#72の実GPT受け入れを代替しません。

`observation_boundary` は返信とoracleの確認後、合成の壁・チェストをRCONで除去し、空気のreadbackを確認して後続caseへ進みます。`learning_reuse` はbot周囲の8方位から空気の配置先を個別に探し、視野角を覆う位置に合成`oak_log`を置き、初回・再利用の各配置後15秒以内に得た新しいBody観測で`oak_log`が見えることをowner依頼前に確認します。配置場所が塞がっている場合やBody観測で見えない場合は固定codeで未完了停止し、GPT依頼を送りません。各段階でRCONから位置とRotationを読み、位置と現在yawを指定してpitchを設定するtpを試します。位置readback不一致とRotation readbackの取得不能は引き続き未完了停止します。yaw/pitchの一致は固定booleanで診断記録し、向き設定直前のactive operation有無も記録しますが、一致自体は合格条件にしません。RCONで原木の設置を確認し、15秒以内の新しいBody観測に`oak_log`が含まれることを初回・再利用それぞれのowner依頼前に必須とします。原木候補の高さはBot実位置の足元levelから選び、各setblock直前にもairを再確認します。初回と再利用の依頼はいずれも原木1本の採掘と結果確認を求め、RCONがfixture位置のうち少なくとも1か所から`oak_log`が消えたことを確かめます。成功操作とworld changeを記録した後、残りの合成原木だけをRCONで除去し、readbackしてから仮説確認・次のfixtureへ進みます。未完了時もcase終了後、後続caseの前に残った合成原木を同様に除去・readbackします。初回dig後は、次のどちらかを読み取り専用DB snapshotで確認します。(1) そのdigと同じrun IDのsuccessful receiptに結び付いたderived hypothesisとそのrevision version、(2) case開始時のsnapshotにsuccessful receipt由来のderived hypothesisを持つSkill IDが存在し、初回dig outcomeのSkill IDが一致し、outcomeの使用versionが現行snapshotのimmutable revision historyにあること。どちらの場合も、選ばれた同じSkillが次の採掘で新規consultされ、successful outcomeとserver world changeが確認され、さらに後続revision versionとtrusted receipt件数が増えた時だけpassします。(1)のDB記録は既存case/run期限と使用量上限の範囲内で最大30秒だけ待ち、確認できなければ固定codeで未完了停止します。(2)は開始時snapshotのtrusted derivationと初回outcomeのID/version一致を確認し、使用versionの存在は現行immutable historyで照合します。

run36では配置先の占有、run37では配置確認後のBody可視条件未成立で未完了でした。run37の観測は占有が解消していたことを示しますが、pitch・高さ・遮蔽・観測時機のどれが原因かは区別できません。位置/yawを維持したpitch調整と高さ追従は次の検証に向けた仮説であり、実機では未確認です。新しいBody観測、RCON world判定、cleanup readbackの条件は維持します。

run38は最初のRotation読取で固定code `LEARNING_LOG_FIXTURE_ROTATION_READBACK_UNAVAILABLE` となり、GPT呼び出し前に停止しました。安全artifactにRCON返信原文がないため、指数表記などの形式差か一時的な読取失敗かは未確定です。parserは有限な指数表記とNBT数値suffixを扱い、読み取りは限定回数だけ再試行します。raw返信はartifactに保存せず、再試行後も解釈できない場合は未完了のまま停止し、0度を仮定しません。この対応は次の実機runまで未検証です。

`learning_reuse` 開始後に未完了停止したartifactには、最後に確認した段階を固定enumの `learningReuseStage` として記録します（初回fixture可視、初回dig確認、初回digの仮説根拠確認、再利用fixture可視、再利用結果確認、版・receipt更新確認）。この値は進捗の診断だけを示し、既存のBody・DB・RCON条件を満たしたpass判定は変えません。Skill本文・IDや会話内容は含めません。

隔離実行で初回の成功と仮説作成を確認し、再利用用fixtureの可視確認までに学習caseが約16万トークンを使用したため、このcaseの上限を30 calls / 30万トークンにしています。run全体の80万トークン上限と、ゲーム内結果・Skill版・receiptのpass条件は維持します。

run40（HEAD `7466742`）はCI 7/7成功、隔離PaperでBody、runtime、自律行動、観測境界、永続記憶の5 caseがpassしました。学習fixtureは再利用段階で8個の原木設置、更新後のBody観測と原木可視性を確認しましたが、再利用結果を確認する前に学習caseの30 calls上限を31 callsで超え、約25.0万トークンで未完了でした。run全体は42 calls・304,653 tokensでusageは`partial_or_unknown`です。後続caseは未実施、server・listener・一時worldのcleanupは3/3確認済みです。終了時snapshotではowner proposalは初回依頼の1件だけで、再利用依頼後の新規proposalを確認できませんでした。この事実から再利用依頼が目的提案として伝わらなかった可能性が高いものの、LLM内部の理由は未確認です。

run41（HEAD `a18b351`）はCI 7/7成功、隔離PaperでBody、runtime、自律行動、観測境界、永続記憶、Skill本文・参照量の6 caseがpassしました。再利用依頼では新しいowner proposalを確認し、Skillを参照した採掘とRCON上の結果まで成立しました。採掘後約3秒のDB読取では版・receipt更新を確認できず、学習caseは17 calls・102,857 tokensで未完了です。その後のactivityに学習tool成功が現れましたが、対象Skillの版とreceiptはまだ照合できていません。Skill交換caseはexport活動を観測できないまま9 calls・102,205 tokensで10万tokens上限を超えました。終了時snapshotのproposalは学習用の2件で、Skill export依頼の新規提案は確認できません。run全体は41 calls・288,498 tokens、usage `partial_or_unknown`、cleanup 3/3です。後続のゲーム行動・未知状況・並行会話・統合caseは未実施です。

run42（HEAD `d7b9c4a`）はCI 7/7成功、隔離Paperで学習再利用とSkill本文・参照量を含む7 caseがpassしました。Skill交換ではexport tool成功2回とimport tool成功1回を記録しましたが、caseは12 calls・104,973 tokensで10万tokens上限を超えました。tool成功だけでは編集済みMarkdownが同じSkill ID・版・receiptへ反映されたか、重複importが不変かを証明できません。run全体は38 calls・244,985 tokens、usage `partial_or_unknown`、cleanup 3/3です。ゲーム行動・未知状況・並行会話・統合caseは未実施です。

run43（HEAD `c151088`）はCI 7/7成功、隔離PaperでSkill交換を含む8 caseがpassしました。交換は同じSkill IDへの編集反映と重複import後の版・本文・receipt不変性を照合しました。修理caseは8 calls・123,932 tokensで10万tokens上限を超え、最後のsnapshot内の`place`判断・結果は0件、cleanup前の対象穴はRCONで`air`でした。Skill交換で生じた3件のpending owner提案が次のcaseへ残り、修理依頼もpendingのまま終了しました。最後の判断の5 roundにはResponsesのcompaction itemが各1件含まれましたが、報告されたround inputは16,281から25,496 tokensへ増え、効率改善は実証できていません。run全体は62 calls・534,334 tokens、usage `partial_or_unknown`、cleanup 3/3です。未知複合状況・並行会話・統合caseは未実施です。

同じHEAD `7f8b272` のrun44はBody smokeの`look`がsuccessfulでも対象stoneが5秒以内のBody観測に現れず、GPTを呼ばず未完了でした。直後の同HEAD run45ではBody smokeはpassしたため、run44の失敗は再現しませんでした。run45は自発生活caseが16 calls・108,667 tokensで10万tokens上限を超え、修理caseに未到達です。両runともCI 7/7成功、cleanup 3/3です。修理caseの持ち越し提案を待つ新しい境界はまだ実ゲームで未検証です。

run46（HEAD `9c94326`）は後段の修理caseだけを選び、非OP Body smokeはpass、未選択10 caseと統合結果は未完了として保存しました。CI 7/7成功です。修理caseでは先行pending提案0件、`place`判断・結果各1件を記録し、cleanup前の穴はRCONで`oak_planks`でした。しかしBodyの`place`結果は`unverified`で、16 calls・103,883 tokensで10万tokens上限を超えたためcaseは未完了です。private診断の固定分類はnative place受付後の効果未観測で、timeoutではありません。設置のサーバー更新待機を加え、遅延更新なら成功、クライアント内だけの変更なら未検証のままとする単体テストを追加しました。新しい待機は次の実ゲームrunまで未検証です。run46のcleanupは3/3です。

run47（HEAD `c90d40b`）はBody smoke中に`look`が成功した一方、採掘対象セルのBody観測が`chest`であり、`stone`のfixture確認前に停止しました。GPT呼び出しは0、cleanup 3/3です。乱数を含むspawn位置から対象セルを決めていたため、隔離world内の既設宝箱へ重なる場合がありました。固定開始位置と空セル・設置readbackの変更はこの結果に対応します。設置後のサーバー更新待機はrun47では未実施です。

run48（HEAD `b05a58b`）の対象case実行では、修理用資材の設置をBodyとRCONの双方で確認し、ゲーム行動caseがpassしました。run59（HEAD `c11516c`）の対象case実行では、Body操作中のowner依頼変更、guestによる無権限変更の不成立、serverで確認した接近と即時停止を確認し、並行会話caseがpassしました。どちらも未選択caseを含む統合passではありません。run60（同HEAD）の未知複合caseでは自律行動caseがpassし、botは標的へ近づいて壁を掘りましたが、課題の採集・帰還・失敗後の回復はcase上限内で成立せず未完了です。障害物の準備中にbotが移動したため、制御された失敗の注入も適格性を失いました。いずれの実行も一時server・listener・worldのcleanupは3/3です。

未知複合caseでは、障害物のbackup・設置・readback中だけtickを停止し、安全な立ち位置を確認してからtickを再開します。失敗は再開時点で既知の操作と結果を除いた新しいBody操作の結果だけを数え、例外時もtickの再開をreadbackで確認します。現在のfixtureは壁と標的の距離を保ち、対象直下のstone床をRCONで確認します。壁による経路変更、失敗後の再観測・別行動、採集と帰還を測ります。

run61（HEAD `5cc1c25`）ではtickの停止・再開をreadbackで確認しましたが、停止前に取得した位置と障害物の準備中の実位置が一致せず、同一操作・立ち位置の適格性を失って注入はskipされました。未知複合caseは30 calls・210,977 tokensで上限を超え、標的の採集・持ち帰りと失敗後の回復は未達です。自律行動caseはpass、CIは7/7成功、cleanupは3/3です。

run62（HEAD `58ecd8a`）ではtick停止後の位置と安全な立ち位置を確認できましたが、障害物を置く前の最初の適格性確認で対象Body操作は既に終了しており、注入はskipされました。未知複合caseは25 calls・200,387 tokensで上限を超え、標的の採集・持ち帰りと失敗後の回復は未達です。自律行動caseはpass、CIは7/7成功、cleanupは3/3です。同じ操作の継続を障害物設置の条件にせず、安全な立ち位置で障害物を設置した後にtickを再開し、再開時点で既知だった操作・結果を除外した新しいBody失敗だけを数えるよう変更しました。障害物の適格性、復元、失敗後の再判断と課題達成は次の実ゲーム測定まで未確認です。

`unknown_composite` の固定診断には壁・乾地fixtureのRCON readback、失敗・回復操作のkind、課題送信後に初めて得た可視観測で青い羊毛・壁材(stone)が現れたかを含めます。この観測は課題送信時点の視界を示すとは限らず、可視観測が得られない場合はvisibilityを`unknown`として保持します。現在の保存用観測はブロック名のみで一般ブロックの位置を持たないため、stoneの有無は壁そのものの視認証明ではなく、壁材名の検出です。これらの診断は既存の達成・回復判定を変更しません。

課題送信後に成功した既存oracleサンプルだけから、開始位置からの最大移動距離bucket、標的への最短距離bucket、近づいた観測の有無、blocks・position・inventoryの進捗種別を上限付き集計で保存します。生座標や時系列は保存しません。有効サンプルがない場合は`not_sampled`または`unavailable`、一部読取失敗を含む集計は`partial`として扱います。これらは観測差分の診断で、成功操作やbot起因の進捗を証明しません。特にblock差分には自然な水流変化が含まれる可能性があります。取得・帰還の成功条件は従来どおり別のoracleで判定します。

unknown fixtureは壁と対象をspawnの+X側に配置するため、停止中にJava版のyaw -90°・pitch 0°を設定し、RCONのRotation readbackで向きを確認してからresumeします（Java yawは0°が南、負の90°が東）。壁は足元の一段に置いて直進移動を妨げつつ、標的までの初期視線を通します。RCON preflightは壁足元、初期視線、短い横迂回路の足場・通行空間と迂回後の視線を確認します。向き確認後、課題送信前に取得できた観測receiptだけを別の`unknownPreTask...`項目へ記録します。向き設定後のreceiptが無い場合は`unknown`とし、課題後の`unknownTask...`可視観測とは混ぜません。この診断は対象座標をagentへ渡さず、達成条件も変更しません。実GPT＋Paperの対象caseでは乾地fixtureの標的が開始時から視界に入り、case passを確認しました。遮蔽された目標の自律探索は #77 で検証します。

これらは代表ケースです。全操作の網羅、すべてのMinecraft環境・mod・protocol差、死亡を含むすべての結果を証明しません。未実装と判断した操作はありません。確認していない能力や環境差は未検証として残します。

## 操作群の初期実測

| 能力群                 | 操作                                                                                                                                 | ソース上の接続                        | fixture経由のハーネス確認                                                                                         | 実GPTの受け入れ・実測                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 移動・視線・入力・拾得 | `move_to`, `move_relative`, `look`, `look_sweep`, `control`, `collect_item`                                                          | 31操作schemaとBody dispatchを静的確認 | run5で`look`成功と対象stone可視性を確認                                                                           | run10は`autonomous_life` pass・position進展、run11は成功`look`後もworld進展なしで未完了。passの再現性は未確認 |
| ブロックと制作         | `attack`, `dig`, `place`, `craft`                                                                                                    | 同上                                  | run6の非OP `dig`成功とRCONの空気化確認。`place`・`craft`の直接smokeは未実施                                       | run10のposition進展からブロック操作は確認できず、owner依頼の建築も未実施                                      |
| 装備・使用・所持品     | `equip`, `use`, `consume`, `toss`, `transfer`                                                                                        | 同上                                  | run9・run10のfurnace `window_transfer`投入・返却を確認。他の所持品操作は未確認                                    | GPT経由の操作は未実行・未網羅                                                                                 |
| 画面と設備             | `open_window`, `window_click`, `window_transfer`, `window_close`                                                                     | 同上                                  | run9・run10でfurnace可視化、open、投入、返却、closeがすべてpass。投入はBody・RCON双方を確認。run8失敗原因は未特定 | GPTによる設備操作は未実行                                                                                     |
| 活動・乗り物・専門画面 | `fish`, `sleep`, `wake`, `mount`, `dismount`, `move_vehicle`, `elytra_fly`, `trade`, `enchant`, `anvil`, `write_book`, `update_sign` | 同上                                  | 専用fixture smokeなし                                                                                             | run10・run11の予算停止後caseは未実行                                                                          |

「ソース上の接続」は実ゲーム実行の証明ではありません。fixture smokeはGPTの自律判断と別case・別usageで記録します。直接のfixture smokeがないことを非対象化や未実装の断定に使いません。能力別の結果はartifactと統合後の受け入れ記録で更新してください。

## 実行条件と上限

実行にはNode.js環境、Java 21、Paper 1.21.11の起動用jar（manifestの`Main-Class`は`io.papermc.paperclip.Main`）、利用者が同意済みのEULAファイルが必要です。GPTを使うcaseでは利用可能な`OPENAI_API_KEY`も必要です。ユーザーが実API・server実行を指定した節目に、専用環境で次のように呼び出します。

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

`AI_PLAYER_E2E_RETURN_PATH_PROBE_ONLY=YES`を加えると、Body smoke後に壁と乾地床をRCON確認したfixtureで採掘dropの回収とspawn帰還を診断します。drop位置の下にstone床があるかも固定boolで記録します。このprobeはGPT/APIキー不要で、`AI_PLAYER_E2E_NAVIGATION_PROBE_ONLY`とは同時指定できません。採掘後のdrop位置へBodyでlookし、現在のBody観測に非playerの`name=item`が一意に見えた場合だけ、その可視entity IDを指定して`collect_item`を一度実行します。dropが不可視・曖昧・観測不能なら固定codeで未完了とし、追従も帰還も行いません。拾得確認にはBodyのsuccessful status、対象IDに一致する`playerCollect`由来の`item_collected`、RCON所持確認をすべて要求し、その後だけ`move_to`でspawnへ一度帰還します。回収後のRCON drop有無はfixture近傍の照会、所持bool、現在のプレイヤーとdrop間の距離bucketで別に記録し、drop不在だけを拾得成功と扱いません。Bodyの事後観測可否、同じ可視entityの可視bool、Body所持bool、可視中だけ算出するプレイヤーとdropの距離bucketも保存します。観測できない値は`unknown`または観測可否boolで表し、隠れたentity位置から距離を推定しません。pathfinderの失敗は`no_path`、`path_timeout`、`goto_rejected`、`unknown`の固定enumで記録します。artifactは可視性status/count、entity kindの固定分類、Body status/outcome/effect種別と対象一致bool、RCON/Bodyのdrop・所持・距離bucket、pickup確認bool、帰還の試行/skip理由、Body経路status、spawn到着・帰還後所持を保存します。entity ID、座標、自由記述detail、raw logは保存しません。追従・各操作はabortとdeadlineで有界です。probeの`pass`は診断手順の完了を示すだけで、Issueの拾得・帰還受け入れを自動合格にしません。

既定上限は45分、160回のGPT呼び出し、合計800,000 tokensです。case上限は合計204 calls / 1,525,000 tokensで、各caseに独立したdeadlineがあります。`food_intent_continuity`は26 calls / 180,000 tokens、case deadlineは8分です。`autonomous_life` は18 calls / 100,000 tokens、case deadlineは5分です。run18では11 calls・input 63,832・output 2,607・計66,439 tokensで旧60,000-token上限を超え、最後に記録された`commit_action_decision`はokでした。その後のsnapshotはusage gateでpredicate評価前に止まり、最後のsafe player診断と自律milestone進捗は異なる観測時点を示しています。artifact上のfollow-up判断未確認は「判断がなかった」証拠ではなく、判断時刻と成功outcome時刻の詳細はsafe artifactにありません。100,000 tokens / 18 callsは、run18の計測点から次の有限な判断・観測一巡を測る余裕（最大33,561追加tokens・7 calls）として設定します。これは測定上限でありIssueの達成条件ではありません。`unknown_composite` は48 calls / 390,000 tokens、case deadlineは7分です。run17では125,200 tokens消費時点で最低2つのterminal actionが不足していました。直近のround規模（1 actionあたり2–3 round、最大約8,500 input tokens）から、残る2 actionに約34,000–51,000 tokensが必要と見積もり、当初200,000を一回の測定上限として設定しました。後続runで採集物の所持が旧上限付近に初めて観測され、帰還と回復を測るため330,000へ変更しました。HEAD a724e6e の対象試験では標的の破壊と所持を確認し、採掘後のドロップ品へ接近するmove_toの失敗直後に39 calls・330,348 tokensで停止しました。回復判断と帰還を一度測るためcaseのtoken上限だけ60,000増やし、call上限は48のまま保ちます。達成保証や同条件の反復延長には使いません。case上限のtoken合計はrun上限を725,000超え、calls合計も44回超えるため、run全体の上限を維持したままでは後続caseがglobal budgetで未完了停止する場合があります。成功条件とrun全体160/800,000/45分の上限は変更しません。`AI_PLAYER_E2E_MAX_DURATION_MINUTES`、`AI_PLAYER_E2E_MAX_LLM_CALLS`、`AI_PLAYER_E2E_MAX_TOTAL_TOKENS`で既定値以下へ下げられます。上限の超過やdeadlineはrun/caseを未完了にし、そこで停止します。偶然passするまで同じ高コストcaseを反復しません。GPT usageが取得できなかったAPI失敗や中断を0消費とはみなさず、既知合計と`partial_or_unknown`を分けます。

実行順は`runtime_contract`、`autonomous_life`、`observation_boundary`、`persistent_memory_restart`、`learning_reuse`、`skill_compactness_and_knowledge_separation`、`skill_exchange`、`game_action_discretion`、`food_intent_continuity`、`unknown_composite`、`parallel_dialogue_stop`、`integrated_result`です。unknownのcase budget/deadlineでrunが停止する前に独立した6 caseを測り、unknown handoff後の停止検証をparallelのまま最後に保ちます。同一runtime・DB・goal/skill履歴を引き継ぐため、unknown開始前に蓄積する判断履歴は従来順と異なります。各caseのpredicate・fixtureはこの順序変更では変えません。学習caseの予算変更は前述の実測に基づきます。unknownまでの各caseがそれぞれ上限まで消費した場合、parallelの前にrun全体のtoken上限へ達します。unknownがbudget/deadline停止すれば`parallel_dialogue_stop`と、それら全結果を要求する`integrated_result`は未実行のままです。

artifactのrun/case duration、runtime報告call/token/latency、case status、fixture seedを使って結果を再現・比較します。API受付やGPT応答だけではpassにならず、成功caseはDB・Body観測・独立したRCON world oracleなど、ケースごとの結果条件を満たす必要があります。全caseがpassしcleanupも確認できた時だけrun全体をpassとします。後続runのsafe activityではrequest_errorの固定原因分類を保存し、思考中断と通信・provider失敗を区別します。過去runにこの分類を遡って補いません。

## 現在の検証状況

以下のrun履歴には、#74へ切り分けた旧水路・水中drop fixtureでの実行も含まれます。履歴は監査用に残し、#72の現在の乾地fixtureを通過した証拠には数えません。乾地fixtureへ変更後は、実GPT＋Paperによるtargeted `unknown_composite` caseのpassを確認しています（artifact `3422ee20…`）。

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

HEAD `82211ab` の同じ対象caseではBody smokeと自発生活がpassし、未知状況は31 calls・既知203,180 tokensで従来の20万token上限に達しました。run全体は40 calls・既知249,438 tokens、usageは`partial_or_unknown`、cleanup 3/3です。サーバー上の標的までの最短距離は2未満、Bot所持品に青い羊毛が観測され、保存済み判断の末尾には帰路の移動がありました。ただし標的の元位置を`air`と判定する旧oracleはfalseで、採掘後に水が流れ込んだ可能性を区別できません。帰還結果と失敗後の回復は未確認です。次の測定では標的が`blue_wool`でなくなったことを読戻し、短い移動中に資格を失った障害注入は別の開始済み移動に限り最大3回まで再候補とします。同一操作ID・立ち位置・周囲entityの安全確認は各候補で維持します。最後の帰路判断が従来上限付近にあったため、未知状況case予算を48 calls・33万tokensに設定します。この変更を反映した最初の実ゲーム結果は次段落に記します。

HEAD `fccca5c` の対象caseではBody smokeと自発生活がpassしました。制御障害は2件目の開始済み移動を対象に安全確認を通過し、57ブロックの設置を読戻しました。一方、復元を確認できず、`UNKNOWN_OBSTACLE_RESTORE_FAILED`でcaseを未完了として停止しました。未知状況は24 calls・既知154,178 tokens、run全体は31 calls・既知191,543 tokens、usageは`partial_or_unknown`、隔離server・listener・一時worldのcleanupは3/3です。復元失敗の内部段階はこのrunでは記録されず、原因は未特定です。試験fixtureの復元時にtickを停止してからclone・比較し、終了時に再開する処理と、失敗段階の固定分類を追加しました。GPT不要の隔離Paper probeでは、経路移動と水路を含む領域での障害物設置・復元がpassし、API呼び出し0回、cleanup 3/3でした。このprobeは復元経路の局所検証であり、未知複合状況での標的の採集・持帰り、失敗後の回復は未確認です。

HEAD `26893c5` の対象caseではBody smokeと自発生活がpassし、未知状況は43 calls・既知333,088 tokensでcase上限、run全体は50 calls・既知370,647 tokens、usageは`partial_or_unknown`、cleanup 3/3でした。成功した`move_to`と`look`は複数ありましたが、サーバー観測では標的への距離短縮、採集、持帰りを確認できません。制御障害は2件の開始済み移動が二度目の適格性確認で終わったため設置せず、失敗後の回復も未確認です。終了時のBody観測には石と水があり、青い羊毛は見えていませんでした。別のGPT不要な隔離Paper probeでは、同じ壁・水路を迂回して標的近傍へ移動した後、標的へ視線を向けると青い羊毛をBodyで観測できました。API呼び出し0回、cleanup 3/3です。これにより近傍での可視経路は確認しましたが、実GPTがそこへ達する判断はまだ実証できません。保存済みのtool活動では、新しいowner目的が届いた後に関連Skillを検索した証跡がありません。新しい目的へ初めて着手する時のSkill検索・本文参照を判断入力で明示しました。この変更後の実GPT効果は未確認です。

`AI_PLAYER_E2E_NAVIGATION_PROBE_ONLY=YES`では、サーバー確認済みの相対移動後にBodyの`look_sweep`を1回行い、走査結果の固定集約値をartifactへ記録します。既存の`targetLook`と可視性待機は最後まで実行し、scanで標的が未観測ならその後に固定codeで未完了にします。このprobeはGPT呼び出し0回です。

直近の隔離Paper probeではサーバー上で標的近傍への到達を確認しましたが、走査では標的を観測できず、`BODY_NAVIGATION_PROBE_LOOK_SWEEP_TARGET_NOT_OBSERVED`で未完了となりました。`targetLook`と可視性待機も実行しましたが、その状態はartifactに残っておらず、cleanupは3/3です。原因は縦視野か候補打切りか未確定のため、次回は走査status・完了・標的名の観測有無・打切り有無・異なるyaw数と、既存lookのstatus・可視性を座標や角度原値なしで記録します。この集約値を加えた後のprobe結果は末尾に記録します。

HEAD `8ace054` では、全体24-call上限を意図的に指定した短い隔離Paper＋実GPT試験を行いました。Body smokeと自発生活はpass、owner目的を受けた後に`search_skills`が呼ばれましたが、検索結果は空配列で、`read_skill`は呼ばれませんでした。runは25 calls・既知141,128 tokensで指定した全体上限に達し、usageは`partial_or_unknown`、cleanup 3/3です。短い試験の未達を採集・帰還の失敗判定には使いません。Skill検索は入力文全体の部分一致に依存していました。今回の検索引数の原文は公開用証跡に残していないため、この照合方式が空結果の原因だった可能性として扱います。語句一致がない場合だけ基礎7カテゴリの短い候補を返し、GPTが本文を選んで読むための入口を残しました。代表的な長い依頼文での単体試験はpassし、実GPTでの本文参照と行動効果は未確認です。

HEAD `ab0cb85` の対象caseではBody smokeと自発生活がpassしました。新しいowner目的の後にSkill検索と本文参照があり、サーバー上で標的から2ブロック未満まで接近し、自然な`move_to`失敗後の再観測・別操作の成功を確認しました。未知caseは46 calls・既知331,325 tokensで上限、run全体は57 calls・既知399,192 tokens、usageは`partial_or_unknown`、cleanup 3/3です。標的の破壊・所持・帰還、制御障害後の回復は未確認です。終盤のBody観測には青い羊毛がなく、目標に近づいた後の探索判断が残件です。探索Skillの基礎本文を、障害を越えた後に既知の方角へ視線を向けて目的物を探す短い原則へ改訂しました。次の測定では、サーバーが標的から2ブロック未満を確認した時点と、直近2秒以内のBody観測で標的が見えたかを別々の固定値で残します。古い観測を近傍の可視証拠に数えません。この改訂後の実GPT効果は未確認です。

HEAD `a8dcd23` の対象caseではBody smokeと自発生活がpassし、未知caseは42 calls・既知342,739 tokensで上限、run全体は51 calls・既知391,754 tokens、usageは`partial_or_unknown`、cleanup 3/3です。自然な失敗と後続成功、制御障害の設置・復元は確認しましたが、障害による失敗はなく、標的への距離短縮・採集・持帰りは未確認です。近傍に到達しなかったため新しい近傍Body可視性は未採取です。保存された判断と結果には`look`と`move_to`の反復があり、目標への進捗がないまま近隣の別資源に注意が向いていました。従来の判断入力は直近4件の結果と古い移動結果だけを示し、古い`look`の反復は省かれていました。active owner目的以降の直近12件の操作種別と結果を短くまとめて渡し、GPTが行動の反復と目的の進捗を見直せるようにしました。この入力追加後の実GPT効果は未確認です。

HEAD `155bc01` の対象試験ではBody smokeと自発生活がpassしました。未知caseは44 calls・既知345,639 tokensで上限停止、run全体は52 calls・既知395,456 tokens、cleanup 3/3です。サーバーでは標的から2ブロック未満への接近、自然な失敗後の別操作への回復を確認しました。一方、近傍の新鮮なBody観測に標的はなく、採集・所持・帰還は未確認です。直近操作履歴を入力へ加えた効果は単一runから断定しません。

視線走査の0 GPT隔離Paper probeでは、水平視線の8方向走査は成功・完了し異なるyawも8件でしたが、近傍の標的を観測できませんでした。候補打切りもあり、直接lookでは標的が可視でした。そこで走査の既定pitchを-25度とし、上方などは引数で指定できるようにしました。変更後の同probeはpassし、走査結果に標的が含まれること、直接lookでの可視性、cleanup 3/3、GPT呼び出し0を確認しました。走査の出力は観測した視界の限定的な候補であり、対象がないという全域証明にはしません。この0 GPT probeだけではGPTの選択と課題の完遂は検証できません。

HEAD `a724e6e` の対象試験ではBody smokeと自発生活がpassし、未知caseは39 calls・既知330,348 tokensで上限停止、run全体は48 calls・既知380,735 tokens、cleanup 3/3です。GPTは探索Skillを参照し、走査を選択しましたが、その走査結果自体には標的がありませんでした。後続の視線変更と採掘を経て、サーバー上で標的の除去と青い羊毛の所持を確認しました。採掘後、ドロップ品へ接近して取得を確かめる`move_to`が失敗した直後に上限へ達しました。この実行では帰還操作は確認されておらず、帰還と失敗後の回復は未確認です。走査が採集に寄与したという因果関係や、採集の再現性はこの一回から断定しません。

この実測に基づき未知caseのtoken上限だけを390,000へ変更した一回の対象試験では、Body smokeと自発生活はpassし、未知caseは45 calls・既知396,685 tokensで上限停止、run全体は52 calls・既知437,416 tokens、cleanup 3/3でした。自然な移動失敗後の再観測・別操作の成功は確認しましたが、標的への最短距離は5〜10ブロックで、採集・所持・帰還はありません。4回の走査はすべて完了したものの標的を含まず、最後のBody観測には標的が見えました。走査と相対移動が交互に続いた行動経路のため、前回の採集成功を再現できませんでした。同条件の高コストな再試行や上限再延長は行いません。

0 GPTの隔離Paper帰路診断では、同じ壁・水路fixtureで標的の可視確認と採掘、地上dropの存在を確認しました。採掘直後の位置ずれがあったため乾地の待機位置へ戻した後、drop付近への`move_to`とspawnへの`move_to`はともに経路探索成功・サーバー到着を確認しました。拾得は確認できず、帰還時にも所持していません。診断手順はpass、API呼び出し0、cleanup 3/3です。この一回は経路が存在することを示しますが、実GPT試験での移動失敗原因、拾得・持帰り、再現性は未確認です。

HEAD `f7c5e97` の全case試験では、Body smoke、runtime、自発生活、観測境界、再起動後の記憶がpassしました。学習caseは最初の採掘まで進み、8個の原木をサーバーと新しいBody観測で確認しましたが、仮説Skillの提案1件が固定コード`OPERATION_REFERENCE_MISMATCH`で拒否され、学習更新0件のまま未完了でした。後続のSkill簡潔性とMarkdown往復は学習成果がなく未完了です。建築caseは10 calls・既知103,691 tokensでcase上限に達し、保存された判断には配置を確認できず、fixture穴はairのままでした。未知状況、並行会話、統合結果は未実施です。run全体は40 calls・既知278,744 tokens、usageは`partial_or_unknown`、cleanup 3/3でした。この結果だけから学習修正後の実GPT効果や、建築で穴が配置候補として見えていたかは判断しません。

HEAD `215d3d6` の全case試験は`learning_reuse`の初回digとserver world changeを確認した後、`first_dig_confirmed`段階で未完了でした。公開artifactの固定理由は`ONE_SUCCESS_DID_NOT_CREATE_VERIFIED_HYPOTHESIS`でした。同じrunのprivate sidecarでは、そのsuccessful digに既存のtrusted-derived Skill version 3が使われたことを確認しています。従来の「新しいSkill IDが作られたこと」だけを求めるpredicateが、この有効な経路を落としていました。修正基準では、開始時DB snapshot上のsuccessful derivationとSkill ID、初回outcomeの同じSkill IDと使用version、現行revision historyにある使用versionを照合します。このrunは修正後の再利用条件を通過した証拠ではありません。

HEAD `215d3d6` の同じ全case試験ではBody smoke、runtime、自発生活、観測境界、再起動後の記憶がpassし、学習更新は3件でした。建築caseは事前の新しいBody観測にfixture穴が配置候補として入り、`place`の成功結果とRCONでの`oak_planks`充填を確認しました。ただしcase累計101,673 tokensで100,000-token上限を超え、前後world snapshotを使う最終predicateより先に停止したため、caseは未完了です。run全体は40 calls・既知306,565 tokens、usageは`partial_or_unknown`、cleanupは3/3です。未知状況、並行会話、統合結果は未実施です。

HEAD `795fa0a` の全case試験では、`learning_reuse`のfixture可視性と初回server-confirmed dig後に、`FIRST_DIG_DID_NOT_CREATE_OR_USE_VERIFIED_HYPOTHESIS`で未完了停止しました。caseは16 calls・124,269 tokens、snapshotのlearningUpdatesは1件でした。private sidecarには同じSkill IDを使ったsuccessful digがversion 1、続いてversion 2で記録されていました。sidecarは開始時DB revision snapshotを含まないため、このrunだけでは判定失敗の条件を特定できません。実装上、preexisting候補には開始時trusted-derived Skill IDの一致に加えて使用versionも開始時revision historyにあることを要求しており、開始後に追加されたimmutable revision versionを拒否し得ます。新しい判定は開始時点のtrusted-derived Skill IDと初回outcomeのSkill IDを照合し、使用versionは現行immutable revision historyで確認します。このrunは再利用caseの後続条件を通過した証拠ではありません。同じrunの建築caseは12 calls・既知112,237 tokensでcase上限停止し、事前観測にはfixture穴が配置候補として含まれましたが、保存済み判断に`place`はなく穴はairでした。run全体は42 calls・既知314,589 tokens、usageは`partial_or_unknown`、cleanupは3/3です。未知状況、並行会話、統合結果は未実施です。

HEAD `4a9f4c4` の`learning_reuse`対象試験は初回dig確認後、`FIRST_DIG_DID_NOT_CREATE_OR_USE_VERIFIED_HYPOTHESIS`で未完了でした。caseは10 calls・63,889 tokens、artifactのlearningUpdatesは1件、cleanupは3/3です。同runのprivate sidecar要約ではsuccessful digがSkill version 1を使った記録が2件あり、run中に`propose_skill_learning`の成功も1件ありました。保存artifactには開始時・現行snapshotのSkill membershipや、初回digと同一run IDのderived rowの照合結果がなく、この証拠だけでは、case開始後に作られたtrusted-derived Skillを初回digが使った経路か、receipt/revision照合の別条件不足かを区別できません。判定条件はそのままにし、次の失敗artifactに限って、outcome kind/status、Skill at use有無、baseline/currentのID membershipとtrusted-derived membership、現行revision一致、初回dig receipt由来rowの有無・一致、Skillとtrusted-derivedの件数を固定enum・boolean・countで記録します。診断にはID、version値、座標、本文を含めず、DB trust・server world check・後続再利用/版/receipt条件を変更しません。次の隔離runでこの診断を得るまでは、acceptance predicateを広げません。

HEAD `46f3b8e` の対象runは`autonomous_life`が6 calls・32,720 tokensでpassした後、`learning_reuse`が0 callsで`LEARNING_LOG_FIXTURE_FACING_NOT_CONFIRMED`となり、GPT依頼前に停止しました。RCON位置とRotationのreadbackは得られたものの、安全artifactはyaw/pitchのどちらが許容差を外れたかを記録していません。失敗時のlast-known judgement/operationは`move_to`で、同じrunのautonomous milestone時点にもactive operationが残っていました。移動中のyaw変化は原因候補ですが未確定です。fixture orientation mismatchを停止条件から外し、`learningFixtureYawMatched`、`learningFixturePitchMatched`、向き設定直前の`learningFixtureActiveOperationAtOrient`を固定booleanで記録します。RCON位置readbackとRotation取得は引き続き必須です。各配置後のRCON設置確認と15秒以内の新しいBody観測に`oak_log`が現れる確認はGPT依頼前の必須条件として維持します。この変更後の実Minecraft挙動は未検証です。

後続の0 GPT帰路診断では、初回は採掘前提が未成立でした。採掘直前の乾地・支持ブロック・位置一致を確認する診断を追加した次の実行では採掘とdrop付近・spawnへの移動が成功しましたが、所持は確認できず、移動後の半径2ブロック検索でdrop位置は不明でした。検索半径を最大16ブロックへ限定して広げた実行では、移動直後に標的から半径8ブロック以内のdropを確認し、Botとの距離は2ブロック以上でした。拾得待ち後のdrop位置は不明で、所持はありません。いずれもAPI呼び出し0、終了処理3/3です。dropが移動した経路と実GPT試験での取得・帰還は未確認です。診断手順のpassをIssue受け入れには数えません。

HEAD `ddc0c77` の`learning_reuse`対象試験では、初回digとserverのブロック変化を確認しましたが、そのreceiptに結び付く改訂はなく未完了でした。原因はbody outcomeイベントを受けても最後の操作結果だけを学習評価しており、後続の移動結果で採掘結果が隠れ得ることでした。結果イベントを操作ごとの履歴・trusted receiptに結び付ける変更後、HEAD `9f2f296` の対象試験では初回digの同一receipt・Skill・使用版に対応する実質改訂を確認しました。再利用digもserverで確認できましたが、その後の学習提案は操作参照の不一致で拒否され、caseは未完了でした。いずれも終了処理3/3です。

HEAD `2c0e2a5` の`learning_reuse`対象試験では、Body smokeと`autonomous_life`がpassし、学習caseもpassしました。初回の成功digとserverのブロック変化から、同じtrusted receipt・Skill・使用版に結び付く実質改訂を確認しました。次の原木では同じSkillへの新規consultation、成功digとserver変化、さらにそのdigのreceipt・使用版に結び付く新しい実質改訂を確認しました。対象runは23 LLM calls・既知127,544 tokens、usageは`partial_or_unknown`、終了処理3/3です。未選択caseは`CASE_NOT_SELECTED`で、run全体の`incomplete`をIssue全体のpassへ読み替えません。

実drop位置を使う0 GPT隔離Paper probeでは、採掘とdrop位置の解析後、`range: 0.25`の`move_to`がBody・経路ともsuccessfulで、サーバーは保存した移動目標のセルへの到着を確認しました。一方、到着時に再観測したdropはBotから`2+`の距離bucketにあり、所持は増えませんでした。拾得未確認のためspawn帰還は実行せず、診断手順はpass、GPT呼び出し0、cleanup 3/3です。この結果は静的な目標位置へ到着できる証拠であり、動いたdropへの追従・拾得、実GPTによる選択と帰還は未確認です。

## 直近の安全なE2E証跡（2026-09-27）

Targeted `unknown_composite` artifact `3422ee20…` はcase passです。caseは23 LLM calls、run全体は30 calls・既知228,808 tokens、usageは`partial_or_unknown`、cleanupは3/3でした。これは開始時から対象が視界に入る現在の乾地fixtureの結果です。

全case run artifact `d357682f…` は`body_operation_smoke`、`runtime_contract`、`autonomous_life`、`observation_boundary`、`persistent_memory_restart`がpassし、`learning_reuse`は31 callsの予算で未完了停止しました。run全体は既知378,075 tokens、usageは`partial_or_unknown`、cleanupは3/3です。

Issue #72全体の受け入れは未達です。必要なケースの残件と共通runtime・DBを引き継ぐ統合証拠を閉じる必要があります。単一の長時間全case連続runは #76、遮蔽された目標探索は #77 の範囲です。既知usageは部分計測として扱い、不明分を補完しません。
