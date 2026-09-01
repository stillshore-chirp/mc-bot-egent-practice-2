#!/usr/bin/env python3
"""Validate the static structure of this repository agent-governance surface."""

from __future__ import annotations

import argparse
from fnmatch import fnmatchcase
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt


ROOT = Path(__file__).resolve().parents[1]
LIMITS = {
    "root": (180, 16_384),
    "nested": (100, 8_192),
    "skill": (180, 16_384),
    "adapter": (30, 4_096),
}
COMBINED_ROUTER_BYTES = 24_576
TASK_STATE_TEMPLATE = "docs/ai-governance/templates/task-state.json"
TASK_STATE_SCHEMA = "task-state/v1"
TASK_STATE_STATUSES = frozenset({"planned", "running", "partial", "blocked", "complete"})
TASK_STATE_RESULTS = frozenset({"pass", "fail", "partial", "unverified"})
TASK_STATE_MAX_BYTES = 16_384
TASK_STATE_MAX_ITEMS = 50
TASK_STATE_MAX_STRING_LENGTH = 1_000
TASK_STATE_MAX_SUMMARY_LENGTH = 500
_TASK_STRING_LIST = ("list", "string", True)
_TASK_REQUIRED_STRING_LIST = ("list", "string", False)
PR_MONITOR_STATES = frozenset({"MERGED", "CLOSED", "OPEN"})
PR_MONITOR_TERMINAL_STATES = frozenset({"MERGED", "CLOSED"})
PR_MONITOR_LIGHTWEIGHT_KEY_FIELDS = (
    "state",
    "headRefOid",
    "updatedAt",
    "reviewDecision",
    "mergeStateStatus",
)
TASK_STATE_SHAPE: dict[str, object] = {
    "schema": "string",
    "status": "string",
    "goal": "string",
    "acceptance": _TASK_REQUIRED_STRING_LIST,
    "snapshot": {"base": "string", "head": "string", "phase": "string"},
    "lane": {"id": "string", "owner": "string", "owned_paths": _TASK_STRING_LIST},
    "completed_evidence": (
        "list",
        {
            "gate": "string",
            "summary": ("bounded", TASK_STATE_MAX_SUMMARY_LENGTH),
            "result": "string",
            "artifact_reference": "nullable_string",
        },
        True,
    ),
    "input_closure": {
        "paths": _TASK_STRING_LIST,
        "config": _TASK_STRING_LIST,
        "artifacts": _TASK_STRING_LIST,
        "conditions": _TASK_STRING_LIST,
    },
    "invalidated_gates": (
        "list",
        {"gate": "string", "reason": "string", "reacquire_scope": _TASK_REQUIRED_STRING_LIST},
        True,
    ),
    "remaining_work": _TASK_STRING_LIST,
    "risks_blockers": {"risks": _TASK_STRING_LIST, "blockers": _TASK_STRING_LIST},
}
# These fields are optional so existing task-state/v1 documents remain valid.
# New states can opt into an explicit measurement/publication boundary.
TASK_STATE_OPTIONAL_SHAPE: dict[str, object] = {
    "measurement": {
        "gate": "string",
        "input_paths": _TASK_REQUIRED_STRING_LIST,
    },
    "publication": {
        "gate": "string",
        "annotation_paths": _TASK_REQUIRED_STRING_LIST,
    },
}
REQUIRED_FILES = (
    "AGENTS.md",
    "CLAUDE.md",
    "docs/agent-principles.md",
    "docs/agent-harness.md",
    "docs/documentation-structure.md",
    "docs/security-publication-checklist.md",
    "docs/ai-governance/00-index.md",
    "docs/ai-governance/01-agent-operating-contract.md",
    "docs/ai-governance/03-evidence-and-completion-gates.md",
    "docs/ai-governance/13-maintenance-policy.md",
    "docs/ai-governance/14-issue-quality-gate.md",
    TASK_STATE_TEMPLATE,
    "scripts/validate_governance.py",
)
REQUIRED_RULES = (
    ".claude/rules/agent-harness.md",
    ".cursor/rules/agent-harness.mdc",
)
SKILL_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*$")


