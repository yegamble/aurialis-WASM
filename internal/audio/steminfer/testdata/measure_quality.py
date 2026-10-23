"""Independent private quality/precision report from immutable saved PCM.

No prediction is time-aligned, gain-adjusted, equalized or remixed before these
measurements. SI-SDR itself uses the standard scale-invariant projection; actual
scale-dependent SDR, RMS ratio and peak are reported alongside it.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf

LABELS = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def read_wav(path, expected):
    if path.stat().st_size != 3528044 or digest(path) != expected:
        raise ValueError("immutable fixed-length evaluation WAV changed")
    samples, rate = sf.read(path, dtype="float64", always_2d=True)
    if rate != 44100 or samples.shape != (441000, 2) or not np.isfinite(samples).all():
        raise ValueError("invalid fixed evaluation output")
    return samples


def quality(reference, prediction):
    wanted = reference - reference.mean(axis=0)
    actual = prediction - prediction.mean(axis=0)
    energy = float(np.sum(wanted * wanted))
    if energy == 0:
        return {"available": False, "reason": "truth has no energy"}
    projection = wanted * (float(np.sum(actual * wanted)) / energy)
    projected_energy = float(np.sum(projection * projection))
    remaining = float(np.sum((actual - projection) ** 2))
    actual_energy = float(np.sum(actual * actual))
    raw_truth_energy = float(np.sum(reference * reference))
    raw_actual_energy = float(np.sum(prediction * prediction))
    raw_error_energy = float(np.sum((prediction - reference) ** 2))
    return {"available": True,
            "siSdrDb": 10 * math.log10(projected_energy / max(remaining, 1e-30)) if projected_energy else None,
            "siSdrUnavailableReason": None if projected_energy else "zero aligned prediction energy",
            "scaleDependentSdrDb": 10 * math.log10(energy / max(float(np.sum((actual - wanted) ** 2)), 1e-30)),
            "rmsRatioDb": 10 * math.log10(actual_energy / energy) if actual_energy else None,
            "rawScaleDependentSdrDb": 10 * math.log10(raw_truth_energy / max(raw_error_energy, 1e-30)),
            "rawRmsRatioDb": 10 * math.log10(raw_actual_energy / raw_truth_energy) if raw_actual_energy else None,
            "dcError": (prediction - reference).mean(axis=0).tolist(),
            "peak": float(np.max(np.abs(prediction)))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--truth", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--oracle", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    truth = json.loads((args.truth / "manifest.json").read_text())
    native = json.loads((args.native / "native.json").read_text())
    source_hash = truth["files"]["mixture.wav"]["sha256"]
    if native["sourceSHA256"] != source_hash or native["contextSamples"] != 882000 or native["windows"] != 1 or native["heads"] != 5:
        raise ValueError("native output provenance/context mismatch")
    mixture = read_wav(args.truth / "mixture.wav", source_hash)
    native_files = {item["name"]: item for item in native["artifacts"]}
    if set(native_files) != {label + ".wav" for label in LABELS}:
        raise ValueError("native output head set mismatch")
    original = None
    if args.oracle:
        metadata = json.loads((args.oracle / "oracle.json").read_text())
        if (metadata["format"] != "aurialis-original-full-window-v1" or metadata["fftVariant"] != "original_f32" or
                metadata["samples"] != 882000 or metadata["sourceFrames"] != 441000 or
                metadata["sourceWavSHA256"] != source_hash or metadata["fullKeyAttention"] is not True or
                metadata["originalSHA256"] != "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f"):
            raise ValueError("original full-window oracle provenance mismatch")
        if digest(args.oracle / "oracle.bin") != metadata["binarySHA256"]:
            raise ValueError("original binary checksum mismatch")
        original = np.memmap(args.oracle / "oracle.bin", dtype="<f4", mode="r")
    report = {"format": "aurialis-private-heldout-quality-v1", "sourceSHA256": source_hash,
              "modelSHA256": native["modelSHA256"], "contextSamples": 882000,
              "definition": "per-channel zero-mean SI-SDR/SDR/RMS ratio, both channels jointly; raw-prefixed metrics retain DC; no time/output-gain alignment",
              "scope": truth["heldOutScope"], "limits": truth["limits"], "heads": {}}
    delivered_sum = np.zeros_like(mixture)
    original_sum = np.zeros_like(mixture)
    for label in LABELS:
        name = label + ".wav"
        reference = read_wav(args.truth / name, truth["files"][name]["sha256"])
        prediction = read_wav(args.native / name, native_files[name]["sha256"])
        delivered_sum += prediction
        result = {"native": quality(reference, prediction), "mixture": quality(reference, mixture)}
        native_score = result["native"].get("siSdrDb")
        mixture_score = result["mixture"].get("siSdrDb")
        result["siSdrImprovementDb"] = native_score - mixture_score if native_score is not None and mixture_score is not None else None
        if original is not None:
            if label == "other":
                expected = (mixture - original_sum).astype(np.float32).astype(np.float64)
            else:
                key = "pcm.vocal" if label == "vocals" else "pcm." + label
                item = metadata["tensors"][key]
                if item["shape"] != [2, 882000] or item["bytes"] != 2 * 882000 * 4 or item["offset"] < 0 or item["offset"] % 4:
                    raise ValueError("original output shape mismatch")
                values = original[item["offset"] // 4:(item["offset"] + item["bytes"]) // 4]
                if values.size != 2 * 882000:
                    raise ValueError("original output is truncated")
                expected = values.reshape(2, 882000)[:, :441000].T.astype(np.float64)
                original_sum += expected
            if not np.isfinite(expected).all():
                raise ValueError("original output contains nonfinite samples")
            error = prediction - expected
            maximum = float(np.max(np.abs(error)))
            normalized = math.sqrt(float(np.sum(error * error)) / max(float(np.sum(expected * expected)), 1e-30))
            result["original"] = quality(reference, expected)
            result["nativeVsOriginal"] = {"maxAbsolute": maximum, "normalizedRMS": normalized,
                                           "withinExistingShortOracleTolerance": maximum <= .003 and normalized <= .001}
        report["heads"][label] = result
    report["maximumReconstructionError"] = float(np.max(np.abs(delivered_sum - mixture)))
    with args.out.open("x") as target:
        json.dump(report, target, indent=2, allow_nan=False)
        target.write("\n")
    print(json.dumps({label: {"siSdrDb": item["native"].get("siSdrDb"), "improvementDb": item["siSdrImprovementDb"], "nativeVsOriginal": item.get("nativeVsOriginal")} for label, item in report["heads"].items()}))


if __name__ == "__main__":
    main()
