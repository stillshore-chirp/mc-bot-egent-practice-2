# AIガバナンス文書インデックス

このディレクトリは、Minecraft AIコンパニオンの開発で、Issue品質、委任、証跡、完了条件、公開安全性を扱う詳細正本です。企業全体の法務・倫理審査やモデル監査を意味しません。

エージェントルール全体の配置と3製品への接続は[docs/agent-harness.md](../agent-harness.md)を正本とします。

## 読み方

1. root AGENTS.mdと変更対象に最も近いAGENTS.mdを読む。
2. taskに該当する共有Skillを発動する。
3. 変更内容に直接関係する正本だけを追加で読む。
4. 実環境調査ではproduction-investigation Skillと公開安全性Skillを組み合わせる。
5. 完了時は[証跡と完了ゲート](03-evidence-and-completion-gates.md)を参照する。

## 中心文書

| 文書 | 責務 |
|---|---|
| [agent-harness.md](../agent-harness.md) | 委任、checkpoint、input closure、evidence reuse、task-state、PR monitor |
| [01-agent-operating-contract.md](01-agent-operating-contract.md) | 作業前確認、観測境界、報告契約 |
| [03-evidence-and-completion-gates.md](03-evidence-and-completion-gates.md) | gate ledger、対象別evidence、完了条件 |
| [13-maintenance-policy.md](13-maintenance-policy.md) | 正本・adapter・validatorの変更と削除 |
| [14-issue-quality-gate.md](14-issue-quality-gate.md) | Issueの根拠、scope、acceptance、risk |

## Template

- [agent-task-prompt.md](templates/agent-task-prompt.md)
- [completion-gate-report.md](templates/completion-gate-report.md)
- [task-state.json](templates/task-state.json)
