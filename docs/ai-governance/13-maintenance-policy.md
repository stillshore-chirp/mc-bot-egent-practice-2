# エージェントハーネス保守方針

この文書は、エージェントルール、task Skill、tool adapter、機械検証を保守する方針です。全体構成は [`docs/agent-harness.md`](../agent-harness.md) を正本とします。

## 正本

- 共通の常時読込契約: `AGENTS.md`
- task固有手順: `.agents/skills/<name>/SKILL.md`
- 配置とinstruction budget: `docs/agent-harness.md`
- 設計heuristic: `docs/agent-principles.md`
- 証跡と完了条件: `docs/ai-governance/03-evidence-and-completion-gates.md`
- Issue品質: `docs/ai-governance/14-issue-quality-gate.md`
- 公開安全性: `docs/security-publication-checklist.md`
- Claude Code adapter: `.claude/rules/`, `.claude/skills/`
- Cursor adapter: `.cursor/rules/`
- 機械検証: `scripts/verify-agent-harness.sh`

`CLAUDE.md` は `@AGENTS.md` だけにします。adapterは正本を参照するだけで、新しい判断基準を持ちません。

## 変更時の3製品確認

### Codex

- rootから必要な規則とtask Skillへ到達できる。
- task手順が常時読込へ混入していない。
- rootと、将来追加される最寄りのnested ruleがinstruction budgetを満たす。

### Claude Code

- `CLAUDE.md` が共通核を一重にimportしている。
- path ruleが必要時だけ詳細正本を案内する。
- Skill adapterが同名の共有Skillだけへ接続する。
- adapterへ本文をcopyしていない。

### Cursor

- root `AGENTS.md` とMDC ruleが競合しない。
- ruleは `alwaysApply: false` と対象 `globs` を持つ。
- task手順は `.agents/skills/` を正本として利用する。
- ruleへ共通核やSkill本文をcopyしていない。

## 追加と削除の判断

1. 全作業に必要ならroot `AGENTS.md`。
2. 実在する特定pathだけなら最寄りのnested `AGENTS.md` と薄いadapter。
3. 特定taskだけなら共有Skillと必要なadapter。
4. 機械判定できるならscript、test、lint、CI。
5. 既存正本へ統合できるならfileを増やさない。

領域や実装がまだ存在しない場合、将来のためだけのnested rule、空Skill、placeholder文書を追加しません。廃止されたpathまたはtaskのruleは、参照元と検証を同じ変更で削除します。

## 重複と競合の防止

- 同じhard gate、checklist、workflow本文を複数箇所で正本化しません。
- rootは共通核、Skillは実行順序、docsは判定基準、adapterは接続、scriptは形式検査を担当します。
- 表現を少し変えた意味上の重複もhuman reviewで確認します。
- 競合する旧指示、循環参照、壊れたlink、孤立したadapterを残しません。
- 機械検査の例外を追加する場合は、必要性と検査不能範囲をIssueとPRへ記録します。

## Hard gateとheuristic

secret、証跡捏造、data破壊、公開契約、権限境界、latest headのCI・review・thread・mergeabilityはhard gateです。DRY、KISS、SRP、OCP、行数、重複回数、test配分はheuristicです。

数値化できるinstruction budgetと形式は機械検査します。設計の質を行数や単語の存在だけで判定しません。

## 配送契約の保守

配送の実行順序は [GitHub配送Skill](../../.agents/skills/github-delivery/SKILL.md)、Pass / Failの条件は [証跡と完了ゲート](03-evidence-and-completion-gates.md) を正本とします。契約を変える場合は、この2つと `AGENTS.md`、PR template、検証scriptを同じ変更で確認し、この文書へ手順や完了checklistを複製しません。

## 検証

変更後は `bash scripts/verify-agent-harness.sh` を実行します。加えて、変更したshellの `bash -n` とshellcheck、Pythonのcompile、YAML、Markdown link、公開安全性、差分を確認します。

静的検証は各toolの実際のrule・Skill発見、外部URL、GitHub上のCI・review・mergeabilityを保証しません。これらは利用toolまたは配送時の観測で補います。
