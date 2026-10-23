"""Prepare only pinned private fixture code; no model/audio fetching or assets."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    manifest = json.loads((source / "source-manifest.json").read_text())
    for relative, item in manifest["files"].items():
        data = (source / relative).read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Pinned upstream shader changed: " + relative)
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    names = ("worker.mjs", "client.mjs", "contract.mjs", "harness.mjs", "index.html", "style.css", "LICENSE", "NOTICE")
    receipt = {"format": "aurialis-private-gpu-harness-1", "publicActivation": False, "files": {}}
    for name in names:
        data = (source / name).read_bytes()
        (args.out / name).write_bytes(data)
        receipt["files"][name] = hashlib.sha256(data).hexdigest()
    shader = (source / "upstream/matmul.wgsl").read_text()
    module = ("// Generated from the exact pinned MIT s64 source; see source NOTICE.\nexport const SHADER_SOURCE = " + json.dumps(shader) + ";\n").encode()
    (args.out / "shader.mjs").write_bytes(module)
    receipt["files"]["shader.mjs"] = hashlib.sha256(module).hexdigest()
    receipt["shaderSHA256"] = hashlib.sha256(shader.encode()).hexdigest()
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
