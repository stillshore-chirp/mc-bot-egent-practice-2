# ガバナンス文書の役割

この文書は、repository内のrule、Skill、adapter、validator、templateの責務を定義します。共通の変更運用は実行環境の指示に従います。

## 配置と責務

- root AGENTS.mdはMinecraft製品契約と正本への入口を持つ。
- .agents/skills/<name>/SKILL.mdはtask固有の製品観測境界、Issue品質、公開安全性を持つ。
- .claude/と.cursor/は正本へ接続する薄いrouterで、内容を複製しない。
- docs/ai-governance/は製品固有のevidence基準と文書配置を説明する。
- scripts/validate_governance.pyは形式、存在、参照、frontmatter、identity、budget、task-stateのstatic検証を行う。

## 維持する性質

同じ契約の本文を複数の正本へ複製しません。製品挙動の契約とruntimeの実装・観測を対応付け、static validatorでtool discovery、Hook、runtime動作、実環境状態を保証したとは扱いません。
