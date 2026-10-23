"""Private packaging receipt; it cannot grant distribution or parser qualification."""
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
recipe = Path(__file__).resolve().parent
assets = root / "assets"
lock = json.loads((recipe / "sources.lock.json").read_text())
configuration = (root / "ffbuild" / "config.h").read_text()
components = (root / "ffbuild" / "config_components.h").read_text()
for forbidden in ["GPL", "NONFREE", "VERSION3", "NETWORK", "PTHREADS", "W32THREADS", "OS2THREADS"]:
    if not re.search(r"^#define CONFIG_" + forbidden + r" 0$", configuration, re.MULTILINE):
        raise SystemExit("Forbidden or unreviewed feature: " + forbidden)
expected = {
    "DECODER": {"MP3FLOAT", "FLAC", "VORBIS", "AAC", "ALAC", "OPUS"},
    "DEMUXER": {"MP3", "FLAC", "OGG", "AAC", "MOV"},
    "PARSER": {"MPEGAUDIO", "FLAC", "VORBIS", "AAC", "OPUS"},
    "ENCODER": set(), "MUXER": set(), "FILTER": set(), "PROTOCOL": set(),
    "INDEV": set(), "OUTDEV": set(), "HWACCEL": set(),
}
for category, allowed in expected.items():
    actual = set(re.findall(r"^#define CONFIG_([A-Z0-9_]+)_" + category + r" 1$", components, re.MULTILINE))
    if actual != allowed:
        raise SystemExit(category + " differs from the closed private profile: " + repr(actual))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def rename(source, stem, suffix, maximum):
    data = source.read_bytes()
    if not data or len(data) > maximum:
        raise SystemExit("Private decoder asset exceeds its size bound: " + str(source))
    name = stem + "." + digest(data) + suffix
    target = assets / name
    source.rename(target)
    return name, digest(data), len(data)

wasm, wasm_hash, _ = rename(assets / "decoder-core.wasm", "decoder-core", ".wasm", 16 * 1024 * 1024)
core, _, _ = rename(assets / "decoder-core.mjs", "decoder-core", ".mjs", 4 * 1024 * 1024)
envelope_data = (recipe / "envelope.mjs").read_bytes()
envelope = "envelope." + digest(envelope_data) + ".mjs"
(assets / envelope).write_bytes(envelope_data)
worker_data = (recipe / "decoder.worker.mjs").read_text()
for token, value in {
    "__AURIALIS_CORE_FILE__": core, "__AURIALIS_ENVELOPE_FILE__": envelope,
    "__AURIALIS_WASM_FILE__": wasm, "__AURIALIS_WASM_SHA256__": wasm_hash,
}.items():
    if worker_data.count(token) != 1:
        raise SystemExit("Missing/duplicate fixed worker token: " + token)
    worker_data = worker_data.replace(token, value)
worker_bytes = worker_data.encode()
worker = "decoder.worker." + digest(worker_bytes) + ".mjs"
(assets / worker).write_bytes(worker_bytes)
(assets / "client.mjs").write_bytes((recipe / "client.mjs").read_bytes())
harness = (recipe / "fixtures" / "harness.mjs").read_text().replace('"../client.mjs"', '"./client.mjs"')
(assets / "fixture-harness.mjs").write_text(harness)
records = []
for path in sorted(assets.iterdir()):
    data = path.read_bytes()
    records.append({"path": path.name, "bytes": len(data), "sha256": digest(data)})
total = sum(item["bytes"] for item in records)
if total > 32 * 1024 * 1024:
    raise SystemExit("Private decoder asset total exceeds its admission bound.")
manifest = {
    "abi": 1, "status": "private-unqualified", "distributionApproved": False,
    "worker": worker, "assetBytes": total, "assets": records,
    "source": lock["ffmpeg"], "toolchain": lock["emscripten"],
    "qualification": {"imports": "pending", "fixedMemory": "pending actual module inspection",
                      "audio": "pending", "resources": "pending", "licenseRelinking": "pending"},
}
(assets / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n")
(root / "recipe-sha256.json").write_text(json.dumps({
    path.name: digest(path.read_bytes()) for path in sorted(recipe.iterdir()) if path.is_file()
}, indent=2) + "\n")
