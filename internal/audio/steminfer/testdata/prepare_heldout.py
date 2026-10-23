"""Build two attributed six-source evaluation mixtures without model feedback.

Private development only. BabySlakh authors: Ethan Manilow, Gordon Wichern,
Prem Seetharaman and Jonathan Le Roux, CC BY 4.0, DOI10.5281/zenodo.4603870.
Provided Gregorian vocal: CyclePat, GloriaGregorianChant.ogg, CC BY 3.0.
Transforms and source/output hashes are saved; neither creator endorses this use.
These constructed excerpts are not a commercial or model-training-held-out benchmark.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

import numpy as np
import scipy
from scipy.signal import resample_poly
import soundfile as sf
import yaml

LABELS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
PANS = [0.0, -0.1, 0.0, -0.35, 0.35, 0.15]
VOCAL_SHA256 = "f3cefaad551c24e81413f9c3a4a492fd519174697808056a6ee7c559e29140ce"
ARCHIVE_SHA256 = "6490dc83d8b59ccbe7e9e0304023af8e585d2065f9a5f5921952a273fac4a9b0"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def rms(value):
    return math.sqrt(float(np.mean(value.astype(np.float64) ** 2)))


def write_wav(path, samples):
    data = np.ascontiguousarray(samples, dtype="<f4").tobytes()
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(data), b"WAVE", b"fmt ",
                         16, 3, 2, 44100, 352800, 8, 32, b"data", len(data))
    with path.open("xb") as target:
        target.write(header)
        target.write(data)
    path.chmod(0o600)
    return {"sha256": sha256(path), "bytes": path.stat().st_size, "frames": len(samples),
            "sampleRate": 44100, "channels": 2, "format": "IEEE-F32", "rms": rms(samples),
            "peak": float(np.max(np.abs(samples)))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--selected", type=Path, required=True)
    parser.add_argument("--vocal", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    metadata_path = args.selected / "manifest.json"
    if metadata_path.stat().st_size > 65536:
        raise ValueError("bounded extraction manifest required")
    extraction = json.loads(metadata_path.read_text())
    if extraction["archiveSHA256"] != ARCHIVE_SHA256 or extraction["selection"] != ["Track00005", "Track00012"]:
        raise ValueError("wrong pinned evaluation selection")
    if args.vocal.stat().st_size != 697382 or sha256(args.vocal) != VOCAL_SHA256:
        raise ValueError("wrong pinned licensed vocal")
    vocal_info = sf.info(args.vocal)
    if vocal_info.frames > 60 * vocal_info.samplerate or vocal_info.channels > 2:
        raise ValueError("vocal exceeds fixed source bound")
    voice, voice_rate = sf.read(args.vocal, dtype="float32", always_2d=True)
    voice = voice.mean(axis=1, dtype=np.float64)
    args.out.mkdir(parents=True, exist_ok=True, mode=0o700)
    for track, voice_start in [("Track00005", 20), ("Track00012", 30)]:
        directory = args.selected / track
        metadata = yaml.safe_load((directory / "metadata.yaml").read_text())
        grouping = {label: [] for label in LABELS[1:]}
        for stem, entry in sorted(metadata["stems"].items()):
            key = str(Path(track) / "stems" / (stem + ".wav"))
            if key not in extraction["files"]:
                continue
            path = args.selected / key
            expected = extraction["files"][key]
            if path.stat().st_size != expected["bytes"] or sha256(path) != expected["sha256"]:
                raise ValueError("extracted source bytes changed")
            label = {"Drums": "drums", "Bass": "bass", "Guitar": "guitar", "Piano": "piano"}.get(entry["inst_class"], "other")
            grouping[label].append(path)
        if not all(grouping.values()):
            raise ValueError("fixed selected track lacks a required truth group")
        duration = min(sf.info(path).frames // 16000 for paths in grouping.values() for path in paths)
        chosen = None
        for start in range(30, min(duration - 10, 300) + 1, 5):
            groups = {}
            for label, paths in grouping.items():
                groups[label] = np.zeros(160000, dtype=np.float64)
                for path in paths:
                    segment, rate = sf.read(path, start=start * 16000, frames=160000, dtype="float32", always_2d=True)
                    if rate != 16000 or segment.shape != (160000, 1):
                        raise ValueError("wrong fixed corpus sample layout")
                    groups[label] += segment[:, 0]
            if all(rms(value) >= 1e-4 for value in groups.values()):
                chosen = start, groups
                break
        if chosen is None:
            raise ValueError("no predeclared activity window in selected truth")
        start, groups = chosen
        frames = 441000
        sources = {label: resample_poly(value, 441, 160, window=("kaiser", 5.0), padtype="constant")[:frames] for label, value in groups.items()}
        voice_segment = voice[voice_start * voice_rate:(voice_start + 10) * voice_rate]
        divisor = math.gcd(44100, voice_rate)
        sources["vocals"] = resample_poly(voice_segment, 44100 // divisor, voice_rate // divisor, window=("kaiser", 5.0), padtype="constant")[:frames]
        transforms = {}
        rendered = []
        for label, pan in zip(LABELS, PANS):
            mono = sources[label]
            if len(mono) != frames or not np.isfinite(mono).all():
                raise ValueError("invalid prepared truth source")
            angle = (pan + 1) * math.pi / 4
            stereo = np.column_stack((mono * math.cos(angle), mono * math.sin(angle)))
            before = rms(stereo)
            if before < 1e-6:
                raise ValueError("inactive prepared truth group")
            gain = .035 / before
            rendered.append(stereo * gain)
            transforms[label] = {"pan": pan, "gain": gain, "targetStereoRMSBeforeFinalGain": .035}
        mixture = sum(rendered)
        final_gain = min(1.0, .65 / float(np.max(np.abs(mixture))))
        rendered = [(value * final_gain).astype(np.float32) for value in rendered]
        mixture = sum(value.astype(np.float64) for value in rendered).astype(np.float32)
        destination = args.out / (track + "-mixed-10s")
        destination.mkdir(mode=0o700)
        manifest = {"format": "aurialis-constructed-truth-v1", "track": track,
                    "heldOutScope": "excludes previous Track00001/Track00020 evaluation; model training membership unknown",
                    "selectionRule": "earliest 10s window at30s then5s steps through300s where every instrument-group RMS>=1e-4; no model output consulted",
                    "slakhWindowSeconds": [start, start + 10], "vocalWindowSeconds": [voice_start, voice_start + 10],
                    "slakhArchiveSHA256": ARCHIVE_SHA256, "extractionManifestSHA256": sha256(metadata_path),
                    "vocalSHA256": VOCAL_SHA256, "finalGain": final_gain, "transforms": transforms,
                    "groups": {label: [str(path.relative_to(args.selected)) for path in paths] for label, paths in grouping.items()},
                    "dependencies": {"numpy": np.__version__, "scipy": scipy.__version__, "soundfile": sf.__version__},
                    "resampling": "independent development SciPy resample_poly, Kaiser5.0, zero exterior; no time/gain alignment of predictions",
                    "attribution": [{"authors": "Ethan Manilow, Gordon Wichern, Prem Seetharaman, Jonathan Le Roux", "work": "BabySlakh / Cutting Music Source Separation Some Slakh, WASPAA2019", "source": "https://zenodo.org/records/4603870", "license": "https://creativecommons.org/licenses/by/4.0/", "changes": "excerpted, grouped, resampled, panned, level-scaled, remixed"}, {"authors": "CyclePat", "work": "GloriaGregorianChant.ogg", "source": "https://commons.wikimedia.org/wiki/File:GloriaGregorianChant.ogg", "license": "https://creativecommons.org/licenses/by/3.0/", "changes": "excerpted, downmixed, resampled, level-scaled, remixed"}],
                    "limits": ["constructed sample-based music plus provided Gregorian vocal; no broad genre benchmark", "synthetic Choir Aahs remain Other under corpus instrument taxonomy; vocal-category overlap can affect metrics"], "files": {}}
        for label, value in zip(LABELS, rendered):
            manifest["files"][label + ".wav"] = write_wav(destination / (label + ".wav"), value)
        manifest["files"]["mixture.wav"] = write_wav(destination / "mixture.wav", mixture)
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"track": track, "slakhWindow": start, "vocalWindow": voice_start, "mixture": manifest["files"]["mixture.wav"]}))


if __name__ == "__main__":
    main()
