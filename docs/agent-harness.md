# エージェントハーネスのリポジトリ仕様

この文書は、正本の配置、evidenceとtask-stateのデータ契約、instruction budgetを定義します。共通の作業運用は実行環境の指示に従います。説明文であり、validatorや製品runtimeの代替ではありません。

## 正本、読者、責務

| 正本 | 読者 | 責務 |
|---|---|---|
| AGENTS.md、最寄りのAGENTS.md | 3製品 | Minecraft製品固有の契約と正本へのrouting |
| .agents/skills/<name>/SKILL.md | 3製品 | task固有のMinecraft観測境界、Issue品質、公開安全性 |
| docs/ai-governance/ | agent、reviewer、保守者 | 製品固有のevidence基準と文書配置 |
| この文書 | agent、保守者 | task-state、input closure、validator、instruction budget |
| scripts/validate_governance.py | CI、保守者 | 形式、存在、参照、identity、budgetのstatic検査 |

CLAUDE.md、.claude/、.cursor/は正本へ接続するrouterです。本文を複製せず、routerの不調を製品境界の緩和に使いません。

## Evidenceとinput closure

evidenceはHEAD / base、対象path、関連config、生成artifact、実行条件と結果に対応付けます。GitHubのCI・review・threadなど外部の状態は、repository上の検証結果と区別します。測定結果に後から公開用annotationを加える場合、annotationは測定scopeと区別します。

input closureは、evidenceの妥当性に関係するpath、config、artifact、conditionsの集合です。task-stateに保存されたclosureと現在の条件が一致する場合に限り、対応するcompleted evidenceを参照できます。

## task-state/v1

cross-sessionのfield sourceは[task-state/v1 template](ai-governance/templates/task-state.json)です。status、snapshot、lane、completed evidence、input closure、measurement、publication、invalidated gates、remaining work、risks、blockersのshapeはこのtemplateとvalidatorが定義します。complete状態には未完了作業、invalidated gate、blockerがなく、evidenceがpassであることを要します。static validatorはこのdata contractを確認します。

## Minecraft runtimeの観測限界

Minecraft runtimeを使う検証では、owner、PID、process group、port、readiness、cleanupを実行条件として記録します。runtimeを使わない検証はその範囲を明記します。static validatorのPASSはtool発見、Hook注入、runtime routing、権限、実環境の成功を保証しません。

## instruction budgetとstatic validator

root AGENTS.mdは180行・16KiB、nested AGENTS.mdは100行・8KiB、adapterは30行・4KiB、canonical Skillは180行・16KiB、rootと有効なnested ruleの合計は24KiBを上限とします。source-sizeはestimateで、実際のtoken telemetryではありません。

形式、参照、frontmatter、Skill identity、task-state、budgetは[validate_governance.py](../scripts/validate_governance.py)で検査します。static検査は製品runtimeや外部サービスの状態を判定しません。
