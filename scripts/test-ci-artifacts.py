"""Adversarial CI artifact tests; no application audio or production builds."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("ci_artifacts", Path(__file__).with_name("ci-artifacts.py"))
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class ArtifactBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.bundle = Path(self.temporary.name) / "bundle"
        self.root.mkdir()
        self.facts = {"checkoutSha": "a" * 40, "headSha": "b" * 40, "sourceSha256": "c" * 64, "runId": "123", "runAttempt": "1", "platform": "Linux", "architecture": "x86_64", "executionTarget": "native"}
        self.provenance = mock.patch.object(artifacts, "provenance", return_value=self.facts)
        self.provenance.start()
        self.addCleanup(self.provenance.stop)
        for name, mode in artifacts.MEMBERS.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("fixture:" + name).encode())
            path.chmod(mode)
        artifacts.pack(self.root, self.bundle)

    def update_sums(self):
        (self.bundle / "SHA256SUMS").write_text("".join(artifacts.digest(self.bundle / name) + "  " + name + "\n" for name in ("manifest.json", "runtime.tar")))

    def replace_tar(self, entries):
        with tarfile.open(self.bundle / "runtime.tar", "w") as archive:
            for entry in entries:
                archive.addfile(entry, io.BytesIO(b"x" * entry.size) if entry.isfile() else None)
        self.update_sums()

    def test_roundtrip_retains_executable_modes_and_checks_every_file(self):
        for name in artifacts.MEMBERS:
            (self.root / name).unlink()
        artifacts.restore(self.root, self.bundle)
        artifacts.verify(self.root, str(self.root / "aurialis"))
        artifacts.verify(self.root, str(self.root / "artifacts/ci-runtime/aurialis-e2e"))
        for name, mode in artifacts.MEMBERS.items():
            self.assertEqual((self.root / name).stat().st_mode & 0o777, mode)
        (self.root / "public/wasm/aurialis-dsp.wasm").write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            artifacts.verify(self.root)

    def test_no_unsafe_binary_path_or_symbolic_destination(self):
        artifacts.restore(self.root, self.bundle)
        with self.assertRaises(ValueError):
            artifacts.verify(self.root, str(self.root / "other"))
        (self.root / "aurialis").unlink()
        (self.root / "aurialis").symlink_to(self.root / "public/wasm/wasm_exec.js")
        with self.assertRaises(ValueError):
            artifacts.restore(self.root, self.bundle)
        self.assertFalse((self.root / artifacts.RECEIPT).exists())

    def test_archive_and_manifest_tampering_rejected_before_restore(self):
        for name in ("runtime.tar", "manifest.json"):
            path = self.bundle / name
            original = path.read_bytes()
            path.write_bytes(original + b"x")
            with self.assertRaises(ValueError):
                artifacts.restore(self.root, self.bundle)
            path.write_bytes(original)
        self.assertFalse((self.root / artifacts.RECEIPT).exists())

    def test_wrong_checkout_source_run_attempt_platform_and_target_rejected(self):
        for field in self.facts:
            changed = copy.deepcopy(self.facts)
            changed[field] += "-changed"
            with mock.patch.object(artifacts, "provenance", return_value=changed):
                with self.assertRaises(ValueError):
                    artifacts.restore(self.root, self.bundle)

    def test_closed_manifest_sizes_modes_and_members(self):
        original = json.loads((self.bundle / "manifest.json").read_text())
        for change in ("extra", "missing", "oversized", "mode", "hash", "boolean-size"):
            manifest = copy.deepcopy(original)
            if change == "extra":
                manifest["files"]["../../escape"] = manifest["files"]["aurialis"]
            elif change == "missing":
                del manifest["files"]["aurialis"]
            elif change == "oversized":
                manifest["files"]["aurialis"]["bytes"] = artifacts.MAXIMUM_BYTES + 1
            elif change == "mode":
                manifest["files"]["aurialis"]["mode"] = 0o777
            elif change == "hash":
                manifest["files"]["aurialis"]["sha256"] = "z" * 64
            else:
                manifest["files"]["aurialis"]["bytes"] = True
            with self.assertRaises(ValueError):
                artifacts.checked_manifest(manifest, self.facts)

    def test_duplicate_json_fields_are_rejected(self):
        path = self.bundle / "manifest.json"
        path.write_text('{"version":1,"version":1}')
        with self.assertRaises(ValueError):
            artifacts.load_json(path)

    def test_tar_traversal_links_duplicates_and_wrong_size_rejected(self):
        with tarfile.open(self.bundle / "runtime.tar") as archive:
            original = archive.getmembers()
        for change in ("traversal", "symlink", "hardlink", "duplicate", "directory", "size"):
            entries = copy.deepcopy(original)
            if change == "traversal":
                entries[0].name = "../../escaped"
            elif change == "symlink":
                entries[0].type, entries[0].linkname = tarfile.SYMTYPE, "/tmp/escaped"
            elif change == "hardlink":
                entries[0].type, entries[0].linkname = tarfile.LNKTYPE, "/tmp/escaped"
            elif change == "duplicate":
                entries[-1].name = entries[0].name
            elif change == "directory":
                entries[0].type = tarfile.DIRTYPE
            else:
                entries[0].size += 1
            self.replace_tar(entries)
            with self.assertRaises(ValueError):
                artifacts.restore(self.root, self.bundle)
            self.assertFalse((self.root / artifacts.RECEIPT).exists())


class ProvenanceTests(unittest.TestCase):
    def test_rerun_consumes_explicit_earlier_producer_and_rejects_future_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "source.go").write_text("original source")
            with mock.patch.object(artifacts.subprocess, "check_output", side_effect=lambda args, **_kwargs: b"source.go\0" if args[1] == "ls-files" else "a" * 40), mock.patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2", "AURIALIS_CI_BUILD_ATTEMPT": "1"}):
                original = artifacts.provenance(root)
                self.assertEqual(original["runAttempt"], "1")
                (root / "source.go").write_text("changed source")
                self.assertNotEqual(original["sourceSha256"], artifacts.provenance(root)["sourceSha256"])
                with mock.patch.dict(os.environ, {"AURIALIS_CI_BUILD_ATTEMPT": "3"}):
                    with self.assertRaises(ValueError):
                        artifacts.provenance(root)


if __name__ == "__main__":
    unittest.main()
