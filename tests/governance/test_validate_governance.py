from __future__ import annotations

from pathlib import Path

import pytest

from scripts.validate_governance import (
    ROOT,
    GovernanceError,
    PR_MONITOR_LIGHTWEIGHT_KEY_FIELDS,
    decide_pr_monitor_run,
    markdown_targets,
    validate_pr_monitor_lightweight_key,
    validate_links,
    validate_skills,
)


def _write_skill(
    root: Path,
    tree: str,
    directory: str,
    *,
    name: str | None = None,
    body: str = "",
) -> Path:
    path = root / tree / directory / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"name: {name or directory}\n"
        "description: synthetic governance fixture\n"
        "---\n"
        f"{body}",
        encoding="utf-8",
    )
    return path


def _skill_tree(
    root: Path,
    *,
    canonical: dict[str, str] | None = None,
    adapters: dict[str, str] | None = None,
    router_content: str | None = None,
    adapter_bodies: dict[str, str] | None = None,
) -> tuple[Path, Path]:
    canonical = canonical or {"sample": "sample"}
    adapters = adapters or {directory: directory for directory in canonical}
    for directory, name in canonical.items():
        _write_skill(root, ".agents/skills", directory, name=name)
    for directory, name in adapters.items():
        body = (adapter_bodies or {}).get(
            directory,
            f"[canonical](../../../.agents/skills/{directory}/SKILL.md)\n",
        )
        _write_skill(root, ".claude/skills", directory, name=name, body=body)

    router = root / "AGENTS.md"
    if router_content is None:
        router_content = "\n".join(
            f"[{directory}](.agents/skills/{directory}/SKILL.md)"
            for directory in canonical
        ) + "\n"
    router.write_text(router_content, encoding="utf-8")
    return root, router


def test_validate_skills_accepts_matching_identity_and_rendered_links(tmp_path: Path) -> None:
    root, router = _skill_tree(tmp_path)

    assert validate_skills(root, [router]) == (1, 1, 1)


@pytest.mark.parametrize("side", ["canonical", "adapter"])
def test_validate_skills_rejects_name_that_differs_from_directory(
    tmp_path: Path, side: str
) -> None:
    kwargs: dict[str, object] = {}
    if side == "canonical":
        kwargs["canonical"] = {"sample": "other"}
    else:
        kwargs["adapters"] = {"sample": "other"}
    root, router = _skill_tree(tmp_path, **kwargs)

    with pytest.raises(GovernanceError, match="must match its directory"):
        validate_skills(root, [router])


@pytest.mark.parametrize("side", ["canonical", "adapter"])
def test_validate_skills_rejects_duplicate_frontmatter_names(
    tmp_path: Path, side: str
) -> None:
    kwargs: dict[str, object] = {}
    if side == "canonical":
        kwargs["canonical"] = {"alpha": "same", "beta": "same"}
    else:
        kwargs["canonical"] = {"alpha": "alpha", "beta": "beta"}
        kwargs["adapters"] = {"alpha": "same", "beta": "same"}
    root, router = _skill_tree(tmp_path, **kwargs)

    with pytest.raises(GovernanceError, match="duplicate .*frontmatter name"):
        validate_skills(root, [router])


@pytest.mark.parametrize(
    "canonical,adapters,message",
    [
        (
            {"sample": "sample", "other": "other"},
            {"sample": "sample"},
            "missing adapters: other",
        ),
        (
            {"sample": "sample"},
            {"sample": "sample", "orphan": "orphan"},
            "orphan adapters: orphan",
        ),
    ],
)
def test_validate_skills_requires_matching_canonical_and_adapter_names(
    tmp_path: Path,
    canonical: dict[str, str],
    adapters: dict[str, str],
    message: str,
) -> None:
    root, router = _skill_tree(
        tmp_path,
        canonical=canonical,
        adapters=adapters,
    )

    with pytest.raises(GovernanceError, match=message):
        validate_skills(root, [router])


@pytest.mark.parametrize(
    "surface,content",
    [
        ("inline", "`[sample]({target})`\n"),
        ("indented", "    [sample]({target})\n"),
        ("fence", "````md\n[sample]({target})\n````\n"),
        ("comment", "<!-- [sample]({target}) -->\n"),
        ("router_image", "![sample]({target})\n"),
        ("adapter", "![sample]({target})\n"),
    ],
)
def test_validate_skills_requires_rendered_markdown_link(
    tmp_path: Path, surface: str, content: str
) -> None:
    target = ".agents/skills/sample/SKILL.md"
    router_content = content.format(target=target)
    adapter_bodies = None
    if surface == "adapter":
        router_content = f"[sample]({target})\n"
        adapter_bodies = {
            "sample": content.format(
                target="../../../.agents/skills/sample/SKILL.md"
            )
        }
    root, router = _skill_tree(
        tmp_path,
        router_content=router_content,
        adapter_bodies=adapter_bodies,
    )

    with pytest.raises(GovernanceError, match="must link"):
        validate_skills(root, [router])


@pytest.mark.parametrize(
    "content",
    [
        f"{chr(96)}[sample]({{target}}){chr(96)}\n",
        "    [sample]({target})\n",
        f"{chr(96) * 4}md\n[sample]({{target}})\n{chr(96) * 4}\n",
        "<!-- [sample]({target}) -->\n",
    ],
)
def test_validate_skills_requires_rendered_link_in_adapter(
    tmp_path: Path, content: str
) -> None:
    target = "../../../.agents/skills/sample/SKILL.md"
    root, router = _skill_tree(
        tmp_path,
        router_content="[sample](.agents/skills/sample/SKILL.md)\n",
        adapter_bodies={"sample": content.format(target=target)},
    )

    with pytest.raises(GovernanceError, match="must link"):
        validate_skills(root, [router])


