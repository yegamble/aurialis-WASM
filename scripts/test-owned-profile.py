"""Synthetic fresh-directory contracts only; no Chromium or runtime profile."""
import importlib.util
from pathlib import Path
import os
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
from qualification_runtime import qualification_runtime
import qualification_runtime as runtime_module

SPEC = importlib.util.spec_from_file_location("owned_profile", Path(__file__).parent / "qualification/owned_profile.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProfileContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aurialis-profile-unit-")
        self.scratch = Path(self.temporary.name).resolve()
        self.owner = MODULE.OwnedProfile(self.scratch, "a" * 64)

    def tearDown(self):
        self.temporary.cleanup()

    def test_pinned_runtime_records_actual_executable_and_cleanup_capability(self):
        value = qualification_runtime()
        self.assertEqual(value["version"], "3.14.6")
        self.assertTrue(value["symlinkSafe"])
        self.assertIn("dir_fd", value["rmtreeSignature"])
        self.assertEqual(Path(value["resolvedExecutable"]), Path(sys.executable).resolve())
        self.owner.create()
        self.assertEqual(self.owner.runtime, value)

    def test_unqualified_version_refuses_before_any_profile_creation(self):
        with patch.object(runtime_module.sys, "version_info", (3, 9, 6)):
            with self.assertRaisesRegex(RuntimeError, "Python 3.14.6"):
                self.owner.create()
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(self.owner.created, {})

    def test_missing_fd_cleanup_api_refuses_before_profile_creation(self):
        def old_rmtree(path, ignore_errors=False):
            raise AssertionError("Unsupported cleanup must never run")
        old_rmtree.avoids_symlink_attacks = True
        with patch.object(runtime_module.shutil, "rmtree", old_rmtree):
            with self.assertRaisesRegex(RuntimeError, "fd-relative"):
                self.owner.create()
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_exact_node_descriptor_and_fresh_mode(self):
        value = self.owner.create()
        self.assertEqual(set(value), {"token", "sdkVersion", "userData", "artifacts"})
        self.assertEqual(value["sdkVersion"], "1.64.1")
        for key in ["userData", "artifacts"]:
            self.assertEqual(set(value[key]), {"path", "dev", "ino"})
            self.assertTrue(value[key]["dev"].isdigit())
            self.assertEqual(Path(value[key]["path"]).stat().st_mode & 0o777, 0o700)
        value["userData"]["ino"] = "0"
        self.assertNotEqual(self.owner.descriptor()["userData"]["ino"], "0")

    def test_existing_path_is_never_adopted_or_deleted(self):
        foreign = self.scratch / "profile"
        foreign.mkdir(mode=0o700)
        (foreign / "keep").write_text("foreign")
        with self.assertRaises(FileExistsError):
            self.owner.create()
        self.assertEqual((foreign / "keep").read_text(), "foreign")
        self.assertEqual(self.owner.created, {})

    def test_partial_creation_remains_diagnostic_without_deletion(self):
        (self.scratch / "browser-artifacts").mkdir(mode=0o700)
        with self.assertRaises(FileExistsError):
            self.owner.create()
        self.assertTrue((self.scratch / "profile").is_dir())
        self.assertEqual(set(self.owner.created), {"userData"})
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            self.owner.cleanup_success()

    def test_replaced_or_symlinked_directory_refuses_cleanup(self):
        self.owner.create()
        original = self.scratch / "profile"
        moved = self.scratch / "old-profile"
        original.rename(moved)
        original.mkdir(mode=0o700)
        (original / "keep").write_text("foreign")
        with patch.object(MODULE.shutil, "rmtree") as remove:
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                self.owner.cleanup_success()
            remove.assert_not_called()
        self.assertEqual((original / "keep").read_text(), "foreign")
        original.rename(self.scratch / "new-foreign")
        original.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.owner.cleanup_success()

    def test_parent_success_cleanup_requires_actual_absence(self):
        self.owner.create()
        with patch.object(MODULE.shutil, "rmtree") as remove:
            with self.assertRaisesRegex(RuntimeError, "remains"):
                self.owner.cleanup_success()
            self.assertEqual(remove.call_count, 1)
        self.assertTrue(all(not row["absent"] for row in self.owner.state()["paths"]))
        state = self.owner.cleanup_success()
        self.assertTrue(all(row["absent"] for row in state["paths"]))
        self.assertEqual(len(state["removed"]), 2)

    def test_partial_cleanup_reports_exact_state_without_deleting_foreign_paths(self):
        self.owner.create()
        original = MODULE.shutil.rmtree
        def remove(name, **kwargs):
            if name == "browser-artifacts":
                raise OSError("injected second-directory cleanup failure")
            return original(name, **kwargs)
        with patch.object(MODULE.shutil, "rmtree", side_effect=remove):
            with self.assertRaisesRegex(OSError, "second-directory"):
                self.owner.cleanup_success()
        state = self.owner.state()
        self.assertTrue(state["paths"][0]["absent"])
        self.assertFalse(state["paths"][1]["absent"])
        self.assertEqual(len(state["removed"]), 1)


if __name__ == "__main__":
    unittest.main()
