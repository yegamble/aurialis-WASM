"""Adversarial metadata-only success-cleanup admission; no browser or deletion."""
from pathlib import Path
import copy
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
from scale_completion import DELIVERY, REFUSAL, read_json, validate_launcher, validate_scale_result


def report(project="album-native-scale"):
    titles = [DELIVERY] if project == "album-native-scale" else [DELIVERY, REFUSAL]
    return {"errors": [], "stats": {"expected": len(titles), "unexpected": 0, "skipped": 0, "flaky": 0},
            "suites": [{"specs": [{"title": title, "ok": True, "tests": [{"projectName": project, "projectId": project, "expectedStatus": "passed", "status": "expected", "results": [{"status": "passed", "retry": 0, "errors": []}]}]} for title in titles]}]}


class CompletionContracts(unittest.TestCase):
    def test_exact_native_and_browser_case_sets_are_required(self):
        for project, count in (("album-native-scale", 1), ("album-browser-scale", 2)):
            self.assertEqual(len(validate_scale_result(report(project), project)), count)

    def test_global_errors_skips_flaky_wrong_project_and_duplicates_refuse(self):
        for name in ("global", "skip", "flaky", "project", "duplicate", "missing", "wrong-title"):
            with self.subTest(name=name):
                value = report("album-browser-scale")
                spec = value["suites"][0]["specs"][0]
                if name == "global": value["errors"] = [{"message": "stopped early"}]
                elif name == "skip": value["stats"]["skipped"] = 1
                elif name == "flaky": value["stats"]["flaky"] = 1
                elif name == "project": spec["tests"][0]["projectName"] = "other"
                elif name == "duplicate": value["suites"][0]["specs"][1] = copy.deepcopy(spec)
                elif name == "missing": value["suites"][0]["specs"].pop()
                else: spec["title"] = "similar but incomplete work"
                with self.assertRaises(RuntimeError): validate_scale_result(value, "album-browser-scale")

    def test_retry_or_failed_final_result_never_authorizes_cleanup(self):
        for name in ("retry", "failed", "results", "error", "expected-status"):
            with self.subTest(name=name):
                value = report(); case = value["suites"][0]["specs"][0]["tests"][0]
                if name == "retry": case["results"][0]["retry"] = 1
                elif name == "failed": case["results"][0]["status"] = "failed"
                elif name == "results": case["results"].append(copy.deepcopy(case["results"][0]))
                elif name == "error": case["results"][0]["errors"] = [{"message": "error"}]
                else: case["expectedStatus"] = "failed"
                with self.assertRaises(RuntimeError): validate_scale_result(value, "album-native-scale")

    def test_launcher_primary_cleanup_and_child_exit_remain_independent(self):
        value = {"mode": "scale", "project": "album-native-scale", "primary": None, "cleanup": [], "childExit": {"code": 0, "signal": None}, "audioProcessing": True}
        validate_launcher(value, "scale", "album-native-scale")
        for key, changed in (("primary", "failed"), ("cleanup", [{"phase": "server", "error": "close"}]), ("childExit", {"code": 0, "signal": "SIGTERM"}), ("audioProcessing", False)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                validate_launcher({**value, key: changed}, "scale", "album-native-scale")

    def test_file_reader_refuses_links_oversize_nonfinite_and_nonobject(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "receipt.json"; path.write_text('{"status":"pass"}')
            value, receipt = read_json(path); self.assertEqual(value, {"status": "pass"}); self.assertEqual(len(receipt["sha256"]), 64)
            link = path.parent / "link"; link.symlink_to(path)
            with self.assertRaises(OSError): read_json(link)
            with self.assertRaises(RuntimeError): read_json(path, 2)
            path.write_text('{"value":NaN}')
            with self.assertRaises(ValueError): read_json(path)
            path.write_text('[]')
            with self.assertRaises(RuntimeError): read_json(path)


if __name__ == "__main__":
    unittest.main()
