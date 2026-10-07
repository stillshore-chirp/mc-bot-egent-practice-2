# ドキュメント構成と責務分担

READMEはプロジェクト入口、詳細な契約は対応する正本へ分けます。共通の作業運用は実行環境の指示に従います。

## 製品技術文書の正本

全体像から各領域へ進み、評価・原因調査でコードへ戻れる構成にします。

| 文書 | 責務 | 重複させない内容 |
| --- | --- | --- |
| [README](../README.md) | 目的、入口、起動、読み順 | 詳細な操作・保存契約 |
| [architecture](architecture.md) | 既定経路の全体構成・責務・設計理由 | legacyの詳細 |
| [autonomous-player](autonomous-player.md) | 会話/目的判断、イベント、競合、停止、具体例 | Bodyの全操作仕様 |
| [memory](memory.md) | 人格、入力文脈、一時/永続状態、復元、限界 | 技能の交換形式 |
| [player-body](player-body.md) | 視野・操作・結果確認・キャンセル | 目的の選び方 |
| [mc-bot-skills](mc-bot-skills.md) | 技能仮説、証跡、学習、版、交換 | 汎用的な作業手順 |
| [testing](testing.md) | 評価指標、観測先、原因調査、テスト対応 | 実ゲームcaseの全手順 |
| [ai-player-e2e](ai-player-e2e.md) | 実ゲーム評価手順・過去結果・限界 | 最新コードの全体解説 |
| [operations](operations.md) | 設定・起動停止・バックアップ・運用 | runtimeの内部状態遷移 |
| [dashboard](dashboard.md) | 画面・traceの詳細文書への入口 | 成功判定の代替 |
| [legacy-runtime](architecture.md#旧toolruntime経路の詳細) | 明示的な旧アプリケーションの契約 | 既定動作との混在 |

製品説明はコードの入口・型・保存/呼出し箇所と対応付けます。設計意図、実装、過去の実測、今回未実行の検証を分け、過去のrun番号を一般保証へ置き換えません。

## 開発文書の正本

| 文書 | 責務 |
|---|---|
| README.md | 目的、目標、非目標、現在の状態、入口 |
| AGENTS.md | Minecraft製品固有の契約と正本へのrouting |
| docs/agent-harness.md | 正本配置、evidence/input closure、task-state、instruction budget、static validator |
| docs/agent-principles.md | Minecraft AIコンパニオンの設計heuristic |
| docs/documentation-structure.md | 文書責務と配置判断 |
| docs/ai-governance/00-index.md | governance文書の読み方と入口 |
| docs/ai-governance/01-agent-operating-contract.md | Minecraft実環境の観測境界 |
| docs/ai-governance/03-evidence-and-completion-gates.md | 製品とgovernance変更のevidence境界 |
| docs/ai-governance/13-maintenance-policy.md | rule、Skill、adapter、validatorのrepository内の役割 |
| docs/ai-governance/14-issue-quality-gate.md | Issueの製品根拠と事実・仮説の区別 |
| docs/ai-governance/templates/ | 作業依頼、製品evidence報告、task-state |
| docs/security-publication-checklist.md | 公開安全性のrepository固有例 |
| .agents/skills/ | task固有の製品証跡と公開境界 |
| .claude/、.cursor/ | 正本へのrouter |
| .github/ | Issue / PRの入力構造 |
| scripts/validate_governance.py | central static validator |

## 配置判断

1. 製品の短い契約とrouterはAGENTS.md。
2. Minecraft製品固有の観測基準は共有Skill。
3. evidence・保守の説明はdocsへ置く。
4. 機械判定できるtask-stateや文書形式はvalidatorへ置く。
5. tool固有fileは正本への参照だけを持つ。
6. 既存正本へ統合できる場合は新規fileを増やさない。
