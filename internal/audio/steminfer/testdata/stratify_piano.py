"""Private taxonomy diagnostic on already-produced immutable outputs, no inference."""
from pathlib import Path
import hashlib
import json
import math
import runpy
import sys

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import yaml

base = Path(sys.argv[1])
out = Path(sys.argv[2])
evidence = base / "artifacts/private-stems/recovery-20261023"
evaluation = evidence / "evaluation"
truthdir = evaluation / "heldout/Track00005-mixed-10s"
native = evaluation / "native-output/native-718266099"
selected = evaluation / "selected"
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
quality_path = base / "internal/audio/steminfer/testdata/measure_quality.py"
assert digest(quality_path) == "5fa603a57c5cfd43b38e7b7afea86f123923909f59a531cc6af3482273eceb4f"
quality = runpy.run_path(str(quality_path))["quality"]
manifest = json.loads((truthdir / "manifest.json").read_text())
assert digest(truthdir / "manifest.json") == "aafcb377b91e39d0dc7c2b9e5099b55513ee08489315883f8bbb24c80274802c"
assert manifest["slakhWindowSeconds"] == [30, 40]
assert manifest["groups"]["piano"] == ["Track00005/stems/S02.wav", "Track00005/stems/S06.wav"]
extraction = json.loads((selected / "manifest.json").read_text())
assert digest(selected / "manifest.json") == manifest["extractionManifestSHA256"]
meta_path = selected / "Track00005/metadata.yaml"
assert digest(meta_path) == extraction["files"]["Track00005/metadata.yaml"]["sha256"]
meta = yaml.safe_load(meta_path.read_text())
receipt = json.loads((native / "native.json").read_text())
assert receipt["sourceSHA256"] == manifest["files"]["mixture.wav"]["sha256"]
assert receipt["contextSamples"] == 882000 and receipt["windows"] == 1 and receipt["heads"] == 5
assert digest(truthdir / "piano.wav") == manifest["files"]["piano.wav"]["sha256"]
combined, rate = sf.read(truthdir / "piano.wav", dtype="float64", always_2d=True)
assert rate == 44100 and combined.shape == (441000, 2)
parts = {}
provenance = {}
transform = manifest["transforms"]["piano"]
angle = (transform["pan"] + 1) * math.pi / 4
for name in ("S02", "S06"):
    relative = "Track00005/stems/" + name + ".wav"
    path = selected / relative
    expected = extraction["files"][relative]
    assert path.stat().st_size == expected["bytes"] and digest(path) == expected["sha256"]
    pcm, rate = sf.read(path, start=30 * 16000, frames=160000, dtype="float32", always_2d=True)
    assert rate == 16000 and pcm.shape == (160000, 1)
    mono = resample_poly(pcm[:, 0].astype(np.float64), 441, 160, window=("kaiser", 5.0), padtype="constant")[:441000]
    parts[name] = np.column_stack((mono * math.cos(angle), mono * math.sin(angle))) * transform["gain"] * manifest["finalGain"]
    provenance[name] = {"source": relative, "sha256": expected["sha256"], "metadata": meta["stems"][name], "stereoRms": float(np.sqrt(np.mean(parts[name] ** 2)))}
component_error = float(np.max(np.abs(sum(parts.values()).astype(np.float32).astype(np.float64) - combined)))
assert component_error < 5e-8
predictions = {}
for item in receipt["artifacts"]:
    path = native / item["name"]
    assert digest(path) == item["sha256"]
    prediction, rate = sf.read(path, dtype="float64", always_2d=True)
    assert rate == 44100 and prediction.shape == (441000, 2) and np.isfinite(prediction).all()
    predictions[item["name"]] = prediction
assert set(predictions) == {label + ".wav" for label in ("vocals", "drums", "bass", "guitar", "piano", "other")}
results = {name: {label: quality(component, prediction) for label, prediction in predictions.items()} for name, component in parts.items()}
cross = float(np.sum(parts["S02"] * parts["S06"]) / np.sqrt(np.sum(parts["S02"] ** 2) * np.sum(parts["S06"] ** 2)))
report = {"format": "aurialis-private-piano-taxonomy-diagnostic-v1", "sourceSHA256": receipt["sourceSHA256"], "nativeManifestSHA256": digest(native / "native.json"), "truthManifestSHA256": digest(truthdir / "manifest.json"), "qualityToolSHA256": digest(quality_path), "provenance": provenance, "componentReconstructionMaxAbsolute": component_error, "componentCosineSimilarity": cross, "unchangedCombinedPianoQuality": quality(combined, predictions["piano.wav"]), "pairwiseComponentDiagnostics": results, "limits": ["No model inference or output changes; existing combined piano/Other scores remain authoritative for that original grouping.", "Pairwise comparisons diagnose taxonomy overlap; they do not qualify an acoustic-only label or redefine Other.", "Both components share the original group gain/pan/final gain; no separate normalization, alignment or mixture changes.", "Constructed sample-based single excerpt; model training membership unknown; no broad genre or browser qualification."]}
with out.open("x") as target:
    json.dump(report, target, indent=2, allow_nan=False)
    target.write("\n")
print(json.dumps({"componentError": component_error, "componentCosine": cross, "combinedPianoSiSdr": report["unchangedCombinedPianoQuality"]["siSdrDb"], "componentSiSdr": {name: {label: metric.get("siSdrDb") for label, metric in values.items()} for name, values in results.items()}}, indent=2))
