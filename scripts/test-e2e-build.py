"""QA helper failure/signal cleanup; all fake builds stay in owned temp roots."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class E2EBuildCleanupTests(unittest.TestCase):
    def test_failed_interrupted_and_production_alias_builds_leave_no_observer(self):
        helper = Path(__file__).with_name("build-e2e.sh").read_bytes()
        cases = (("failure", "exit 23", 23), ("interrupt", 'kill -INT "$PPID"; exit 0', 130), ("terminate", 'kill -TERM "$PPID"; exit 0', 143), ("production-alias", "exit 0", 1))
        for outcome, code, expected in cases:
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                for directory in ("scripts", "fake-bin", "e2e/support", "internal/webui/embedded/wasm"):
                    (root / directory).mkdir(parents=True)
                (root / "scripts/build-e2e.sh").write_bytes(helper)
                (root / "aurialis").write_bytes(b"unchanged production fixture")
                (root / "internal/webui/embedded/wasm/aurialis-realtime.wasm").write_bytes(b"bounded fixture")
                (root / "e2e/support/actual-output-tap.js").write_bytes(b"test-only observer fixture")
                fake_go = root / "fake-bin/go"
                fake_go.write_text("#!/bin/sh\n" + code + "\n")
                fake_go.chmod(0o755)
                output = "./aurialis" if outcome == "production-alias" else str(root / "separate-qa")
                result = subprocess.run(["bash", str(root / "scripts/build-e2e.sh"), output], env={**os.environ, "PATH": str(root / "fake-bin") + os.pathsep + os.environ["PATH"]}, capture_output=True, timeout=5, check=False)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertFalse((root / "internal/webui/embedded/__qa/actual-output-tap.js").exists())
                self.assertEqual((root / "aurialis").read_bytes(), b"unchanged production fixture")


if __name__ == "__main__":
    unittest.main()
