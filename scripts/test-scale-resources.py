"""Injected RSS/disk/serialization boundaries only; no browser or process controls."""
from pathlib import Path
import os
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
from scale_resources import *


def row(pid, group, rss):
    return {"pid": pid, "ppid": 1, "pgid": group, "start": str(pid), "rssBytes": rss, "state": "S"}


class ResourceContracts(unittest.TestCase):
    def baseline(self):
        return {**resource_values([row(10, 10, 1), row(20, 20, 1)], 10, row(30, 30, 1), [row(40, 40, 1)], row(50, 50, 1)), "dataBytes": 0, "scratchBytes": 0, "knownIdentities": 5}

    def admit(self, values, **kwargs):
        return admit_sample({"knownIdentities": values["processes"], **values}, available=MIN_FREE + MAX_DATA, elapsed=0, seconds=60, **kwargs)

    def test_combined_known_identity_boundary_deduplicates_and_charges_unresolved_retirement(self):
        owned = {pid: row(pid, 10, 0) for pid in range(10, 2058)}
        service = {pid: row(pid, 20, 0) for pid in range(2058, 4105)}
        parent = row(5000, 5000, 1)
        count = known_identity_count(owned, service, set(), owned[10], parent)
        self.assertEqual(count, 4096)  # Duplicate exact native identity is counted once.
        values = {**self.baseline(), "knownIdentities": count}; self.admit(values)
        service[4105] = row(4105, 20, 0)
        values["knownIdentities"] = known_identity_count(owned, service, set(), owned[10], parent)
        self.assertEqual(values["knownIdentities"], 4097)
        self.assertLess(len(owned), 4096); self.assertLess(len(service), 4096)
        with self.assertRaisesRegex(RuntimeError, "historical identity"):
            self.admit(values)
        self.assertEqual(known_identity_count(owned, service, {4105, 6000}, None, parent), 4098)

    def test_collective_browser_ceiling_rejects_separately_small_members(self):
        values = resource_values([row(10, 10, 1), row(20, 20, 2 * GIB), row(21, 20, GIB + 1)], 10, None, [], row(50, 50, 1))
        with self.assertRaisesRegex(RuntimeError, "Collective browser"):
            self.admit({**values, "dataBytes": 0, "scratchBytes": 0})

    def test_service_supervisor_native_tip_union_and_are_counted_exactly_once(self):
        nodes = [row(10, 10, GIB), row(11, 10, GIB), row(20, 20, GIB)]
        native, parent, service = row(30, 30, GIB // 2), row(50, 50, GIB // 2), row(40, 40, 1)
        values = resource_values(nodes, 10, native, [service, native], parent)
        self.assertEqual(values["processes"], 6)
        self.assertEqual(values["ownedRSS"], 4 * GIB + 1)
        with self.assertRaisesRegex(RuntimeError, "Complete union"):
            self.admit({**values, "dataBytes": 0, "scratchBytes": 0})

    def test_per_service_and_supervisor_ceilings_are_explicit(self):
        for name in ("serviceGroupRSS", "supervisorRSS"):
            with self.subTest(name=name):
                values = self.baseline(); values[name] = GIB + 1
                with self.assertRaisesRegex(RuntimeError, "sampled 1 GiB"):
                    self.admit(values)

    def test_exact_budget_includes_terminal_publication_and_one_byte_denies(self):
        values = self.baseline(); values["dataBytes"] = MAX_DATA - TERMINAL_RESERVE
        self.admit(values)
        values["dataBytes"] += 1
        with self.assertRaisesRegex(RuntimeError, "terminal publication"):
            self.admit(values)

    def test_physical_admission_includes_unspent_combined_demand(self):
        values = self.baseline(); values["dataBytes"] = 100
        admit_sample(values, available=MIN_FREE + MAX_DATA - 100, elapsed=0, seconds=60)
        with self.assertRaisesRegex(RuntimeError, "remaining combined demand"):
            admit_sample(values, available=MIN_FREE + MAX_DATA - 101, elapsed=0, seconds=60)

    def test_log_report_and_misc_subcaps_are_inside_combined_budget(self):
        for key, value in (("log_bytes", MAX_LOGS + 1), ("report_bytes", MAX_REPORTS - TERMINAL_RESERVE + 1), ("misc_bytes", MAX_MISC + 1)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.admit(self.baseline(), **{key: value})

    def test_symlink_files_and_directories_count_entry_bytes_without_following(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as foreign:
            path = Path(root).resolve(); destination = Path(foreign).resolve()
            (destination / "large").write_bytes(bytes(MIB))
            baseline = directory_bytes(path)
            (path / "directory-link").symlink_to(destination, target_is_directory=True)
            (path / "file-link").symlink_to(destination / "large")
            accounted = directory_bytes(path)
            own = path.stat(); expected = max(own.st_size, own.st_blocks * 512)
            for link in path.iterdir():
                item = link.lstat(); expected += max(item.st_size, item.st_blocks * 512)
            self.assertEqual(accounted, expected)
            self.assertGreater(accounted, baseline)
            self.assertLess(accounted, MIB)
            self.assertEqual((destination / "large").stat().st_size, MIB)

    def test_one_disk_ledger_counts_entries_once_and_applies_subcaps_inside_total(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); scratch = root / "native"; scratch.mkdir()
            (scratch / "profile").mkdir(); (scratch / "profile/data").write_bytes(bytes(9000))
            service = root / "service"; service.mkdir(); (service / "debug.log").write_bytes(bytes(5000)); (service / "state.bin").write_bytes(bytes(7000))
            (root / "result.json").write_text('{"status":"pass"}')
            values = disk_values(root, scratch)
            self.assertEqual(values["dataBytes"], directory_bytes(root))
            self.assertEqual(values["scratchBytes"], directory_bytes(scratch))
            self.assertGreaterEqual(values["logBytes"], 5000)
            self.assertGreater(values["reportBytes"], 0)
            self.assertGreaterEqual(values["miscBytes"], 7000)

    def test_special_files_fail_without_following_or_reading_them(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve(); os.mkfifo(path / "pipe")
            with self.assertRaisesRegex(RuntimeError, "Special file"):
                directory_bytes(path)

    def test_bounded_receipt_reserves_newline_and_refuses_overflow_or_nonfinite(self):
        value = {"status": "pass", "observations": [1, 2]}
        encoded = bounded_json(value)
        self.assertEqual(bounded_json(value, len(encoded)), encoded)
        with self.assertRaisesRegex(RuntimeError, "publication bound"):
            bounded_json(value, len(encoded) - 1)
        with self.assertRaises(ValueError):
            bounded_json({"peak": float("nan")})


if __name__ == "__main__":
    unittest.main()
