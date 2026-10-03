# ドキュメント構成と責務分担

READMEはプロジェクト入口、詳細な契約は対応する正本へ分けます。

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

## 開発作業の正本

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
