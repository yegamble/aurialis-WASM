"""Fixed PID-probe controls; all subprocess, selector and pipe IO is mocked."""
import base64
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
import listener_probe as probe


class Selector:
    def __init__(self): self.mapping = {}; self.closed = False
    def register(self, stream, _event, name): self.mapping[stream.fileno()] = SimpleNamespace(fd=stream.fileno(), fileobj=stream, data=name)
    def unregister(self, stream): self.mapping.pop(stream.fileno())
    def get_map(self): return self.mapping
    def select(self, timeout): return [(value, 1) for value in list(self.mapping.values())]
    def close(self): self.closed = True


class ListenerControls(unittest.TestCase):
    def fixture(self, stdout=b"101\n102\n", stderr=b"", code=0):
        process = Mock(pid=100); process.poll.return_value = code; process.wait.return_value = code
        process.stdout = Mock(); process.stdout.fileno.return_value = 10
        process.stderr = Mock(); process.stderr.fileno.return_value = 11
        streams = {10: bytearray(stdout), 11: bytearray(stderr)}
        def read(fd, count):
            result = bytes(streams[fd][:count]); del streams[fd][:count]; return result
        return process, read, Selector()

    def call(self, process, read, selector, **extra):
        with patch.object(probe.subprocess, "Popen", return_value=process), patch.object(probe.selectors, "DefaultSelector", return_value=selector), patch.object(probe.os, "set_blocking"), patch.object(probe.os, "read", side_effect=read):
            return probe.listener_probe(3927)

    def test_terse_canonical_pids_and_exact_fixed_command(self):
        process, read, selector = self.fixture()
        with patch.object(probe.subprocess, "Popen", return_value=process) as launch, patch.object(probe.selectors, "DefaultSelector", return_value=selector), patch.object(probe.os, "set_blocking"), patch.object(probe.os, "read", side_effect=read):
            pids, diagnostic = probe.listener_probe(3927)
        self.assertEqual(pids, {101, 102})
        self.assertEqual(launch.call_args.args[0], ["/usr/sbin/lsof", "-nP", "-iTCP:3927", "-sTCP:LISTEN", "-t"])
        self.assertTrue(diagnostic["stdout"]["complete"]); self.assertEqual(diagnostic["exitCode"], 0)
        self.assertEqual(base64.b64decode(diagnostic["stdout"]["prefixBase64"]), b"101\n102\n")
        process.kill.assert_not_called(); process.stdout.close.assert_called_once(); process.stderr.close.assert_called_once(); self.assertTrue(selector.closed)

    def test_p_f_blocks_noncanonical_and_excess_pid_count_refuse(self):
        for stdout in [b"p101\nf5\n", b"101", b"0101\n", b"+101\n", b"1\n", b"99999999999\n", b"101\n\n", b"101\n" * 257]:
            with self.subTest(stdout=stdout[:30]), self.assertRaises(probe.ListenerProbeError): self.call(*self.fixture(stdout))

    def test_nonzero_exit_retains_bounded_selected_output(self):
        with self.assertRaises(probe.ListenerProbeError) as caught: self.call(*self.fixture(b"", b"permission denied", 1))
        value = caught.exception.diagnostic
        self.assertEqual(value["exitCode"], 1); self.assertTrue(value["stderr"]["complete"])
        self.assertEqual(base64.b64decode(value["stderr"]["prefixBase64"]), b"permission denied")
        self.assertLessEqual(len(json.dumps(value).encode()), 4096)

    def test_stdout_or_stderr_overflow_kills_and_reaps_assigned_handle(self):
        for stream, size in [("stdout", 4097), ("stderr", 1025)]:
            process, read, selector = self.fixture(b"x" * size if stream == "stdout" else b"101\n", b"x" * size if stream == "stderr" else b"")
            process.poll.return_value = None; process.kill.side_effect = lambda: setattr(process.poll, "return_value", -9)
            with self.subTest(stream=stream), self.assertRaises(probe.ListenerProbeError) as caught: self.call(process, read, selector)
            diagnostic = caught.exception.diagnostic
            self.assertEqual(diagnostic[stream]["bytesCaptured"], size); self.assertTrue(diagnostic[stream]["captureOverflow"]); self.assertFalse(diagnostic[stream]["complete"])
            self.assertTrue(diagnostic[stream]["prefixTruncated"]); self.assertLessEqual(len(json.dumps(diagnostic).encode()), 4096)
            process.kill.assert_called_once(); process.wait.assert_called()

    def test_deadline_after_assignment_kills_and_attempts_wait0(self):
        process, read, selector = self.fixture(); process.poll.return_value = None
        process.kill.side_effect = lambda: setattr(process.poll, "return_value", -9)
        calls = [0]
        def remaining(maximum):
            calls[0] += 1
            if calls[0] > 1: raise RuntimeError("phase deadline exhausted")
            return maximum
        with patch.object(probe, "remaining", side_effect=remaining):
            with self.assertRaises(probe.ListenerProbeError) as caught: self.call(process, read, selector)
        process.kill.assert_called_once(); process.wait.assert_called_once_with(timeout=0)
        self.assertIn("deadline", caught.exception.diagnostic["primary"]["message"])

    def test_late_successful_exit_never_returns_pid_authority(self):
        process, read, selector = self.fixture(); expired = [False]
        process.wait.side_effect = lambda timeout: expired.__setitem__(0, True) or 0
        def remaining(maximum):
            if expired[0]: raise RuntimeError("phase deadline exhausted")
            return maximum
        with patch.object(probe, "remaining", side_effect=remaining):
            with self.assertRaises(probe.ListenerProbeError) as caught: self.call(process, read, selector)
        self.assertEqual(caught.exception.diagnostic["exitCode"], 0)
        self.assertIsNotNone(caught.exception.diagnostic["primary"])

    def test_observer_setup_rejection_after_popen_keeps_direct_handle(self):
        process, read, selector = self.fixture(); process.poll.return_value = None
        process.kill.side_effect = lambda: setattr(process.poll, "return_value", -9)
        with patch.object(probe.subprocess, "Popen", return_value=process), patch.object(probe.selectors, "DefaultSelector", side_effect=RuntimeError("selector setup failed")):
            with self.assertRaises(probe.ListenerProbeError): probe.listener_probe(3927)
        process.kill.assert_called_once(); process.wait.assert_called(); process.stdout.close.assert_called_once(); process.stderr.close.assert_called_once()

    def test_primary_survives_independent_reap_and_close_failures(self):
        process, read, selector = self.fixture(); process.poll.return_value = None
        process.wait.side_effect = [probe.subprocess.TimeoutExpired("fixed-lsof", 3), RuntimeError("reap failed")]
        process.kill.side_effect = RuntimeError("kill failed"); process.stdout.close.side_effect = RuntimeError("stdout close failed")
        with self.assertRaises(probe.ListenerProbeError) as caught: self.call(process, read, selector)
        value = caught.exception.diagnostic
        self.assertEqual(value["primary"]["type"], "TimeoutExpired")
        self.assertEqual([entry["phase"] for entry in value["cleanup"]], ["listener-direct-kill", "listener-direct-reap", "listener-stdout-close"])
        process.stderr.close.assert_called_once(); self.assertTrue(selector.closed)

    def test_spawn_failure_publishes_not_executed_and_unknown_outputs(self):
        with patch.object(probe.subprocess, "Popen", side_effect=PermissionError("spawn denied")):
            with self.assertRaises(probe.ListenerProbeError) as caught: probe.listener_probe(3927)
        self.assertFalse(caught.exception.diagnostic["executed"]); self.assertIsNone(caught.exception.diagnostic["exitCode"])
        self.assertFalse(caught.exception.diagnostic["stdout"]["complete"])

    def test_invalid_port_refuses_before_popen(self):
        with patch.object(probe.subprocess, "Popen") as launch, self.assertRaises(RuntimeError): probe.listener_probe("3927")
        launch.assert_not_called()


if __name__ == "__main__": unittest.main()
