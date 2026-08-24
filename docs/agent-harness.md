# エージェントハーネス設計・保守ガイド

この文書は、mc-bot-egent-practice-2をCodex・Claude Code・Cursorのいずれで扱っても、同じ品質基準へ到達するための構成を定義します。

## 目的

常時読み込む長文、複数の正本、taskと無関係な手順は、重要な指示への注意を薄めます。このリポジトリでは責務を次の層へ分けます。

| 層 | 役割 | 配置 |
|---|---|---|
| 共通核 | 全作業に必要な進行、安全境界、配送契約 | `AGENTS.md` |
| path固有ルール | 実在する領域だけの追加契約 | 将来必要になった時点のnested `AGENTS.md` |
| task Skill | GitHub配送、実環境調査、公開安全性の実行順序 | `.agents/skills/` |
| 詳細正本 | 配置判断、原則、証跡、保守、公開判定 | `docs/` |
| tool adapter | 各toolの発見機構から正本への接続 | `CLAUDE.md`, `.claude/`, `.cursor/` |
| 機械検証 | 形式、参照、budget、重複、必須契約 | `scripts/verify-agent-harness.sh`, CI |

現時点で製品コードのpathは未確定です。将来のディレクトリを仮定したnested ruleや空adapterは作りません。

## 正本とadapter

- 共有する常時読込契約はルート `AGENTS.md`。
- task手順は `.agents/skills/<name>/SKILL.md`。
- 判断基準と保守方針は `docs/`。
- `.claude/rules/`、`.claude/skills/`、`.cursor/rules/` は、対象範囲と読むべき正本だけを示す薄いadapter。
- adapterへ正本のchecklistや手順本文をコピーしません。

## 3製品の接続

### Codex

- ルートから作業場所までの `AGENTS.md` を利用します。
- task固有手順は `.agents/skills/` を読みます。
- 複数領域を変更する場合は、各対象に最も近い `AGENTS.md` を明示的に確認します。

### Claude Code

- `CLAUDE.md` は `@AGENTS.md` だけをimportし、共通核を一重に共有します。
- `.claude/rules/*.md` はfrontmatterの `paths` で必要な時だけ詳細正本へ案内します。
- `.claude/skills/<name>/SKILL.md` は対応する共有Skillだけを案内します。

### Cursor

- 共通核はルート `AGENTS.md` から読みます。
- `.cursor/rules/*.mdc` は `globs` と `alwaysApply: false` で、対象変更だけを詳細正本へ案内します。
- task手順はAgent Skills互換の `.agents/skills/` を正本として使います。

各toolのversion、実行形態、sandboxによる発見差は静的検証だけでは保証できません。発見できない場合はtool名、version、実行形態、再現pathをIssueへ記録します。