class GovernanceError(ValueError):
    """Raised when the static governance structure is invalid."""


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def _mapping(loader: UniqueKeyLoader, node: yaml.nodes.MappingNode, deep: bool = False) -> dict[Any, Any]:
    result: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise GovernanceError(f"duplicate frontmatter key: {key!r}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def fail(message: str) -> None:
    raise GovernanceError(message)


def validate_pr_monitor_lightweight_key(value: object) -> None:
    """Validate the exact structured fields of a PR-monitor state key."""

    required = set(PR_MONITOR_LIGHTWEIGHT_KEY_FIELDS)
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        fail("PR monitor lightweight key must be a string-keyed object")
    actual = set(value)
    missing = sorted(required - actual)
    unknown = sorted(actual - required)
    if missing or unknown:
        fail(
            "PR monitor lightweight key fields invalid: "
            f"missing={missing} unknown={unknown}"
        )


def decide_pr_monitor_run(
    state: str,
    state_key_changed: bool,
    reassessment_checkpoint_due: bool,
    monitoring_still_needed: bool,
    *,
    merge_state_status: str | None = None,
    review_decision: str | None = None,
) -> dict[str, object]:
    """Return a static reference decision for one PR-monitor run.

    This function documents a decision contract for callers and tests; it does
    not enforce product runtime behavior or operate a scheduler.  ``state``
    is authoritative, so optional GitHub status fields cannot override a
    terminal state.  ``reassessment_checkpoint_due`` comes from a logical
    checkpoint or deadline, not a fixed timeout count.  The monitor stops
    only when that reassessment says ``monitoring_still_needed`` is false.
    """

    if not isinstance(state, str) or state not in PR_MONITOR_STATES:
        fail(f"unknown PR monitor state: {state!r}")
    if not isinstance(state_key_changed, bool):
        fail("PR monitor state_key_changed must be a boolean")
    if not isinstance(reassessment_checkpoint_due, bool):
        fail("PR monitor reassessment_checkpoint_due must be a boolean")
    if not isinstance(monitoring_still_needed, bool):
        fail("PR monitor monitoring_still_needed must be a boolean")

    # Keep these inputs explicit in the reference contract while ensuring that
    # UNKNOWN or empty secondary fields do not outrank the canonical state.
    del merge_state_status, review_decision

    if state in PR_MONITOR_TERMINAL_STATES:
        return {
            "task_action": "delete",
            "details": False,
            "wait": None,
            "notify": False,
            "stop_reason": "terminal_state",
            "unverified_scope": None,
        }
    if state_key_changed:
        return {
            "task_action": "retain",
            "details": True,
            "wait": None,
            "notify": False,
            "stop_reason": None,
            "unverified_scope": None,
        }
    if reassessment_checkpoint_due and not monitoring_still_needed:
        return {
            "task_action": "stop",
            "details": False,
            "wait": None,
            "notify": True,
            "stop_reason": "monitoring_not_needed",
            "unverified_scope": "external_wait",
        }
    return {
        "task_action": "retain",
        "details": False,
        "wait": "event/backoff",
        "notify": False,
        "stop_reason": None,
        "unverified_scope": None,
    }


def rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        fail(f"cannot read {path}: {error}")


def require_file(path: Path, root: Path) -> None:
    if not path.is_file():
        fail(f"required file missing: {rel(path, root)}")


def _validate_task_state_shape(
    value: Any, shape: object, label: str, path: Path, root: Path
) -> None:
    if isinstance(shape, dict):
        if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
            fail(f"{rel(path, root)} task-state {label} must be an object")
        actual, expected = set(value), set(shape)
        missing, unknown = sorted(expected - actual), sorted(actual - expected)
        if missing or unknown:
            fail(f"{rel(path, root)} task-state {label} keys invalid: missing={missing} unknown={unknown}")
        for key, child_shape in shape.items():
            _validate_task_state_shape(value[key], child_shape, f"{label}.{key}", path, root)
        return
    if shape == "nullable_string":
        if value is not None:
            _validate_task_state_shape(value, "string", label, path, root)
        return
    if shape == "string" or (isinstance(shape, tuple) and shape[0] == "bounded"):
        if not isinstance(value, str) or not value.strip():
            fail(f"{rel(path, root)} task-state {label} must be a non-empty string")
        max_length = shape[1] if isinstance(shape, tuple) else TASK_STATE_MAX_STRING_LENGTH
        if len(value) > max_length:
            fail(f"{rel(path, root)} task-state {label} exceeds bounded length")
        return
    if isinstance(shape, tuple) and shape[0] == "list":
        if not isinstance(value, list) or (not shape[2] and not value):
            fail(f"{rel(path, root)} task-state {label} must be a string list")
        if len(value) > TASK_STATE_MAX_ITEMS:
            fail(f"{rel(path, root)} task-state {label} exceeds item bound")
        for index, item in enumerate(value):
            _validate_task_state_shape(item, shape[1], f"{label}[{index}]", path, root)
        return
    fail(f"{rel(path, root)} task-state {label} has an unsupported shape")


def _validate_task_state_document(
    value: Any, path: Path, root: Path
) -> None:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        fail(f"{rel(path, root)} task-state document must be an object")
    expected = set(TASK_STATE_SHAPE)
    optional = set(TASK_STATE_OPTIONAL_SHAPE)
    actual = set(value)
    missing, unknown = sorted(expected - actual), sorted(actual - expected - optional)
    if missing or unknown:
        fail(f"{rel(path, root)} task-state document keys invalid: missing={missing} unknown={unknown}")
    for key, child_shape in TASK_STATE_SHAPE.items():
        _validate_task_state_shape(value[key], child_shape, f"document.{key}", path, root)
    for key, child_shape in TASK_STATE_OPTIONAL_SHAPE.items():
        if key in value:
            _validate_task_state_shape(value[key], child_shape, f"document.{key}", path, root)


def _task_paths_overlap(left: str, right: str) -> bool:
    """Return whether two path entries can name the same input.

    Intersecting two independent glob languages needs a solver.  Until one is
    available, treating glob/glob pairs as overlapping keeps the validator
    fail-closed while preserving the existing literal and literal/glob rules.
    Non-canonical repository paths are also treated as overlapping so a second
    spelling cannot evade the self-reference check.
    """

    def canonical(value: str) -> str | None:
        if value != value.strip() or value.startswith("/") or "\\" in value:
            return None
        parts = value.split("/")
        if not value or any(part in {"", ".", ".."} for part in parts):
            return None
        return value

    left_path, right_path = canonical(left), canonical(right)
    if left_path is None or right_path is None:
        return True
    glob_magic = frozenset("*?[")
    if any(char in glob_magic for char in left_path) and any(
        char in glob_magic for char in right_path
    ):
        return True
    return (
        left_path == right_path
        or fnmatchcase(left_path, right_path)
        or fnmatchcase(right_path, left_path)
    )


def validate_task_state(path: Path, root: Path = ROOT) -> None:
    """Validate one repository-owned, client-neutral task-state document."""

    raw = text(path)
    if len(raw.encode("utf-8")) > TASK_STATE_MAX_BYTES:
        fail(f"{rel(path, root)} task-state exceeds UTF-8 size bound")
    try:
        state = json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"{rel(path, root)} task-state is not valid JSON: {error.msg}")
    _validate_task_state_document(state, path, root)
    if state["schema"] != TASK_STATE_SCHEMA:
        fail(f"{rel(path, root)} task-state has unknown schema: {state['schema']}")
    if state["status"] not in TASK_STATE_STATUSES:
        fail(f"{rel(path, root)} task-state has unknown status: {state['status']}")
    measurement = state.get("measurement")
    publication = state.get("publication")
    if measurement is not None and publication is not None:
        overlaps = [
            (measurement_path, annotation_path)
            for measurement_path in measurement["input_paths"]
            for annotation_path in publication["annotation_paths"]
            if _task_paths_overlap(measurement_path, annotation_path)
        ]
        if overlaps:
            measurement_path, annotation_path = overlaps[0]
            fail(
                f"{rel(path, root)} task-state measurement/publication self-reference: "
                f"{measurement_path!r} overlaps {annotation_path!r}"
            )
    if state["completed_evidence"]:
        closure = state["input_closure"]
        if not closure["paths"] or not closure["conditions"]:
            fail(f"{rel(path, root)} completed evidence requires paths and conditions in input closure")
        artifacts = closure["artifacts"]
        for entry in state["completed_evidence"]:
            reference = entry["artifact_reference"]
            if reference is not None and reference not in artifacts:
                fail(f"{rel(path, root)} completed evidence has an external artifact reference")
    completed_gates = {entry["gate"] for entry in state["completed_evidence"]}
    invalidated_gates = {entry["gate"] for entry in state["invalidated_gates"]}
    if completed_gates & invalidated_gates:
        fail(f"{rel(path, root)} a gate cannot be completed and invalidated")
    blockers = state["risks_blockers"]["blockers"]
    status = state["status"]
    if status in {"planned", "running", "partial"} and not state["remaining_work"]:
        fail(f"{rel(path, root)} active task-state requires remaining work")
    if status == "complete" and (
        state["remaining_work"] or state["invalidated_gates"] or blockers
    ):
        fail(f"{rel(path, root)} complete task-state must have no remaining work, invalidated gates, or blockers")
    if status == "complete" and (
        not state["completed_evidence"]
        or any(entry["result"] != "pass" for entry in state["completed_evidence"])
    ):
        fail(f"{rel(path, root)} complete task-state requires only passing evidence")
    if status == "blocked" and not blockers:
        fail(f"{rel(path, root)} blocked task-state requires a blocker")
    for entry in state["completed_evidence"]:
        if entry["result"] not in TASK_STATE_RESULTS:
            fail(f"{rel(path, root)} task-state has unknown evidence result: {entry['result']}")


