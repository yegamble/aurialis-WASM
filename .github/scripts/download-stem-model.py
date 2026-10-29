#!/usr/bin/env python3
"""Download only the model pinned by steminfer Go source, with hard bounds."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

CHUNK_BYTES = 1 << 20
MAX_MODEL_BYTES = 256 << 20
READ_TIMEOUT_SECONDS = 30
TOTAL_TIMEOUT_SECONDS = 20 * 60
USER_AGENT = "Aurialis-steminfer-qualification/1"


def read_pin(root: Path) -> tuple[str, int, str]:
    model_source = (root / "internal/audio/steminfer/model.go").read_text(encoding="utf-8")
    weights_source = (root / "internal/audio/steminfer/weights.go").read_text(encoding="utf-8")
    url_match = re.search(r'^const ModelURL = "([^"\n]+)"$', model_source, re.MULTILINE)
    size_match = re.search(r"^const modelBytes = ([0-9]+)$", weights_source, re.MULTILINE)
    sha_match = re.search(r'^const modelSHA256 = "([0-9a-f]{64})"$', weights_source, re.MULTILINE)
    if not (url_match and size_match and sha_match):
        raise ValueError("Could not read ModelURL, modelBytes, and modelSHA256 from steminfer Go source")
    url = url_match.group(1)
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "github.com" or not parsed.path.startswith("/yegamble/aurialis-WASM/releases/download/"):
        raise ValueError("ModelURL must be the public Aurialis GitHub release asset over HTTPS")
    return url, int(size_match.group(1)), sha_match.group(1)


def download(
    url: str,
    destination: Path,
    expected_size: int,
    expected_sha256: str,
    *,
    opener=urlopen,
    total_timeout: int = TOTAL_TIMEOUT_SECONDS,
) -> None:
    if expected_size <= 0 or expected_size > MAX_MODEL_BYTES or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("invalid model size or SHA-256 pin")
    if total_timeout <= 0:
        raise TimeoutError(f"model download exceeded {total_timeout} seconds")
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"refusing to replace existing model path: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"Accept": "application/octet-stream", "User-Agent": USER_AGENT})
    deadline = time.monotonic() + total_timeout
    temporary_path: Path | None = None
    digest = hashlib.sha256()
    received = 0
    try:
        remaining_time = deadline - time.monotonic()
        if remaining_time <= 0:
            raise TimeoutError(f"model download exceeded {total_timeout} seconds")
        with opener(request, timeout=min(READ_TIMEOUT_SECONDS, remaining_time)) as response:
            if urlparse(response.geturl()).scheme != "https":
                raise ValueError("model download redirected away from HTTPS")
            length = response.headers.get("Content-Length")
            if length is not None and length != str(expected_size):
                raise ValueError(f"model Content-Length {length} does not match pinned size {expected_size}")
            with tempfile.NamedTemporaryFile(
                mode="xb", dir=destination.parent, prefix=f".{destination.name}.", suffix=".part", delete=False
            ) as output:
                temporary_path = Path(output.name)
                while received <= expected_size:
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        raise TimeoutError(f"model download exceeded {total_timeout} seconds")
                    chunk = response.read(min(CHUNK_BYTES, expected_size + 1 - received))
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > expected_size:
                        raise ValueError(f"model exceeds pinned size of {expected_size} bytes")
                    digest.update(chunk)
                    output.write(chunk)
        if received != expected_size:
            raise ValueError(f"model ended at {received} bytes; pinned size is {expected_size}")
        actual_sha256 = digest.hexdigest()
        if actual_sha256 != expected_sha256:
            raise ValueError(f"model SHA-256 {actual_sha256} does not match pinned digest")
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new model file path, normally under RUNNER_TEMP")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args(argv)
    try:
        url, size, sha256 = read_pin(args.repo_root)
        download(url, args.destination, size, sha256)
    except Exception as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    print(f"Downloaded pinned model: {size} bytes; SHA-256 {sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
