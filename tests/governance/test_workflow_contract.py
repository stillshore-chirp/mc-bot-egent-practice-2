from __future__ import annotations

from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
WORKFLOW = WORKFLOW_DIR / "ci.yml"


def load_workflow() -> dict[str, object]:
    return yaml.load(WORKFLOW.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def test_normal_pr_has_one_always_created_workflow() -> None:
    workflows = sorted(path.name for path in WORKFLOW_DIR.glob("*.yml"))

    assert workflows == ["ci.yml"]
    document = load_workflow()
    triggers = document["on"]
    assert "push" in triggers
    assert "pull_request" in triggers
    assert "paths" not in triggers["pull_request"]


def test_workflow_uses_classifier_selected_jobs_and_aggregate_gate() -> None:
    document = load_workflow()
    jobs = document["jobs"]

    assert set(jobs) == {
        "verification_scope",
        "product",
        "dashboard_browser",
        "governance",
        "workflow_contract",
        "quality_gate",
    }
    assert jobs["quality_gate"]["name"] == "Quality gate (selected checks)"
    assert jobs["quality_gate"]["if"] == "always()"
    assert set(jobs["quality_gate"]["needs"]) == {
        "verification_scope",
        "product",
        "dashboard_browser",
        "governance",
        "workflow_contract",
    }


def test_every_step_level_external_action_is_immutably_pinned() -> None:
    uses_lines = [
        line.strip()
        for line in WORKFLOW.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("uses:")
    ]

    assert uses_lines
    for line in uses_lines:
        assert re.fullmatch(
            r"uses: [a-z0-9_.-]+/[a-z0-9_.-]+@[0-9a-f]{40} # [A-Za-z0-9_.-]+",
            line,
        ), line


def test_workflow_preserves_product_browser_and_governance_commands() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")

    for command in (
        "npm run format:check",
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run build",
        "npm run audit:high",
        "npm run test:browser",
        "python scripts/validate_governance.py",
        "python scripts/verify_task_skills.py",
    ):
        assert command in source
    assert "if: failure()" in source
    assert "retention-days: 7" in source


def test_node_22_compatibility_lane_avoids_duplicate_static_checks() -> None:
    document = load_workflow()
    product_steps = document["jobs"]["product"]["steps"]
    guarded = {
        step["name"]: step.get("if")
        for step in product_steps
        if step["name"] in {
            "Check formatting",
            "Lint",
            "Type-check",
            "Audit high and critical vulnerabilities",
        }
    }

    assert guarded
    assert set(guarded.values()) == {"matrix.node-version == '24.x'"}