def budget(path: Path, root: Path, kind: str) -> None:
    require_file(path, root)
    raw = path.read_bytes()
    lines, bytes_limit = LIMITS[kind]
    try:
        count = len(raw.decode("utf-8").splitlines())
    except UnicodeDecodeError as error:
        fail(f"{rel(path, root)} is not UTF-8: {error}")
    if count > lines:
        fail(f"{rel(path, root)} exceeds {lines} lines: {count}")
    if len(raw) > bytes_limit:
        fail(f"{rel(path, root)} exceeds {bytes_limit} bytes: {len(raw)}")


def load_frontmatter(path: Path, root: Path) -> dict[str, Any]:
    lines = text(path).splitlines()
    if not lines or lines[0].strip() != "---":
        fail(f"{rel(path, root)} frontmatter must start on the first line")
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration as error:
        fail(f"{rel(path, root)} frontmatter closing delimiter is missing")
        raise AssertionError from error
    try:
        value = yaml.load("\n".join(lines[1:end]), Loader=UniqueKeyLoader)
    except (yaml.YAMLError, GovernanceError) as error:
        fail(f"{rel(path, root)} invalid frontmatter: {error}")
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        fail(f"{rel(path, root)} frontmatter must be a string-keyed mapping")
    return value


def required_string(data: dict[str, Any], key: str, path: Path, root: Path) -> None:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        fail(f"{rel(path, root)} frontmatter {key} must be a non-empty string")


