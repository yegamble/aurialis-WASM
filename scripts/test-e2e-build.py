"""QA helper failure/signal cleanup; all fake builds stay in owned temp roots."""
import os
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest


class E2EBuildCleanupTests(unittest.TestCase):
    def make_fixture(self, root):
        for directory in ("scripts", "fake-bin", "e2e/support", "internal/webui/embedded/wasm"):
            (root / directory).mkdir(parents=True)
        (root / "scripts/build-e2e.sh").write_bytes(Path(__file__).with_name("build-e2e.sh").read_bytes())
        (root / "aurialis").write_bytes(b"unchanged production fixture")
        (root / "internal/webui/embedded/wasm/aurialis-realtime.wasm").write_bytes(b"bounded fixture")
        (root / "internal/webui/embedded/build-target-native.json").write_text('{"schema":1,"target":"native"}\n')
        (root / "e2e/support/actual-output-tap.js").write_bytes(b"test-only observer fixture")
        fake_go = root / "fake-bin/go"
        fake_go.write_text("#!/bin/sh\nexit 0\n")
        fake_go.chmod(0o755)

    def run_build(self, root):
        env = {**os.environ, "PATH": str(root / "fake-bin") + os.pathsep + os.environ["PATH"]}
        return subprocess.run(["bash", str(root / "scripts/build-e2e.sh"), str(root / "qa-binary")], cwd=root, env=env, capture_output=True, timeout=5, check=False)

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
                (root / "internal/webui/embedded/build-target-native.json").write_text('{"schema":1,"target":"native"}\n')
                (root / "e2e/support/actual-output-tap.js").write_bytes(b"test-only observer fixture")
                fake_go = root / "fake-bin/go"
                fake_go.write_text("#!/bin/sh\n" + code + "\n")
                fake_go.chmod(0o755)
                output = "./aurialis" if outcome == "production-alias" else str(root / "separate-qa")
                result = subprocess.run(["bash", str(root / "scripts/build-e2e.sh"), output], env={**os.environ, "PATH": str(root / "fake-bin") + os.pathsep + os.environ["PATH"]}, capture_output=True, timeout=5, check=False)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertFalse((root / "internal/webui/embedded/__qa/actual-output-tap.js").exists())
                self.assertEqual((root / "aurialis").read_bytes(), b"unchanged production fixture")

    def test_browser_target_is_rejected_before_qa_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            (root / "internal/webui/embedded/build-target-native.json").unlink()
            (root / "internal/webui/embedded/build-target-browser.json").write_text('{"schema":1,"target":"browser"}\n')
            result = self.run_build(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "internal/webui/embedded/__qa/actual-output-tap.js").exists())

    def test_stale_owned_observer_is_removed_but_user_assets_are_kept(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            qa = root / "internal/webui/embedded/__qa"
            qa.mkdir()
            asset = b"test-only observer fixture"
            (qa / "actual-output-tap.js").write_bytes(asset)
            digest = hashlib.sha256(asset).hexdigest()
            (qa / ".aurialis-build-e2e-owner").write_text(f"aurialis-build-e2e-v1 2147483647 {digest}\n")
            (qa / "user-asset.txt").write_text("keep")
            result = self.run_build(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((qa / "actual-output-tap.js").exists())
            self.assertFalse((qa / ".aurialis-build-e2e-owner").exists())
            self.assertEqual((qa / "user-asset.txt").read_text(), "keep")

    def test_unowned_observer_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_fixture(root)
            qa = root / "internal/webui/embedded/__qa"
            qa.mkdir()
            asset = qa / "actual-output-tap.js"
            asset.write_text("user-owned")
            result = self.run_build(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(asset.read_text(), "user-owned")

    def test_browser_target_binary_is_rejected_before_server_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            binary = root / "artifacts/ci-runtime/aurialis-e2e"
            binary.parent.mkdir(parents=True)
            ran = root / "server-started"
            binary.write_text(f'#!/bin/sh\n# {{"schema":1,"target":"browser"}}\ntouch "{ran}"\n')
            binary.chmod(0o755)
            (root / "scripts/serve-e2e.sh").write_bytes(Path(__file__).with_name("serve-e2e.sh").read_bytes())
            (root / "scripts/ci-artifacts.py").write_text("raise SystemExit(0)\n")
            result = subprocess.run(["bash", str(root / "scripts/serve-e2e.sh"), "3847"], cwd=root, env={**os.environ, "AURIALIS_E2E_BINARY": str(binary)}, capture_output=True, timeout=5, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(ran.exists())


if __name__ == "__main__":
    unittest.main()
