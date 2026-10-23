"""Inert relink inventory units; no Docker, compiler or FFmpeg execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("relink_inputs", Path(__file__).resolve().parents[1] / "copy-relink-inputs.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InventoryTests(unittest.TestCase):
    def expected(self, data):
        entry = [["piece", len(data), hashlib.sha256(data).hexdigest()]]
        return (len(data), 1, 0, hashlib.sha256(json.dumps(entry, separators=(",", ":")).encode()).hexdigest())

    def test_copies_and_verifies_content_not_only_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "piece").write_bytes(b"abc")
            receipt = module.copy_tree(source, root / "target", self.expected(b"abc"))
            self.assertEqual(receipt["bytes"], 3)
            (source / "piece").write_bytes(b"xyz")
            with self.assertRaisesRegex(RuntimeError, "differs"):
                module.inventory(source, self.expected(b"abc"))

    def test_rejects_links_and_unexpected_empty_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "piece").write_bytes(b"abc")
            (source / "extra").write_bytes(b"")
            with self.assertRaisesRegex(RuntimeError, "bounds"):
                module.inventory(source, self.expected(b"abc"))
            (source / "extra").unlink()
            (source / "piece").unlink()
            (source / "piece").symlink_to(root / "missing")
            with self.assertRaisesRegex(RuntimeError, "link/special"):
                module.inventory(source, self.expected(b"abc"))

    def test_refuses_an_existing_output_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "piece").write_bytes(b"abc")
            with self.assertRaisesRegex(RuntimeError, "new"):
                module.copy_tree(source, source, self.expected(b"abc"))

if __name__ == "__main__":
    unittest.main()