nested `AGENTS.md` を追加する場合は、その親pathをURL percent-encodeしたscope keyを使い、`.claude/rules/nested-agents-<scope-key>.md` と `.cursor/rules/nested-agents-<scope-key>.mdc` を同じ変更で追加します。例えば `apps/bot/AGENTS.md` のscope keyは `apps%2Fbot` です。`nested-agents-` prefixはこの接続専用として予約します。両adapterは対象pathだけへscopeし、nested `AGENTS.md` への参照だけを持ちます。ClaudeとCursorのglob解釈を一致させるため、scopeのディレクトリ名に `*`, `?`, `[`, `]`, `{`, `}`, `!`, `,`, `\` は使いません。検証scriptは、globとして安全でないscope、adapterの欠落、scope不一致、本文複製、対応するnested ruleがない孤立adapterを拒否します。

## 配置の判断

新しい規則を追加する前に、次の順で判断します。

1. 全taskで毎回必要なら `AGENTS.md` に短く置く。
2. 実在する特定pathだけに必要なら最寄りのnested `AGENTS.md` と薄いadapterを置く。
3. 特定taskだけに必要なら `.agents/skills/` と必要なClaude adapterを置く。
4. 機械判定できるならscript、test、lint、CIへ置く。
5. 既存の詳細正本へ統合できる場合は新規文書を増やさない。

## Hard gateとheuristic

Hard gateは、違反時に停止または未完了扱いにする客観的な条件です。secret・個人情報の非公開、権限境界、観測していない状態の非断定、latest headのCI・review・thread・mergeabilityが該当します。

Heuristicは設計判断を助ける目安です。DRY、KISS、SRP、OCP、YAGNI、行数、重複回数、test配分が該当します。例外が成立する判断を、数値だけでPass / Failへ変換しません。

## GitHub配送の権限

ソースコード変更依頼には、主Issueの確定、専用branch、commit、push、非ドラフトPR、CI確認、GitHub上のreview対応、対応済みthread解決、mergeability確認までの通常配送が含まれます。実行順序は [GitHub配送Skill](../.agents/skills/github-delivery/SKILL.md)、観測可能な完了条件は [証跡と完了ゲート](ai-governance/03-evidence-and-completion-gates.md) を正本とします。

merge、Issue・PRのclose、release、deploy、force-push、公開済み履歴の書換え、破壊的操作には、対象を特定した別の明示指示が必要です。

## Instruction budget

次をhard upper boundとします。短いほど常に良いという意味ではなく、超過時に構造を見直す上限です。

| 対象 | 行数 | UTF-8 bytes |
|---|---:|---:|
| ルート `AGENTS.md` | 180以下 | 16 KiB以下 |
| nested `AGENTS.md` | 100以下 | 8 KiB以下 |
| rule / Skill adapter | 30以下 | 4 KiB以下 |
| canonical Skill | 180以下 | 16 KiB以下 |
| ルート + 対象pathで有効な全nested `AGENTS.md` | - | 24 KiB以下 |

上限を超える場合は、常時読込である必要、分割できない理由、3製品への影響をIssueとPRへ記録し、検証scriptの上限を黙って緩和しません。

## 禁止する構造

- tool別ファイルへ同じ長文を複製する。
- `AGENTS.md`、Skill、詳細docsで同じchecklistをそれぞれ正本化する。
- 一つのGitHub clientや特定review名を、同等手段がある全toolの共通条件にする。
- 変更のない同一headへ、clean結果を増やすためだけのreviewを反復する。
- read-only回答へIssue・branch・PR欄の定型出力を要求する。
- 将来だけを理由にpath rule、空文書、placeholderを作る。
- 形式で検査できる条件を自然言語だけで維持する。

## Review契約の配置

reviewの実行順序は [GitHub配送Skill](../.agents/skills/github-delivery/SKILL.md)、Pass / Failの観測条件は [証跡と完了ゲート](ai-governance/03-evidence-and-completion-gates.md) を正本とします。この文書では手順や完了条件を再定義しません。

## 変更時の確認

1. 変更をcommon、path、task、docs、machineのどこへ置くか決めた。
2. Codex、Claude Code、Cursorから必要な正本へ到達できる。
3. adapterへルール本文を複製していない。
4. Hard gateとheuristicを区別した。
5. instruction budgetを満たした。
6. 旧正本、競合指示、循環参照、壊れたlinkを残していない。
7. GitHub配送Skillと完了ゲートの参照が保たれ、機械検証が両者の契約を確認している。

## 検証

依存を導入した環境で次を実行します。

```bash
python3 -m pip install -r requirements-agent-harness.txt
bash -n scripts/verify-agent-harness.sh
python3 -m py_compile scripts/validate_agent_frontmatter.py
bash scripts/verify-agent-harness.sh
```

CIはエージェントルールと共同作業文書の関連pathが変わった場合だけ同じ検証を実行します。製品コード用のCIは製品実装の設計後に追加します。

検証対象は、gitが管理する非ignore fileのうち、共通核、nested rule、Skill、tool rule・adapter、明示した共同作業文書、template、harness workflow・scriptです。将来の製品コード、一般docs、parser・security fixture、binary assetの内容検査は製品CIへ分離します。移植元固有語と廃止指示の検査もactiveなbootstrap成果物へ限定し、無関係なprovenance文書を失敗条件にしません。active ruleではinline codeとcode fence内も競合検査の対象です。
