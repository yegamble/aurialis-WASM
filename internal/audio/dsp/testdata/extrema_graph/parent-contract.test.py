"""Synthetic supervisor tests only; these never load a Go/WASM module."""
# cspell:ignore killpg
import importlib.util
import pathlib
import tempfile
import sys

sys.dont_write_bytecode = True
import unittest
from unittest.mock import Mock, patch

FILE = pathlib.Path(__file__).with_name('run-wasm-pair.py')
SPEC = importlib.util.spec_from_file_location('runner', FILE)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class ParentContract(unittest.TestCase):
    def test_streaming_byte_compare_and_independent_hash(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-extrema-contract-') as directory:
            a, b = [pathlib.Path(directory) / name for name in ('a', 'b')]
            a.write_bytes(b'a' * 65536 + b'ending')
            b.write_bytes(a.read_bytes())
            self.assertTrue(RUNNER.compare_streams(a, b)['byteEqual'])
            b.write_bytes(b'a' * 65536 + b'EndinG')
            result = RUNNER.compare_streams(a, b)
            self.assertFalse(result['byteEqual'])
            self.assertEqual(result['firstDifferentByte'], 65536)
            b.write_bytes(b'a' * 65536)
            self.assertEqual(RUNNER.compare_streams(a, b)['firstDifferentByte'], 65536)
            with self.assertRaises(ValueError):
                RUNNER.compare_streams(a, b, cap=65535)

    def test_go_counter_admission_is_closed_not_a_new_audio_tolerance(self):
        valid = 'cases27 rate8000 baseFrames180687 numericWords6256332 outputBytes2354640 fixedGraphBytes1073080 inputSHA256' + 'a' * 64
        self.assertEqual(RUNNER.parse_counter_receipt(valid, 8000)['cases'], 27)
        for bad in (valid.replace('cases27', 'cases26'), valid.replace('180687', '200001'), valid.replace('6256332', '16777217'), valid.replace('2354640', '8388609'), valid.replace('1073080', '2097153')):
            with self.assertRaises(ValueError):
                RUNNER.parse_counter_receipt(bad, 8000)

    def test_child_exit_is_observed_and_stdout_stderr_share_cap(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-extrema-contract-') as directory:
            result = RUNNER.bounded_child([str(RUNNER.NODE), '-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=3'], pathlib.Path(directory), seconds=2)
            self.assertEqual(result['exit'], 3)
            self.assertIsNone(result['failure'])
            self.assertEqual(result['logBytes'], 6)
        with tempfile.TemporaryDirectory(prefix='aurialis-extrema-contract-') as directory:
            result = RUNNER.bounded_child([str(RUNNER.NODE), '-e', 'process.stdout.write(Buffer.alloc(131072));process.stderr.write(Buffer.alloc(131073))'], pathlib.Path(directory), seconds=2)
            self.assertEqual(result['failure'], 'combined-log256KiB-cap')
            self.assertEqual(result['logBytes'], RUNNER.LOG_CAP)
            self.assertIsNotNone(result['exit'])
            if result['processGroupSignal'] == 'group-denied-direct-child-killed':
                self.assertEqual(result['cleanupFailure'], 'process-group-signal-denied; descendants-not-certified-stopped')
            else:
                self.assertIsNone(result['cleanupFailure'])
            self.assertEqual((pathlib.Path(directory) / 'child.log').stat().st_size, RUNNER.LOG_CAP)


    def test_exited_leader_permission_race_is_reaped_without_false_group_claim(self):
        process = Mock(pid=123, poll=lambda: 0)
        with patch.object(RUNNER.os, 'killpg', side_effect=PermissionError):
            self.assertEqual(RUNNER.signal_group(process), 'leader-already-exited')
        process.kill.assert_not_called()

    def test_denied_live_group_signal_is_explicitly_not_group_certification(self):
        process = Mock(pid=123, poll=lambda: None)
        with patch.object(RUNNER.os, 'killpg', side_effect=PermissionError):
            self.assertEqual(RUNNER.signal_group(process), 'group-denied-direct-child-killed')
        process.kill.assert_called_once()

    def test_existing_log_admission_starts_no_child(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-extrema-contract-') as directory:
            (pathlib.Path(directory) / 'child.log').write_text('retained')
            with patch.object(RUNNER.subprocess, 'Popen') as create:
                with self.assertRaises(FileExistsError):
                    RUNNER.bounded_child([str(RUNNER.NODE)], pathlib.Path(directory))
                create.assert_not_called()

    def test_external_watchdog_kills_without_waiting_for_javascript_yield(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-extrema-contract-') as directory:
            result = RUNNER.bounded_child([str(RUNNER.NODE), '-e', 'while(true){}'], pathlib.Path(directory), seconds=0.1)
            self.assertEqual(result['failure'], 'external0.1s-wall-watchdog')
            self.assertEqual(result['exit'], -9)


if __name__ == '__main__':
    unittest.main()
