# cspell:words Solovyev RMSNorm tobytes frombuffer fsum roformer reassociation
"""Private original L2 normalization *sqrt256 trace; no model forward pass.

The pinned RMSNorm class is extracted unchanged from Roman Solovyev's original
MIT source (2024). See ../LICENSE and ../NOTICE. Actual Go outputs stay in the
fixture beside actual original PyTorch outputs; neither replaces the other.
"""
import argparse
import ast
import hashlib
import inspect
import json
import math
from pathlib import Path
import re
import struct

SOURCE_SHA = "a6f670325cdb8a7a212914f62602119b23eb888df9bcfe4a85f9be74728b3ef4"
ORIGINAL_SHA = "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f"
GAMMA_NAME = "layers.0.0.layers.0.0.norm.gamma"


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--go-fixtures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if digest_file(args.source) != SOURCE_SHA or digest_file(args.checkpoint) != ORIGINAL_SHA:
        raise ValueError("pinned original source/checkpoint checksum mismatch")
    source = args.source.read_text()
    classes = [node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == "RMSNorm"]
    if len(classes) != 1:
        raise ValueError("original RMSNorm class changed")
    import torch
    import torch.nn.functional as functional
    torch.set_num_threads(1)
    if inspect.signature(functional.normalize).parameters["eps"].default != 1e-12:
        raise ValueError("original default normalization epsilon changed")
    namespace = {"torch": torch, "nn": torch.nn, "Module": torch.nn.Module, "F": functional}
    # Only the exact checksum-pinned original class is executed, not its imports,
    # model constructors or any untrusted checkpoint-provided Python objects.
    code = compile(ast.Module(body=classes, type_ignores=[]), str(args.source), "exec")
    exec(code, namespace)  # noqa: S102 -- Exact pinned MIT original class only.
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=True, mmap=True)
    original_gamma = state[GAMMA_NAME]
    if original_gamma.dtype != torch.float16 or tuple(original_gamma.shape) != (256,) or not torch.isfinite(original_gamma).all():
        raise ValueError("original gamma shape/dtype/finite check failed")
    gamma_bytes = original_gamma.float().contiguous().numpy().tobytes()
    root = args.go_fixtures.resolve(strict=True)
    manifest_path = root / "manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 65536:
        raise ValueError("invalid bounded Go manifest")
    go_manifest = json.loads(manifest_path.read_text())
    cases = go_manifest.get("cases")
    if go_manifest.get("format") != "aurialis-private-norm-go-1" or not isinstance(cases, list) or not 1 <= len(cases) <= 64:
        raise ValueError("invalid Go fixture manifest")
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    records = []
    seen = set()
    for record in cases:
        name = record["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]+-r[0-9]+\.go\.bin", name) or name in seen:
            raise ValueError("invalid or repeated Go fixture name")
        seen.add(name)
        path = root / name
        if path.is_symlink() or path.resolve(strict=True).parent != root or not 24 <= path.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError("invalid bounded Go fixture")
        data = path.read_bytes()
        if len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("Go trace checksum mismatch")
        magic, rows, width, reserved1, reserved2 = struct.unpack_from("<8s4I", data)
        size = rows * 256 * 4
        if magic != b"AURNGO01" or not 1 <= rows <= 512 or width != 256 or reserved1 or reserved2 or len(data) != 24 + 2 * size + 1024 + 8 * rows:
            raise ValueError("Go trace layout mismatch")
        x = torch.frombuffer(bytearray(data[24:24 + size]), dtype=torch.float32).reshape(rows, 256)
        gamma = torch.frombuffer(bytearray(data[24 + size:24 + size + 1024]), dtype=torch.float32)
        if not torch.isfinite(x).all() or not torch.isfinite(gamma).all():
            raise ValueError("nonfinite normalization operands")
        if record["gamma"] == GAMMA_NAME and gamma.numpy().tobytes() != gamma_bytes:
            raise ValueError("Go gamma differs from exact original F16 widening")
        layer = namespace["RMSNorm"](256)
        with torch.no_grad():
            layer.gamma.copy_(gamma)
        with torch.inference_mode():
            result = layer(x).contiguous()
            norms = x.norm(p=2, dim=-1).contiguous()
        if not torch.isfinite(result).all():
            raise ValueError("nonfinite original normalization output")
        if record["admission"] != "reject-before-worker" and not torch.isfinite(norms).all():
            raise ValueError("unexpected nonfinite original normalization norm")
        name = name.replace(".go.bin", ".bin")
        combined = b"AUNORM01" + data[8:] + result.numpy().tobytes() + norms.numpy().tobytes()
        (args.out / name).write_bytes(combined)
        output = {**record, "name": name, "bytes": len(combined), "sha256": hashlib.sha256(combined).hexdigest(), "goTraceSHA256": record["sha256"]}
        records.append(output)
    metadata = {"format": "aurialis-private-norm-traces-1", "publicActivation": False,
                "operation": "original L2 normalization, max(norm,1e-12), then sqrt256 then raw gamma",
                "sourceSHA256": SOURCE_SHA, "originalCheckpointSHA256": ORIGINAL_SHA,
                "goManifestSHA256": digest_file(manifest_path), "goModelSHA256": go_manifest["modelSHA256"],
                "originalTraceSHA256": go_manifest["originalTraceSHA256"], "torchVersion": str(torch.__version__),
                "torchThreads": torch.get_num_threads(), "cases": records}
    (args.out / "manifest.json").write_text(json.dumps(metadata, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"cases": len(records), "torchVersion": metadata["torchVersion"], "torchThreads": metadata["torchThreads"], "modelForwardPasses": 0}))


if __name__ == "__main__":
    main()
