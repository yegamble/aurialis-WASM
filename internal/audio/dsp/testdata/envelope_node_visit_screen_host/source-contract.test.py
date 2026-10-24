"""Synthetic binding, ownership and closed-I/O contracts; no GoJS instance."""
# cspell:ignore fstat WRONLY CREAT
import copy
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('source_only_screen_host', SOURCE / 'run-screen.py')
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
OLD = HOST.load('unchanged_screen_contract', SOURCE.with_name('extrema_screen') / 'screen-contract.test.py')


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


class ScreenHostContract(unittest.TestCase):
    def test_actual_same_module_binding_and_all_source_inputs(self):
        binding = HOST.source_snapshot()
        self.assertEqual(binding['schema'], HOST.SCHEMA)
        self.assertEqual(len(binding['runnerFiles']), 37)
        self.assertEqual(binding['modules']['baseline']['sha256'], 'f7f270e64ff525c12ef3c67eea786a794667df933a332a4ea02ba71090093d95')
        self.assertEqual(binding['modules']['candidate']['sha256'], 'd7f415cb7962687b8c77b590d85a098b2fa0c287bed00542d8180cdad0dec0d3')
        self.assertEqual(binding['fixtures']['baseline']['archiveRole'], 'accepted e492 candidate in same WASM backend')
        self.assertEqual((SOURCE / 'screen-child.mjs').read_text(), HOST.child_from_old())
        self.assertNotIn('max-old-space-size', (SOURCE / 'screen-child.mjs').read_text())
        self.assertNotIn('rss_reader', (SOURCE / 'run-screen.py').read_text())

    def test_wrong_module_runtime_source_mapping_refused(self):
        build, manifest = HOST.GRAPH.read_manifest(HOST.BUILD)
        for kind in ('module', 'path', 'overlay', 'runtime'):
            changed = copy.deepcopy(manifest)
            if kind == 'module':
                changed['modules']['wasm']['baseline']['sha256'] = '0' * 64
            elif kind == 'path':
                changed['modules']['wasm']['baseline']['file'] = '/wrong/module.wasm'
            elif kind == 'overlay':
                changed['modules']['wasm']['candidate']['overlaySHA256'] = '0' * 64
            else:
                changed['runtime']['sha256'] = '0' * 64
            with patch.object(HOST.GRAPH, 'read_manifest', return_value=(build, changed)):
                with self.assertRaises(ValueError):
                    HOST.source_snapshot()

    def test_closed_selection_has_no_fixture_or_calibration_route(self):
        for label, phase, workload, leg in [('baseline', 'verify', 'steady', 'gate'), ('candidate', 'measure', 'peaky', 'candidate'), ('baseline', 'measure', 'steady', 'after')]:
            HOST.screen_selection(label, phase, workload, leg)
        for args in [('baseline', 'fixture', 'steady', 'gate'), ('candidate', 'measure', 'steady', 'before'), ('baseline', 'measure', 'steady', 'candidate'), ('baseline', 'verify', '../outside', 'gate')]:
            with self.assertRaises(ValueError):
                HOST.screen_selection(*args)

    def supervised(self, registration=None, constructor=None, spawn=None, chunks=None, clock=0, signaling=None, close=None):
        watcher = FakeSelector()
        stream = types.SimpleNamespace(fileno=lambda: 7, close=Mock())
        process = types.SimpleNamespace(pid=123, stdout=stream, wait=Mock(return_value=0), kill=Mock())
        if registration:
            watcher.register = Mock(side_effect=registration)
        if close:
            watcher.close = Mock(side_effect=close)
        ticks = iter([0, clock])
        with tempfile.TemporaryDirectory(prefix='aurialis-screen-owner-synthetic-') as temporary:
            directory = pathlib.Path(temporary)
            with patch.object(HOST.selectors, 'DefaultSelector', side_effect=constructor, return_value=watcher), patch.object(HOST.subprocess, 'Popen', side_effect=spawn, return_value=process) as create, patch.object(HOST.os, 'read', side_effect=chunks or []), patch.object(HOST.time, 'monotonic', side_effect=lambda: next(ticks, clock)), patch.object(HOST.SUPERVISOR, 'signal_group', side_effect=signaling, return_value='sent') as stop:
                receipt = HOST.bounded_child(['/synthetic/no-screen'], directory)
                create.assert_called_once()
                self.assertTrue((directory / 'parent-exit.json').is_file())
                self.assertEqual((directory / 'child.log').stat().st_size, receipt['logBytes'])
                return receipt, process, stop.call_count

    def test_success_retains_original_parent_caps_and_eof(self):
        receipt, process, signals = self.supervised(chunks=[b'PASS\n', b''])
        HOST.validate_parent(receipt)
        self.assertTrue(receipt['stdoutEOF'])
        self.assertEqual(signals, 0)
        process.wait.assert_called_once()
        self.assertEqual(receipt['wallLimitSeconds'], 28)
        self.assertEqual(receipt['logCapBytes'], 262144)

    def test_registration_constructor_and_spawn_failure_owned_cleanup(self):
        for kwargs in ({'registration': PermissionError('denied')}, {'constructor': OSError('denied')}):
            receipt, process, signals = self.supervised(**kwargs)
            self.assertIsNotNone(receipt['primaryFailure'])
            self.assertEqual(signals, 1)
            process.wait.assert_called_once()
            process.stdout.close.assert_called_once()
        receipt, process, signals = self.supervised(spawn=OSError('denied'))
        self.assertFalse(receipt['spawned'])
        self.assertIsNone(receipt['exit'])
        process.wait.assert_not_called()
        self.assertEqual(signals, 0)

    def test_primary_and_cleanup_errors_remain_separate(self):
        receipt, process, signals = self.supervised(registration=PermissionError('primary'), signaling=OSError('signal'), close=OSError('close'))
        self.assertEqual(receipt['primaryFailure']['type'], 'PermissionError')
        self.assertIn('process-group-signal-error-OSError', receipt['cleanupFailure'])
        self.assertIn('resource-close-error-OSError', receipt['cleanupFailure'])
        process.kill.assert_called_once()
        process.wait.assert_called_once()
        self.assertEqual(signals, 1)
        with self.assertRaises(ValueError):
            HOST.validate_parent(receipt)

    def test_original_wall_and_log_caps_fail_closed(self):
        receipt, _process, signals = self.supervised(clock=29)
        self.assertEqual(receipt['failure'], 'external28s-wall-watchdog')
        self.assertEqual(signals, 1)
        receipt, _process, _signals = self.supervised(chunks=[b'x' * 16384] * 17)
        self.assertEqual(receipt['failure'], 'combined-log256KiB-cap')
        self.assertEqual(receipt['logBytes'], 262144)

    def test_closed_io_completion_and_caps(self):
        state = {'file': '/aurialis-private-fixture/rate192000.bin', 'flags': os.O_WRONLY | os.O_CREAT | os.O_EXCL, 'mode': 0o600, 'failure': None, 'everOpened': True, 'opened': False, 'closed': True, 'bytes': 16, 'logBytes': 5,
                 'requests': [{'operation': 'open', 'result': 'ok'}, {'operation': 'writeSync', 'fd': 3, 'length': 16, 'result': 'ok'}, {'operation': 'close', 'result': 'ok'}]}
        HOST.validate_io(state, 16, 5)
        for key, value in [('closed', False), ('opened', True), ('file', '/wrong'), ('mode', 0o644), ('bytes', 17), ('failure', 'EACCES')]:
            changed = copy.deepcopy(state)
            changed[key] = value
            with self.assertRaises(ValueError):
                HOST.validate_io(changed, 16, 5)
        for fd, length in [(4, 16), (3, 65537)]:
            changed = copy.deepcopy(state)
            changed['requests'][1].update({'fd': fd, 'length': length})
            with self.assertRaises(ValueError):
                HOST.validate_io(changed, 16, 5)

    def test_frozen_closed_fs_and_post_exit_synthetic_only(self):
        script = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFixtureFS, virtualDirectory } from '../extrema_graph/closed-fs.mjs';
