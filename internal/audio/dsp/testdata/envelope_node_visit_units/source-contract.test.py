"""Synthetic source contracts only: no original Go/GoJS unit or WASM instance."""
# cspell:ignore ctypes pidinfo argtypes restype
import copy
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('source_only_units', SOURCE / 'run-unit.py')
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
NAME = 'TestStudioExactExtremaBitContract'
LOG = '=== RUN   ' + NAME + '\n--- PASS: ' + NAME + ' (0.00s)\nPASS\n'


class FakeSelector:
    def __init__(self):
        self.key = None
    def register(self, stream, _event):
        self.key = types.SimpleNamespace(fileobj=stream)
    def get_map(self):
        return {} if self.key is None else {1: self.key}
    def select(self, _timeout):
        return [] if self.key is None else [(self.key, None)]
    def unregister(self, _stream):
        self.key = None
    def close(self):
        pass


class Contracts(unittest.TestCase):
    def test_closed_original_whitelist_and_full_log(self):
        self.assertEqual(HOST.selected_test(NAME)['name'], NAME)
        for bad in ('TestWriteStudioExtremaScreen', 'TestStudio.*', NAME + '/frames1', 'TestStudioClippingRepairNoAllocations'):
            with self.assertRaises(ValueError):
                HOST.selected_test(bad)
        self.assertEqual(HOST.validate_log(LOG, NAME)['started'], [NAME])
        for bad in (LOG.replace('=== RUN   ', ''), LOG.replace('PASS:', 'SKIP:'), LOG.replace('PASS:', 'FAIL:'), LOG + LOG, LOG[:-1], LOG.replace(NAME, 'TestStudioUnknown'), LOG + 'WARNING: DATA RACE\n'):
            with self.assertRaises(ValueError):
                HOST.validate_log(bad, NAME)

    def test_all_original_nested_cases_required(self):
        name = 'TestStudioPartitionedPostDetectorDirectConvolutionAndFiniteEdges'
        nested = [name + '/frames' + str(n) for n in (1, 127, 128, 129, 257, 513, 4097)]
        log = '=== RUN   ' + name + '\n' + ''.join('=== RUN   ' + entry + '\n' for entry in nested) + '--- PASS: ' + name + ' (0.01s)\n' + ''.join('    --- PASS: ' + entry + ' (0.00s)\n' for entry in nested) + 'PASS\n'
        self.assertEqual(HOST.validate_log(log, name)['started'], [name] + nested)
        with self.assertRaises(ValueError):
            HOST.validate_log(log.replace('    --- PASS: ' + nested[-1] + ' (0.00s)\n', ''), name)

    def test_exact_resident_api_structure_and_boundary(self):
        self.assertEqual(HOST.ctypes.sizeof(HOST.TaskInfo), 96)
        self.assertEqual(HOST.TaskInfo.resident.offset, 8)
        self.assertEqual(HOST.check_rss(HOST.RSS_CAP), HOST.RSS_CAP)
        for bad in (0, -1, True, '1'):
            with self.assertRaises(ValueError):
                HOST.check_rss(bad)
        with self.assertRaises(MemoryError):
            HOST.check_rss(HOST.RSS_CAP + 1)
        def call(_pid, flavor, arg, pointer, size):
            self.assertEqual((flavor, arg, size), (4, 0, 96))
            pointer._obj.resident = 123456
            return 96
        class Call:
            def __call__(self, *args):
                return call(*args)
        library = types.SimpleNamespace(proc_pidinfo=Call())
        with patch.object(HOST.ctypes, 'CDLL', return_value=library):
            self.assertEqual(HOST.rss_reader()(123), 123456)
        library.proc_pidinfo = lambda *_args: 0
        with patch.object(HOST.ctypes, 'CDLL', return_value=library):
            # Functions allow the ctypes signature attributes used by the host.
            with self.assertRaises(OSError):
                HOST.rss_reader()(123)

    def supervised(self, chunks, resident, clock=0, group='sent'):
        watcher = FakeSelector()
        stream = types.SimpleNamespace(fileno=lambda: 7, close=lambda: None)
        process = types.SimpleNamespace(pid=123, stdout=stream, poll=lambda: None if watcher.get_map() else 0, wait=lambda timeout: 0)
        times = iter([0, clock])
        def monotonic():
            return next(times, clock)
        with tempfile.TemporaryDirectory(prefix='aurialis-unit-synthetic-') as temporary:
            with patch.object(HOST.selectors, 'DefaultSelector', return_value=watcher), patch.object(HOST.subprocess, 'Popen', return_value=process) as spawn, patch.object(HOST.os, 'read', side_effect=chunks), patch.object(HOST.time, 'monotonic', side_effect=monotonic), patch.object(HOST.SUPERVISOR, 'signal_group', return_value=group):
                receipt = HOST.bounded_unit(['/synthetic/no-module'], pathlib.Path(temporary), {}, resident)
                spawn.assert_called_once()
                raw = (pathlib.Path(temporary) / 'child.log').read_bytes()
                self.assertEqual(len(raw), receipt['logBytes'])
                return receipt, raw

    def test_mocked_success_rss_and_no_observation_rejection(self):
        receipt, raw = self.supervised([LOG.encode(), b''], lambda _pid: 999)
        HOST.validate_parent(receipt)
        self.assertEqual(raw.decode(), LOG)
        self.assertEqual(receipt['resident']['maxObservedBytes'], 999)
        bad = copy.deepcopy(receipt)
        bad['resident']['samples'] = 0
        with self.assertRaises(ValueError):
            HOST.validate_parent(bad)

    def test_mocked_rss_overage_and_query_failure_cleanup(self):
        receipt, _ = self.supervised([], lambda _pid: HOST.RSS_CAP + 1)
        self.assertEqual(receipt['failure'], 'resident-monitor-MemoryError')
        self.assertEqual(receipt['resident']['maxObservedBytes'], HOST.RSS_CAP + 1)
        self.assertEqual(receipt['processGroupSignal'], 'sent')
        def failed(_pid):
            raise OSError('synthetic denied')
        receipt, _ = self.supervised([], failed, group='group-denied-direct-child-killed')
        self.assertEqual(receipt['failure'], 'resident-monitor-OSError')
        self.assertIsNotNone(receipt['cleanupFailure'])

    def test_mocked_original_wall_and_log_caps(self):
        receipt, _ = self.supervised([], lambda _pid: 1, clock=29)
        self.assertEqual(receipt['failure'], 'external28s-wall-watchdog')
        receipt, raw = self.supervised([b'x' * 16384] * 17, lambda _pid: 1)
        self.assertEqual(receipt['failure'], 'combined-log256KiB-cap')
        self.assertEqual(len(raw), 262144)

    def test_log_only_js_io_no_wasm(self):
        script = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUnitIO, verifyUnitIO } from './unit-io.mjs';
