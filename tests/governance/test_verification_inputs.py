from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "classify_verification_inputs",
    ROOT / "scripts" / "classify_verification_inputs.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_product_change_selects_only_product_gate() -> None:
    result = MODULE.classify_paths(["src/runtime/task-service.ts"])

    assert result["classification_ok"] is True
    assert result["product"] is True
    assert result["browser"] is False
    assert result["governance"] is False
    assert result["workflow_contract"] is False


def test_dashboard_change_selects_product_and_browser() -> None:
    result = MODULE.classify_paths(["src/trace/service.ts"])

    assert result["classification_ok"] is True
    assert result["product"] is True
    assert result["browser"] is True


def test_governance_change_does_not_run_product_gates() -> None:
    result = MODULE.classify_paths(["docs/ai-governance/13-maintenance-policy.md"])

    assert result["classification_ok"] is True
    assert result["governance"] is True
    assert result["product"] is False
    assert result["browser"] is False


def test_workflow_change_selects_every_gate() -> None:
    result = MODULE.classify_paths([".github/workflows/ci.yml"])

    assert result["classification_ok"] is True
    assert all(result[gate] is True for gate in MODULE.GATES)


def test_unknown_path_fails_closed_and_selects_diagnostics() -> None:
    result = MODULE.classify_paths(["new-surface/contract.fixture"])

    assert result["classification_ok"] is False
    assert result["unknown_paths"] == ["new-surface/contract.fixture"]
    assert all(result[gate] is True for gate in MODULE.GATES)


def test_full_profile_selects_every_gate() -> None:
    result = MODULE.classify_paths([], full=True)

    assert result["classification_ok"] is True
    assert all(result[gate] is True for gate in MODULE.GATES)


def test_diff_contract_keeps_deleted_and_renamed_sides_visible() -> None:
    source = (ROOT / "scripts" / "classify_verification_inputs.py").read_text(
        encoding="utf-8"
    )

    assert '"--no-renames"' in source
    assert 'f"{base}...{head}"' in source
    assert '"-z"' in source


def test_retired_harness_paths_remain_classifiable_when_deleted() -> None:
    result = MODULE.classify_paths(
        ["scripts/validate_agent_frontmatter.py", "scripts/verify-agent-harness.sh"]
    )

    assert result["classification_ok"] is True
    assert result["governance"] is True
