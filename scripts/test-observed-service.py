"""Injected snapshots and command hashes only; no OS process observation."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent / "qualification"
sys.path.insert(0, str(SOURCE))
SPEC = importlib.util.spec_from_file_location("service_under_test", SOURCE / "observed_service.py")
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)


def row(pid, parent, group=100, start=None, rss=10, state="S"):
    return {"pid": pid, "ppid": parent, "pgid": group, "start": start or "start-" + str(pid),
            "rssBytes": rss, "state": state}


class ServiceContracts(unittest.TestCase):
    def setUp(self):
        self.rows = {100: row(100, 50), 101: row(101, 100), 102: row(102, 101)}
        self.commands = {pid: format(pid, "064x") for pid in self.rows}
        self.snapshot = patch.object(SERVICE, "snapshot", side_effect=lambda: copy.deepcopy(self.rows))
        self.command = patch.object(SERVICE, "command_hash", side_effect=lambda pid: self.commands.get(pid))
        self.snapshot.start()
        self.command.start()
        self.addCleanup(self.snapshot.stop)
        self.addCleanup(self.command.stop)

    def observer(self):
        return SERVICE.ObservedService(100)

    def test_initial_exact_group_and_transitive_ancestry_are_admitted(self):
        self.rows = dict(reversed(list(self.rows.items())))
        observer = self.observer()
        self.assertEqual(observer.identity["commandSHA256"], self.commands[100])
        self.assertEqual({x["pid"] for x in observer.observe()}, {100, 101, 102})
        self.assertEqual({x["pid"] for x in observer.admissions}, {101, 102})
        self.assertEqual(len(observer.known), 3)

    def test_new_members_require_current_transitive_ancestry(self):
        observer = self.observer()
        self.rows[103] = row(103, 102)
        self.rows[104] = row(104, 103)
        self.commands.update({103: "d" * 64, 104: "e" * 64})
        self.assertEqual({x["pid"] for x in observer.observe()}, {100, 101, 102, 103, 104})
        self.assertEqual(len(observer.admissions), 4)
        observer.observe()
        self.assertEqual(len(observer.admissions), 4)

    def test_known_members_can_reparent_while_exact_leader_remains(self):
        observer = self.observer()
        self.rows[102]["ppid"] = 1
        self.assertIn(102, {x["pid"] for x in observer.observe()})

    def test_new_orphan_cannot_use_only_a_same_group_leader(self):
        observer = self.observer()
        self.rows[103] = row(103, 1)
        self.commands[103] = "d" * 64
        with self.assertRaisesRegex(RuntimeError, "ancestry"):
            observer.observe()
        self.assertNotIn(103, observer.known)

    def test_anchor_absence_terminal_reuse_and_changed_command_refuse(self):
        for change in ("absent", "terminal", "reuse", "command"):
            with self.subTest(change=change):
                self.setUpFresh()
                observer = self.observer()
                if change == "absent":
                    del self.rows[100]
                elif change == "terminal":
                    self.rows[100]["state"] = "Z"
                elif change == "reuse":
                    self.rows[100]["start"] = "different-start"
                else:
                    self.commands[100] = "f" * 64
                with self.assertRaises(RuntimeError):
                    observer.observe()

    def setUpFresh(self):
        self.rows = {100: row(100, 50), 101: row(101, 100), 102: row(102, 101)}
        self.commands = {pid: format(pid, "064x") for pid in self.rows}

    def test_known_pid_reuse_or_foreign_group_refuses(self):
        for changed in ({"start": "reused"}, {"pgid": 999}):
            with self.subTest(changed=changed):
                self.setUpFresh()
                observer = self.observer()
                self.rows[102].update(changed)
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    observer.observe()

    def test_new_descendant_cannot_escape_group(self):
        observer = self.observer()
        self.rows[103] = row(103, 102, group=103)
        self.commands[103] = "d" * 64
        with self.assertRaisesRegex(RuntimeError, "escaped"):
            observer.observe()

    def test_unrelated_foreign_groups_are_not_counted(self):
        self.rows[999] = row(999, 1, group=999, rss=999999)
        observer = self.observer()
        self.assertEqual(sum(x["rssBytes"] for x in observer.observe()), 30)

    def test_cyclic_or_terminal_new_ancestry_refuses(self):
        for terminal in (False, True):
            with self.subTest(terminal=terminal):
                self.setUpFresh()
                observer = self.observer()
                self.rows[103] = row(103, 104)
                self.rows[104] = row(104, 103 if not terminal else 100,
                                     state="Z" if terminal else "S")
                self.commands.update({103: "d" * 64, 104: "e" * 64})
                with self.assertRaisesRegex(RuntimeError, "ancestry"):
                    observer.observe()

    def test_missing_command_requires_fresh_confirmed_exit(self):
        for terminal in (False, True):
            with self.subTest(terminal=terminal):
                self.setUpFresh()
                observer = self.observer()
                old = copy.deepcopy(self.rows)
                self.commands[102] = None
                if terminal:
                    self.rows[102]["state"] = "Z"
                else:
                    del self.rows[102]
                self.assertNotIn(102, {x["pid"] for x in observer.observe(old)})
                self.assertTrue(any(x["phase"] == "confirmed-member-exit" for x in observer.events))

    def test_unsettled_missing_or_changed_command_refuses(self):
        for command in (None, "f" * 64):
            with self.subTest(command=command):
                self.setUpFresh()
                observer = self.observer()
                self.commands[102] = command
                with self.assertRaisesRegex(RuntimeError, "did not settle"):
                    observer.observe()

    def test_leader_command_race_cannot_admit_without_live_anchor(self):
        observer = self.observer()
        old = copy.deepcopy(self.rows)
        self.commands[100] = None
        del self.rows[100]
        with self.assertRaisesRegex(RuntimeError, "leader exited"):
            observer.observe(old)

    def test_identity_count_is_bounded_before_command_admission(self):
        observer = self.observer()
        for pid in range(103, 4197):
            self.rows[pid] = row(pid, 100)
        with self.assertRaisesRegex(RuntimeError, "quota"):
            observer.observe()
        self.assertEqual(len(observer.known), 3)

    def test_invalid_resource_rows_refuse(self):
        for changed in ({"rssBytes": -1}, {"pid": True}, {"start": ""}, {"state": ""}):
            with self.subTest(changed=changed):
                self.setUpFresh()
                observer = self.observer()
                self.rows[102].update(changed)
                with self.assertRaises(RuntimeError):
                    observer.observe()

    def test_union_deduplicates_and_keeps_conservative_rss_without_mutation(self):
        left = row(100, 50, rss=10)
        right = row(100, 1, rss=30)
        other = row(999, 1, group=999, rss=70)
        actual = SERVICE.resource_union([left], [right, other])
        self.assertEqual(len(actual), 2)
        self.assertEqual(sum(x["rssBytes"] for x in actual), 100)
        self.assertEqual(left["rssBytes"], 10)
        self.assertEqual(right["rssBytes"], 30)

    def test_union_rejects_same_pid_changed_start_or_group(self):
        for changed in ({"start": "reused"}, {"pgid": 999}):
            with self.subTest(changed=changed):
                other = {**row(100, 50), **changed}
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    SERVICE.resource_union([row(100, 50)], [other])


    def test_departed_member_cannot_reappear_with_identical_coarse_identity(self):
        observer = self.observer()
        saved = dict(self.rows[102])
        del self.rows[102]
        observer.observe()
        self.assertIn(102, observer.departed)
        self.rows[102] = {**saved, "ppid": 1}
        with self.assertRaisesRegex(RuntimeError, "departed|terminal"):
            observer.observe()

    def test_terminal_member_cannot_become_live_again(self):
        observer = self.observer()
        self.rows[102]["state"] = "Z"
        observer.observe()
        self.rows[102].update({"state": "S", "ppid": 1})
        with self.assertRaisesRegex(RuntimeError, "departed|terminal"):
            observer.observe()

    def test_fresh_confirmed_exit_also_prevents_live_reappearance(self):
        for terminal in (False, True):
            with self.subTest(terminal=terminal):
                self.setUpFresh()
                observer = self.observer()
                old = copy.deepcopy(self.rows)
                command = self.commands[102]
                self.commands[102] = None
                if terminal:
                    self.rows[102]["state"] = "Z"
                else:
                    del self.rows[102]
                observer.observe(old)
                self.commands[102] = command
                self.rows[102] = row(102, 1)
                with self.assertRaisesRegex(RuntimeError, "departed|terminal"):
                    observer.observe()

    def test_second_leader_command_observation_cannot_ignore_confirmed_exit(self):
        observer = self.observer()
        count = 0
        def raced(pid):
            nonlocal count
            if pid == 100:
                count += 1
                if count == 2:
                    del self.rows[100]
                    return None
            return self.commands.get(pid)
        with patch.object(SERVICE, "command_hash", side_effect=raced):
            with self.assertRaisesRegex(RuntimeError, "leader exited"):
                observer.observe()



    def test_entry_anchor_loss_cannot_be_reused_after_reappearance(self):
        for terminal in (False, True):
            with self.subTest(terminal=terminal):
                self.setUpFresh()
                observer = self.observer()
                saved = dict(self.rows[100])
                if terminal:
                    self.rows[100]["state"] = "Z"
                else:
                    del self.rows[100]
                with self.assertRaisesRegex(RuntimeError, "leader anchor"):
                    observer.observe()
                self.rows[100] = saved
                with self.assertRaisesRegex(RuntimeError, "departed|terminal"):
                    observer.observe()



if __name__ == "__main__":
    unittest.main(verbosity=2)
