"""Same-run browser-target static assets. Never user audio or a native UI reuse."""
import argparse
import importlib.util
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location("ci_browser_shared", Path(__file__).with_name("ci-artifacts.py"))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
ASSETS = "deploy/cloudflare/assets"
POLICY = "deploy/cloudflare/asset-policy.json"
ARCHIVE = "artifacts/ci-browser-runtime/assets.tar"
INDEX = "artifacts/ci-browser-runtime/assets-manifest.json"
MAXIMUM_FILE = 25 * 1024 * 1024
MAXIMUM_MODEL_SHARD = 16 * 1024 * 1024
MAXIMUM_METADATA = 2 * 1024 * 1024
MAXIMUM_FILES = 4096


def safe_name(name):
    if not isinstance(name, str) or not 0 < len(name) <= 1024 or any(ord(character) < 32 or ord(character) == 127 for character in name) or "\\" in name or ":" in name:
        raise ValueError("Invalid browser asset name")
    parsed = PurePosixPath(name)
    if name == "." or parsed.is_absolute() or parsed.as_posix() != name or any(part in (".", "..") for part in parsed.parts):
        raise ValueError("Browser asset paths must remain relative")
    return name


def bounded_json(root, name):
    path = shared.checked_file(root, name)
    if not 0 < path.stat().st_size <= MAXIMUM_METADATA:
        raise ValueError("Browser asset metadata exceeds its bound")
    return json.loads(path.read_text(), object_pairs_hook=shared.unique_object)


def policy(root):
    value = bounded_json(root, POLICY)
    if not isinstance(value, dict) or set(value) != {"csp", "execution", "files", "paths"} or value["execution"] != "browser":
        raise ValueError("Static app policy must declare browser execution")
    paths = value["paths"]
    if not isinstance(paths, list) or not 0 < len(paths) <= MAXIMUM_FILES or any(not isinstance(name, str) for name in paths):
        raise ValueError("Invalid bounded browser asset set")
    for name in paths:
        safe_name(name)
    if paths != sorted(set(paths)) or type(value["files"]) is not int or value["files"] != len(paths):
        raise ValueError("Browser policy file count or order differs")
    csp = value["csp"]
    if not isinstance(csp, str) or not 0 < len(csp) <= 256 * 1024 or any(ord(character) < 32 for character in csp):
        raise ValueError("Invalid browser policy header")
    return value


def checked_index(root):
    value = bounded_json(root, INDEX)
    expected_paths = policy(root)["paths"]
    if not isinstance(value, dict) or set(value) != {"version", "files"} or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["files"], dict) or set(value["files"]) != set(expected_paths):
        raise ValueError("Browser asset manifest differs from its closed policy set")
    total = 0
    for name, entry in value["files"].items():
        limit = MAXIMUM_MODEL_SHARD if name.startswith("models/") else MAXIMUM_FILE
        if not isinstance(entry, dict) or set(entry) != {"bytes", "sha256", "mode"} or type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= limit or type(entry["mode"]) is not int or entry["mode"] != 0o644 or not isinstance(entry["sha256"], str) or len(entry["sha256"]) != 64 or any(character not in "0123456789abcdef" for character in entry["sha256"]):
            raise ValueError("Browser asset size, mode or checksum is invalid")
        total += entry["bytes"]
    if total > shared.MAXIMUM_BYTES:
        raise ValueError("Browser app exceeds bounded package memory")
    return value


def asset_paths(root):
    directory = shared.checked_file(root, ASSETS)
    paths = []
    for path in directory.rglob("*"):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError("Static app contains a link or non-regular entry")
        if path.is_file():
            paths.append(path.relative_to(directory).as_posix())
    return sorted(paths)


def verify_assets(root):
    manifest = checked_index(root)
    if asset_paths(root) != sorted(manifest["files"]):
        raise ValueError("Restored browser app contains missing or unexpected assets")
    for name, entry in manifest["files"].items():
        path = shared.checked_file(root, ASSETS + "/" + name)
        if path.stat().st_size != entry["bytes"] or path.stat().st_mode & 0o777 != 0o644 or shared.digest(path) != entry["sha256"]:
            raise ValueError("Restored browser asset differs: " + name)


def verify(root):
    shared.verify(root, profile="browser")
    verify_assets(root)


def pack(root, destination):
    expected = policy(root)
    if asset_paths(root) != expected["paths"]:
        raise ValueError("Built app assets differ from generated browser policy")
    descriptor = {}
    for name in expected["paths"]:
        path = shared.checked_file(root, ASSETS + "/" + name)
        path.chmod(0o644)
        descriptor[name] = {"bytes": path.stat().st_size, "sha256": shared.digest(path), "mode": 0o644}
    index = shared.checked_file(root, INDEX)
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(json.dumps({"version": 1, "files": descriptor}, indent=2) + "\n")
    index.chmod(0o644)
    checked_index(root)
    archive_path = shared.checked_file(root, ARCHIVE)
    with tarfile.open(archive_path, "w", format=tarfile.USTAR_FORMAT) as archive:
        for name in expected["paths"]:
            path = shared.checked_file(root, ASSETS + "/" + name)
            entry = archive.gettarinfo(str(path), arcname=name)
            if not entry.isfile():
                raise ValueError("Browser asset must be a regular file")
            entry.mode, entry.uid, entry.gid, entry.uname, entry.gname, entry.mtime = 0o644, 0, 0, "", "", 0
            with path.open("rb") as source:
                archive.addfile(entry, source)
    archive_path.chmod(0o644)
    shared.pack(root, destination, profile="browser")


def restore(root, directory):
    receipt = shared.checked_file(root, shared.BROWSER_RECEIPT)
    receipt.unlink(missing_ok=True)
    try:
        shared.restore(root, directory, profile="browser")
        manifest = checked_index(root)
        archive_path = shared.checked_file(root, ARCHIVE)
        with tempfile.TemporaryDirectory(prefix="aurialis-static-ci-") as temporary:
            staging = Path(temporary) / "assets"
            staging.mkdir()
            with tarfile.open(archive_path, "r:") as archive:
                entries = archive.getmembers()
                if len(entries) != len(manifest["files"]) or {entry.name for entry in entries} != set(manifest["files"]):
                    raise ValueError("Unexpected browser archive members")
                for entry in entries:
                    expected = manifest["files"][entry.name]
                    if not entry.isfile() or entry.size != expected["bytes"] or entry.mode & 0o777 != 0o644:
                        raise ValueError("Browser archive contains a link or wrong size/mode")
                    target = staging / entry.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    source = archive.extractfile(entry)
                    if source is None:
                        raise ValueError("Missing browser asset bytes")
                    with source, target.open("xb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                    target.chmod(0o644)
                    if shared.digest(target) != expected["sha256"]:
                        raise ValueError("Browser asset checksum differs")
            target = shared.checked_file(root, ASSETS)
            if target.exists():
                asset_paths(root)
                shutil.rmtree(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staging, target)
        verify(root)
    except BaseException:
        receipt.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pack", "restore", "verify"))
    parser.add_argument("directory", nargs="?", type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if arguments.command == "verify":
        verify(root)
    elif arguments.directory is None:
        parser.error("pack and restore need an artifact directory")
    elif arguments.command == "pack":
        pack(root, arguments.directory)
    else:
        restore(root, arguments.directory)
    print("Browser-target static artifact " + arguments.command + " verified; no native UI reuse.")


if __name__ == "__main__":
    main()
