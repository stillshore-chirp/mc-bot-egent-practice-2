#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "required file missing: $1"
}

max_size() {
  local file="$1"
  local max_lines="$2"
  local max_bytes="$3"
  local lines bytes
  lines="$(wc -l < "$file" | tr -d ' ')"
  bytes="$(wc -c < "$file" | tr -d ' ')"
  (( lines <= max_lines )) || fail "$file exceeds ${max_lines} lines: $lines"
  (( bytes <= max_bytes )) || fail "$file exceeds ${max_bytes} bytes: $bytes"
}

require_text() {
  local file="$1"
  local text="$2"
  grep -Fq -- "$text" "$file" || fail "$file must contain: $text"
}

REQUIRED_FILES=(
  "README.md"
  ".gitignore"
  "AGENTS.md"
  "CLAUDE.md"
  "docs/agent-harness.md"
  "docs/agent-principles.md"
  "docs/documentation-structure.md"
  "docs/security-publication-checklist.md"
  "docs/ai-governance/03-evidence-and-completion-gates.md"
  "docs/ai-governance/13-maintenance-policy.md"
  "docs/ai-governance/14-issue-quality-gate.md"
  ".agents/skills/github-delivery/SKILL.md"
  ".agents/skills/production-investigation/SKILL.md"
  ".agents/skills/security-publication/SKILL.md"
  ".claude/rules/agent-harness.md"
  ".claude/skills/github-delivery/SKILL.md"
  ".claude/skills/production-investigation/SKILL.md"
  ".claude/skills/security-publication/SKILL.md"
  ".cursor/rules/agent-harness.mdc"
  ".github/ISSUE_TEMPLATE/feature.md"
  ".github/pull_request_template.md"
  ".github/workflows/agent-harness.yml"
  "requirements-agent-harness.txt"
  "scripts/validate_agent_frontmatter.py"
  "scripts/verify-agent-harness.sh"
)

CANONICAL_SKILLS=(
  ".agents/skills/github-delivery/SKILL.md"
  ".agents/skills/production-investigation/SKILL.md"
  ".agents/skills/security-publication/SKILL.md"
)

ADAPTERS=(
  ".claude/rules/agent-harness.md"
  ".claude/skills/github-delivery/SKILL.md"
  ".claude/skills/production-investigation/SKILL.md"
  ".claude/skills/security-publication/SKILL.md"
  ".cursor/rules/agent-harness.mdc"
)

for file in "${REQUIRED_FILES[@]}"; do
  require_file "$file"
done

max_size "AGENTS.md" 180 16384
for file in "${CANONICAL_SKILLS[@]}"; do
  max_size "$file" 180 16384
done
for file in "${ADAPTERS[@]}"; do
  max_size "$file" 30 4096
done

python3 scripts/validate_agent_frontmatter.py --self-test --repository "$REPO_ROOT"

require_text "README.md" "## プロジェクトの目的"
require_text "README.md" "## 目指す理想"
require_text "README.md" "## 初期目標"
require_text "README.md" "## 非目標"
require_text "README.md" "## 現在の状態"

require_text "AGENTS.md" "専用branch、論理的なcommit、push、非ドラフトPR、latest headのCI、GitHub上のreview対応、未解決thread確認、mergeability確認"
require_text "AGENTS.md" "対象を特定した別の明示指示がある場合だけ実行します"
require_text "AGENTS.md" ".agents/skills/github-delivery/SKILL.md"
require_text "AGENTS.md" ".agents/skills/production-investigation/SKILL.md"
require_text "AGENTS.md" ".agents/skills/security-publication/SKILL.md"

