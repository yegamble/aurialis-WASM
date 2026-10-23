"""Extract two pinned licensed truth tracks for private development qualification.

No request-path dependency or public audio asset is introduced. Download the
882,818,115-byte author archive separately at a bounded rate, then pass it here.
Selection excludes Track00001/Track00020 used in the earlier constructed probe;
this is held out from our prior evaluation, not a claim about model training.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

ARCHIVE_BYTES = 882818115
ARCHIVE_SHA256 = "6490dc83d8b59ccbe7e9e0304023af8e585d2065f9a5f5921952a273fac4a9b0"
PUBLISHED_MD5 = "311096dc2bde7d61c97e930edbfc7f78"
TRACKS = {"Track00005", "Track00012"}
SOURCE = "https://zenodo.org/records/4603870"
LICENSE = "https://creativecommons.org/licenses/by/4.0/"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.archive.stat().st_size != ARCHIVE_BYTES:
        raise ValueError("pinned archive size mismatch")
    checksum = hashlib.sha256()
    with args.archive.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(part)
    if checksum.hexdigest() != ARCHIVE_SHA256:
        raise ValueError("pinned archive checksum mismatch")
    args.out.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.out.is_symlink():
        raise ValueError("output must be an owned directory")
    manifest = {"format": "aurialis-private-truth-recovery-v1", "source": SOURCE,
                "archiveSHA256": ARCHIVE_SHA256, "publishedMD5": PUBLISHED_MD5,
                "license": LICENSE, "authors": "Ethan Manilow, Gordon Wichern, Prem Seetharaman, Jonathan Le Roux",
                "citation": "Cutting Music Source Separation Some Slakh, WASPAA 2019",
                "selection": sorted(TRACKS), "heldOutScope": "our prior evaluation only; model training membership unknown",
                "files": {}}
    total = 0
    with tarfile.open(args.archive, "r|gz") as archive:
        for index, member in enumerate(archive):
            if index >= 5000:
                raise ValueError("archive member count exceeds fixed corpus bound")
            path = PurePosixPath(member.name)
            parts = path.parts
            if not (len(parts) in (3, 4) and parts[0] == "babyslakh_16k" and parts[1] in TRACKS):
                continue
            metadata = len(parts) == 3 and parts[2] == "metadata.yaml"
            stem = len(parts) == 4 and parts[2] == "stems" and re.fullmatch(r"S[0-9]{2}\.wav", parts[3])
            if not (metadata or stem):
                continue
            cap = 1024 * 1024 if metadata else 64 * 1024 * 1024
            if not member.isfile() or member.size < 1 or member.size > cap:
                raise ValueError("selected corpus member is not a bounded regular file")
            relative = Path(*parts[1:])
            if str(relative) in manifest["files"] or len(manifest["files"]) >= 64:
                raise ValueError("duplicate or oversized selected corpus")
            total += member.size
            if total > 512 * 1024 * 1024:
                raise ValueError("selected corpus exceeds extraction cap")
            target = args.out / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if target.parent.is_symlink() or target.parent.parent.is_symlink():
                raise ValueError("output path contains a link")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise ValueError("selected corpus member is unreadable")
            digest = hashlib.sha256()
            count = 0
            with extracted, target.open("xb") as destination:
                while True:
                    block = extracted.read(1024 * 1024)
                    if not block:
                        break
                    count += len(block)
                    if count > member.size:
                        raise ValueError("selected member exceeds declared size")
                    digest.update(block)
                    destination.write(block)
            if count != member.size:
                raise ValueError("selected member is truncated")
            target.chmod(0o600)
            manifest["files"][str(relative)] = {"bytes": count, "sha256": digest.hexdigest()}
    for track in TRACKS:
        if str(Path(track) / "metadata.yaml") not in manifest["files"]:
            raise ValueError("selected track metadata is absent")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"files": len(manifest["files"]), "bytes": total, "tracks": sorted(TRACKS)}))


if __name__ == "__main__":
    main()
