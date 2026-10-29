#!/usr/bin/env python3
"""Bounded local tests for the pinned Smart Split model downloader."""

from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("download-stem-model.py")
SPEC = importlib.util.spec_from_file_location("download_stem_model", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, body: bytes, *, content_length: str | None = None, final_url: str = "https://release-assets.githubusercontent.com/file"):
        self.body = body
        self.offset = 0
        self.headers = {} if content_length is None else {"Content-Length": content_length}
        self.final_url = final_url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def geturl(self):
        return self.final_url

    def read(self, size: int) -> bytes:
        chunk = self.body[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk


class StemModelDownloadTests(unittest.TestCase):
    def test_reads_public_model_and_compiled_size_digest_pins(self):
        root = Path(__file__).resolve().parents[2]
        url, size, sha = MODULE.read_pin(root)
        self.assertEqual(url, "https://github.com/yegamble/aurialis-WASM/releases/download/stem-model-v1/mega53-five-heads-v1.safetensors")
        self.assertEqual(size, 176487688)
        self.assertEqual(len(sha), 64)

    def test_streams_exact_size_and_digest_to_new_destination(self):
        body = b"model bytes in bounded chunks"
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "model.safetensors"
            calls = []

            def opener(request, *, timeout):
                calls.append((request.full_url, timeout, request.get_header("User-agent")))
                return FakeResponse(body, content_length=str(len(body)))

            MODULE.download("https://github.com/example/model", destination, len(body), hashlib.sha256(body).hexdigest(), opener=opener)
            self.assertEqual(destination.read_bytes(), body)
            self.assertEqual(calls, [("https://github.com/example/model", MODULE.READ_TIMEOUT_SECONDS, MODULE.USER_AGENT)])
            self.assertEqual(list(Path(temporary).iterdir()), [destination])

    def test_rejects_content_length_short_oversized_hash_and_http_redirect(self):
        body = b"bounded model"
        cases = (
            (FakeResponse(body, content_length="999"), len(body), hashlib.sha256(body).hexdigest(), "Content-Length"),
            (FakeResponse(body[:-1]), len(body), hashlib.sha256(body).hexdigest(), "ended at"),
            (FakeResponse(body + b"x"), len(body), hashlib.sha256(body).hexdigest(), "exceeds pinned size"),
            (FakeResponse(body), len(body), "0" * 64, "SHA-256"),
            (FakeResponse(body, final_url="http://example.invalid/model"), len(body), hashlib.sha256(body).hexdigest(), "HTTPS"),
        )
        for response, size, digest, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / "model.safetensors"
                with self.assertRaisesRegex((ValueError, TimeoutError), message):
                    MODULE.download("https://github.com/example/model", destination, size, digest, opener=lambda *_args, **_kwargs: response)
                self.assertFalse(destination.exists())
                self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_refuses_existing_output_and_invalid_pins(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "model.safetensors"
            destination.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                MODULE.download("https://github.com/example/model", destination, 4, "0" * 64)
            self.assertEqual(destination.read_bytes(), b"keep")
            with self.assertRaises(ValueError):
                MODULE.download("https://github.com/example/model", Path(temporary) / "other", 0, "0" * 64)

    def test_total_deadline_stops_before_reading(self):
        body = b"model"
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "model.safetensors"
            opened = []
            with self.assertRaisesRegex(TimeoutError, "exceeded"):
                MODULE.download(
                    "https://github.com/example/model",
                    destination,
                    len(body),
                    hashlib.sha256(body).hexdigest(),
                    opener=lambda *_args, **_kwargs: opened.append(True),
                    total_timeout=0,
                )
            self.assertEqual(opened, [])
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_rejects_a_pin_above_the_hard_size_cap(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "model.safetensors"
            with self.assertRaisesRegex(ValueError, "invalid model size"):
                MODULE.download(
                    "https://github.com/example/model",
                    destination,
                    MODULE.MAX_MODEL_BYTES + 1,
                    "0" * 64,
                )
            self.assertFalse(destination.exists())

    def test_pin_source_must_be_complete_and_public_https(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "internal/audio/steminfer"
            source.mkdir(parents=True)
            (source / "model.go").write_text('const ModelURL = "http://example.invalid/model"\n', encoding="utf-8")
            (source / "weights.go").write_text('const modelBytes = 3\nconst modelSHA256 = "' + "0" * 64 + '"\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "public Aurialis GitHub"):
                MODULE.read_pin(root)


if __name__ == "__main__":
    unittest.main()
