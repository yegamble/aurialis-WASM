# cspell:words Solovyev roformer tobytes frombuffer einsum SDPA AURAGO AURATT
"""Bounded actual original Attend endpoints and separately labeled eight probes.

Copyright (c) 2024 Roman Solovyev (ZFTurbo), original Attend source, MIT.
The pinned module is loaded unchanged. See ../LICENSE and ../NOTICE.
No model, checkpoint, audio or GPU operation is loaded or executed.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import time

SOURCE_SHA = "c7abbc40a3fd20ff7f6001fa9f8ee9ad5df6452272712a5e719b8f8468bf2223"
OUTPUT_CAP = 64 * 1024 * 1024
MAX_CASES = 32


def checked(path, root, maximum):
    if path.is_symlink() or path.resolve(strict=True).parent != root or not path.is_file() or not 1 <= path.stat().st_size <= maximum:
        raise ValueError("unsafe bounded fixture source")
    return path.read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--go-fixtures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    source = args.source.read_bytes()
    if len(source) > 32768 or digest(source) != SOURCE_SHA:
        raise ValueError("pinned MIT original Attend source mismatch")
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        if os.environ.get(name) != "1":
            raise ValueError("single-thread policy must precede interpreter startup")
    import torch
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.set_flush_denormal(False)
    namespace = {"__name__": "aurialis_private_pinned_attend"}
    # Only this exact checksum-pinned, reviewed MIT module is executed.
    exec(compile(source, str(args.source), "exec"), namespace)  # noqa: S102
    root = args.go_fixtures.resolve(strict=True)
    manifest_data = checked(root / "manifest.json", root, 65536)
    manifest = json.loads(manifest_data)
    records = manifest.get("cases")
    if manifest.get("format") != "aurialis-private-attention-go-1" or not isinstance(records, list) or not 1 <= len(records) <= MAX_CASES:
        raise ValueError("invalid closed Go manifest")
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    total = len(manifest_data) + sum(item["bytes"] for item in records)
    if total >= OUTPUT_CAP:
        raise ValueError("combined new producer output already exceeds64MiB")
    seen = set()
    output_records = []
    original_einsum = torch.einsum
    captured = {}

    def capture_einsum(equation, *operands):
        result = original_einsum(equation, *operands)
        if equation == "b h i d, b h j d -> b h i j":
            captured["raw"] = result.detach().clone()
        return result

    namespace["einsum"] = capture_einsum
    math_layer = namespace["Attend"](dropout=0.0, flash=False).eval()
    sdpa_layer = namespace["Attend"](dropout=0.0, flash=True).eval()
    probabilities = []
    hook = math_layer.attn_dropout.register_forward_pre_hook(lambda _module, inputs: probabilities.append(inputs[0].detach().clone()))
    try:
        for record in records:
            if time.monotonic() - started > 25:
                raise TimeoutError("attention original producer exceeded25seconds")
            name = record["name"]
            if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]+-m[0-9]+-n[0-9]+\.go\.bin", name) or name in seen:
                raise ValueError("unsafe or duplicate Go fixture name")
            seen.add(name)
            raw = checked(root / name, root, 2 * 1024 * 1024)
            if len(raw) != record["bytes"] or digest(raw) != record["sha256"]:
                raise ValueError("Go fixture byte/hash mismatch")
            magic, m, n, width, reserved = struct.unpack_from("<8s4I", raw)
            if magic != b"AURAGO01" or not 1 <= m <= 8 or not 1 <= n <= 1723 or width != 64 or reserved or [m, n] != [record["m"], record["n"]]:
                raise ValueError("invalid Go attention geometry")
            counts = [m * 64, n * 64, n * 64, m * n, m * n, m * 64]
            if len(raw) != 24 + 4 * sum(counts):
                raise ValueError("invalid Go attention layout")
            data = torch.frombuffer(bytearray(raw[24:]), dtype=torch.float32)
            if not torch.isfinite(data).all():
                raise ValueError("nonfinite Go operand/reference")
            offset = 0
            arrays = []
            for count in counts:
                arrays.append(data[offset:offset + count])
                offset += count
            q, k, v = (arrays[0].reshape(1, 1, m, 64), arrays[1].reshape(1, 1, n, 64), arrays[2].reshape(1, 1, n, 64))
            if q.abs().max() > 16 or k.abs().max() > 16 or v.abs().max() > 32:
                raise ValueError("operand magnitude admission exceeded")
            captured.clear()
            probabilities.clear()
            with torch.inference_mode():
                math_output = math_layer(q, k, v)
                if len(probabilities) != 1 or "raw" not in captured:
                    raise ValueError("actual original math instrumentation changed")
                math_raw, math_probability = captured["raw"], probabilities[0]
                sdpa_output = sdpa_layer(q, k, v)
                # These explicit operations are probes, never claimed SDPA internals.
                probe_raw = original_einsum("b h i d, b h j d -> b h i j", q, k)
                scaled = probe_raw * 0.125
                maximum = scaled.amax(dim=-1, keepdim=True)
                shifted = scaled - maximum
                exponential = shifted.exp()
                denominator = exponential.sum(dim=-1, keepdim=True)
                probability = exponential / denominator
                probe_output = original_einsum("b h i j, b h j d -> b h i d", probability, v)
            if not torch.equal(probe_raw, math_raw):
                raise ValueError("identical actual and probe raw einsum changed")
            combined_arrays = arrays + [math_raw, math_probability, math_output, sdpa_output, probe_raw, scaled, maximum, shifted, exponential, denominator, probability, probe_output]
            for tensor in combined_arrays:
                if not torch.isfinite(tensor).all():
                    raise ValueError("nonfinite actual original/probe trace")
            payload = b"AURATT01" + raw[8:24] + b"".join(t.contiguous().numpy().astype("<f4", copy=False).tobytes() for t in combined_arrays)
            total += len(payload)
            if total > OUTPUT_CAP - 65536:
                raise ValueError("combined new producer output exceeds64MiB")
            output_name = name.replace(".go.bin", ".bin")
            (args.out / output_name).write_bytes(payload)
            probe_difference = (probe_output - math_output).abs().max().item()
            record_out = {**record, "name": output_name, "bytes": len(payload), "sha256": digest(payload), "goTraceSHA256": record["sha256"], "probeVsActualMathMaximumDifference": probe_difference, "cpuSDPAVsActualMathMaximumDifference": (sdpa_output - math_output).abs().max().item()}
            if record["kind"] == "ftz-resurrection":
                record_out["ftzResurrection"] = {"rawTail": probe_raw.flatten()[1].item(), "scoreTail": scaled.flatten()[1].item(), "expTail": exponential.flatten()[1].item(), "probabilityTail": probability.flatten()[1].item(), "probeOutput": probe_output.flatten()[0].item(), "actualGoOutput": arrays[5][0].item(), "actualMathOutput": math_output.flatten()[0].item(), "actualCPUSDPAOutput": sdpa_output.flatten()[0].item(), "classification": "underflow-limited regardless of observed final/zero"}
            output_records.append(record_out)
    finally:
        hook.remove()
    metadata = {"format": "aurialis-private-attention-traces-1", "publicActivation": False, "sourceSHA256": SOURCE_SHA, "goManifestSHA256": digest(manifest_data), "goBackend": manifest["backend"], "torchVersion": str(torch.__version__), "torchThreads": torch.get_num_threads(), "torchInteropThreads": torch.get_num_interop_threads(), "torchFlushDenormal": False, "modelForwards": 0, "gpuOperations": 0, "scope": "actual Go endpoint; exact pinned original Attend math + CPU SDPA endpoints; eight separately labeled unfused PyTorch probes", "stages": ["raw", "scaled", "maximum", "shifted", "exponential", "denominator", "probability", "output"], "cases": output_records}
    payload = (json.dumps(metadata, indent=2, allow_nan=False) + "\n").encode()
    if total + len(payload) > OUTPUT_CAP:
        raise ValueError("combined producer output metadata exceeds64MiB")
    (args.out / "manifest.json").write_bytes(payload)
    print(json.dumps({"cases": len(output_records), "combinedNewFixtureBytes": total + len(payload), "torchVersion": metadata["torchVersion"], "threads": metadata["torchThreads"], "interopThreads": metadata["torchInteropThreads"], "elapsedSeconds": time.monotonic() - started, "modelForwards": 0, "gpuOperations": 0, "ftzResurrection": next(item["ftzResurrection"] for item in output_records if "ftzResurrection" in item)}, allow_nan=False))


if __name__ == "__main__":
    main()