import { finishChild } from '../extrema_graph/child-lifecycle.mjs';
const io = createFixtureFS({ rate: 192000, constants: fs.constants, onData: (buffer) => buffer.length, onLog: (_fd, buffer) => buffer.length });
const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
const fd = await new Promise((resolve, reject) => io.fs.open(`${virtualDirectory}/rate192000.bin`, flags, 0o600, (error, value) => error ? reject(error) : resolve(value)));
io.fs.writeSync(fd, Buffer.from([1, 2, 3]));
await new Promise((resolve, reject) => io.fs.close(fd, (error) => error ? reject(error) : resolve()));
assert.equal(io.receipt().bytes, 3);
assert.equal(io.receipt().closed, true);
const denied = createFixtureFS({ rate: 192000, constants: fs.constants, onData: (buffer) => buffer.length, onLog: (_fd, buffer) => buffer.length });
await new Promise((resolve) => denied.fs.open('/outside', flags, 0o600, (error) => { assert.equal(error.code, 'EACCES'); resolve(); }));
assert.equal(denied.receipt().failure, 'EACCES');
const order = [];
finishChild({ code: 0, receipt: {}, writeReceipt: () => order.push('receipt'), writeError: () => order.push('error'), exit: () => order.push('exit') });
assert.deepEqual(order, ['receipt', 'exit']);
assert.throws(() => finishChild({ code: 0, receipt: {}, writeReceipt: () => Promise.resolve(), writeError() {}, exit() {} }));
console.log('synthetic closedFS/post-exit passed; no GoJS instance');
"""
        result = subprocess.run([str(HOST.NODE), '--input-type=module', '-e', script], cwd=SOURCE, capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('synthetic closedFS/post-exit passed', result.stdout)

    def test_bound_receipts_and_raw_screen_bytes_without_execution(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-screen-receipt-synthetic-') as temporary:
            directory = pathlib.Path(temporary) / 'synthetic-binding'
            child = directory / 'runs/verify-steady-gate-baseline'
            child.mkdir(parents=True)
            binding = {'modules': {'baseline': {'sha256': 'module', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay'}}, 'runtime': {'sha256': 'runtime'}}
            (directory / 'BINDING.json').write_text(json.dumps(binding))
            data = OLD.stream('verify')[0]
            output = child / 'rate192000.bin'
            output.write_bytes(data)
            output.chmod(0o600)
            log = ('=== RUN   TestWriteStudioExtremaScreen\n' + 'cases2 rate192000 baseFrames24576 numericWords128 outputBytes' + str(len(data)) + ' fixedGraphBytes1073080 inputSHA256' + 'a' * 64 + '\n--- PASS: TestWriteStudioExtremaScreen (0.00s)\nPASS\n').encode()
            (child / 'child.log').write_bytes(log)
            parent = {'argv': [str(HOST.NODE), str(SOURCE / 'screen-child.mjs'), directory.name, 'baseline', 'verify', 'steady', 'gate'], 'spawned': True, 'exit': 0, 'failure': None, 'primaryFailure': None, 'cleanupFailure': None, 'processGroupSignal': None, 'wallLimitSeconds': 28, 'logCapBytes': 262144, 'logBytes': len(log), 'stdoutEOF': True}
            (child / 'parent-exit.json').write_text(json.dumps(parent))
            state = {'file': '/aurialis-private-fixture/rate192000.bin', 'flags': os.O_WRONLY | os.O_CREAT | os.O_EXCL, 'mode': 0o600, 'failure': None, 'everOpened': True, 'opened': False, 'closed': True, 'bytes': len(data), 'logBytes': len(log), 'requests': [{'operation': 'open', 'result': 'ok'}, {'operation': 'close', 'result': 'ok'}]}
            receipt = {'buildId': directory.name, 'label': 'baseline', 'phase': 'verify', 'workload': 'steady', 'leg': 'gate', 'moduleSHA256': 'module', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay', 'runtimeSHA256': 'runtime', 'bindingSHA256': HOST.digest(directory / 'BINDING.json'), 'baseBUILD_SHA256': HOST.BUILD_SHA, 'goExit': 0, 'goExited': True, 'failure': None, 'outputSHA256': HOST.METHOD.sha(data), 'io': state}
            (child / 'receipt.json').write_text(json.dumps(receipt))
            parsed = HOST.read_result(directory, binding, 'baseline', 'verify', 'steady', 'gate')
            self.assertEqual(parsed['frames'], 24576)
            for key, value in [('moduleSHA256', 'wrong'), ('bindingSHA256', 'wrong'), ('goExit', 1), ('goExited', False), ('failure', 'late callback')]:
                bad = copy.deepcopy(receipt)
                bad[key] = value
                (child / 'receipt.json').write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    HOST.read_result(directory, binding, 'baseline', 'verify', 'steady', 'gate')


def load_tests(loader, tests, _pattern):
    tests.addTests(loader.loadTestsFromTestCase(OLD.ScreenContract))
    return tests


if __name__ == '__main__':
    unittest.main()
