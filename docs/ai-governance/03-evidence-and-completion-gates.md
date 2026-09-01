# 証跡と完了ゲート

この文書は、repository governance、Minecraft runtime、GitHub共同作業面の変更を完了扱いするためのevidenceと判定条件を定義します。static validatorはruntime成功や外部サービス状態を代替しません。

## 1. 共通evidence

受け入れ条件ごとに、差分、test、静的検査、CI、review、実環境観測などの根拠を対応付けます。HEAD / base、変更path、関連設定、生成物、実行条件をinput closureとして記録し、stable evidenceとvolatile delivery stateを分けます。

配送checkpointはimplementation → focused_verification → code_freeze → measurement → publication_freeze → external_gate → review_fix → acceptedです。高コストgateはclosureと公開境界をfreezeした後に選びます。

gate ledgerにはgate、snapshot phase・HEAD・base、input closure（path / config / artifact / conditions）、result、artifact referenceを置きます。closureと交差したpath・設定・生成物・条件だけがgateを失効させ、invalidation reasonとreacquire scopeを残します。同じclosure・条件の成功evidenceは再利用します。

task budget（context、owned paths、runtime、deadline、output cap）とreview budget（対象HEAD、cycle、severity、再取得条件）は、laneとgateの開始前に固定します。予算はhard safetyやacceptance contradictionを延期する理由にせず、P2-only findingや公開文言の調整は限定されたreview scopeで扱います。

## 2. Governance面

rule、Skill、adapter、docs、Issue / PR template、validatorの変更では、次を確認します。

- frontmatter、Skill identity、routerのscope、rendered Markdown link
- instruction budget、UTF-8、broken link、task-state/v1 shape
- rootとadapterの責務分離、旧正本・孤立adapterの不在
- public safety、差分の無関係path混入の不在
- focused Python governance testsとstatic validatorの結果

この面ではアプリ画面のscreenshot、dev server、Minecraft接続を受け入れ条件へ追加しません。

## 3. Minecraft / production面

実環境調査では、対象環境、時間範囲、観測方法、read-only/write、ownerを記録します。観測事実は安全に要約し、server address、player、memory内容、log原文、追跡IDを公開しません。runtimeを使う場合はPID、process group、port、readiness、cleanupのevidenceを残します。

code上の仮説だけでproduction状態を断定しません。bot actionはゲーム内の結果で確認し、確認できない場合はunverifiedまたはblockedとして残します。

## 4. PR monitor

各runの軽量keyはstate、headRefOid、updatedAt、reviewDecision、mergeStateStatusの完全一致で比較します。MERGED / CLOSEDはterminal-firstで、そのrunの詳細照会を抑制しscheduled taskを削除します。OPENでkeyが無変化なら詳細照会をせずevent/backoffで待機し、logical checkpointまたはdeadlineで継続要否を再評価します。timeoutはfailure扱いにしません。

## 5. 完了条件

- acceptance、対象path、非対象、公開境界が一致している。
- P0、security、secret、data integrity、受入証跡の矛盾が残っていない。
- 対応pathに必要なfocused verificationがlatest local差分で成功している。
- static validator、frontmatter、link、budget、task-stateの結果を示している。
- 実行したこと、未実行理由、残るriskを分離している。
- PRをmerge可能と報告する場合、latest HEADのCI、review、未解決thread、mergeabilityを同一snapshotで確認している。

merge、Issue / PR close、release、deploy、force-pushは対象と権限の別明示なしに実行しません。
