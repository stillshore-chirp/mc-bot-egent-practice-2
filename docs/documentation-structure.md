# ドキュメント構成と責務分担

この文書は、現在実在する文書の責務と、新しい情報の配置判断を定義します。READMEは入口に保ち、詳細な契約は対応する正本へ分けます。

## 現在の正本

| 文書 | 責務 |
|---|---|
| `README.md` | 目的、理想、初期目標、非目標、現在の状態、文書入口 |
| `AGENTS.md` | 3toolが常時共有する短い作業契約 |
| `docs/agent-harness.md` | 共通核、Skill、adapter、機械検証の配置とinstruction budget |
| `docs/agent-principles.md` | 将来の設計・実装を助けるheuristicとAIコンパニオンのhard gate |
| `docs/documentation-structure.md` | 文書責務と配置判断 |
| `docs/ai-governance/03-evidence-and-completion-gates.md` | 証跡と完了の観測条件 |
| `docs/ai-governance/13-maintenance-policy.md` | ルール変更時の3tool保守契約 |
| `docs/ai-governance/14-issue-quality-gate.md` | 主Issueの品質条件 |
| `docs/security-publication-checklist.md` | commit、Issue、PR、証跡の公開安全性 |
| `.agents/skills/` | task固有workflowの正本 |
| `.claude/`, `.cursor/` | toolの発見機構から正本への薄いadapter |
| `.github/` | Issue・PRの入力構造と対象CI |

製品アーキテクチャ、利用者向け操作、運用、API、記憶、ゲーム操作の詳細文書は、対応する設計または実装が存在してから追加します。将来のためだけのplaceholderは作りません。

## 配置判断

1. 初見の訪問者がプロジェクトの状態を判断する情報はREADMEへ置く。
2. 全作業に常時必要な短い契約はAGENTSへ置く。
3. taskの実行順序は共有Skillへ置く。
4. 判断基準、根拠、保守手順はdocsの対応する正本へ置く。
5. 機械判定できる条件はscriptとCIへ置く。
6. tool固有fileには適用範囲と正本への参照だけを置く。
7. 既存正本へ統合できる場合は新しいfileを増やさない。

## 更新時の確認

- 目的、理想、目標、非目標、現在の実装状態が変わる場合はREADMEを更新する。
- 全taskの作業契約が変わる場合はAGENTSを更新する。
- rule配置、instruction budget、3tool接続が変わる場合はagent-harnessと検証scriptを更新する。
- GitHub配送の観測条件が変わる場合はGitHub配送Skill、完了ゲート、PR template、検証scriptを同じ変更で確認する。
- 公開可能な情報の境界が変わる場合は公開安全性Skillとchecklistを同じ変更で確認する。
- 新しい製品領域が実装された場合だけ、最寄りの正本やpath ruleが必要かを判断する。

## 重複管理

- 共通核、task Skill、詳細docs、adapter、機械検証で同じ長文を正本化しません。
- 複数文書で同じ情報が必要な場合は、一つを正本にし、他は短い要約とlinkだけにします。
- READMEへtask固有workflow、実装内部、長い検証手順を置きません。
- adapterへchecklist、権限表、実行手順を複製しません。
- secret、認証情報、個人情報、実環境log原文、追跡可能な実識別子を恒久文書へ残しません。
