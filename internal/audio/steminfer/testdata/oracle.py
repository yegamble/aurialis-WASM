# cspell:words Solovyev gelu randn stft onesided Roformer istft tobytes
"""Independent development oracle for the original Mega53 PyTorch architecture.

Derived from ZFTurbo/Music-Source-Separation-Training, MIT (Roman Solovyev,
2024), source commit 6fdad13686bb7e84d029ec66f9dbe76e65c93ebf.
See ../LICENSE and ../NOTICE. No network access, arbitrary pickle execution,
model conversion, or production dependency is introduced by this script.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import time

import torch
import torch.nn.functional as F

ORIGINAL_SHA = "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f"
BANDS = [2] * 24 + [4] * 12 + [12] * 8 + [24] * 8 + [48] * 8 + [128, 129]
HEADS = [("vocal", 49), ("drums", 15), ("bass", 4), ("guitar", 20), ("piano", 33)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=2053)
    parser.add_argument("--broadband", action="store_true")
    args = parser.parse_args()
    if not 1025 <= args.samples <= 882000:
        raise ValueError("bounded inference window required")
    digest = hashlib.sha256()
    with args.checkpoint.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(part)
    if digest.hexdigest() != ORIGINAL_SHA:
        raise ValueError("original checkpoint checksum mismatch")
    torch.set_num_threads(4)
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=True, mmap=True)
    captured = {}

    def weight(name):
        value = state[name]
        if value.dtype != torch.float16 or not torch.isfinite(value).all():
            raise ValueError("invalid original weight " + name)
        return value.float()

    def capture(name, value):
        captured[name] = value.detach().contiguous().float()

    def norm(value, name):
        return F.normalize(value, dim=-1, p=2, eps=1e-12) * math.sqrt(value.shape[-1]) * weight(name)

    def linear(value, prefix, bias=True):
        return F.linear(value, weight(prefix + ".weight"), weight(prefix + ".bias") if bias else None)

    def rotate(value, frequencies):
        # The checkpoint's original F16 frequencies are widened exactly. They
        # must not be replaced by newly computed F32 rotary frequencies.
        angles = torch.arange(value.shape[-2], dtype=torch.float32)[:, None] * frequencies[None, :]
        cosine = angles.cos().repeat_interleave(2, -1)
        sine = angles.sin().repeat_interleave(2, -1)
        pairs = value.reshape(*value.shape[:-1], 32, 2)
        rotated = torch.stack((-pairs[..., 1], pairs[..., 0]), -1).flatten(-2)
        return value * cosine + rotated * sine

    def transformer(value, prefix):
        a, f = prefix + ".layers.0.0", prefix + ".layers.0.1.net"
        xn = norm(value, a + ".norm.gamma")
        batch, length, _ = xn.shape
        qkv = linear(xn, a + ".to_qkv", False).reshape(batch, length, 3, 8, 64)
        q, k, v = [qkv[:, :, i].transpose(1, 2) for i in range(3)]
        frequencies = weight(a + ".rotary_embed.freqs")
        q, k = rotate(q, frequencies), rotate(k, frequencies)
        # Explicit original softmax attention; no causal/local approximation.
        attended = (q @ k.transpose(-1, -2) * (64 ** -0.5)).softmax(-1) @ v
        attended *= linear(xn, a + ".to_gates").sigmoid().transpose(1, 2).unsqueeze(-1)
        value = value + linear(attended.transpose(1, 2).reshape(batch, length, 512), a + ".to_out.0", False)
        hidden = F.gelu(linear(norm(value, f + ".0.gamma"), f + ".1"), approximate="none")
        return value + linear(hidden, f + ".4")

    index = torch.arange(args.samples, dtype=torch.float64)
    left = .01 + .12 * torch.sin(index * (2 * math.pi * 997 / 44100)) + .03 * torch.cos(index.square() * .000017)
    right = -.02 + .09 * torch.sin(index * (2 * math.pi * 631 / 44100)) - .04 * torch.cos(index * .29)
    if args.broadband:
        generator = torch.Generator().manual_seed(99271)
        noise = torch.randn((2, args.samples), generator=generator, dtype=torch.float32)
        left += .005 * noise[0].double()
        right += .005 * noise[1].double()
    left[0], right[-1] = .7, -.4
    source = torch.stack((left, right)).float()
    capture("source", source)
    window = torch.hann_window(2048, periodic=True, dtype=torch.float32)
    capture("window", window)
    started = time.perf_counter()
    with torch.inference_mode():
        spectrum = torch.stft(source, 2048, 512, 2048, window, center=True, pad_mode="reflect", normalized=False, onesided=True, return_complex=True)
        # bin then channel then real/imaginary, with time leading.
        features = torch.view_as_real(spectrum).permute(2, 1, 0, 3).contiguous().flatten(1)
        capture("features", features)
        values = []
        offset = 0
        for band, bins in enumerate(BANDS):
            width = bins * 4
            values.append(linear(norm(features[:, offset:offset + width], f"band_split.to_features.{band}.0.gamma"), f"band_split.to_features.{band}.1"))
            offset += width
        hidden = torch.stack(values, 0)
        capture("band_split", hidden)
        for layer in range(12):
            hidden = transformer(hidden, f"layers.{layer}.0")
            if layer in (0, 11):
                capture(f"layer{layer}.time", hidden)
            hidden = transformer(hidden.transpose(0, 1), f"layers.{layer}.1").transpose(0, 1).contiguous()
            if layer in (0, 11):
                capture(f"layer{layer}.frequency", hidden)
        hidden = norm(hidden, "final_norm.gamma")
        capture("hidden", hidden)
        for label, original in HEADS:
            parts = []
            for band in range(len(BANDS)):
                prefix = f"mask_estimators.{original}.to_freqs.{band}.0"
                parts.append(F.glu(linear(linear(hidden[band], prefix + ".0").tanh(), prefix + ".2"), dim=-1))
            mask = torch.cat(parts, -1)
            capture("mask." + label, mask)
            mask = torch.view_as_complex(mask.reshape(features.shape[0], 1025, 2, 2).contiguous()).permute(2, 1, 0)
            predicted = spectrum * mask
            predicted[:, 0] = 0  # original BSRoformer zero_dc=True
            output = torch.istft(predicted, 2048, 512, 2048, window, center=True, normalized=False, onesided=True, length=args.samples)
            capture("pcm." + label, output)
    args.out.mkdir(parents=True, exist_ok=True)
    metadata = {"fixture": "broadband" if args.broadband else "tonal", "architectureCommit": "6fdad13686bb7e84d029ec66f9dbe76e65c93ebf", "originalSHA256": ORIGINAL_SHA, "samples": args.samples, "dtype": "F32", "tensors": {}}
    offset = 0
    with (args.out / "oracle.bin").open("wb") as target:
        for name, value in captured.items():
            raw = value.numpy().astype("<f4", copy=False).tobytes()
            metadata["tensors"][name] = {"shape": list(value.shape), "offset": offset, "bytes": len(raw)}
            target.write(raw)
            offset += len(raw)
    metadata["binarySHA256"] = hashlib.sha256((args.out / "oracle.bin").read_bytes()).hexdigest()
    metadata["elapsedSeconds"] = time.perf_counter() - started
    (args.out / "oracle.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"bytes": offset, "samples": args.samples, "tensors": len(captured), "elapsedSeconds": metadata["elapsedSeconds"]}))


if __name__ == "__main__":
    main()
