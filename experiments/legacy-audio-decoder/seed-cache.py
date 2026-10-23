"""Copy only the measured cache from the exact pinned read-only SDK image."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys

EXPECTED_BYTES = 623559028
EXPECTED_FILES = 2077
EXPECTED_DIRS = 98
EXPECTED_LAYOUT = "fca6ecbdbad850dd34ecfa97b77a97c2c1ba2ee94e1ba5247d34332b5503b0cb"
MAX_BYTES = 768 * 1024 * 1024

def inventory(root):
    total = 0
    entries = []
    directories = 0
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            path = Path(base) / name
            info = path.lstat()
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
                entries.append([str(path.relative_to(root)), info.st_size])
            elif stat.S_ISDIR(info.st_mode):
                directories += 1
            else:
                raise RuntimeError("Unexpected link or special file in pinned SDK cache.")
            if total > MAX_BYTES or len(entries) > EXPECTED_FILES or directories > EXPECTED_DIRS:
                raise RuntimeError("Pinned SDK cache exceeds its measured bounds.")
    digest = hashlib.sha256(json.dumps(sorted(entries), separators=(",", ":")).encode()).hexdigest()
    if total != EXPECTED_BYTES or len(entries) != EXPECTED_FILES or directories != EXPECTED_DIRS or digest != EXPECTED_LAYOUT:
        raise RuntimeError("Pinned SDK cache layout/size changed.")
    return {"bytes": total, "files": len(entries), "directories": directories, "layoutSHA256": digest}

def main():
    source, destination = (Path(value) for value in sys.argv[1:])
    if destination.exists():
        raise RuntimeError("SDK seed destination must be new.")
    before = inventory(source)
    shutil.copytree(source, destination, symlinks=False)
    after = inventory(destination)
    if before != after:
        raise RuntimeError("SDK cache copy did not preserve measured layout.")
    (destination.parent / "sdk-cache-seed.json").write_text(json.dumps({
        "source": str(source), "destination": str(destination), "maximumBytes": MAX_BYTES,
        "verifiedBeforeCopy": before, "verifiedAfterCopy": after,
        "image": "emscripten/emsdk@sha256:badbe38bedc8f4ff88a5a24672a2d59606015ba9a3bbe69801ad2fbdf75ab500",
    }, indent=2) + "\n")

if __name__ == "__main__":
    main()
