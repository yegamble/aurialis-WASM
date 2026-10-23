"""Same-run CI build reuse. Never a product upload or request path."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

MEMBERS = {
    "aurialis": 0o755,
    "artifacts/ci-runtime/aurialis-e2e": 0o755,
    "public/wasm/aurialis-dsp.wasm": 0o644,
    "public/wasm/aurialis-realtime.wasm": 0o644,
    "public/wasm/wasm_exec.js": 0o644,
}
MAXIMUM_BYTES = 512 * 1024 * 1024
RECEIPT = "artifacts/ci-runtime/receipt.json"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def provenance(root):
    # Include the working source bytes, not just HEAD: dirty or stale outputs
    # cannot be silently reused after a local edit. Generated assets are ignored.
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).split(b"\0")
    source_hash = hashlib.sha256()
    for raw in sorted(name for name in tracked if name):
        path = root / os.fsdecode(raw)
        source_hash.update(raw + b"\0")
        content = os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes()
        source_hash.update(hashlib.sha256(content).digest())
    checkout = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    current_attempt = int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
    build_attempt = int(os.environ.get("AURIALIS_CI_BUILD_ATTEMPT", str(current_attempt)))
    if not 1 <= build_attempt <= current_attempt:
        raise ValueError("CI producer attempt must belong to this run's history")
    return {
        "checkoutSha": checkout,
        "headSha": os.environ.get("AURIALIS_CI_HEAD_SHA", checkout),
        "sourceSha256": source_hash.hexdigest(),
        "runId": os.environ.get("GITHUB_RUN_ID", "local"),
        "runAttempt": str(build_attempt),
        "platform": platform.system(),
        "architecture": platform.machine(),
        "executionTarget": os.environ.get("NEXT_PUBLIC_AURIALIS_EXECUTION", "native"),
    }


def checked_manifest(value, expected):
    if not isinstance(value, dict) or set(value) != {"version", "provenance", "files"} or type(value["version"]) is not int or value["version"] != 1 or value["provenance"] != expected:
        raise ValueError("CI artifact checkout/run/platform/target provenance differs")
    files = value["files"]
    if not isinstance(files, dict) or set(files) != set(MEMBERS):
        raise ValueError("CI artifact member set differs")
    total = 0
    for name, mode in MEMBERS.items():
        entry = files[name]
        if not isinstance(entry, dict) or set(entry) != {"bytes", "sha256", "mode"}:
            raise ValueError("Invalid CI file descriptor")
        size, checksum = entry["bytes"], entry["sha256"]
        if type(size) is not int or not 0 < size <= MAXIMUM_BYTES or entry["mode"] != mode or not isinstance(checksum, str) or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            raise ValueError("Invalid CI file bound, hash or mode")
        total += size
    if total > MAXIMUM_BYTES:
        raise ValueError("CI runtime exceeds bounded archive size")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate CI manifest member")
        result[key] = value
    return result


def load_json(path):
    if path.stat().st_size > 65536:
        raise ValueError("Oversized CI manifest")
    return json.loads(path.read_text(), object_pairs_hook=unique_object)


def checked_file(root, name):
    path = root / name
    for component in (path, *path.parents):
        if component == root:
            break
        if component.is_symlink():
            raise ValueError("CI artifact paths cannot contain symbolic links")
    return path


def verify(root, binary=None):
    manifest = checked_manifest(load_json(checked_file(root, RECEIPT)), provenance(root))
    if binary is not None and Path(binary).absolute() not in (root / "aurialis", root / "artifacts/ci-runtime/aurialis-e2e"):
        raise ValueError("Prebuilt executable must be a verified CI runtime member")
    for name, entry in manifest["files"].items():
        path = checked_file(root, name)
        if not path.is_file() or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"] or path.stat().st_mode & 0o777 != entry["mode"]:
            raise ValueError("CI runtime file differs: " + name)
    return manifest


def pack(root, destination):
    files = {}
    for name, mode in MEMBERS.items():
        path = checked_file(root, name)
        files[name] = {"bytes": path.stat().st_size, "sha256": digest(path), "mode": mode}
    manifest = checked_manifest({"version": 1, "provenance": provenance(root), "files": files}, provenance(root))
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with tarfile.open(destination / "runtime.tar", "w", format=tarfile.USTAR_FORMAT) as archive:
        for name, mode in MEMBERS.items():
            info = archive.gettarinfo(str(root / name), arcname=name)
            if not info.isfile():
                raise ValueError("CI runtime member must be a regular file")
            info.mode, info.uid, info.gid, info.uname, info.gname = mode, 0, 0, "", ""
            with (root / name).open("rb") as source:
                archive.addfile(info, source)
    (destination / "SHA256SUMS").write_text("".join(digest(destination / name) + "  " + name + "\n" for name in ("manifest.json", "runtime.tar")))


def restore(root, directory):
    if (directory / "SHA256SUMS").stat().st_size > 256 or (directory / "manifest.json").stat().st_size > 65536 or (directory / "runtime.tar").stat().st_size > MAXIMUM_BYTES + 1024 * 1024:
        raise ValueError("Oversized CI artifact container or metadata")
    sums = (directory / "SHA256SUMS").read_text()
    expected_sums = "".join(digest(directory / name) + "  " + name + "\n" for name in ("manifest.json", "runtime.tar"))
    if sums != expected_sums:
        raise ValueError("CI archive/manifest checksum differs")
    manifest = checked_manifest(load_json(directory / "manifest.json"), provenance(root))
    archive_path = directory / "runtime.tar"
    receipt = checked_file(root, RECEIPT)
    receipt.unlink(missing_ok=True)
    # Never use unrestricted tar extraction. Reject directories, links, duplicate
    # members and traversal before writing only the five closed known filenames.
    with tempfile.TemporaryDirectory(prefix="aurialis-ci-") as temporary:
        staging = Path(temporary)
        with tarfile.open(archive_path, "r:") as archive:
            entries = archive.getmembers()
            if len(entries) != len(MEMBERS) or {entry.name for entry in entries} != set(MEMBERS):
                raise ValueError("Unexpected CI tar members")
            for entry in entries:
                expected = manifest["files"][entry.name]
                if not entry.isfile() or entry.size != expected["bytes"]:
                    raise ValueError("CI tar member is a link or has the wrong size")
                target = staging / entry.name
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(entry)
                if source is None:
                    raise ValueError("CI tar member is unavailable")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                if digest(target) != expected["sha256"]:
                    raise ValueError("CI tar member checksum differs")
            for name, mode in MEMBERS.items():
                target = checked_file(root, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(staging / name, target)
                target.chmod(mode)
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(manifest, indent=2) + "\n")
    verify(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pack", "restore", "verify"))
    parser.add_argument("directory", nargs="?", type=Path)
    parser.add_argument("--binary")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.command == "verify":
        verify(root, args.binary)
    elif args.directory is None:
        parser.error("pack and restore require an artifact directory")
    elif args.command == "pack":
        pack(root, args.directory)
    else:
        restore(root, args.directory)
    print("CI runtime " + args.command + " verified for the exact checkout and workflow run.")


if __name__ == "__main__":
    main()
