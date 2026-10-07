# AIガバナンス文書インデックス

このディレクトリは、Minecraft AIコンパニオンの製品固有のIssue根拠、evidence、公開安全性、rule配置を扱います。共通の作業運用は実行環境の指示を優先します。企業全体の法務・倫理審査やモデル監査を意味しません。

エージェントルールの配置と3製品への接続は[docs/agent-harness.md](../agent-harness.md)を正本とします。

## 読み方

1. 製品契約はroot AGENTS.mdで確認する。
2. taskに直接関係するrepository Skillを参照する。
3. 製品evidence、Issueの根拠、公開安全性に関係する正本だけを追加で読む。

## 中心文書

| 文書 | 責務 |
|---|---|
| [agent-harness.md](../agent-harness.md) | 正本配置、input closure、task-state、instruction budget、static validator |
| [01-agent-operating-contract.md](01-agent-operating-contract.md) | Minecraft実環境で何を観測事実と呼ぶか |
| [03-evidence-and-completion-gates.md](03-evidence-and-completion-gates.md) | Minecraft製品とgovernance変更のevidence境界 |
| [13-maintenance-policy.md](13-maintenance-policy.md) | rule、Skill、adapter、validatorのrepository内の役割 |
| [14-issue-quality-gate.md](14-issue-quality-gate.md) | Issue内での製品状態、根拠、仮説の区別 |

## Template

- [agent-task-prompt.md](templates/agent-task-prompt.md)
- [completion-gate-report.md](templates/completion-gate-report.md)
- [task-state.json](templates/task-state.json)
