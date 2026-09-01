#!/usr/bin/env python3
"""Classify changed paths into the smallest safe CI gate set."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Iterable


GATES = ("product", "browser", "governance", "workflow_contract")


def _matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


WORKFLOW_PATTERNS = (
    ".github/workflows/**",
    "scripts/classify_verification_inputs.py",
    "tests/governance/test_verification_inputs.py",
    "tests/governance/test_workflow_contract.py",
)

GOVERNANCE_PATTERNS = (
    "AGENTS.md",
    "**/AGENTS.md",
    "CLAUDE.md",
    ".agents/**",
    ".claude/**",
    ".cursor/**",
    ".github/ISSUE_TEMPLATE/**",
    ".github/pull_request_template.md",
    "docs/agent-harness.md",
    "docs/agent-principles.md",
    "docs/documentation-structure.md",
    "docs/security-publication-checklist.md",
    "docs/ai-governance/**",
    "requirements-agent-harness.txt",
    "scripts/validate_governance.py",
    "scripts/verify_task_skills.py",
    "scripts/validate_agent_frontmatter.py",
    "scripts/verify-agent-harness.sh",
    "tests/governance/**",
)

BROWSER_PATTERNS = (
    "dashboard/**",
    "src/dashboard/**",
    "src/trace/**",
    "tests/browser/**",
    "tests/e2e/dashboard-live.ts",
    "playwright.config.ts",
    "vite.config.ts",
    "tsconfig.dashboard.json",
    "dashboard/package.json",
)

PRODUCT_PATTERNS = (
    "src/**",
    "tests/unit/**",
    "tests/integration/**",
    "tests/e2e/**",
    "README.md",
    ".env.example",
    ".gitignore",
    "config/**",
    "docs/architecture.md",
    "docs/dashboard.md",
    "docs/dashboard/**",
    "docs/memory.md",
    "docs/operations.md",
    "docs/testing.md",
    "package.json",
    "package-lock.json",
    "eslint.config.js",
    "playwright.config.ts",
    "tsconfig.json",
    "tsconfig.*.json",
    "vite.config.ts",
)


def classify_paths(paths: Iterable[str], *, full: bool = False) -> dict[str, object]:
    normalized = sorted({path.strip("/") for path in paths if path.strip("/")})
    selected = {gate: full for gate in GATES}
    unknown: list[str] = []

    for path in normalized:
        known = False
        if _matches(path, WORKFLOW_PATTERNS):
            selected = {gate: True for gate in GATES}
            known = True
        if _matches(path, GOVERNANCE_PATTERNS):
            selected["governance"] = True
            known = True
        if _matches(path, PRODUCT_PATTERNS):
            selected["product"] = True
            known = True
        if _matches(path, BROWSER_PATTERNS):
            selected["product"] = True
            selected["browser"] = True
            known = True
        if not known:
            unknown.append(path)

    if unknown:
        # An unregistered path is a classifier defect. Select every gate as the
        # safe diagnostic profile, but keep classification_ok false so the
        # aggregate gate cannot pass silently.
        selected = {gate: True for gate in GATES}

    return {
        "classification_ok": not unknown,
        **selected,
        "changed_paths": normalized,
        "unknown_paths": unknown,
    }


def changed_paths(base: str, head: str) -> list[str]:
    command = [
        "git",
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        f"{base}...{head}",
        "--",
    ]
    completed = subprocess.run(command, check=True, capture_output=True)
    return [item.decode("utf-8") for item in completed.stdout.split(b"\0") if item]


def _write_github_output(result: dict[str, object], output_path: Path) -> None:
    lines: list[str] = []
    for key in ("classification_ok", *GATES):
        lines.append(f"{key}={str(result[key]).lower()}")
    lines.append(f"unknown_paths={json.dumps(result['unknown_paths'], ensure_ascii=False)}")
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--paths", nargs="*")
    parser.add_argument("--github-output", action="store_true")
    args = parser.parse_args()

    try:
        if args.full:
            result = classify_paths([], full=True)
        elif args.paths is not None:
            result = classify_paths(args.paths)
        elif args.base and args.head:
            result = classify_paths(changed_paths(args.base, args.head))
        else:
            parser.error("use --full, --paths, or both --base and --head")
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError) as exc:
        result = classify_paths(["<diff-error>"])
        result["error"] = type(exc).__name__

    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if args.github_output:
        output = os.environ.get("GITHUB_OUTPUT")
        if not output:
            print("GITHUB_OUTPUT is required with --github-output", file=sys.stderr)
            return 2
        _write_github_output(result, Path(output))
    return 0 if result["classification_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