def validate_frontmatter(path: Path, root: Path) -> dict[str, Any]:
    data = load_frontmatter(path, root)
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        fail(f"frontmatter path is outside repository: {path}")
        raise AssertionError from error
    if len(parts) >= 3 and parts[:2] in ((".agents", "skills"), (".claude", "skills")):
        required_string(data, "name", path, root)
        required_string(data, "description", path, root)
        if SKILL_NAME.fullmatch(data["name"]) is None:
            fail(f"{rel(path, root)} frontmatter name is not kebab-case")
    elif len(parts) >= 3 and parts[:2] == (".claude", "rules"):
        values = data.get("paths")
        if not isinstance(values, list) or not values or any(not isinstance(item, str) or not item.strip() for item in values):
            fail(f"{rel(path, root)} frontmatter paths must be a non-empty string list")
    elif len(parts) >= 3 and parts[:2] == (".cursor", "rules"):
        required_string(data, "description", path, root)
        globs = data.get("globs")
        if not ((isinstance(globs, str) and globs.strip()) or (isinstance(globs, list) and globs and all(isinstance(item, str) and item.strip() for item in globs))):
            fail(f"{rel(path, root)} frontmatter globs must be a non-empty string or list")
        if data.get("alwaysApply") is not False:
            fail(f"{rel(path, root)} frontmatter alwaysApply must be false")
    else:
        fail(f"cannot infer frontmatter kind for {rel(path, root)}")
    return data


def markdown_targets(
    path: Path, root: Path, *, include_images: bool = True
) -> Iterable[Path]:
    for token in MarkdownIt("commonmark").parse(text(path)):
        if token.type != "inline":
            continue
        for child in token.children or []:
            if child.type == "link_open":
                raw = child.attrGet("href")
            elif include_images and child.type == "image":
                raw = child.attrGet("src")
            else:
                continue
            if not raw:
                continue
            parsed = urlsplit(unquote(raw.strip()))
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            candidate = (root / parsed.path.lstrip("/") if parsed.path.startswith("/") else path.parent / parsed.path).resolve()
            try:
                candidate.relative_to(root.resolve())
            except ValueError:
                fail(f"{rel(path, root)} link escapes repository: {parsed.path}")
            yield candidate


