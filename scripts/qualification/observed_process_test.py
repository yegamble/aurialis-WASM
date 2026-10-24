"""Synthetic identity/RSS union controls; no browser, model or audio work."""
import unittest
from unittest import mock
from observed_process import ObservedProcess, union_rows


class Observation(unittest.TestCase):
    def row(self, pid=10):
        return {"pid": pid, "ppid": 2, "pgid": pid, "start": "exact-start", "rssBytes": 30, "state": "S"}

    def test_native_is_counted_once_even_when_already_owned(self):
        native = self.row()
        self.assertEqual(sum(row["rssBytes"] for row in union_rows([native, self.row(11)], native)), 60)

    def test_changed_native_command_or_start_is_refused(self):
        row = self.row()
        with mock.patch("observed_process.snapshot", return_value={10: row}), mock.patch("observed_process.command_hash", return_value="accepted"):
            process = ObservedProcess(10)
        with mock.patch("observed_process.command_hash", return_value="changed"):
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                process.observe({10: row})
        with mock.patch("observed_process.command_hash", return_value="accepted"):
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                process.observe({10: {**row, "start": "reused"}})

    def test_disappeared_host_never_becomes_an_uncharged_zero(self):
        row = self.row()
        with mock.patch("observed_process.snapshot", return_value={10: row}), mock.patch("observed_process.command_hash", return_value="accepted"):
            process = ObservedProcess(10)
        with self.assertRaisesRegex(RuntimeError, "exited"):
            process.observe({})


if __name__ == "__main__":
    unittest.main()
