#!/usr/bin/env python3
"""Validate discovered task Skills and their Claude Code adapters.

Repository-wide governance checks are owned by ``validate_governance.py``.
This entrypoint remains for the CI task-Skill step and performs only the
Skill-specific subset.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in {None, ""}:  # pragma: no cover - direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.validate_governance import (  # noqa: E402
    GovernanceError,
    ROOT,
    discover_routers,
    validate_skills,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    # Kept as a compatibility flag for the workflow; the static repository
    # check below is the self-test as well as the normal validation.
    parser.add_argument("--self-test", action="store_true")
    parser.parse_args()
    try:
        canonical, adapters, routers = validate_skills(ROOT, discover_routers(ROOT))
    except (OSError, GovernanceError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(
        "Task Skill verification: PASS "
        f"({canonical} canonical, {adapters} adapters, {routers} routers)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