const good = createUnitIO(fs.constants, (_fd, buffer) => buffer.length);
good.fs.writeSync(1, Buffer.from('PASS\\n'));
verifyUnitIO(good.receipt());
const denied = createUnitIO(fs.constants, (_fd, buffer) => buffer.length);
await new Promise((resolve) => denied.fs.open('/any', 0, 0, (error) => { assert.equal(error.code, 'EACCES'); resolve(); }));
assert.equal(denied.receipt().everOpened, false);
assert.throws(() => verifyUnitIO(denied.receipt()));
const pcm = createUnitIO(fs.constants, (_fd, buffer) => buffer.length);
assert.throws(() => pcm.fs.writeSync(3, Buffer.from([1])));
assert.equal(pcm.receipt().bytes, 0);
const capped = createUnitIO(fs.constants, (_fd, buffer) => buffer.length);
for (let i = 0; i < 4; i++) capped.fs.writeSync(1, Buffer.alloc(65536));
assert.throws(() => capped.fs.writeSync(1, Buffer.from([1])));
assert.equal(capped.receipt().logBytes, 262144);
assert.throws(() => verifyUnitIO(capped.receipt()));
console.log('synthetic log-only IO passed; no WASM instance');
"""
        result = subprocess.run([str(HOST.GRAPH.NODE), '--input-type=module', '-e', script], cwd=SOURCE, capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('synthetic log-only IO passed', result.stdout)

    def test_go_js_raw_receipt_identity_and_zero_file_admission(self):
        module = {'sha256': 'module', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay'}
        receipt = {'sourceId': 'source-only', 'runId': 'one-child', 'label': 'candidate', 'name': NAME,
                   'sourceSHA256': 'source', 'manifestSHA256': HOST.BUILD_SHA, 'moduleSHA256': 'module',
                   'runtimeSHA256': 'runtime', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay',
                   'goExit': 0, 'goExited': True, 'failure': None,
                   'io': {'failure': None, 'openAttempts': 0, 'everOpened': False, 'opened': False,
                          'closed': False, 'bytes': 0, 'logBytes': 5,
                          'requests': [{'operation': 'writeSync', 'fd': 1, 'result': 'ok'}]}}
        def admit(value):
            with patch.object(HOST.GRAPH, 'read_manifest', return_value=(None, {'runtime': {'sha256': 'runtime'}})):
                HOST.validate_wasm(value, NAME, 'source', module, 'source-only', 'one-child', 'candidate', 5)
        admit(receipt)
        for key, value in [('sourceId', 'other'), ('runId', 'other'), ('label', 'baseline'), ('goExit', 1), ('goExited', False), ('failure', 'late callback'), ('runtimeSHA256', 'other')]:
            bad = copy.deepcopy(receipt)
            bad[key] = value
            with self.assertRaises(ValueError):
                admit(bad)
        for key, value in [('openAttempts', 1), ('bytes', 1), ('everOpened', True), ('logBytes', 6), ('failure', 'EACCES'), ('requests', [{'operation': 'open', 'fd': 3, 'result': 'ok'}])]:
            bad = copy.deepcopy(receipt)
            bad['io'][key] = value
            with self.assertRaises(ValueError):
                admit(bad)

    def test_owned_registration_failure_is_cleaned(self):
        watcher = FakeSelector()
        watcher.register = Mock(side_effect=PermissionError('synthetic registration denied'))
        process = types.SimpleNamespace(pid=123, stdout=types.SimpleNamespace(close=Mock()), poll=lambda: None, wait=Mock(return_value=-9))
        with tempfile.TemporaryDirectory(prefix='aurialis-owned-synthetic-') as temporary:
            with patch.object(HOST.selectors, 'DefaultSelector', return_value=watcher), patch.object(HOST.subprocess, 'Popen', return_value=process), patch.object(HOST.SUPERVISOR, 'signal_group', return_value='sent') as stop:
                receipt = HOST.bounded_unit(['/synthetic/no-module'], pathlib.Path(temporary), {}, lambda _pid: 1)
                self.assertEqual(receipt['failure'], 'supervisor-error-PermissionError')
                stop.assert_called_once_with(process)
                process.wait.assert_called_once()
                process.stdout.close.assert_called_once()
                self.assertIsNotNone(receipt['primaryFailure'])
                self.assertTrue((pathlib.Path(temporary) / 'parent-exit.json').is_file())

    def test_owned_selector_creation_failure_is_cleaned(self):
        process = types.SimpleNamespace(pid=123, stdout=types.SimpleNamespace(close=Mock()), poll=lambda: None, wait=Mock(return_value=-9))
        with tempfile.TemporaryDirectory(prefix='aurialis-setup-synthetic-') as temporary:
            with patch.object(HOST.selectors, 'DefaultSelector', side_effect=OSError('synthetic selector setup denied')), patch.object(HOST.subprocess, 'Popen', return_value=process), patch.object(HOST.SUPERVISOR, 'signal_group', return_value='sent') as stop:
                receipt = HOST.bounded_unit(['/synthetic/no-module'], pathlib.Path(temporary), {}, lambda _pid: 1)
                self.assertEqual(receipt['failure'], 'supervisor-error-OSError')
                stop.assert_called_once_with(process)
                process.wait.assert_called_once()

    def test_primary_setup_error_survives_cleanup_errors(self):
        watcher = FakeSelector()
        watcher.register = Mock(side_effect=PermissionError('primary registration denial'))
        watcher.close = Mock(side_effect=OSError('synthetic close failure'))
        process = types.SimpleNamespace(pid=123, stdout=types.SimpleNamespace(close=Mock()), poll=lambda: None, wait=Mock(return_value=-9), kill=Mock())
        with tempfile.TemporaryDirectory(prefix='aurialis-cleanup-synthetic-') as temporary:
            with patch.object(HOST.selectors, 'DefaultSelector', return_value=watcher), patch.object(HOST.subprocess, 'Popen', return_value=process), patch.object(HOST.SUPERVISOR, 'signal_group', side_effect=OSError('synthetic signal failure')):
                receipt = HOST.bounded_unit(['/synthetic/no-module'], pathlib.Path(temporary), {}, lambda _pid: 1)
                self.assertEqual(receipt['failure'], 'supervisor-error-PermissionError')
                self.assertEqual(receipt['primaryFailure']['type'], 'PermissionError')
                self.assertIn('process-group-signal-error-OSError', receipt['cleanupFailure'])
                self.assertIn('resource-close-error-OSError', receipt['cleanupFailure'])
                process.kill.assert_called_once()
                process.wait.assert_called_once()
                with self.assertRaises(ValueError):
                    HOST.validate_parent(receipt)

    def test_spawn_failure_has_no_owned_child(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-spawn-synthetic-') as temporary:
            with patch.object(HOST.subprocess, 'Popen', side_effect=OSError('synthetic spawn denied')), patch.object(HOST.SUPERVISOR, 'signal_group') as stop:
                receipt = HOST.bounded_unit(['/synthetic/no-module'], pathlib.Path(temporary), {}, lambda _pid: 1)
                self.assertFalse(receipt['spawned'])
                self.assertIsNone(receipt['exit'])
                self.assertEqual(receipt['failure'], 'supervisor-error-OSError')
                stop.assert_not_called()
                self.assertTrue((pathlib.Path(temporary) / 'parent-exit.json').is_file())

    def test_source_bounds_and_old_proof_admission_only(self):
        snapshot = HOST.sources()
        self.assertEqual(len(snapshot), 10)
        self.assertNotIn('studio_gain_envelope.go', '\n'.join(snapshot))
        self.assertEqual(HOST.GRAPH.digest(HOST.GRAPH.PROOF / HOST.BUILD / 'BUILD.json'), HOST.BUILD_SHA)
        self.assertNotIn('WebAssembly.instantiate', (SOURCE / 'unit-io.mjs').read_text())
        self.assertIn("lock.open('x')", (SOURCE / 'run-unit.py').read_text())
        self.assertIn('GRAPH.write_json(claim', (SOURCE / 'run-unit.py').read_text())


if __name__ == '__main__':
    unittest.main()