require_text ".agents/skills/github-delivery/SKILL.md" "編集前に、依頼を完全に含む主Issueを検索"
require_text ".agents/skills/github-delivery/SKILL.md" "該当する既存Issueがなければ、Issue品質ゲートを満たす主Issueを編集前に作成"
require_text ".agents/skills/github-delivery/SKILL.md" "gitへ入る文書、rule、Skill、adapter、template"
require_text ".agents/skills/github-delivery/SKILL.md" "非ドラフトPRを作成または更新"
require_text ".agents/skills/github-delivery/SKILL.md" "latest headに紐づくpush CIとpull_request CI"
require_text ".agents/skills/github-delivery/SKILL.md" "P0が残る場合は完了不可"
require_text ".agents/skills/github-delivery/SKILL.md" "P1は原則として同じ変更内で修正し、分離する場合は理由と追跡先を示す"
require_text ".agents/skills/github-delivery/SKILL.md" "P2は完了を止めないが、対応しない理由または後続先を記録"
require_text ".agents/skills/github-delivery/SKILL.md" "actionableな指摘は一つのreview cycleでまとめて確認"
require_text ".agents/skills/github-delivery/SKILL.md" "P1を分離する理由と追跡先、またはP2を対応しない理由か後続先まで記録した場合は、それだけを理由にheadを変更したり追加reviewを行ったりしない"
require_text ".agents/skills/github-delivery/SKILL.md" "修正したthreadは、修正がlatest headへpushされ、関連検証が成功した後だけ"
require_text ".agents/skills/github-delivery/SKILL.md" "コード変更が不要な指摘は、妥当でない根拠、P1を分離する理由と追跡先、またはP2を対応しない理由か後続先を返信して解決"
require_text ".agents/skills/github-delivery/SKILL.md" "actionableな未解決threadがなく"
require_text ".agents/skills/github-delivery/SKILL.md" "同一headでclean結果を増やすためだけの再reviewを行わない"
require_text ".agents/skills/github-delivery/SKILL.md" "GitHubのmergeabilityがclean"
require_text ".agents/skills/github-delivery/SKILL.md" "対象を特定した別の明示指示がある場合だけ行う"

require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "latest headについて、対象branchで定義されたpush CIとpull_request CIが成功している"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "latest meaningful changeに対するGitHub上で確認可能な自動または人間のreviewがclean"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "actionableな未解決review threadがない"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "P0が残る場合は完了不可"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "P1は原則として同じ変更内で修正し、分離する場合は理由と追跡先を示します"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "P2は完了を止めませんが、対応しない理由または後続先を記録"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "P1を分離する理由と追跡先、またはP2を対応しない理由か後続先を記録した場合はheadを変えず、そのreviewで終了できます"
require_text "docs/ai-governance/03-evidence-and-completion-gates.md" "GitHubのmergeabilityがclean"

require_text ".github/pull_request_template.md" "push CI"
require_text ".github/pull_request_template.md" "pull_request CI"
require_text ".github/pull_request_template.md" "latest meaningful changeへのreview"
require_text ".github/pull_request_template.md" "P0 / P1の対応状況、P1分離時の理由と追跡先"
require_text ".github/pull_request_template.md" "P2の対応判断、非対応理由または後続先"
require_text ".github/pull_request_template.md" "actionableな未解決review thread"
require_text ".github/pull_request_template.md" "GitHub mergeability"
require_text ".github/pull_request_template.md" "公開安全性"
require_text ".github/pull_request_template.md" "参照した外部正本"
require_text ".github/pull_request_template.md" "repository:"
require_text ".github/pull_request_template.md" "branch / version:"
require_text ".github/pull_request_template.md" "commit SHA:"
require_text ".github/pull_request_template.md" "確認日:"
require_text ".github/pull_request_template.md" "未実行項目"
require_text ".github/pull_request_template.md" "残るリスク"

require_text ".agents/skills/production-investigation/SKILL.md" "Minecraft"
require_text ".agents/skills/production-investigation/SKILL.md" "LLM"
require_text ".agents/skills/production-investigation/SKILL.md" "記憶"
require_text ".agents/skills/production-investigation/SKILL.md" "ゲーム内"
require_text ".agents/skills/production-investigation/SKILL.md" "## 3. 安全性と権限"
require_text ".agents/skills/production-investigation/SKILL.md" "## 4. 原因判定"
require_text ".agents/skills/security-publication/SKILL.md" "## 2. 最小化"
require_text ".agents/skills/security-publication/SKILL.md" "## 3. 検査"

require_text "docs/agent-harness.md" "GitHub配送Skill"
require_text "docs/agent-harness.md" "証跡と完了ゲート"
require_text "docs/ai-governance/13-maintenance-policy.md" "GitHub配送Skill"
require_text "docs/ai-governance/13-maintenance-policy.md" "証跡と完了ゲート"

echo "Agent harness verification: PASS"
