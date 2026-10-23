"""Recover a deterministic existing-F16 five-head archive from pinned Mega53.

Development/build-time only: never imported by the Go product or request path.
The original checkpoint is checksum-pinned before safe weights-only mmap loading.
No quantization or F32-to-F16 conversion is permitted. Every output tensor is
verified byte-for-byte against its selected original tensor after serialization.

Architecture: ZFTurbo/Music-Source-Separation-Training commit
6fdad13686bb7e84d029ec66f9dbe76e65c93ebf, MIT (Roman Solovyev, 2024).
See ../LICENSE and ../NOTICE. The recovered container may have a different hash
from the lost historical archive; its fresh manifest must be reviewed explicitly.
"""
# cspell:words Solovyev safetensors mmap fsync dtype numel uint16 tobytes WRONLY CREAT

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile

ORIGINAL_SHA256 = "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f"
ORIGINAL_BYTES = 1368919887
ARCHITECTURE_COMMIT = "6fdad13686bb7e84d029ec66f9dbe76e65c93ebf"
CONFIG_SHA256 = "7e198062a251587088adb91215a4f44ab59e67bd62fcc805cf54d6e7dfc51103"
HISTORICAL_SUBSET_SHA256 = "2e551e9e50a0be1adf0d955492523f019eea913c79697c73b362aee086af8384"
HEADS = [("vocals", 49), ("drums", 15), ("bass", 4), ("guitar", 20), ("piano", 33)]
BANDS = [2] * 24 + [4] * 12 + [12] * 8 + [24] * 8 + [48] * 8 + [128, 129]


def expected_shapes():
    shapes = {}
    for band, bins in enumerate(BANDS):
        prefix = f"band_split.to_features.{band}."
        shapes[prefix + "0.gamma"] = [bins * 4]
        shapes[prefix + "1.weight"] = [256, bins * 4]
        shapes[prefix + "1.bias"] = [256]
    block = {
        "0.rotary_embed.freqs": [32], "0.norm.gamma": [256],
        "0.to_qkv.weight": [1536, 256], "0.to_gates.weight": [8, 256],
        "0.to_gates.bias": [8], "0.to_out.0.weight": [256, 512],
        "1.net.0.gamma": [256], "1.net.1.weight": [1024, 256],
        "1.net.1.bias": [1024], "1.net.4.weight": [256, 1024],
        "1.net.4.bias": [256],
    }
    for layer in range(12):
        for axis in range(2):
            for suffix, shape in block.items():
                shapes[f"layers.{layer}.{axis}.layers.0.{suffix}"] = shape
    shapes["final_norm.gamma"] = [256]
    for head in range(5):
        for band, bins in enumerate(BANDS):
            prefix = f"mask_estimators.{head}.to_freqs.{band}.0."
            shapes[prefix + "0.weight"] = [512, 256]
            shapes[prefix + "0.bias"] = [512]
            shapes[prefix + "2.weight"] = [bins * 8, 512]
            shapes[prefix + "2.bias"] = [bins * 8]
    return shapes


