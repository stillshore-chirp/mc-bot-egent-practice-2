# ドキュメント構成と責務分担

READMEはプロジェクト入口、詳細な契約は対応する正本へ分けます。

## 現在の正本

| 文書 | 責務 |
|---|---|
| README.md | 目的、目標、非目標、現在の状態、入口 |
| AGENTS.md | 3製品が常時共有するhard gate、routing、最小実行 |
| docs/agent-harness.md | 配置、checkpoint、委任、evidence、task-state、PR monitor |
| docs/agent-principles.md | Minecraft AIコンパニオンの設計heuristic |
| docs/documentation-structure.md | 文書責務と配置判断 |
| docs/ai-governance/00-index.md | governance文書の読み方と入口 |
| docs/ai-governance/01-agent-operating-contract.md | 作業前、観測境界、報告 |
| docs/ai-governance/03-evidence-and-completion-gates.md | evidenceと完了条件 |
| docs/ai-governance/13-maintenance-policy.md | 正本・adapter・validatorの保守 |
| docs/ai-governance/14-issue-quality-gate.md | Issue品質 |
| docs/ai-governance/templates/ | task prompt、completion report、task-state |
| docs/security-publication-checklist.md | 公開安全性 |
| .agents/skills/ | task手順の正本 |
| .claude/、.cursor/ | tool発見用adapter |
| .github/ | Issue / PRの入力構造 |
| scripts/validate_governance.py | central static validator |

## 配置判断

1. 全作業に必要な短いhard gateはAGENTS.md。
2. taskの手順は共有Skill。
3. 判断基準、根拠、保守はdocs。
4. 機械判定できる条件はvalidatorとfocused test。
5. tool固有fileは適用範囲と正本への参照だけ。
6. 既存正本へ統合できる場合は新規fileを増やさない。

## 更新時の確認

作業契約、配送、公開安全性、Issue品質、task-stateの意味が変わる場合は関係する正本、adapter、validator、test、templateを同じ変更で確認します。製品runtimeやMinecraft運用の詳細は、実装と観測が存在する対応文書へ置きます。secret、個人情報、実環境log原文、追跡可能な実識別子を恒久文書へ残しません。
