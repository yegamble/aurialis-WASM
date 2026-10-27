"""Independent metering comparison using FFmpeg ebur128; no production dependency.

Run after sourcing the repository Go toolchain environment:
    python3 wasm/dsp/verify_meters.py

The script creates synthetic float32 stereo fixtures in a private temporary
folder, runs the native Go fixture test and FFmpeg independently, then compares
integrated loudness, final short-term loudness, and true-peak readings. Low/high
frequency probes have 100-sample edge tapers; the two reconstruction filters can
differ at abrupt boundaries. This is a reference comparison, not certification. It never
runs in the server/audio request path and requires a local FFmpeg installation.
"""

import array
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile


def generate(rate, mode):
    duration = 9 if mode == "gate" else 3
    count = rate * duration
    result = array.array("f")
    for index in range(count):
        frequency = 80 if mode == "low" else (8000 if mode == "high" else 997)
        amplitude = 0.1
        if mode == "gate":
            amplitude = 0.1 if index < rate * 3 else (0 if index < rate * 6 else 0.001)
        value = amplitude * math.sin(2 * math.pi * frequency * index / rate)
        if mode in {"low", "high"}:
            value *= min(1, index / 100, (count - 1 - index) / 100)
        if mode == "peak":
            taper = min(1, index / 100, (count - 1 - index) / 100)
            value = taper * math.sin(math.pi * index / 2 + math.pi / 4)
        result.extend([value, value])
    if os.sys.byteorder != "little":
        result.byteswap()
    return result


def main():
    root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="aurialis-meter-") as folder:
        fixture_path = Path(folder) / "native.json"
        environment = dict(os.environ, AURIALIS_METER_FIXTURE=str(fixture_path))
        subprocess.run(
            ["go", "test", "./wasm/dsp", "-run", "TestWriteNativeMeterFixture", "-count=1"],
            cwd=root, env=environment, check=True,
        )
        fixtures = json.loads(fixture_path.read_text())
        maximum_loudness_error = 0
        maximum_peak_error = 0
        for fixture in fixtures:
            rate, mode = int(fixture["rate"]), fixture["mode"]
            path = Path(folder) / "audio.f32"
            with path.open("wb") as destination:
                generate(rate, mode).tofile(destination)
            probe = subprocess.run(
                ["ffmpeg", "-hide_banner", "-f", "f32le", "-ar", str(rate),
                 "-ac", "2", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                capture_output=True, text=True, check=True,
            ).stderr
            summary = probe[probe.rfind("Summary:"):]
            reference_i = float(re.search(r"I:\s*([-\d.]+) LUFS", summary)[1])
            reference_s = float(re.findall(r"S:\s*([-\d.]+)", probe)[-1])
            reference_peak = float(re.search(r"Peak:\s*([-\d.]+) dBFS", summary)[1])
            actual = fixture["metrics"]
            loudness_error = max(abs(actual["integratedLufs"] - reference_i),
                                 abs(actual["shortTermLufs"] - reference_s))
            peak_error = abs(actual["truePeakDbtp"] - reference_peak)
            maximum_loudness_error = max(maximum_loudness_error, loudness_error)
            maximum_peak_error = max(maximum_peak_error, peak_error)
            assert loudness_error <= 0.11, (rate, mode, actual, reference_i, reference_s)
            assert peak_error <= 0.15, (rate, mode, actual["truePeakDbtp"], reference_peak)
        print(f"independent-meter: {len(fixtures)} FFmpeg comparisons passed at 44.1/48/96 kHz; "
              f"max loudness error {maximum_loudness_error:.4f} LU, peak error {maximum_peak_error:.4f} dB")


if __name__ == "__main__":
    main()
