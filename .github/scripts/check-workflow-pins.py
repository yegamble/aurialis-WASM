#!/usr/bin/env python3
"""Fail when a workflow or composite action can run code that is not pinned.

Every non-local `uses:` must name a full 40-hex commit SHA followed by a
`# vX.Y.Z` comment (Dependabot keeps both in step). Docker actions must use
an `@sha256:` digest. `@latest` is rejected anywhere in workflow files, since
it lets a tool install change between two runs of the same commit.

Usage: check-workflow-pins.py [repo-root]
"""

import pathlib
import re
import sys

USES = re.compile(r"^\s*(?:-\s*)?uses:\s*['\"]?([^'\"\s#]+)['\"]?\s*(#.*)?$")
SHA_PIN = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
VERSION_COMMENT = re.compile(r"^#\s*v\d+(?:\.\d+){0,2}\S*\s*$")
DOCKER_PIN = re.compile(r"^docker://[^@\s]+@sha256:[0-9a-f]{64}$")


def workflow_files(root: pathlib.Path) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for pattern in ("workflows/*.yml", "workflows/*.yaml", "actions/**/*.yml", "actions/**/*.yaml"):
        files.extend((root / ".github").glob(pattern))
    return sorted(set(files))


def check(root: pathlib.Path) -> list[str]:
    errors: list[str] = []
    files = workflow_files(root)
    if not files:
        return [f"no workflow files found under {root / '.github'}"]
    for path in files:
        rel = path.relative_to(root)
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            where = f"{rel}:{number}"
            if "@latest" in line:
                errors.append(f"{where}: '@latest' is not reproducible; pin an explicit version")
            match = USES.match(line)
            if not match:
                continue
            ref, comment = match.group(1), (match.group(2) or "").strip()
            if ref.startswith("./"):
                continue
            if ref.startswith("docker://"):
                if not DOCKER_PIN.match(ref):
                    errors.append(f"{where}: {ref} must be pinned to an @sha256: digest")
                continue
            if not SHA_PIN.match(ref):
                errors.append(f"{where}: {ref} must be pinned to a full 40-hex commit SHA")
            elif not VERSION_COMMENT.match(comment):
                errors.append(f"{where}: {ref} needs a trailing '# vX.Y.Z' comment naming the pinned release")
    return errors


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = check(root)
    for error in errors:
        print(f"::error::{error}")
    if errors:
        return 1
    print(f"All actions in {len(workflow_files(root))} workflow files are SHA-pinned; no @latest found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
