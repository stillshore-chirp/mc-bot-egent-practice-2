# ガバナンス保守方針

この文書は、rule、Skill、adapter、validator、template、testを増減・変更する判断基準です。配置と委任・evidence・task-stateは[agent-harness.md](../agent-harness.md)を正本とします。

## 配置と責務

- root AGENTS.mdは全作業のhard gate、権限、最小実行を持つ。
- .agents/skills/<name>/SKILL.mdはtask手順を持つ。
- .claude/と.cursor/は正本へ接続する薄いrouterであり、本文を複製しない。
- docs/ai-governance/はIssue、evidence、完了の判定基準を持つ。
- scripts/validate_governance.pyは形式、存在、参照、frontmatter、identity、budget、task-stateのstatic検証だけを行う。

## 変更と削除

変更前に対象path、正本owner、読者、enforcement（static / test / runtime / advisory）、coverage、公開範囲、riskを確認します。既存正本・adapter・validator・testを検索し、統合・縮約・replacementを先に検討します。

削除時はconsumer、link、coverage、replacement、sunset理由を確認します。旧validatorや旧fixtureを復活させず、central validatorとfocused testへ統合します。製品runtime、Hook、tool discovery、権限をstatic checkで代用しません。

## 保守ゲート

3製品の到達性、frontmatter、rendered link、Skill identity、instruction budget、task-state、公開安全性、関連testを確認します。継続的なPR monitorはstateをterminal-firstで扱い、OPEN無変化ではevent/backoffへ戻します。
