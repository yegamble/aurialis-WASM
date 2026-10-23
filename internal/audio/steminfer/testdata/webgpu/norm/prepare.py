"""Closed private normalization harness; hashes original/Go references, no network."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct

SOURCE_SHA = "a6f670325cdb8a7a212914f62602119b23eb888df9bcfe4a85f9be74728b3ef4"
MODEL_SHA = "0d51845078d4c075d825ba18f776f9af96e50d34d3491102a1215b6dbaf684b7"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    root = args.fixtures.resolve(strict=True)
    manifest_path = root / "manifest.json"
    if manifest_path.is_symlink() or not 1 <= manifest_path.stat().st_size <= 65536:
        raise ValueError("invalid bounded fixture manifest")
    manifest = json.loads(manifest_path.read_text())
    cases = manifest.get("cases")
    if manifest.get("format") != "aurialis-private-norm-traces-1" or manifest.get("sourceSHA256") != SOURCE_SHA or manifest.get("goModelSHA256") != MODEL_SHA or not isinstance(cases, list) or not 1 <= len(cases) <= 64:
        raise ValueError("pinned normalization provenance changed")
    names, records = set(), []
    for item in cases:
        name = item["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]+-r[0-9]+\.bin", name) or name in names:
            raise ValueError("invalid or repeated fixture name")
        names.add(name)
        path = root / name
        if path.is_symlink() or not 24 <= path.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError("invalid fixture size/link")
        data = path.read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("actual Go/original fixture checksum mismatch")
        magic, rows, width, reserved0, reserved1 = struct.unpack_from("<8s4I", data)
        if magic != b"AUNORM01" or not 1 <= rows <= 512 or width != 256 or reserved0 or reserved1 or len(data) != 24 + 3 * rows * 256 * 4 + 1024 + 12 * rows:
            raise ValueError("fixture layout mismatch")
        if item["admission"] not in ("admit", "reject-before-worker"):
            raise ValueError("unsupported expected admission")
        records.append({key: item[key] for key in ("name", "sha256", "bytes", "admission")})
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    receipt = {"format": "aurialis-private-normalization-harness-1", "publicActivation": False, "fixtureManifestSHA256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(), "files": {}}
    def write(name, data):
        (args.out / name).write_bytes(data)
        receipt["files"][name] = hashlib.sha256(data).hexdigest()
    for name in ("client.mjs", "worker.mjs", "contract.mjs", "harness.mjs", "index.html"):
        write(name, (source / name).read_bytes())
    write("style.css", (source.parent / "style.css").read_bytes())
    write("LICENSE", (source.parents[2] / "LICENSE").read_bytes())
    write("NOTICE", (source.parents[2] / "NOTICE").read_bytes())
    shader = (source / "rmsnorm256.wgsl").read_bytes()
    receipt["shaderSHA256"] = hashlib.sha256(shader).hexdigest()
    write("shader.mjs", ("// Private two-pass original L2*sqrt256 fixture; see LICENSE/NOTICE.\nexport const SHADER_SOURCE = " + json.dumps(shader.decode()) + ";\n").encode())
    write("fixture-index.mjs", ("// Exact whole-file hashes of actual Go and pinned-original traces.\nexport const FIXTURE_SHA256 = Object.freeze(" + json.dumps([item["sha256"] for item in records if item["admission"] == "admit"]) + ");\nexport const FIXTURE_FILES = Object.freeze(" + json.dumps(records) + ");\n").encode())
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
