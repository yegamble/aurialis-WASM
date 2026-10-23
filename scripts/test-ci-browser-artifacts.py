"""Adversarial browser-target artifact checks using only tiny synthetic assets."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("ci_browser", Path(__file__).with_name("ci-browser-artifacts.py"))
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class BrowserArtifactBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.bundle = Path(self.temporary.name) / "bundle"
        self.root.mkdir()
        self.facts = {"checkoutSha": "a" * 40, "headSha": "b" * 40, "sourceSha256": "c" * 64, "runId": "123", "runAttempt": "1", "platform": "Linux", "architecture": "x86_64", "executionTarget": "browser"}
        self.provenance = mock.patch.object(artifacts.shared, "provenance", return_value=self.facts)
        self.provenance.start()
        self.addCleanup(self.provenance.stop)
        self.files = {"index.html": b"<html>local audio</html>", "master/$d$trackId.txt": b"literal Next placeholder RSC", "wasm/aurialis-dsp.wasm": b"fixture-not-executable"}
        for name, content in self.files.items():
            path = self.root / artifacts.ASSETS / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.policy = {"csp": "default-src 'self';", "execution": "browser", "files": len(self.files), "paths": sorted(self.files)}
        (self.root / artifacts.POLICY).write_text(json.dumps(self.policy))
        artifacts.pack(self.root, self.bundle)

    def rewrite_index(self, transform):
        path = self.root / artifacts.INDEX
        value = json.loads(path.read_text())
        transform(value)
        path.write_text(json.dumps(value))
        artifacts.shared.pack(self.root, self.bundle, profile="browser")

    def rewrite_inner_tar(self, transform):
        path = self.root / artifacts.ARCHIVE
        with tarfile.open(path) as archive:
            members = [(entry, archive.extractfile(entry).read()) for entry in archive.getmembers()]
        transform(members)
        with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as archive:
            for entry, content in members:
                archive.addfile(entry, io.BytesIO(content) if entry.isfile() else None)
        artifacts.shared.pack(self.root, self.bundle, profile="browser")

    def test_roundtrip_restores_exact_assets_policy_and_rsc_names(self):
        shutil.rmtree(self.root / artifacts.ASSETS)
        for name in artifacts.shared.BROWSER_MEMBERS:
            (self.root / name).unlink()
        artifacts.restore(self.root, self.bundle)
        artifacts.verify(self.root)
        for name, content in self.files.items():
            path = self.root / artifacts.ASSETS / name
            self.assertEqual(path.read_bytes(), content)
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        self.assertEqual(set(artifacts.shared.BROWSER_MEMBERS), {artifacts.ARCHIVE, artifacts.INDEX, artifacts.POLICY})
        self.assertEqual(len(artifacts.shared.MEMBERS), 5)
        with self.assertRaises(ValueError):
            artifacts.shared.verify(self.root, str(self.root / "aurialis"), profile="browser")

    def test_target_native_and_browser_profiles_cannot_substitute(self):
        with self.assertRaises(ValueError):
            artifacts.shared.restore(self.root, self.bundle)
        self.facts["executionTarget"] = "native"
        with self.assertRaises(ValueError):
            artifacts.restore(self.root, self.bundle)
        self.assertFalse((self.root / artifacts.shared.BROWSER_RECEIPT).exists())

    def test_changed_source_or_actual_asset_invalidates_receipt(self):
        artifacts.restore(self.root, self.bundle)
        for field in self.facts:
            changed = copy.deepcopy(self.facts)
            changed[field] += "-different"
            with mock.patch.object(artifacts.shared, "provenance", return_value=changed):
                with self.assertRaises(ValueError):
                    artifacts.verify(self.root)
        (self.root / artifacts.ASSETS / "index.html").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            artifacts.verify(self.root)

    def test_extra_missing_link_assets_and_symbolic_receipt_rejected(self):
        artifacts.restore(self.root, self.bundle)
        unexpected = self.root / artifacts.ASSETS / "unexpected.js"
        unexpected.write_bytes(b"unexpected")
        with self.assertRaises(ValueError):
            artifacts.verify(self.root)
        unexpected.unlink()
        index = self.root / artifacts.ASSETS / "index.html"
        index.unlink()
        with self.assertRaises(ValueError):
            artifacts.verify(self.root)
        index.symlink_to(self.root / artifacts.ASSETS / "wasm/aurialis-dsp.wasm")
        with self.assertRaises(ValueError):
            artifacts.restore(self.root, self.bundle)
        self.assertFalse((self.root / artifacts.shared.BROWSER_RECEIPT).exists())
        index.unlink()
        artifacts.restore(self.root, self.bundle)
        receipt = self.root / artifacts.shared.BROWSER_RECEIPT
        outside = self.bundle / "saved-receipt.json"
        receipt.replace(outside)
        receipt.symlink_to(outside)
        with self.assertRaises(ValueError):
            artifacts.verify(self.root)

    def test_policy_paths_and_execution_are_closed_before_pack(self):
        original = self.policy
        for change in ("native", "count", "unsorted", "duplicate", "extra", "dot", "traversal", "absolute", "control", "alias"):
            policy = copy.deepcopy(original)
            if change == "native":
                policy["execution"] = "native"
            elif change == "count":
                policy["files"] += 1
            elif change == "unsorted":
                policy["paths"].reverse()
            elif change == "duplicate":
                policy["paths"].append(policy["paths"][0])
            elif change == "extra":
                policy["unknown"] = True
            else:
                policy["paths"][0] = {"dot": ".", "traversal": "../escape", "absolute": "/escape", "control": "bad\x7fname", "alias": "a/./b"}[change]
            (self.root / artifacts.POLICY).write_text(json.dumps(policy))
            with self.subTest(change=change), self.assertRaises(ValueError):
                artifacts.pack(self.root, self.bundle)

    def test_index_bounds_hashes_modes_and_closed_members(self):
        original = (self.root / artifacts.INDEX).read_text()
        for change in ("size", "boolean", "mode", "float-mode", "hash", "extra", "missing", "version"):
            value = json.loads(original)
            entry = value["files"]["index.html"]
            if change == "size":
                entry["bytes"] = artifacts.MAXIMUM_FILE + 1
            elif change == "boolean":
                entry["bytes"] = True
            elif change == "mode":
                entry["mode"] = 0o777
            elif change == "float-mode":
                entry["mode"] = float(0o644)
            elif change == "hash":
                entry["sha256"] = "z" * 64
            elif change == "extra":
                value["files"]["../escape"] = entry
            elif change == "missing":
                del value["files"]["index.html"]
            else:
                value["version"] = True
            (self.root / artifacts.INDEX).write_text(json.dumps(value))
            with self.subTest(change=change), self.assertRaises(ValueError):
                artifacts.checked_index(self.root)

    def test_model_shard_specific_sixteen_mib_bound(self):
        self.policy["paths"] = ["models/weights-000.bin"]
        self.policy["files"] = 1
        (self.root / artifacts.POLICY).write_text(json.dumps(self.policy))
        value = {"version": 1, "files": {"models/weights-000.bin": {"bytes": artifacts.MAXIMUM_MODEL_SHARD + 1, "mode": 0o644, "sha256": "a" * 64}}}
        (self.root / artifacts.INDEX).write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            artifacts.checked_index(self.root)
        value["files"]["models/weights-000.bin"]["bytes"] -= 1
        (self.root / artifacts.INDEX).write_text(json.dumps(value))
        artifacts.checked_index(self.root)

    def test_inner_tar_traversal_links_duplicates_sizes_modes_hashes(self):
        original = (self.root / artifacts.ARCHIVE).read_bytes()
        for change in ("traversal", "link", "hardlink", "duplicate", "size", "mode", "bytes"):
            (self.root / artifacts.ARCHIVE).write_bytes(original)
            def alter(members):
                entry, content = members[0]
                if change == "traversal":
                    entry.name = "../escape"
                elif change in ("link", "hardlink"):
                    entry.type, entry.linkname = (tarfile.SYMTYPE if change == "link" else tarfile.LNKTYPE), "/escape"
                elif change == "duplicate":
                    members[-1][0].name = entry.name
                elif change == "size":
                    entry.size += 1
                    members[0] = (entry, content + b"x")
                elif change == "mode":
                    entry.mode = 0o777
                else:
                    members[0] = (entry, b"x" * len(content))
            self.rewrite_inner_tar(alter)
            with self.subTest(change=change), self.assertRaises(ValueError):
                artifacts.restore(self.root, self.bundle)
            self.assertFalse((self.root / artifacts.shared.BROWSER_RECEIPT).exists())
            self.assertFalse((self.root.parent / "escape").exists())

    def test_metadata_file_count_and_total_package_limits(self):
        original = (self.root / artifacts.POLICY).read_text()
        oversized = copy.deepcopy(self.policy)
        oversized["paths"] = ["asset-" + str(index).zfill(5) + ".js" for index in range(artifacts.MAXIMUM_FILES + 1)]
        oversized["files"] = len(oversized["paths"])
        (self.root / artifacts.POLICY).write_text(json.dumps(oversized))
        with self.assertRaises(ValueError):
            artifacts.policy(self.root)
        (self.root / artifacts.POLICY).write_text(original)
        with mock.patch.object(artifacts, "MAXIMUM_METADATA", 1):
            with self.assertRaises(ValueError):
                artifacts.policy(self.root)
        with mock.patch.object(artifacts.shared, "MAXIMUM_BYTES", 1):
            with self.assertRaises(ValueError):
                artifacts.checked_index(self.root)

    def test_duplicate_metadata_fields_rejected(self):
        (self.root / artifacts.INDEX).write_text('{"version":1,"version":1}')
        with self.assertRaises(ValueError):
            artifacts.checked_index(self.root)


if __name__ == "__main__":
    unittest.main()
