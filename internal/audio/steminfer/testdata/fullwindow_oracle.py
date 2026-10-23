# cspell:words nextafter rfft Solovyev gelu randn stft onesided Roformer istft tobytes
"""Bounded full-context diagnostic derived from the independent original oracle.

The sibling oracle.py is unchanged and remains the original conformance oracle.
This evaluator changes only independent batch/query tiling, never key coverage,
weights, rotary frequencies, normalization epsilon, or the trained context.

Derived from ZFTurbo/Music-Source-Separation-Training, MIT (Roman Solovyev,
2024), source commit 6fdad13686bb7e84d029ec66f9dbe76e65c93ebf.
See ../LICENSE and ../NOTICE. No network access, arbitrary pickle execution,
model conversion, or production dependency is introduced by this script.
"""
import argparse
import hashlib
import json
import math
import struct
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
    parser.add_argument("--source-wav", type=Path)
    parser.add_argument("--query-tile", type=int, default=32)
    parser.add_argument("--batch-tile", type=int, default=8)
    parser.add_argument("--capture-all", action="store_true")
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--fft-variant", choices=("original_f32", "f64_rounded", "pcm_one_lsb"), default="original_f32")
    args = parser.parse_args()
    if not 1025 <= args.samples <= 882000:
        raise ValueError("bounded inference window required")
    if not 1 <= args.query_tile <= 64 or not 1 <= args.batch_tile <= 8 or not 1 <= args.threads <= 4:
        raise ValueError("bounded diagnostic tiling/thread policy required")
    if args.capture_all and args.samples > 8192:
        raise ValueError("full intermediate capture is restricted to short conformance fixtures")
    digest = hashlib.sha256()
    with args.checkpoint.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(part)
    if digest.hexdigest() != ORIGINAL_SHA:
        raise ValueError("original checkpoint checksum mismatch")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=True, mmap=True)
    captured = {}
    widened = {}

    def weight(name):
        if name not in widened:
            value = state[name]
            if value.dtype != torch.float16 or not torch.isfinite(value).all():
                raise ValueError("invalid original weight " + name)
            widened[name] = value.float()
        return widened[name]

    def capture(name, value):
        if args.capture_all or name in ("source", "window", "features") or name.startswith("pcm."):
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

    def attention(q, k, v):
        # Every query still sees every key in the original full context.
        # Only independent output rows are tiled; no local attention is used.
        attended = torch.empty_like(q)
        for first in range(0, q.shape[-2], args.query_tile):
            last = min(first + args.query_tile, q.shape[-2])
            scores = q[..., first:last, :] @ k.transpose(-1, -2) * (64 ** -0.5)
            attended[..., first:last, :] = scores.softmax(-1) @ v
        return attended

    def transformer(value, prefix):
        result = torch.empty_like(value)
        for first in range(0, value.shape[0], args.batch_tile):
            last = min(first + args.batch_tile, value.shape[0])
            result[first:last] = transformer_batch(value[first:last], prefix)
        return result

    def transformer_batch(value, prefix):
        a, f = prefix + ".layers.0.0", prefix + ".layers.0.1.net"
        xn = norm(value, a + ".norm.gamma")
        batch, length, _ = xn.shape
        qkv = linear(xn, a + ".to_qkv", False).reshape(batch, length, 3, 8, 64)
        q, k, v = [qkv[:, :, i].transpose(1, 2) for i in range(3)]
        frequencies = weight(a + ".rotary_embed.freqs")
        q, k = rotate(q, frequencies), rotate(k, frequencies)
        # Explicit original softmax attention; no causal/local approximation.
        attended = attention(q, k, v)
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
    source_frames = args.samples
    source_sha256 = None
    if args.source_wav:
        if not 44 + 1025 * 8 <= args.source_wav.stat().st_size <= 44 + args.samples * 8:
            raise ValueError("source must be a bounded canonical stereo F32 WAV")
        raw = args.source_wav.read_bytes()
        if (raw[:4] != b"RIFF" or raw[8:16] != b"WAVEfmt " or
                struct.unpack_from("<IHHIIHH", raw, 16) != (16, 3, 2, 44100, 352800, 8, 32) or
                raw[36:40] != b"data" or struct.unpack_from("<I", raw, 4)[0] != len(raw) - 8 or
                struct.unpack_from("<I", raw, 40)[0] != len(raw) - 44 or (len(raw)-44) % 8):
            raise ValueError("source canonical WAV layout mismatch")
        source_frames = (len(raw) - 44) // 8
        source = torch.frombuffer(bytearray(raw[44:]), dtype=torch.float32).reshape(source_frames, 2).T.contiguous()
        if not torch.isfinite(source).all():
            raise ValueError("nonfinite source")
        source = F.pad(source, (0, args.samples-source_frames))
        source_sha256 = hashlib.sha256(raw).hexdigest()
    if args.fft_variant == "pcm_one_lsb":
        source = torch.nextafter(source, torch.full_like(source, float("inf")))
    capture("source", source)
    window = torch.hann_window(2048, periodic=True, dtype=torch.float32)
    capture("window", window)
    started = time.perf_counter()
    with torch.inference_mode():
        spectrum = torch.stft(source, 2048, 512, 2048, window, center=True, pad_mode="reflect", normalized=False, onesided=True, return_complex=True)
        if args.fft_variant == "f64_rounded":
            # Independent conditioning probe: preserve original F32 multiply,
            # evaluate its FFT accurately in F64, then round features to F32.
            framed = F.pad(source, (1024, 1024), mode="reflect").unfold(-1, 2048, 512)
            windowed = framed * window
            spectrum = torch.fft.rfft(windowed.double(), n=2048).to(torch.complex64).transpose(1, 2).contiguous()
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
            print(json.dumps({"layer": layer, "elapsedSeconds": time.perf_counter()-started}), flush=True)
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
    metadata = {"format": "aurialis-original-full-window-v1", "sourceFrames": source_frames,
                "sourceWavSHA256": source_sha256, "queryTile": args.query_tile,
                "batchTile": args.batch_tile, "threads": args.threads,
                "captureAll": args.capture_all, "fullKeyAttention": True, "fftVariant": args.fft_variant, "fixture": "canonical_wav" if args.source_wav else "broadband" if args.broadband else "tonal", "architectureCommit": "6fdad13686bb7e84d029ec66f9dbe76e65c93ebf", "originalSHA256": ORIGINAL_SHA, "samples": args.samples, "dtype": "F32", "tensors": {}}
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