def test_markdown_targets_can_exclude_images_for_reachability(tmp_path: Path) -> None:
    source = tmp_path / "AGENTS.md"
    source.write_text("[doc](linked.md)\n![asset](asset.png)\n", encoding="utf-8")

    link_only = set(markdown_targets(source, tmp_path, include_images=False))
    all_targets = set(markdown_targets(source, tmp_path))

    assert link_only == {(tmp_path / "linked.md").resolve()}
    assert all_targets == {
        (tmp_path / "linked.md").resolve(),
        (tmp_path / "asset.png").resolve(),
    }


@pytest.mark.parametrize("href", ["./references/missing.md", "../missing.md"])
def test_validate_links_rejects_broken_relative_local_targets(
    tmp_path: Path, href: str
) -> None:
    skill = _write_skill(
        tmp_path,
        ".agents/skills",
        "sample",
        body=f"[missing]({href})\n",
    )

    with pytest.raises(GovernanceError, match="broken local link"):
        validate_links([skill], tmp_path)


def test_validate_links_accepts_existing_peer_skill_with_parent_reference(
    tmp_path: Path,
) -> None:
    _write_skill(tmp_path, ".agents/skills", "peer")
    sample = _write_skill(
        tmp_path,
        ".agents/skills",
        "sample",
        body="[peer](../peer/SKILL.md)\n",
    )

    validate_links([sample], tmp_path)


def test_validate_links_still_checks_broken_image_targets(tmp_path: Path) -> None:
    source = tmp_path / "AGENTS.md"
    source.write_text("![missing](missing.png)\n", encoding="utf-8")

    with pytest.raises(GovernanceError, match="broken local link"):
        validate_links([source], tmp_path)


def test_validate_pr_monitor_lightweight_key_accepts_all_required_fields() -> None:
    validate_pr_monitor_lightweight_key(
        {field: None for field in PR_MONITOR_LIGHTWEIGHT_KEY_FIELDS}
    )


def test_validate_pr_monitor_lightweight_key_rejects_missing_state() -> None:
    key = {
        field: None
        for field in PR_MONITOR_LIGHTWEIGHT_KEY_FIELDS
        if field != "state"
    }

    with pytest.raises(GovernanceError, match=r"missing=\['state'\]"):
        validate_pr_monitor_lightweight_key(key)


def test_validate_pr_monitor_lightweight_key_rejects_unknown_fields() -> None:
    key = {field: None for field in PR_MONITOR_LIGHTWEIGHT_KEY_FIELDS}
    key["unexpected"] = None

    with pytest.raises(GovernanceError, match=r"unknown=\['unexpected'\]"):
        validate_pr_monitor_lightweight_key(key)


@pytest.mark.parametrize("state", ["MERGED", "CLOSED"])
def test_decide_pr_monitor_run_deletes_terminal_task_without_details(state: str) -> None:
    decision = decide_pr_monitor_run(
        state,
        state_key_changed=True,
        reassessment_checkpoint_due=True,
        monitoring_still_needed=False,
        merge_state_status="UNKNOWN",
        review_decision="",
    )

    assert decision == {
        "task_action": "delete",
        "details": False,
        "wait": None,
        "notify": False,
        "stop_reason": "terminal_state",
        "unverified_scope": None,
    }


def test_decide_pr_monitor_run_refreshes_details_when_open_key_changes() -> None:
    assert decide_pr_monitor_run("OPEN", True, False, True) == {
        "task_action": "retain",
        "details": True,
        "wait": None,
        "notify": False,
        "stop_reason": None,
        "unverified_scope": None,
    }


def test_decide_pr_monitor_run_waits_with_event_or_backoff_when_unchanged() -> None:
    assert decide_pr_monitor_run("OPEN", False, False, True) == {
        "task_action": "retain",
        "details": False,
        "wait": "event/backoff",
        "notify": False,
        "stop_reason": None,
        "unverified_scope": None,
    }


def test_decide_pr_monitor_run_keeps_waiting_when_due_but_monitoring_is_needed() -> None:
    assert decide_pr_monitor_run("OPEN", False, True, True) == {
        "task_action": "retain",
        "details": False,
        "wait": "event/backoff",
        "notify": False,
        "stop_reason": None,
        "unverified_scope": None,
    }


def test_decide_pr_monitor_run_stops_and_notifies_when_monitoring_is_unneeded() -> None:
    assert decide_pr_monitor_run("OPEN", False, True, False) == {
        "task_action": "stop",
        "details": False,
        "wait": None,
        "notify": True,
        "stop_reason": "monitoring_not_needed",
        "unverified_scope": "external_wait",
    }


@pytest.mark.parametrize("state", ["", "UNKNOWN", "MERGED "])
def test_decide_pr_monitor_run_rejects_unknown_or_empty_state(state: str) -> None:
    with pytest.raises(GovernanceError, match="unknown PR monitor state"):
        decide_pr_monitor_run(state, False, False, True)


@pytest.mark.parametrize("monitoring_still_needed", [None, "yes"])
def test_decide_pr_monitor_run_rejects_non_boolean_reassessment_decision(
    monitoring_still_needed: object,
) -> None:
    with pytest.raises(GovernanceError, match="monitoring_still_needed must be a boolean"):
        decide_pr_monitor_run("OPEN", False, True, monitoring_still_needed)  # type: ignore[arg-type]

from scripts.validate_governance import validate_repository


def test_repository_governance_surface_is_valid() -> None:
    canonical, adapters, routers = validate_repository(ROOT)
    assert canonical == adapters == 3
    assert routers >= 1
