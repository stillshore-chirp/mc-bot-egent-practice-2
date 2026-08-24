#!/usr/bin/env python3
"""Validate agent frontmatter and repository harness structure."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Iterable
from urllib.parse import quote, unquote

try:
    import yaml
    from markdown_it import MarkdownIt
    from markdown_it.token import Token
except ModuleNotFoundError as exc:  # pragma: no cover - environment guard
    raise SystemExit(
        "ERROR: agent harness dependencies are required; run "
        "`python3 -m pip install -r requirements-agent-harness.txt`"
    ) from exc


class ValidationError(ValueError):
    """Raised when an agent harness contract is invalid."""


HARNESS_DOCUMENTS = (
    "docs/agent-harness.md",
    "docs/agent-principles.md",
    "docs/documentation-structure.md",
    "docs/security-publication-checklist.md",
    "docs/ai-governance/03-evidence-and-completion-gates.md",
    "docs/ai-governance/13-maintenance-policy.md",
    "docs/ai-governance/14-issue-quality-gate.md",
)

MARKDOWN_PARSER = MarkdownIt("commonmark", {"html": True})


class UniqueKeySafeLoader(yaml.SafeLoader):
    """SafeLoader variant that rejects duplicate mapping keys."""


class UniqueKeyBaseLoader(yaml.BaseLoader):
    """BaseLoader variant that preserves workflow keys such as `on`."""


def _construct_unique_mapping(
    loader: yaml.Loader,
    node: yaml.nodes.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ValidationError(f"duplicate YAML key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


for loader_type in (UniqueKeySafeLoader, UniqueKeyBaseLoader):
    loader_type.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
        _construct_unique_mapping,
    )


def _fail(path: Path, message: str) -> ValidationError:
    return ValidationError(f"{path}: {message}")


def _relative(path: Path, root: Path) -> Path:
    try:
        return path.resolve().relative_to(root.resolve())
    except ValueError:
        return path


def load_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise _fail(path, "frontmatter must start on the first line")

    try:
        end = next(
            index for index in range(1, len(lines)) if lines[index].strip() == "---"
        )
    except StopIteration as exc:
        raise _fail(path, "frontmatter closing delimiter is missing") from exc

    raw = "\n".join(lines[1:end])
    try:
        data = yaml.load(raw, Loader=UniqueKeySafeLoader)
    except (yaml.YAMLError, ValidationError) as exc:
        raise _fail(path, f"invalid YAML frontmatter: {exc}") from exc

    if not isinstance(data, dict):
        raise _fail(path, "frontmatter must be a YAML mapping")
    if any(not isinstance(key, str) for key in data):
        raise _fail(path, "frontmatter keys must be strings")

    body = "\n".join(lines[end + 1 :]).strip()
    if not body:
        raise _fail(path, "body must not be empty")
    return data, body


def _require_string(data: dict[str, Any], key: str, path: Path) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise _fail(path, f"{key} must be a non-empty string")
    return value


def _require_exact_keys(data: dict[str, Any], keys: set[str], path: Path) -> None:
    actual = set(data)
    if actual != keys:
        raise _fail(path, f"frontmatter keys must be {sorted(keys)}, got {sorted(actual)}")


def validate_skill(
    data: dict[str, Any], path: Path, *, thin_adapter: bool = False
) -> None:
    required = {"name", "description"}
    if not required.issubset(data):
        raise _fail(path, f"frontmatter must include {sorted(required)}")
    if thin_adapter:
        _require_exact_keys(data, required, path)
    name = _require_string(data, "name", path)
    _require_string(data, "description", path)
    if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) is None:
        raise _fail(path, "name must be lowercase kebab-case")
    if path.parent.name != name:
        raise _fail(path, f"name must match parent directory {path.parent.name!r}")


def validate_claude_rule(data: dict[str, Any], path: Path) -> None:
    paths = data.get("paths")
    if "paths" in data and (
        not isinstance(paths, list)
        or not paths
        or any(not isinstance(item, str) or not item.strip() for item in paths)
    ):
        raise _fail(path, "paths must be a non-empty list of strings when provided")


def validate_cursor_rule(data: dict[str, Any], path: Path) -> None:
    _require_string(data, "description", path)
    globs = data.get("globs")
    if "globs" in data:
        valid_globs = isinstance(globs, str) and bool(globs.strip())
        valid_globs = valid_globs or (
            isinstance(globs, list)
            and bool(globs)
            and all(isinstance(item, str) and item.strip() for item in globs)
        )
        if not valid_globs:
            raise _fail(path, "globs must be a non-empty string or list of strings")
    if not isinstance(data.get("alwaysApply"), bool):
        raise _fail(path, "alwaysApply must be a YAML boolean")


def infer_kind(path: Path, root: Path) -> str:
    relative = _relative(path, root).as_posix()
    if relative.startswith(".claude/rules/"):
        return "claude-rule"
    if relative.startswith(".cursor/rules/"):
        return "cursor-rule"
    if path.name == "SKILL.md" and (
        relative.startswith(".agents/skills/")
        or relative.startswith(".claude/skills/")
    ):
        return "skill"
    raise _fail(path, "cannot infer agent frontmatter kind")


def validate_path(path: Path, root: Path) -> None:
    relative = _relative(path, root).as_posix()
    kind = infer_kind(path, root)
    text = path.read_text(encoding="utf-8")
    managed_claude_adapter = (
        relative == ".claude/rules/agent-harness.md"
        or relative.startswith(".claude/rules/nested-agents-")
    )
    if kind == "claude-rule" and not text.startswith("---\n"):
        if managed_claude_adapter:
            raise _fail(path, "managed Claude adapter requires frontmatter")
        if not text.strip():
            raise _fail(path, "rule body must not be empty")
        return

    data, _ = load_frontmatter(path)
    if kind == "skill":
        validate_skill(
            data,
            path,
            thin_adapter=relative.startswith(".claude/skills/"),
        )
        return
    validators = {
        "claude-rule": validate_claude_rule,
        "cursor-rule": validate_cursor_rule,
    }
    validators[kind](data, path)


def discover_agent_files(root: Path) -> list[Path]:
    patterns = (
        ".agents/skills/**/SKILL.md",
        ".claude/skills/**/SKILL.md",
        ".claude/rules/**/*.md",
        ".cursor/rules/**/*.mdc",
    )
    return sorted({path for pattern in patterns for path in root.glob(pattern)})


def validate_instruction_budgets(root: Path, agent_files: Iterable[Path]) -> None:
    limits = {"root": (180, 16384), "skill": (180, 16384), "adapter": (30, 4096)}
    targets: list[tuple[Path, str]] = [(root / "AGENTS.md", "root")]
    for path in agent_files:
        relative = path.relative_to(root).as_posix()
        category = "skill" if relative.startswith(".agents/skills/") else "adapter"
        targets.append((path, category))

    for path, category in targets:
        max_lines, max_bytes = limits[category]
        raw = path.read_bytes()
        lines = len(raw.decode("utf-8").splitlines())
        if lines > max_lines or len(raw) > max_bytes:
            raise _fail(
                path,
                f"instruction budget exceeded: {lines}/{max_lines} lines, "
                f"{len(raw)}/{max_bytes} bytes",
            )


def validate_skill_layout(root: Path, agent_files: Iterable[Path]) -> None:
    for path in agent_files:
        relative = path.relative_to(root)
        if path.name != "SKILL.md":
            continue
        if relative.parts[:2] in {(".agents", "skills"), (".claude", "skills")}:
            if len(relative.parts) != 4:
                raise _fail(path, "Skill must be exactly one directory below skills/")


def _repository_files(root: Path) -> Iterable[Path]:
    """Return tracked and non-ignored untracked files without scanning build output."""
    try:
        output = subprocess.check_output(
            [
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            cwd=root,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise ValidationError("git ls-files failed while discovering repository files") from exc

    for encoded in output.split(b"\0"):
        if not encoded:
            continue
        try:
            relative = Path(encoded.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ValidationError("repository file names must be valid UTF-8") from exc
        path = root / relative
        if path.is_file():
            yield path


def _harness_files(root: Path) -> Iterable[Path]:
    exact = {
        "README.md",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        *HARNESS_DOCUMENTS,
        "requirements-agent-harness.txt",
        "scripts/validate_agent_frontmatter.py",
        "scripts/verify-agent-harness.sh",
        ".github/ISSUE_TEMPLATE/feature.md",
        ".github/pull_request_template.md",
        ".github/workflows/agent-harness.yml",
    }
    for path in _repository_files(root):
        relative = path.relative_to(root).as_posix()
        if (
            relative in exact
            or (path.name == "AGENTS.md" and path.parent != root)
            or relative.startswith((".agents/", ".claude/", ".cursor/"))
            or relative.startswith("docs/ai-governance/")
        ):
            yield path


def _text_files(root: Path) -> Iterable[Path]:
    suffixes = {".md", ".mdc", ".py", ".sh", ".yml", ".yaml", ".txt"}
    for path in _harness_files(root):
        if path.suffix in suffixes:
            yield path


def validate_text_hygiene(root: Path) -> None:
    invisible_controls = {
        "\ufeff",  # byte-order mark
        "\u200b",  # zero-width space
        "\u200c",  # zero-width non-joiner
        "\u200d",  # zero-width joiner
        "\u2060",  # word joiner
        *map(chr, range(0x202A, 0x202F)),  # bidirectional formatting controls
        *map(chr, range(0x2066, 0x206A)),  # bidirectional isolates
    }
    for path in _text_files(root):
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _fail(path, f"must be valid UTF-8: {exc}") from exc
        if raw and not raw.endswith(b"\n"):
            raise _fail(path, "must end with a newline")
        if found := sorted({character for character in text if character in invisible_controls}):
            codepoints = ", ".join(f"U+{ord(character):04X}" for character in found)
            raise _fail(path, f"contains invisible Unicode control: {codepoints}")
        for line_number, line in enumerate(text.splitlines(), start=1):
            if line != line.rstrip(" \t"):
                raise _fail(path, f"trailing whitespace on line {line_number}")


def _markdown_targets(text: str) -> Iterable[str]:
    environment: dict[str, Any] = {}
    tokens = MARKDOWN_PARSER.parse(text, environment)
    for reference in environment.get("references", {}).values():
        target = reference.get("href")
        if isinstance(target, str) and target:
            yield target
    for token in tokens:
        for child in token.children or []:
            attribute = (
                "href"
                if child.type == "link_open"
                else "src" if child.type == "image" else None
            )
            if attribute and (target := child.attrGet(attribute)):
                yield target


def _assert_exact_case(root: Path, relative: Path, source: Path) -> None:
    current = root
    for part in relative.parts:
        names = {entry.name for entry in current.iterdir()}
        if part not in names:
            raise _fail(source, f"link target has wrong case or is missing: {relative}")
        current = current / part


def _inline_visible_text(tokens: Iterable[Token]) -> str:
    visible: list[str] = []
    for child in tokens:
        if child.type in {"text", "text_special", "code_inline"}:
            visible.append(child.content)
        elif child.type in {"softbreak", "hardbreak"}:
            visible.append(" ")
        elif child.type == "image":
            visible.append(_inline_visible_text(child.children or []))
    return "".join(visible)


def _heading_text(token: Token) -> str:
    return _inline_visible_text(token.children or [])


def _markdown_anchors(text: str) -> set[str]:
    anchors: set[str] = set()
    tokens = MARKDOWN_PARSER.parse(text)
    for index, token in enumerate(tokens[:-1]):
        if token.type != "heading_open" or tokens[index + 1].type != "inline":
            continue
        heading = _heading_text(tokens[index + 1]).lower()
        heading = "".join(
            character
            for character in heading
            if character.isalnum() or character in {" ", "-", "_"}
        )
        base = heading.strip().replace(" ", "-")
        if not base:
            continue
        candidate = base
        suffix = 0
        while candidate in anchors:
            suffix += 1
            candidate = f"{base}-{suffix}"
        anchors.add(candidate)
    return anchors


def validate_markdown_links(root: Path) -> None:
    paths = [path for path in _harness_files(root) if path.suffix in {".md", ".mdc"}]
    for path in sorted(paths):
        text = path.read_text(encoding="utf-8")
        for target in _markdown_targets(text):
            if target.casefold().startswith(("http://", "https://", "mailto:")):
                continue
            path_part, _, fragment = target.partition("#")
            clean = unquote(path_part.split("?", 1)[0])
            candidate = path.resolve() if not clean else (path.parent / clean).resolve()
            try:
                relative = candidate.relative_to(root.resolve())
            except ValueError as exc:
                raise _fail(path, f"link escapes repository: {target}") from exc
            if not candidate.exists():
                raise _fail(path, f"relative link target is missing: {target}")
            _assert_exact_case(root.resolve(), relative, path)
            if fragment and candidate.suffix in {".md", ".mdc"}:
                anchor = unquote(fragment).lower()
                anchors = _markdown_anchors(candidate.read_text(encoding="utf-8"))
                if anchor not in anchors:
                    raise _fail(path, f"Markdown anchor is missing: {target}")


def validate_yaml_files(root: Path) -> None:
    repository_files = list(_harness_files(root))
    for path in sorted(
        path for path in repository_files if path.suffix in {".yml", ".yaml"}
    ):
        try:
            list(
                yaml.load_all(
                    path.read_text(encoding="utf-8"),
                    Loader=UniqueKeyBaseLoader,
                )
            )
        except (yaml.YAMLError, ValidationError) as exc:
            raise _fail(path, f"invalid YAML: {exc}") from exc

    issue_root = root / ".github/ISSUE_TEMPLATE"
    for path in sorted(
        path
        for path in repository_files
        if path == issue_root / "feature.md"
    ):
        data, body = load_frontmatter(path)
        required = {"name", "about", "title", "labels", "assignees"}
        if set(data) != required:
            raise _fail(path, f"Issue template keys must be {sorted(required)}")
        for key in required:
            if not isinstance(data[key], str):
                raise _fail(path, f"{key} must be a string")
        required_headings = {
            "## 背景と目的",
            "## 根拠と未確認事項",
            "## 現在と対応後",
            "## 対応範囲",
            "## 非対象",
            "## 受け入れ条件",
            "## 検証方法",
            "## 公開安全性",
            "## 未確認事項・残るリスク",
        }
        actual_headings = {
            line.strip() for line in body.splitlines() if line.startswith("## ")
        }
        missing = required_headings - actual_headings
        if missing:
            raise _fail(path, f"Issue template headings missing: {sorted(missing)}")


def _validate_workflow_path_patterns(
    path: Path,
    event: str,
    event_data: Any,
    required_paths: set[str],
) -> None:
    if not isinstance(event_data, dict):
        raise _fail(path, f"{event} trigger must be a mapping")
    expected_keys = {"paths"} if event == "push" else {"branches", "paths"}
    if set(event_data) != expected_keys:
        raise _fail(path, f"{event} keys must be exactly {sorted(expected_keys)}")
    path_patterns = event_data.get("paths", [])
    if not isinstance(path_patterns, list) or any(
        not isinstance(pattern, str) or not pattern
        for pattern in path_patterns
    ):
        raise _fail(path, f"{event}.paths must be a list of strings")
    if any(pattern.startswith("!") for pattern in path_patterns):
        raise _fail(path, f"{event}.paths must not contain negative patterns")
    missing = required_paths - set(path_patterns)
    if missing:
        raise _fail(path, f"{event}.paths missing {sorted(missing)}")


def validate_workflow(root: Path) -> None:
    path = root / ".github/workflows/agent-harness.yml"
    try:
        documents = list(
            yaml.load_all(
                path.read_text(encoding="utf-8"),
                Loader=UniqueKeyBaseLoader,
            )
        )
    except (yaml.YAMLError, ValidationError) as exc:
        raise _fail(path, f"invalid workflow YAML: {exc}") from exc
    if len(documents) != 1 or not isinstance(documents[0], dict):
        raise _fail(path, "workflow must be a single YAML mapping")
    data = documents[0]
    triggers = data.get("on", {})
    if not isinstance(triggers, dict) or "push" not in triggers or "pull_request" not in triggers:
        raise _fail(path, "workflow must define push and pull_request triggers")
    if "pull_request_target" in triggers:
        raise _fail(path, "pull_request_target is not allowed")
    pull_request = triggers["pull_request"]
    if not isinstance(pull_request, dict) or pull_request.get("branches") != ["main"]:
        raise _fail(path, "pull_request must target main")

    required_paths = {
        "README.md",
        ".gitignore",
        "AGENTS.md",
        "**/AGENTS.md",
        "CLAUDE.md",
        ".agents/**",
        ".claude/**",
        ".cursor/**",
        *(
            relative
            for relative in HARNESS_DOCUMENTS
            if not relative.startswith("docs/ai-governance/")
        ),
        "docs/ai-governance/**",
        "scripts/verify-agent-harness.sh",
        "scripts/validate_agent_frontmatter.py",
        "requirements-agent-harness.txt",
        ".github/ISSUE_TEMPLATE/feature.md",
        ".github/pull_request_template.md",
        ".github/workflows/agent-harness.yml",
    }
    for event in ("push", "pull_request"):
        _validate_workflow_path_patterns(
            path,
            event,
            triggers[event],
            required_paths,
        )

    permissions = data.get("permissions")
    if permissions != {"contents": "read"}:
        raise _fail(path, "workflow permissions must be contents: read only")

    jobs = data.get("jobs", {})
    verify = jobs.get("verify", {}) if isinstance(jobs, dict) else {}
    if not isinstance(verify, dict) or any(
        key in verify for key in ("if", "continue-on-error")
    ):
        raise _fail(path, "verify job must exist and must not be conditionally disabled")
    if verify.get("runs-on") != "ubuntu-latest" or verify.get("timeout-minutes") != "5":
        raise _fail(path, "verify job must use ubuntu-latest with a five-minute timeout")
    steps = verify.get("steps", []) if isinstance(verify, dict) else []
    if not isinstance(steps, list) or any(not isinstance(step, dict) for step in steps):
        raise _fail(path, "verify.steps must be a list of mappings")
    if any(any(key in step for key in ("if", "continue-on-error")) for step in steps):
        raise _fail(path, "verification steps must not be conditionally disabled")
    by_name = {step.get("name"): step for step in steps}
    if len(by_name) != len(steps) or None in by_name:
        raise _fail(path, "every verification step must have a unique name")

    checkout = by_name.get("Checkout repository", {})
    checkout_with = checkout.get("with", {}) if isinstance(checkout, dict) else {}
    if checkout.get("uses") != "actions/checkout@v7" or checkout_with != {
        "persist-credentials": "false"
    }:
        raise _fail(path, "checkout must use actions/checkout@v7 without credentials")

    setup = by_name.get("Set up Python", {})
    setup_with = setup.get("with", {}) if isinstance(setup, dict) else {}
    if setup.get("uses") != "actions/setup-python@v7" or setup_with != {
        "python-version": "3.14"
    }:
        raise _fail(path, "Python setup must use actions/setup-python@v7 and Python 3.14")

    expected_runs = {
        "Install validation dependencies": (
            "python -m pip install --disable-pip-version-check "
            "-r requirements-agent-harness.txt"
        ),
        "Install shellcheck": (
            "sudo apt-get update\n"
            "sudo apt-get install -y shellcheck"
        ),
        "Lint verification script": "shellcheck scripts/verify-agent-harness.sh",
        "Verify agent harness": "bash scripts/verify-agent-harness.sh",
    }
    for name, expected in expected_runs.items():
        step = by_name.get(name, {})
        if not isinstance(step, dict) or step.get("run", "").strip() != expected:
            raise _fail(path, f"workflow step must run the canonical command: {name}")

    syntax = by_name.get("Validate script syntax", {})
    syntax_commands = syntax.get("run", "").splitlines() if isinstance(syntax, dict) else []
    if syntax_commands != [
        "bash -n scripts/verify-agent-harness.sh",
        "python -m py_compile scripts/validate_agent_frontmatter.py",
    ]:
        raise _fail(path, "syntax step must run bash -n and Python py_compile")


def _bootstrap_source_files(root: Path) -> Iterable[Path]:
    text_suffixes = {".md", ".mdc", ".txt", ".yml", ".yaml"}
    exact = {
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        *HARNESS_DOCUMENTS,
        ".github/ISSUE_TEMPLATE/feature.md",
        ".github/pull_request_template.md",
        ".github/workflows/agent-harness.yml",
    }
    for path in _repository_files(root):
        relative = path.relative_to(root).as_posix()
        if path.suffix not in text_suffixes:
            continue
        if relative in exact or relative.startswith(
            (".agents/", ".claude/", ".cursor/")
        ) or (path.name == "AGENTS.md" and path.parent != root):
            yield path


def validate_source_specific_residue(root: Path) -> None:
    forbidden = (
        ("WordPack", r"(?<![0-9A-Za-z_-])wordpack(?![0-9A-Za-z_-])"),
        ("wordpack-for-english", r"wordpack-for-english"),
        ("mc-bot-egent-practice-1", r"mc-bot-egent-practice-1"),
    )
    for path in _bootstrap_source_files(root):
        text = path.read_text(encoding="utf-8").casefold()
        for term, pattern in forbidden:
            if re.search(pattern, text, re.IGNORECASE):
                raise _fail(path, f"source-specific term remains: {term}")


def validate_conflicting_instructions(root: Path) -> None:
    retired = (
        "指定がなければDraft",
        "通常はDraft",
        "Draftのみ",
        "下書きPR",
        "ドラフトPRのみ",
        "上記は参考情報",
        "この文は無効",
        "常にmerge",
        "コードレビュー往復は最大",
        "P0 または P1 を含まないレビュー結果が 3 回連続",
        "codex/<purpose>",
        "自己reviewで代替する",
        "mergeまで通常配送",
    )
    for path in _bootstrap_source_files(root):
        visible = path.read_text(encoding="utf-8")
        for phrase in retired:
            if phrase in visible:
                raise _fail(path, f"retired or conflicting instruction remains: {phrase}")


def _body_without_frontmatter(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if text.startswith("---\n"):
        _, text = text.split("\n---\n", 1)
    return text


def _normalize_paragraph(value: str) -> str:
    value = re.sub(r"\[[^\]]*\]\([^)]*\)", " ", value)
    value = re.sub(r"[`#>*_|-]", " ", value)
    value = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"\s+", " ", value).strip()


def validate_long_duplicates(root: Path) -> None:
    repository_files = list(_repository_files(root))
    canonical_documents = {
        root / relative for relative in HARNESS_DOCUMENTS
    } | {
        path
        for path in repository_files
        if path.suffix == ".md"
        and path.relative_to(root).as_posix().startswith("docs/ai-governance/")
    }
    canonical = [
        root / "README.md",
        root / "AGENTS.md",
        *sorted(
            path
            for path in repository_files
            if path.name == "AGENTS.md" and path.parent != root
        ),
        *sorted(canonical_documents),
        *sorted((root / ".agents/skills").glob("*/SKILL.md")),
    ]
    adapters = [
        *sorted((root / ".claude").rglob("*.md")),
        *sorted((root / ".cursor").rglob("*.mdc")),
    ]

    canonical_text = "\n".join(
        _normalize_paragraph(_body_without_frontmatter(path)) for path in canonical
    )
    for path in adapters:
        for paragraph in re.split(r"\n\s*\n", _body_without_frontmatter(path)):
            normalized = _normalize_paragraph(paragraph)
            if len(normalized) >= 160 and normalized in canonical_text:
                raise _fail(path, "adapter duplicates a long canonical paragraph")

    paragraph_owners: dict[str, set[Path]] = defaultdict(set)
    for path in canonical:
        for paragraph in re.split(r"\n\s*\n", _body_without_frontmatter(path)):
            normalized = _normalize_paragraph(paragraph)
            if len(normalized) >= 120:
                paragraph_owners[normalized].add(path)
    for paragraph, paths in paragraph_owners.items():
        if len(paths) > 1:
            print(
                "WARNING: repeated canonical paragraph requires human review: "
                + ", ".join(
                    str(_relative(path, root)) for path in sorted(paths)
                )
                + f" ({len(paragraph)} chars)",
                file=sys.stderr,
            )


def validate_adapter_mapping(root: Path) -> None:
    canonical_names = {
        path.parent.name for path in (root / ".agents/skills").glob("*/SKILL.md")
    }
    adapter_names = {
        path.parent.name for path in (root / ".claude/skills").glob("*/SKILL.md")
    }
    if canonical_names != adapter_names:
        raise ValidationError(
            "canonical and Claude Skill names must match: "
            f"canonical={sorted(canonical_names)}, adapters={sorted(adapter_names)}"
        )

    for name in canonical_names:
        path = root / f".claude/skills/{name}/SKILL.md"
        _, body = load_frontmatter(path)
        expected = f"../../../.agents/skills/{name}/SKILL.md"
        expected_body = (
            f"# {name} adapter\n\n"
            f"[共有Skill]({expected})を唯一の手順正本として適用します。"
        )
        if body != expected_body:
            raise _fail(path, "Skill adapter must contain only its canonical reference")

    required_scope = {
        "README.md",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/**/*",
        ".claude/**/*",
        ".cursor/**/*",
        "docs/agent-harness.md",
        "docs/agent-principles.md",
        "docs/documentation-structure.md",
        "docs/ai-governance/**/*",
        "docs/security-publication-checklist.md",
        "scripts/verify-agent-harness.sh",
        "scripts/validate_agent_frontmatter.py",
        "requirements-agent-harness.txt",
        ".github/ISSUE_TEMPLATE/feature.md",
        ".github/pull_request_template.md",
        ".github/workflows/agent-harness.yml",
    }
    claude_rule = root / ".claude/rules/agent-harness.md"
    claude_data, claude_body = load_frontmatter(claude_rule)
    claude_paths = claude_data.get("paths")
    if (
        set(claude_data) != {"paths"}
        or not isinstance(claude_paths, list)
        or set(claude_paths) != required_scope
    ):
        raise _fail(claude_rule, "paths must exactly match the harness surface")
    expected_claude_body = (
        "# Agent harness adapter\n\n"
        "エージェントルールを変更する時は、"
        "[`docs/agent-harness.md`](../../docs/agent-harness.md) と "
        "[`13-maintenance-policy.md`](../../docs/ai-governance/13-maintenance-policy.md) "
        "を正本として参照します。このadapterへ手順本文を複製しません。"
    )
    if claude_body != expected_claude_body:
        raise _fail(claude_rule, "body must contain only canonical routing text")

    cursor_rule = root / ".cursor/rules/agent-harness.mdc"
    cursor_data, cursor_body = load_frontmatter(cursor_rule)
    cursor_globs = cursor_data.get("globs")
    cursor_scope = (
        set(cursor_globs.split(",")) if isinstance(cursor_globs, str) else set()
    )
    cursor_expected = {
        "README.md",
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/**",
        ".claude/**",
        ".cursor/**",
        *(
            relative
            for relative in HARNESS_DOCUMENTS
            if not relative.startswith("docs/ai-governance/")
        ),
        "docs/ai-governance/**",
        "scripts/verify-agent-harness.sh",
        "scripts/validate_agent_frontmatter.py",
        "requirements-agent-harness.txt",
        ".github/ISSUE_TEMPLATE/feature.md",
        ".github/pull_request_template.md",
        ".github/workflows/agent-harness.yml",
    }
    expected_cursor_data = {
        "description": "エージェントハーネス変更時に3tool共通の保守正本へ接続するrouter",
        "globs": cursor_globs,
        "alwaysApply": False,
    }
    if (
        cursor_scope != cursor_expected
        or set(cursor_data) != {"description", "globs", "alwaysApply"}
        or cursor_data != expected_cursor_data
    ):
        raise _fail(cursor_rule, "globs must exactly match the harness surface")
    expected_cursor_body = (
        "# Agent harness adapter\n\n"
        "エージェントルールを変更する時は、"
        "[harness設計](../../docs/agent-harness.md) と "
        "[保守方針](../../docs/ai-governance/13-maintenance-policy.md) "
        "を正本として参照します。このadapterへ手順本文を複製しません。"
    )
    if cursor_body != expected_cursor_body:
        raise _fail(cursor_rule, "body must contain only canonical routing text")


def _nested_adapter_contract(
    root: Path, nested_agents: Path
) -> tuple[Path, dict[str, Any], Path, dict[str, Any], str]:
    scope = nested_agents.parent.relative_to(root).as_posix()
    unsupported = sorted(set(scope) & set("*?[]{}!,\\"))
    if unsupported:
        raise _fail(
            nested_agents,
            "nested scope contains unsupported glob metacharacters: "
            + ", ".join(repr(character) for character in unsupported),
        )
    scope_key = quote(scope, safe="")
    claude_adapter = root / f".claude/rules/nested-agents-{scope_key}.md"
    cursor_adapter = root / f".cursor/rules/nested-agents-{scope_key}.mdc"
    claude_data = {"paths": [f"{scope}/**/*"]}
    cursor_data = {
        "description": f"{scope}のnested AGENTS.mdへ接続するpath adapter",
        "globs": f"{scope}/**",
        "alwaysApply": False,
    }
    link_target = quote(f"{scope}/AGENTS.md", safe="/")
    body = (
        "# Path scope adapter\n\n"
        f"[`{scope}/AGENTS.md`](../../{link_target})を、"
        "このpathで適用する唯一の追加ルール正本として参照します。"
    )
    return claude_adapter, claude_data, cursor_adapter, cursor_data, body


def _active_nested_chain_bytes(
    root_bytes: int,
    path: Path,
    nested_bytes: dict[Path, int],
) -> int:
    return root_bytes + sum(
        size
        for candidate, size in nested_bytes.items()
        if path.is_relative_to(candidate.parent)
    )


def validate_nested_agents(root: Path) -> None:
    repository_files = list(_repository_files(root))
    root_agents = root / "AGENTS.md"
    root_bytes = len(root_agents.read_bytes())
    nested = [
        path
        for path in repository_files
        if path.name == "AGENTS.md" and path.parent != root
    ]
    nested_bytes = {path: len(path.read_bytes()) for path in nested}
    expected_claude_adapters: set[Path] = set()
    expected_cursor_adapters: set[Path] = set()
    for path in nested:
        (
            claude_adapter,
            expected_claude_data,
            cursor_adapter,
            expected_cursor_data,
            expected_body,
        ) = _nested_adapter_contract(root, path)
        expected_claude_adapters.add(claude_adapter)
        expected_cursor_adapters.add(cursor_adapter)

        scoped_files = [
            candidate
            for candidate in repository_files
            if candidate != path
            and candidate.name != ".gitkeep"
            and candidate.is_relative_to(path.parent)
        ]
        if not scoped_files:
            raise _fail(path, "nested rule requires a real file in the same subtree")

        if not claude_adapter.is_file():
            raise _fail(
                path,
                f"Claude path adapter is missing: {_relative(claude_adapter, root)}",
            )
        claude_data, claude_body = load_frontmatter(claude_adapter)
        if claude_data != expected_claude_data or claude_body != expected_body:
            raise _fail(
                claude_adapter,
                "must exactly scope and route to the nested AGENTS.md",
            )

        if not cursor_adapter.is_file():
            raise _fail(
                path,
                f"Cursor path adapter is missing: {_relative(cursor_adapter, root)}",
            )
        cursor_data, cursor_body = load_frontmatter(cursor_adapter)
        if cursor_data != expected_cursor_data or cursor_body != expected_body:
            raise _fail(
                cursor_adapter,
                "must exactly scope and route to the nested AGENTS.md",
            )

        raw = path.read_bytes()
        lines = len(raw.decode("utf-8").splitlines())
        if lines > 100 or len(raw) > 8192:
            raise _fail(
                path,
                f"nested instruction budget exceeded: {lines}/100 lines, "
                f"{len(raw)}/8192 bytes",
            )
        active_bytes = _active_nested_chain_bytes(
            root_bytes,
            path,
            nested_bytes,
        )
        if active_bytes > 24576:
            raise _fail(
                path,
                "root and active nested AGENTS.md chain exceed "
                f"24576 combined bytes: {active_bytes}",
            )

    actual_claude_adapters = set(root.glob(".claude/rules/nested-agents-*.md"))
    actual_cursor_adapters = set(root.glob(".cursor/rules/nested-agents-*.mdc"))
    for orphan in sorted(actual_claude_adapters - expected_claude_adapters):
        raise _fail(orphan, "path adapter has no corresponding nested AGENTS.md")
    for orphan in sorted(actual_cursor_adapters - expected_cursor_adapters):
        raise _fail(orphan, "path adapter has no corresponding nested AGENTS.md")


def validate_repository(root: Path) -> None:
    if (root / "CLAUDE.md").read_bytes() != b"@AGENTS.md\n":
        raise _fail(root / "CLAUDE.md", "must contain exactly @AGENTS.md and one newline")
    agent_files = discover_agent_files(root)
    if not agent_files:
        raise ValidationError("no agent Skill or rule files were discovered")
    for path in agent_files:
        validate_path(path, root)
    validate_skill_layout(root, agent_files)
    validate_instruction_budgets(root, agent_files)
    validate_text_hygiene(root)
    validate_markdown_links(root)
    validate_yaml_files(root)
    validate_workflow(root)
    validate_source_specific_residue(root)
    validate_conflicting_instructions(root)
    validate_long_duplicates(root)
    validate_adapter_mapping(root)
    validate_nested_agents(root)


def run_self_test() -> None:
    invalid_push_events = (
        {"paths": ["AGENTS.md", "!AGENTS.md"]},
        {"paths": ["AGENTS.md"], "paths-ignore": ["AGENTS.md"]},
        {"paths": ["AGENTS.md"], "branches": ["main"]},
    )
    for event_data in invalid_push_events:
        try:
            _validate_workflow_path_patterns(
                Path("workflow.yml"),
                "push",
                event_data,
                {"AGENTS.md"},
            )
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test accepted a suppressible push trigger")

    cases = {
        ".agents/skills/valid-skill/SKILL.md": (
            "---\nname: valid-skill\ndescription: valid\n---\n\n# Valid\n",
            True,
        ),
        ".agents/skills/extended-skill/SKILL.md": (
            "---\nname: extended-skill\ndescription: valid\nmetadata:\n"
            "  owner: project\nlicense: MIT\n---\n\n# Valid\n",
            True,
        ),
        ".claude/skills/adapter/SKILL.md": (
            "---\nname: adapter\ndescription: bad\nmetadata:\n"
            "  owner: project\n---\n\n# Bad\n",
            False,
        ),
        ".agents/skills/duplicate/SKILL.md": (
            "---\nname: duplicate\nname: duplicate\ndescription: bad\n---\n\n# Bad\n",
            False,
        ),
        ".agents/skills/wrong-name/SKILL.md": (
            "---\nname: other\ndescription: bad\n---\n\n# Bad\n",
            False,
        ),
        ".agents/skills/missing/SKILL.md": ("name: missing\n", False),
    }
    with TemporaryDirectory() as directory:
        root = Path(directory)
        for relative, (content, should_pass) in cases.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            passed = True
            try:
                validate_path(path, root)
            except (OSError, ValidationError):
                passed = False
            if passed != should_pass:
                raise ValidationError(f"self-test failed for {relative}")

        cursor = root / ".cursor/rules/test.mdc"
        cursor.parent.mkdir(parents=True)
        cursor.write_text(
            "---\ndescription: test\nglobs:\n  - test/**\n"
            "alwaysApply: false\n---\n\n# Test\n",
            encoding="utf-8",
        )
        validate_path(cursor, root)
        cursor.write_text(
            "---\ndescription: test\nalwaysApply: true\n---\n\n# Test\n",
            encoding="utf-8",
        )
        validate_path(cursor, root)
        cursor.write_text(
            "---\ndescription: test\nglobs: test\nalwaysApply: \"false\"\n---\n\n# Test\n",
            encoding="utf-8",
        )
        try:
            validate_path(cursor, root)
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test accepted string alwaysApply=false")

        claude = root / ".claude/rules/global.md"
        claude.parent.mkdir(parents=True)
        claude.write_text(
            "---\ndescription: global project rule\n---\n\n# Global\n",
            encoding="utf-8",
        )
        validate_path(claude, root)
        nested_claude = root / ".claude/rules/product/global.md"
        nested_claude.parent.mkdir(parents=True)
        nested_claude.write_text("# Global product rule\n", encoding="utf-8")
        validate_path(nested_claude, root)
        if nested_claude not in discover_agent_files(root):
            raise ValidationError("self-test missed a recursive Claude rule")

        claude.write_text(
            "---\npaths: null\n---\n\n# Invalid\n",
            encoding="utf-8",
        )
        try:
            validate_path(claude, root)
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test accepted paths: null")

        managed_claude = root / ".claude/rules/agent-harness.md"
        managed_claude.write_text("# Missing frontmatter\n", encoding="utf-8")
        try:
            validate_path(managed_claude, root)
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test accepted a managed adapter without frontmatter")

        cursor.write_text(
            "---\ndescription: test\nglobs: null\n"
            "alwaysApply: false\n---\n\n# Invalid\n",
            encoding="utf-8",
        )
        try:
            validate_path(cursor, root)
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test accepted globs: null")

    with TemporaryDirectory() as directory:
        root = Path(directory)
        subprocess.run(
            ["git", "init", "--quiet"],
            cwd=root,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        (root / "README.md").write_text(
            "[Inline-code heading](AGENTS.md#use-agentpurpose)\n"
            "[Unicode heading](AGENTS.md#straße)\n"
            "[Collision heading](AGENTS.md#collision-1-1)\n"
            "[Indented heading](AGENTS.md#indented-heading)\n"
            "[Setext heading](AGENTS.md#setext-heading)\n"
            "[Image heading](AGENTS.md#image-foo--bar-heading)\n"
            "[Nested image heading](AGENTS.md#nested-foo-bar-baz-heading)\n"
            "[External](HTTPS://example.com)\n"
            "[Email](MailTo:test@example.com)\n",
            encoding="utf-8",
        )
        (root / "AGENTS.md").write_text(
            "# Root\n\n"
            "## Use `agent/<purpose>`\n\n"
            "## Use ``foo [x](y) bar ` baz <qux>`` now\n\n"
            "## A _Helpful_ Section\n\n"
            "## A _Helpful_ Section\n\n"
            "## foo_bar_baz\n\n"
            "## A <!-- hidden --> B\n\n"
            "## Straße\n\n"
            "## Two  Spaces\n\n"
            "## Collision\n\n"
            "## Collision\n\n"
            "## Collision-1\n\n"
            "  ## Indented heading\n\n"
            "Setext heading\n"
            "--------------\n\n"
            "## Image ![foo &amp; *bar*](.agents/skills/example/assets/image.png) heading\n\n"
            "## Nested ![foo [bar](inner.md) baz](.agents/skills/example/assets/image.png) heading\n\n"
            "````md\n"
            "```md\n"
            "# Ignored heading\n"
            "[ignored](missing.md)\n"
            "```\n"
            "````\n\n"
            "> ```md\n"
            "> [ignored](missing-blockquote.md)\n"
            "> ```\n\n"
            "- example:\n\n"
            "  ```md\n"
            "  [ignored](missing-list.md)\n"
            "  ```\n\n"
            "End example.\n\n"
            "    [ignored](missing-indented.md)\n",
            encoding="utf-8",
        )
        expected_anchors = {
            "root",
            "use-agentpurpose",
            "use-foo-xy-bar--baz-qux-now",
            "a-helpful-section",
            "a-helpful-section-1",
            "foo_bar_baz",
            "a--b",
            "straße",
            "two--spaces",
            "collision",
            "collision-1",
            "collision-1-1",
            "indented-heading",
            "setext-heading",
            "image-foo--bar-heading",
            "nested-foo-bar-baz-heading",
        }
        actual_anchors = _markdown_anchors(
            (root / "AGENTS.md").read_text(encoding="utf-8")
        )
        if actual_anchors != expected_anchors:
            raise ValidationError("Markdown anchor rendering self-test failed")
        fixtures = root / "fixtures"
        fixtures.mkdir()
        (fixtures / "sequence.yml").write_text(
            "- first\n- second\n",
            encoding="utf-8",
        )
        (fixtures / "multi.yaml").write_text(
            "---\nkind: Example\n---\n- item\n",
            encoding="utf-8",
        )
        (fixtures / "broken.md").write_bytes(b"[missing](missing.md)\xff")
        skill_asset = root / ".agents/skills/example/assets/image.png"
        skill_asset.parent.mkdir(parents=True)
        skill_asset.write_bytes(b"\x89PNG\r\n\x1a\n\xff")
        validate_text_hygiene(root)
        validate_markdown_links(root)
        validate_source_specific_residue(root)
        validate_yaml_files(root)

        duplicate_yaml = fixtures / "duplicate.yml"
        duplicate_yaml.write_text("key: first\nkey: second\n", encoding="utf-8")
        validate_yaml_files(root)

        harness_yaml = root / ".github/workflows/agent-harness.yml"
        harness_yaml.parent.mkdir(parents=True)
        harness_yaml.write_text("key: first\nkey: second\n", encoding="utf-8")
        try:
            validate_yaml_files(root)
        except ValidationError as exc:
            if "duplicate YAML key" not in str(exc):
                raise ValidationError("YAML duplicate-key self-test failed") from exc
        else:
            raise ValidationError("self-test accepted a duplicate YAML key")
        harness_yaml.unlink()
        duplicate_yaml.unlink()

        architecture = root / "docs/architecture.md"
        architecture.parent.mkdir()
        architecture.write_text(
            "# Architecture\n\nCloud Run、Firebase、Firestore、Google OAuthを候補として比較します。\n",
            encoding="utf-8",
        )
        validate_source_specific_residue(root)
        architecture.write_text("# Provenance\n\nAdapted from WordPack.\n", encoding="utf-8")
        validate_source_specific_residue(root)

        readme = root / "README.md"
        readme.write_text("# WordPack residue\n", encoding="utf-8")
        try:
            validate_source_specific_residue(root)
        except ValidationError as exc:
            if "source-specific term remains: WordPack" not in str(exc):
                raise ValidationError("source residue self-test failed") from exc
        else:
            raise ValidationError("self-test accepted an unambiguous source identifier")
        readme.write_text("# Project\n", encoding="utf-8")

        history = root / "docs/policy-history.md"
        history.write_text("# History\n\n旧語は下書きPRでした。\n", encoding="utf-8")
        validate_conflicting_instructions(root)
        active_rule = root / ".agents/skills/example/SKILL.md"
        active_rule.write_text("# Active\n\n下書きPRを使います。\n", encoding="utf-8")
        try:
            validate_conflicting_instructions(root)
        except ValidationError as exc:
            if "retired or conflicting instruction remains: 下書きPR" not in str(exc):
                raise ValidationError("conflicting instruction self-test failed") from exc
        else:
            raise ValidationError("self-test accepted a conflicting active instruction")
        active_rule.write_text(
            "# Active\n\n履歴上の旧語は `下書きPR` です。\n",
            encoding="utf-8",
        )
        try:
            validate_conflicting_instructions(root)
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test ignored a code-formatted active instruction")
        active_rule.write_text("# Active\n\n通常は非Draft PRを使います。\n", encoding="utf-8")

        nested = root / "apps/my bot/AGENTS.md"
        nested.parent.mkdir(parents=True)
        nested.write_text("# Bot scope\n", encoding="utf-8")
        (nested.parent / "bot.py").write_text("pass\n", encoding="utf-8")

        nested.write_text("# Bot scope\n\n通常はDraft\n", encoding="utf-8")
        try:
            validate_conflicting_instructions(root)
        except ValidationError:
            pass
        else:
            raise ValidationError("self-test ignored a conflicting nested AGENTS.md")
        nested.write_text("# Bot scope\n", encoding="utf-8")

        try:
            validate_nested_agents(root)
        except ValidationError as exc:
            if "Claude path adapter is missing" not in str(exc):
                raise ValidationError("nested adapter self-test failed") from exc
        else:
            raise ValidationError("self-test accepted a nested rule without adapters")

        claude_path, claude_data, cursor_path, cursor_data, body = (
            _nested_adapter_contract(root, nested)
        )
        for path, data in ((claude_path, claude_data), (cursor_path, cursor_data)):
            path.parent.mkdir(parents=True, exist_ok=True)
            frontmatter = yaml.safe_dump(
                data,
                allow_unicode=True,
                sort_keys=False,
            ).rstrip()
            path.write_text(
                f"---\n{frontmatter}\n---\n\n{body}\n",
                encoding="utf-8",
            )
        validate_nested_agents(root)
        validate_markdown_links(root)

        for metacharacter in "*?[]{}!,\\":
            metacharacter_nested = (
                root / f"apps/scope{metacharacter}name/AGENTS.md"
            )
            try:
                _nested_adapter_contract(root, metacharacter_nested)
            except ValidationError as exc:
                if "unsupported glob metacharacters" not in str(exc):
                    raise ValidationError(
                        "glob metacharacter self-test failed"
                    ) from exc
            else:
                raise ValidationError(
                    f"self-test accepted glob metacharacter {metacharacter!r}"
                )

        unsafe_nested = root / "apps/[bot]/AGENTS.md"
        unsafe_nested.parent.mkdir(parents=True)
        unsafe_nested.write_text("# Unsafe glob scope\n", encoding="utf-8")
        (unsafe_nested.parent / "bot.py").write_text("pass\n", encoding="utf-8")
        try:
            validate_nested_agents(root)
        except ValidationError as exc:
            if "unsupported glob metacharacters" not in str(exc):
                raise ValidationError("glob-safe nested scope self-test failed") from exc
        else:
            raise ValidationError("self-test accepted a glob-unsafe nested scope")
        unsafe_nested.unlink()
        (unsafe_nested.parent / "bot.py").unlink()
        unsafe_nested.parent.rmdir()

        nested.unlink()
        try:
            validate_nested_agents(root)
        except ValidationError as exc:
            if "path adapter has no corresponding nested AGENTS.md" not in str(exc):
                raise ValidationError("orphan adapter self-test failed") from exc
        else:
            raise ValidationError("self-test accepted an orphan path adapter")

    with TemporaryDirectory() as directory:
        root = Path(directory)
        subprocess.run(
            ["git", "init", "--quiet"],
            cwd=root,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        (root / "AGENTS.md").write_text("# Root\n", encoding="utf-8")
        budget_nested = [
            root / "apps/AGENTS.md",
            root / "apps/bot/AGENTS.md",
            root / "apps/bot/deep/AGENTS.md",
        ]
        sibling = root / "other/AGENTS.md"
        boundary_bytes = {
            budget_nested[0]: 12000,
            budget_nested[-1]: 12000,
            sibling: 12000,
        }
        if (
            _active_nested_chain_bytes(576, budget_nested[-1], boundary_bytes)
            != 24576
        ):
            raise ValidationError("nested chain boundary self-test failed")
        for nested_path in budget_nested:
            nested_path.parent.mkdir(parents=True, exist_ok=True)
            nested_path.write_text(
                "# Scope\n" + "x" * 8181 + "\n",
                encoding="utf-8",
            )
            claude_path, claude_data, cursor_path, cursor_data, body = (
                _nested_adapter_contract(root, nested_path)
            )
            for adapter_path, data in (
                (claude_path, claude_data),
                (cursor_path, cursor_data),
            ):
                adapter_path.parent.mkdir(parents=True, exist_ok=True)
                frontmatter = yaml.safe_dump(
                    data,
                    allow_unicode=True,
                    sort_keys=False,
                ).rstrip()
                adapter_path.write_text(
                    f"---\n{frontmatter}\n---\n\n{body}\n",
                    encoding="utf-8",
                )
        (budget_nested[-1].parent / "bot.py").write_text(
            "pass\n",
            encoding="utf-8",
        )
        try:
            validate_nested_agents(root)
        except ValidationError as exc:
            if "active nested AGENTS.md chain exceed" not in str(exc):
                raise ValidationError("nested chain budget self-test failed") from exc
        else:
            raise ValidationError("self-test accepted an oversized nested rule chain")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--repository", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.self_test:
            run_self_test()
        root = (args.repository or Path.cwd()).resolve()
        for path in args.paths:
            validate_path(path, root)
        if args.repository is not None:
            validate_repository(root)
    except (OSError, ValidationError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
