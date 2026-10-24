"""Pinned QA supervisor capabilities; no child, profile or cleanup side effects."""
import inspect
from pathlib import Path
import shutil
import sys

EXPECTED_PYTHON = (3, 14, 6)


def qualification_runtime():
    """Fail before owned directories or children when fd-relative cleanup is unavailable."""
    version = tuple(sys.version_info[:3])
    signature = inspect.signature(shutil.rmtree)
    safe = getattr(shutil.rmtree, "avoids_symlink_attacks", False) is True
    executable = Path(sys.executable)
    if version != EXPECTED_PYTHON or "dir_fd" not in signature.parameters or not safe:
        raise RuntimeError("Qualification requires Python 3.14.6 with symlink-safe fd-relative rmtree; no fallback is permitted")
    if not executable.is_absolute() or not executable.is_file():
        raise RuntimeError("Qualification interpreter requires its resolved executable path")
    return {"version": ".".join(map(str, version)), "executable": str(executable),
            "resolvedExecutable": str(executable.resolve(strict=True)),
            "rmtreeSignature": str(signature), "symlinkSafe": safe,
            "qualificationRuntimeOnly": True}
