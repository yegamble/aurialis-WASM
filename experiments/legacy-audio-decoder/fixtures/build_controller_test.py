"""Inert unit evidence for resource-failure reporting, with no Docker calls."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("private_build_controller", Path(__file__).parents[1] / "run-build.py")
CONTROLLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROLLER)


class BuildExitTest(unittest.TestCase):
    def test_oom_cannot_be_hidden_by_successful_attachment(self):
        self.assertEqual(CONTROLLER.result_code({"OOMKilled": True, "ExitCode": 0}, False, None, 0), 137)

    def test_watchdog_and_disk_failures_cannot_report_success(self):
        self.assertEqual(CONTROLLER.result_code({"ExitCode": 0}, True, None, 0), 124)
        self.assertEqual(CONTROLLER.result_code({"ExitCode": 0}, False, "disk-headroom", 0), 125)

    def test_actual_container_failure_and_success_are_preserved(self):
        self.assertEqual(CONTROLLER.result_code({"ExitCode": 2}, False, None, 0), 2)
        self.assertEqual(CONTROLLER.result_code({"ExitCode": 0}, False, None, 0), 0)


if __name__ == "__main__":
    unittest.main()
