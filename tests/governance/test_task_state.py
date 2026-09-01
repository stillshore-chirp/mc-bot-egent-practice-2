from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from scripts.validate_governance import GovernanceError, TASK_STATE_TEMPLATE, validate_task_state


ROOT = Path(__file__).resolve().parents[2]


def _template() -> dict[str, object]:
    return json.loads((ROOT / TASK_STATE_TEMPLATE).read_text(encoding="utf-8"))


def _write_state(tmp_path: Path, state: dict[str, object]) -> Path:
    path = tmp_path / "task-state.json"
    path.write_text(json.dumps(state), encoding="utf-8")
    return path


def test_task_state_template_is_valid_synthetic_and_client_neutral(tmp_path: Path) -> None:
    state = _template()

    assert state["completed_evidence"][0]["result"] == "pass"
    assert state["completed_evidence"][0]["artifact_reference"] in state["input_closure"]["artifacts"]
    assert state["invalidated_gates"] == []
    assert state["remaining_work"]
    serialized = json.dumps(state, ensure_ascii=False).casefold()
    assert not any(term in serialized for term in ("codex", "claude", "cursor", "client", "api"))
    assert "/users/" not in serialized
    assert re.search(r"\b[0-9a-f]{40}\b", serialized) is None

    validate_task_state(ROOT / TASK_STATE_TEMPLATE)
    state["completed_evidence"][0]["artifact_reference"] = None
    validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_v1_without_optional_boundaries_remains_valid(tmp_path: Path) -> None:
    state = _template()
    state.pop("measurement")
    state.pop("publication")

    validate_task_state(_write_state(tmp_path, state), tmp_path)


@pytest.mark.parametrize(
    "measurement_paths,annotation_paths",
    [
        (["docs/publication-report.md"], ["docs/publication-report.md"]),
        (["docs/**"], ["docs/publication-report.md"]),
        (["docs/publication-report.md"], ["docs/*.md"]),
        (["docs/*.md"], ["docs/report-*"]),
    ],
)
def test_task_state_rejects_measurement_publication_self_reference(
    tmp_path: Path, measurement_paths: list[str], annotation_paths: list[str]
) -> None:
    state = _template()
    state["measurement"]["input_paths"] = measurement_paths
    state["publication"]["annotation_paths"] = annotation_paths

    with pytest.raises(GovernanceError, match="self-reference"):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_accepts_non_overlapping_literal_paths(tmp_path: Path) -> None:
    state = _template()
    state["measurement"]["input_paths"] = ["docs/measurement.md"]
    state["publication"]["annotation_paths"] = ["docs/report.md"]

    validate_task_state(_write_state(tmp_path, state), tmp_path)


@pytest.mark.parametrize(
    "measurement_path,annotation_path",
    [
        ("docs/../docs/publication-report.md", "docs/publication-report.md"),
        ("docs//publication-report.md", "docs/publication-report.md"),
    ],
)
def test_task_state_rejects_noncanonical_self_reference_spellings(
    tmp_path: Path, measurement_path: str, annotation_path: str
) -> None:
    state = _template()
    state["measurement"]["input_paths"] = [measurement_path]
    state["publication"]["annotation_paths"] = [annotation_path]

    with pytest.raises(GovernanceError, match="self-reference"):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_keeps_measurement_evidence_for_publication_only_reacquire(
    tmp_path: Path,
) -> None:
    state = _template()
    state["completed_evidence"][0]["gate"] = "measurement"
    state["invalidated_gates"] = [
        {
            "gate": "publication",
            "reason": "report-only annotation changed",
            "reacquire_scope": ["docs/publication-report.md"],
        }
    ]

    validate_task_state(_write_state(tmp_path, state), tmp_path)


@pytest.mark.parametrize("field,value", [("schema", "task-state/v2"), ("status", "unknown")])
def test_task_state_rejects_unknown_schema_or_status(
    tmp_path: Path, field: str, value: str
) -> None:
    state = _template()
    state[field] = value

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_rejects_missing_required_field(tmp_path: Path) -> None:
    state = _template()
    del state["remaining_work"]

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_rejects_unknown_evidence_result(tmp_path: Path) -> None:
    state = _template()
    state["completed_evidence"][0]["result"] = "unknown"

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_rejects_external_artifact_reference(tmp_path: Path) -> None:
    state = _template()
    state["completed_evidence"][0]["artifact_reference"] = "unlisted-reference"

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_rejects_completed_and_invalidated_gate_overlap(tmp_path: Path) -> None:
    state = _template()
    state["invalidated_gates"] = [
        {"gate": "synthetic-gate", "reason": "changed", "reacquire_scope": ["docs/example.md"]}
    ]

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


def test_task_state_accepts_complete_with_passing_evidence(tmp_path: Path) -> None:
    state = _template()
    state["status"] = "complete"
    state["remaining_work"] = []

    validate_task_state(_write_state(tmp_path, state), tmp_path)


@pytest.mark.parametrize("result", ["fail", "partial", "unverified"])
def test_task_state_rejects_non_passing_complete_evidence(
    tmp_path: Path, result: str
) -> None:
    state = _template()
    state["status"] = "complete"
    state["remaining_work"] = []
    state["completed_evidence"][0]["result"] = result

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


@pytest.mark.parametrize("bound", ["size", "list", "string"])
def test_task_state_rejects_size_list_or_string_bound(tmp_path: Path, bound: str) -> None:
    state = _template()
    if bound == "size":
        state["risks_blockers"]["risks"] = ["x" * 500] * 50
    elif bound == "list":
        state["acceptance"] = ["x"] * 51
    else:
        state["goal"] = "x" * 1_001

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)


@pytest.mark.parametrize(
    "status,remaining,invalidated,blockers",
    [
        ("complete", ["next"], [], []),
        ("complete", [], [{"gate": "other", "reason": "changed", "reacquire_scope": ["path"]}], []),
        ("complete", [], [], ["blocker"]),
        ("blocked", [], [], []),
    ],
)
def test_task_state_rejects_invalid_terminal_state(
    tmp_path: Path,
    status: str,
    remaining: list[str],
    invalidated: list[dict[str, object]],
    blockers: list[str],
) -> None:
    state = _template()
    state["status"] = status
    state["remaining_work"] = remaining
    state["invalidated_gates"] = invalidated
    state["risks_blockers"]["blockers"] = blockers

    with pytest.raises(GovernanceError):
        validate_task_state(_write_state(tmp_path, state), tmp_path)