def _collect_skill_identities(
    paths: Iterable[Path], root: Path, kind: str, budget_kind: str
) -> dict[str, Path]:
    records: list[tuple[Path, str]] = []
    for path in paths:
        budget(path, root, budget_kind)
        data = validate_frontmatter(path, root)
        records.append((path, data["name"]))

    identities: dict[str, Path] = {}
    for path, name in records:
        if name in identities:
            fail(
                f"duplicate {kind} frontmatter name {name!r}: "
                f"{rel(identities[name], root)} and {rel(path, root)}"
            )
        identities[name] = path

    for path, name in records:
        if name != path.parent.name:
            fail(
                f"{rel(path, root)} frontmatter name must match its directory: "
                f"{name!r} != {path.parent.name!r}"
            )
    return identities


def validate_links(paths: Iterable[Path], root: Path) -> None:
    pending = list(paths)
    visited: set[Path] = set()
    while pending:
        path = pending.pop()
        if path in visited or not path.is_file():
            continue
        visited.add(path)
        for candidate in markdown_targets(path, root):
            if not candidate.exists():
                fail(f"{rel(path, root)} has a broken local link: {rel(candidate, root)}")
            if candidate.suffix.lower() in {".md", ".mdc", ".markdown"}:
                pending.append(candidate)


def discover_routers(root: Path) -> list[Path]:
    excluded = {".git", ".venv", "node_modules", ".external"}
    return sorted(path for path in root.rglob("AGENTS.md") if not excluded.intersection(path.relative_to(root).parts))


def validate_skills(root: Path, routers: list[Path]) -> tuple[int, int, int]:
    canonical = sorted((root / ".agents/skills").glob("*/SKILL.md"))
    adapters = sorted((root / ".claude/skills").glob("*/SKILL.md"))
    if not canonical:
        fail("no canonical task Skills found")
    canonical_identities = _collect_skill_identities(canonical, root, "canonical Skill", "skill")
    adapter_identities = _collect_skill_identities(adapters, root, "Claude adapter", "adapter")
    if set(canonical_identities) != set(adapter_identities):
        missing = sorted(set(canonical_identities) - set(adapter_identities))
        orphan = sorted(set(adapter_identities) - set(canonical_identities))
        details = []
        if missing:
            details.append(f"missing adapters: {', '.join(missing)}")
        if orphan:
            details.append(f"orphan adapters: {', '.join(orphan)}")
        suffix = f": {'; '.join(details)}" if details else ""
        fail(f"canonical Skills and Claude adapters must have the same names{suffix}")
    targets = {
        candidate
        for router in routers
        for candidate in markdown_targets(router, root, include_images=False)
    }
    for skill in canonical:
        if skill.resolve() not in targets:
            fail(f"an AGENTS.md must link to {rel(skill, root)}")
        adapter = adapter_identities[skill.parent.name]
        if skill.resolve() not in set(
            markdown_targets(adapter, root, include_images=False)
        ):
            fail(f"{rel(adapter, root)} must link to {rel(skill, root)}")
    return len(canonical), len(adapters), len(routers)


def validate_repository(root: Path) -> tuple[int, int, int]:
    files = [root / path for path in REQUIRED_FILES]
    rules = [root / path for path in REQUIRED_RULES]
    for path in files + rules:
        require_file(path, root)
    budget(root / "AGENTS.md", root, "root")
    root_bytes = (root / "AGENTS.md").stat().st_size
    routers = discover_routers(root)
    for router in routers:
        if router != root / "AGENTS.md":
            budget(router, root, "nested")
            combined = root_bytes + router.stat().st_size
            if combined > COMBINED_ROUTER_BYTES:
                fail(
                    f"{rel(router, root)} with AGENTS.md exceeds "
                    f"{COMBINED_ROUTER_BYTES} bytes: {combined}"
                )
    for rule in rules:
        budget(rule, root, "adapter")
        validate_frontmatter(rule, root)
    if text(root / "CLAUDE.md").strip() != "@AGENTS.md":
        fail("CLAUDE.md must contain only @AGENTS.md")
    validate_task_state(root / TASK_STATE_TEMPLATE, root)
    counts = validate_skills(root, routers)
    canonical = sorted((root / ".agents/skills").glob("*/SKILL.md"))
    adapters = sorted((root / ".claude/skills").glob("*/SKILL.md"))
    validate_links([*files, *rules, *routers, *canonical, *adapters], root)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        counts = validate_repository(args.root.resolve())
    except (OSError, GovernanceError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"Governance verification: PASS ({counts[0]} Skills, {counts[1]} adapters, {counts[2]} routers)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
