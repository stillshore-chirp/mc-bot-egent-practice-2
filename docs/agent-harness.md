# エージェントハーネス設計・保守ガイド

この文書は、Codex、Claude Code、Cursorで共有する、正本の読者・配置、委任、evidence、task-stateの最小契約です。説明文であり、機械検証や製品runtimeの代替ではありません。

## 正本、読者、責務

| 正本 | 読者 | 責務 |
|---|---|---|
| AGENTS.md、最寄りのAGENTS.md | 3製品 | hard gate、権限境界、最小実行 |
| .agents/skills/<name>/SKILL.md | 3製品 | task固有の発動条件、手順、handoff |
| docs/ai-governance/ | agent、reviewer | Issue、evidence、完了の判定基準 |
| この文書 | agent、reviewer、保守者 | 委任、snapshot、closure、task-state、runtime境界 |
| scripts/validate_governance.py | CI、保守者 | 形式、存在、参照、identity、budgetのstatic検査 |

CLAUDE.md、.claude/rules/、.claude/skills/、.cursor/rules/は正本へ到達するrouterです。adapterへ本文を複製せず、routerの不調をhard gateの緩和に使いません。

## 読み分けと変更影響

全体の安全境界はroot、実在するpath固有契約は最寄りのAGENTS.md、task手順はSkillへ置きます。設計heuristicは[agent-principles](agent-principles.md)、保守判断は[maintenance policy](ai-governance/13-maintenance-policy.md)を読みます。logic、共有処理、API、型、data契約を変える時は、参照追跡と関連testで影響範囲を確認します。

## 配送checkpoint

配送は次の順で進め、各段階でHEAD、base、owner、入力閉包、終了条件を固定します。

1. implementation: scope、acceptance、非対象、owner、変更pathを確定。
2. focused_verification: pathに対応する最小十分なtest・構造確認を実行。
3. code_freeze: source、test、設定、生成物とgateのinput closureを固定。
4. measurement: 固定snapshotとscopeで実行数、wall-clock、照会数、output bytesを記録。
5. publication_freeze: Issue、PR、report、artifactの公開内容と安全性を固定。
6. external_gate: 必要なCI、review、thread、mergeabilityを確認。
7. review_fix: actionableな修正後、closureと交差するgateだけを再取得。
8. accepted: latest HEAD / base、acceptance、CI、review、thread、mergeabilityを同一snapshotで照合。

高コストgateはcode_freeze、測定scope、公開境界、再取得条件の確定後に選びます。

## snapshot、evidence、input closure

stable evidenceはHEAD / base、変更path、関連config、生成artifact、実行条件、結果、artifact referenceに束縛します。CI、review、thread、mergeability、待機中statusはvolatile delivery stateとして分離します。

gate ledgerは gate、snapshot phase・HEAD・base、input paths、関連config、artifact、conditions、result、artifact referenceを持ち、失効時はinvalidation reasonとreacquire scopeを追記します。base、owned path、設定、生成物、条件がclosureと交差したgateだけを失効させ、同じclosureと条件の成功evidenceは再利用します。timeoutは失敗でもevidence失効でもなく、laneをrunningのままeventまたはbackoffで再待機します。

測定artifactへ後からreport annotationを加える場合は、annotationを測定scope外へ分離するかpublication gateへ移します。推定token量をobserved telemetryと表現しません。

## bounded laneとevidence package

委任時にrisk lane、owner、target HEAD / base、target paths、acceptance、depends_on、snapshot phase、write ownership、runtime resource、port、cleanup、output cap、completion、verification、reuse evidence、invalidation conditionを固定します。最小contextは目的、受け入れ条件、非対象、HEAD / base、対象path、依存、停止条件だけにします。

completed laneは、status、scope / revision、conclusion、changed paths、verification、unperformed checks、remaining risks、stop reason、snapshot / diff、artifact referenceを含むcompact evidence packageを返します。raw logや長いfile全文は含めません。

task budgetは、primaryとlaneごとの最小context、owned paths、実行時間またはdeadline、runtime資源、output capを開始時に固定します。review budgetは、対象HEAD、review cycle数、確認するseverityとclosure、再取得条件を固定し、同じHEADでclean結果を増やすための再reviewを行いません。P0/P1またはsecurity・acceptance contradictionは予算外でもblockingとして扱います。

checkpointを逃した時だけ同じownerへ一度partial resultを求め、進展がなければscope shrink、縮小後も進展がなければreassignします。partial / unverifiedは未確認範囲と再開条件を保持します。primaryが分離可能な作業を直接行う場合は、specific reason、subagent不能のevidence、scope shrink history、reassignment history、primary-only question、target paths、output capを記録します。

## task-stateとruntime境界

cross-sessionのfield sourceは[task-state/v1 template](ai-governance/templates/task-state.json)だけです。resume時は現在のsnapshotとclosureを照合し、条件一致のcompleted evidenceをartifact referenceで再利用します。completeはacceptanceと必要gateを満たし、remaining work、invalidated gate、blockerがない場合だけです。blockedは権限・外部状態など真の停止理由がある場合だけです。

Minecraft runtimeを使うlaneはowner、PID、process group、port、readiness、cleanupを起動前に固定し、成功・停止・失敗・割込みの全経路でprocess groupとport解放を確認します。runtimeを使わない場合はその旨を記録します。validatorのstatic PASSはtool発見、Hook注入、runtime routing、権限、実環境成功を保証しません。

## instruction budget

root AGENTS.mdは180行・16KiB、nested AGENTS.mdは100行・8KiB、adapterは30行・4KiB、canonical Skillは180行・16KiB、rootと有効なnested ruleの合計は24KiBを上限とします。source-sizeはestimateで、実際のtoken telemetryではありません。形式、参照、frontmatter、Skill identity、task-state、budgetは[validate_governance.py](../scripts/validate_governance.py)で検査します。

## PR monitor契約

各runの冒頭に、state、headRefOid、updatedAt、reviewDecision、mergeStateStatusだけからなる軽量keyを取得します。MERGEDまたはCLOSEDならstateを最優先し、そのrunでscheduled taskを削除して監視を終了し、review・thread・CI・mergeabilityの詳細を取得しません。UNKNOWNや空のsecondary fieldはterminal stateを覆しません。

OPENで外部待ちが必要な時、keyが変わらない間は詳細照会をせず、eventまたはbackoffで待機します。logical checkpointまたはdeadlineで継続要否を再評価し、不要と判断した時だけ停止理由と未確認範囲を通知します。timeout回数を完了条件にしません。

## 保守境界

この契約は静的なrepository governanceです。Codex desktop scheduler、各toolの実際の発見、GitHub権限、Minecraft server、LLM provider、実データ、production logの状態は、対応する実行またはread-only観測なしに成功と断定しません。