def original_key(name):
    if not name.startswith("mask_estimators."):
        return name
    fields = name.split(".")
    fields[1] = str(HEADS[int(fields[1])][1])
    return ".".join(fields)


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def tensor_bytes(tensor, torch):
    if tensor.dtype != torch.float16 or tensor.layout != torch.strided:
        raise ValueError("original F16 strided tensor required")
    if not torch.isfinite(tensor).all():
        raise ValueError("non-finite original weight")
    # Viewing the original bits preserves signed zero, subnormals and stored
    # F16 rotary frequencies. No recomputation or narrowing is performed.
    return tensor.detach().cpu().contiguous().view(torch.uint16).numpy().astype("<u2", copy=False).tobytes()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.checkpoint.stat().st_size != ORIGINAL_BYTES or file_sha256(args.checkpoint) != ORIGINAL_SHA256:
        raise ValueError("original checkpoint pin mismatch")
    if args.output.exists() or args.output.with_suffix(".manifest.json").exists():
        raise ValueError("refuse to replace an existing research archive or manifest")
    if not args.output.parent.is_dir():
        raise ValueError("output parent must already exist")
    # Optional development dependencies load only after the immutable pin and
    # output checks. No installation, network operation or arbitrary pickle load.
    import torch
    from safetensors import safe_open
    torch.set_num_threads(1)
    original = torch.load(args.checkpoint, map_location="cpu", weights_only=True, mmap=True)
    shapes = expected_shapes()
    entries = {}
    proofs = {}
    offset = 0
    for name in sorted(shapes):
        source_name = original_key(name)
        tensor = original[source_name]
        if list(tensor.shape) != shapes[name]:
            raise ValueError("original shape mismatch: " + source_name)
        raw = tensor_bytes(tensor, torch)
        entries[name] = {"dtype": "F16", "shape": shapes[name], "data_offsets": [offset, offset + len(raw)]}
        proofs[name] = {"source": source_name, "shape": shapes[name], "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        offset += len(raw)
    if len(entries) != 1691 or offset != 88152812 * 2:
        raise ValueError("closed five-head parameter count mismatch")
    metadata = {
        "format": "pt", "source_sha256": ORIGINAL_SHA256,
        "architecture_commit": ARCHITECTURE_COMMIT, "config_sha256": CONFIG_SHA256,
        "variant": "aurialis-five-existing-f16-v1",
        "head_map": "0=49:vocals,1=15:drums,2=4:bass,3=20:guitar,4=33:piano",
    }
    header = json.dumps({"__metadata__": metadata, **entries}, separators=(",", ":"), sort_keys=True).encode("utf-8")
    header += b" " * (-len(header) % 8)
    temporary = None
    archive_published = False
    manifest_published = False
    manifest_path = args.output.with_suffix(".manifest.json")
    try:
        with tempfile.NamedTemporaryFile(dir=args.output.parent, prefix=".five-heads-", suffix=".tmp", delete=False) as target:
            temporary = Path(target.name)
            os.chmod(temporary, 0o600)
            target.write(struct.pack("<Q", len(header)))
            target.write(header)
            for name in sorted(entries):
                raw = tensor_bytes(original[proofs[name]["source"]], torch)
                if hashlib.sha256(raw).hexdigest() != proofs[name]["sha256"]:
                    raise ValueError("original tensor changed while serializing")
                target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        # An independent safe loader parses the completed container and checks
        # every selected tensor against the actual original bytes, not a copy
        # transformed through a lower-precision or recomputed parameter path.
        with safe_open(temporary, framework="pt", device="cpu") as restored:
            if set(restored.keys()) != set(entries):
                raise ValueError("restored closed schema mismatch")
            for name in sorted(entries):
                got = tensor_bytes(restored.get_tensor(name), torch)
                want = tensor_bytes(original[proofs[name]["source"]], torch)
                if got != want or list(restored.get_tensor(name).shape) != shapes[name]:
                    raise ValueError("restored tensor differs from original: " + name)
        archive_sha = file_sha256(temporary)
        manifest = {
            "format": "aurialis-existing-f16-recovery-v1", "architectureCommit": ARCHITECTURE_COMMIT,
            "originalSHA256": ORIGINAL_SHA256, "originalBytes": ORIGINAL_BYTES, "configSHA256": CONFIG_SHA256,
            "archiveSHA256": archive_sha, "archiveBytes": temporary.stat().st_size,
            "historicalSubsetSHA256": HISTORICAL_SUBSET_SHA256,
            "matchesHistoricalArchive": archive_sha == HISTORICAL_SUBSET_SHA256,
            "tensorCount": len(proofs), "parameterCount": offset // 2,
            "conversion": "No quantization; exact existing F16 bytes selected and heads renamed; all tensors reloaded and compared byte-for-byte to original.",
            "licenseReference": "https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838",
            "tensors": proofs,
        }
        # A new archive hash is recorded honestly; it is never silently treated
        # as the historical baseline or automatically enabled by the product.
        os.link(temporary, args.output)
        archive_published = True
        descriptor = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        manifest_published = True
        with os.fdopen(descriptor, "w") as target:
            target.write(json.dumps(manifest, indent=2) + "\n")
            target.flush()
            os.fsync(target.fileno())
        print(json.dumps({k: v for k, v in manifest.items() if k != "tensors"}, indent=2))
    except BaseException:
        # Never remove a pre-existing path when publication loses a race. Only
        # newly created output names belong to this invocation.
        if manifest_published:
            manifest_path.unlink(missing_ok=True)
        if archive_published:
            args.output.unlink(missing_ok=True)
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
