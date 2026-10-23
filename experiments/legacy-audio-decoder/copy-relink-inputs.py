"""Reuse only the immutable, inspected Build04 objects and bounded SDK cache."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat

PREVIOUS_WASM = "261c4b4b5cb9ad36e7ac5eebc3dccfc9a0f319b15d2cff53acac263ec4530878"
CACHE = (633412843, 2109, 104, "541c28f83a9a45e4282a6227265360dea8ec1f6e577ece613c0294d2caae9287")
HEADERS = (1207103, 134, 4, "064a3dfba66bd50693069d87f0331f075542bf7c51e950199142cdd7c75aaa82")
MAX_CACHE = 768 * 1024 * 1024

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()

def inventory(root, expected):
    entries, directories, total = [], 0, 0
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise RuntimeError("Input tree must be an actual directory.")
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            path = Path(base) / name
            info = path.lstat()
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > expected[0] or len(entries) >= expected[1]:
                    raise RuntimeError("Relink input exceeds measured bounds.")
                entries.append([str(path.relative_to(root)), info.st_size, digest(path)])
            elif stat.S_ISDIR(info.st_mode):
                directories += 1
                if directories > expected[2]:
                    raise RuntimeError("Too many relink directories.")
            else:
                raise RuntimeError("Unexpected link/special relink input.")
    layout = hashlib.sha256(json.dumps(sorted(entries), separators=(",", ":")).encode()).hexdigest()
    actual = (total, len(entries), directories, layout)
    if actual != expected or total > MAX_CACHE:
        raise RuntimeError("Relink input differs from inspected Build04.")
    return {"bytes": total, "files": len(entries), "directories": directories, "layoutContentSHA256": layout}

def copy_tree(source, target, expected):
    before = inventory(source, expected)
    if target.exists():
        raise RuntimeError("Relink destination must be new.")
    shutil.copytree(source, target, symlinks=False)
    after = inventory(target, expected)
    if before != after:
        raise RuntimeError("Relink copy changed.")
    return after

def main():
    previous, recipe, output = Path("/previous"), Path("/recipe"), Path("/output")
    build = json.loads((previous / "build-status.json").read_text())
    proof = json.loads((previous / "module-inspection.json").read_text())
    if build.get("exitCode") != 0 or build.get("resourceFailure") or build.get("timedOut") or build.get("cleanupError") or build.get("containerState", {}).get("OOMKilled"):
        raise RuntimeError("Previous build was not a bounded successful build.")
    if build.get("image") != json.loads((recipe / "sources.lock.json").read_text())["emscripten"]["image"]:
        raise RuntimeError("Previous toolchain image differs from source lock.")
    if proof["wasm"]["sha256"] != PREVIOUS_WASM or digest(previous / "assets" / proof["wasm"]["path"]) != PREVIOUS_WASM:
        raise RuntimeError("Previous runtime object provenance changed.")
    for name in ["decoder.c", "decoder.h", "decoder-imports.js", "sources.lock.json", "fixtures/decoder-cases.c"]:
        if digest(recipe / name) != proof["sourceRecipeHashes"][name]:
            raise RuntimeError("Reused objects do not match current source: " + name)
    target = output / "relink"
    target.mkdir()
    records = proof["relink"]
    if len(records) != 14:
        raise RuntimeError("Unexpected relink inventory.")
    for record in records:
        name = record["path"]
        if Path(name).name != name:
            raise RuntimeError("Invalid relink input path.")
        source = previous / "relink" / name
        if not stat.S_ISREG(source.lstat().st_mode) or source.stat().st_size != record["bytes"] or digest(source) != record["sha256"]:
            raise RuntimeError("Relink object changed: " + name)
        shutil.copyfile(source, target / name)
        if digest(target / name) != record["sha256"]:
            raise RuntimeError("Relink object copy changed.")
    cache = copy_tree(previous / "emcache", output / "emcache", CACHE)
    headers = copy_tree(previous / "install" / "include", output / "install" / "include", HEADERS)
    (output / "ffbuild").mkdir()
    for name in ["config.h", "config_components.h"]:
        shutil.copyfile(target / name, output / "ffbuild" / name)
    (output / "relink-inputs.json").write_text(json.dumps({
        "previousRuntimeSHA256": PREVIOUS_WASM, "archivesAndObject": records,
        "cache": cache, "headers": headers, "maximumCacheBytes": MAX_CACHE,
        "previousRecipeHashes": proof["sourceRecipeHashes"],
    }, indent=2) + "\n")

if __name__ == "__main__":
    main()
