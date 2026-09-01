---
paths:
  - "AGENTS.md"
  - "CLAUDE.md"
  - ".agents/**/*"
  - ".claude/**/*"
  - ".cursor/**/*"
  - "docs/agent-harness.md"
  - "docs/agent-principles.md"
  - "docs/documentation-structure.md"
  - "docs/security-publication-checklist.md"
  - "docs/ai-governance/**/*"
  - ".github/ISSUE_TEMPLATE/**/*"
  - ".github/pull_request_template.md"
  - "requirements-agent-harness.txt"
  - "scripts/validate_governance.py"
  - "scripts/verify_task_skills.py"
---

エージェントハーネス変更時は[docs/agent-harness.md](../../docs/agent-harness.md)と[13-maintenance-policy.md](../../docs/ai-governance/13-maintenance-policy.md)を読み、3製品の到達性、budget、正本とadapterの分離を確認します。形式・参照・task-stateはscripts/validate_governance.pyで検証します。
