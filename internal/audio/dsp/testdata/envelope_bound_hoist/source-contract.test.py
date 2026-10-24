"""Pure source/mocked ownership contracts; never launch a child."""
import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('bound_source_contract', pathlib.Path(__file__).with_name('producer.py'))
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class Pipe:
    def fileno(self):
        return 99

    def close(self):
        pass


class Process:
    def __init__(self):
        self.stdout = Pipe()
        self.pid = 123
        self.done = False
        self.killed = False
        self.waited = False

    def poll(self):
        return 0 if self.done else None

    def kill(self):
        self.killed = self.done = True

    def wait(self, timeout):
        self.waited = self.done = True
        return 0


class Selector:
    def __init__(self):
        self.file = None

    def register(self, file, event):
        self.file = file

    def get_map(self):
        return {99: self.file} if self.file else {}

    def select(self, timeout):
        return [(types.SimpleNamespace(fileobj=self.file), 1)] if self.file else []

    def unregister(self, file):
        self.file = None

    def close(self):
        pass


class SourceContract(unittest.TestCase):
    def test_exact_candidate_and_reverse(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_bytes()
        candidate = (RUNNER.SOURCE / 'studio_gain_envelope.go.source').read_bytes()
        self.assertEqual(RUNNER.candidate_from_original(original), candidate)
        self.assertEqual(RUNNER.digest(RUNNER.ROOT / RUNNER.PRODUCTION), RUNNER.ORIGINAL_SHA)
        self.assertEqual(RUNNER.digest(RUNNER.SOURCE / 'studio_gain_envelope.go.source'), RUNNER.CANDIDATE_SHA)
        self.assertEqual(candidate.replace(b'\txFloat := float64(x)\n', b'').replace(b'n.slope*xFloat+n.offset', b'n.slope*float64(x)+n.offset'), original)

    def test_transform_refuses_missing_duplicate_or_candidate(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_bytes()
        for data in (b'', original + original, RUNNER.candidate_from_original(original)):
            with self.assertRaises(ValueError):
                RUNNER.candidate_from_original(data)

    def test_frozen_control_every_original_byte(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_bytes()
        control = (RUNNER.SOURCE / 'bound_query_test.go.source').read_bytes()
        RUNNER.check_oracle(original, control)
        with self.assertRaises(ValueError):
            RUNNER.check_oracle(original, control.replace(b'n.slope*float64(x)+n.offset', b'n.slope*xFloat+n.offset', 1))

    def test_no_insert_range_bundling(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_text()
        candidate = (RUNNER.SOURCE / 'studio_gain_envelope.go.source').read_text()
        self.assertEqual(original.split('func (e *studioGainEnvelope) bound')[0], candidate.split('func (e *studioGainEnvelope) bound')[0])

    def test_guard_only_deadline_parameterization(self):
        original = (RUNNER.UNIT.SOURCE / 'run-unit.py').read_text()
        original = original[original.index('class TaskInfo'):original.index('\ndef sources():')]
        expected = original.replace('def bounded_unit(argv, directory, env, read_rss):', 'def bounded_unit(argv, directory, env, read_rss, seconds=28):').replace('deadline = time.monotonic() + 28', 'deadline = time.monotonic() + seconds').replace("'external28s-wall-watchdog'", "f'external{seconds:g}s-wall-watchdog'").replace("'wallLimitSeconds': 28", "'wallLimitSeconds': seconds")
        actual = (RUNNER.SOURCE / 'native-guard.py').read_text()
        self.assertEqual(actual[actual.index('class TaskInfo'):], expected.rstrip() + '\n')

    def test_fixed_work_arithmetic(self):
        work = json.loads((RUNNER.SOURCE / 'PLAN.json').read_text())['work']
        self.assertEqual(4095 + 240 + 64 + 512, work['pairedDirectQueries'])
        self.assertEqual(sum(work['batchBreakdown'].values()), 562)
        self.assertEqual(562 * 3 * 8192 * 3, work['fieldComparisons'])
        self.assertEqual(562 * 8192 * 24, work['snapshotCopyBytes'])
        self.assertEqual(2 * 17 * 16 + 32, 576)
        self.assertEqual(2 * 4911 + 576, work['totalBoundInvocations'])
        self.assertEqual(work['totalBoundInvocations'] * 12, work['nodeVisitsUpper'])

    def test_exact_mapping_keeps_original_screen(self):
        snapshot = RUNNER.source_snapshot()
        self.assertEqual(len(snapshot['mapping']), 8)
        self.assertEqual(sum(value == '' for value in snapshot['mapping'].values()), 6)
        self.assertNotIn(str(RUNNER.ROOT / 'internal/audio/dsp/studio_extrema_screen_test.go'), snapshot['mapping'])
        self.assertFalse((RUNNER.ROOT / RUNNER.VIRTUAL_TEST).exists())

    def test_direct_unit_log_and_exact_counters(self):
        line = 'batches562 stateScans1686 pairedQueries4911 allocationCalls576 nodesPerScan8192 fieldComparisons41435136 boundCalls10398 nodeVisitUpper124776'
        log = '=== RUN   ' + RUNNER.TEST + '\n    x: ' + line + '\n--- PASS: ' + RUNNER.TEST + ' (0.01s)\nPASS\n'
        self.assertEqual(RUNNER.validate_log(log)['test'], RUNNER.TEST)
        for bad in ('PASS\n', log.replace('queries4911', 'queries0'), log.replace('pairedQueries4911', 'pairedQueries0'), log + '=== RUN   TestExtra\n', log.replace('--- PASS:', '--- SKIP:')):
            if bad != log:
                with self.assertRaises(ValueError):
                    RUNNER.validate_log(bad)

    def exercise_guard(self, seconds, registration_error=False, popen_error=False, expire=False):
        guard = RUNNER.GUARD
        process = Process()
        selector = Selector()
        data = [b'PASS\n', b'']
        def read(fd, count):
            chunk = data.pop(0)
            if not chunk:
                process.done = True
            return chunk
        def signal(owned):
            owned.kill()
            return 'group-killed'
        if registration_error:
            selector.register = mock.Mock(side_effect=RuntimeError('register denied'))
        times = iter([100, 100 + seconds + 1]) if expire else None
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(guard.subprocess, 'Popen', side_effect=OSError('spawn denied') if popen_error else None, return_value=process), mock.patch.object(guard.selectors, 'DefaultSelector', return_value=selector), mock.patch.object(guard.os, 'read', side_effect=read), mock.patch.object(guard.SUPERVISOR, 'signal_group', side_effect=signal), mock.patch.object(guard.time, 'monotonic', side_effect=(lambda: next(times)) if expire else (lambda: 100)):
            receipt = guard.bounded_unit(['NO-CHILD'], pathlib.Path(directory), {}, lambda pid: 4096, seconds=seconds)
            self.assertEqual(receipt['wallLimitSeconds'], seconds)
            self.assertTrue((pathlib.Path(directory) / 'parent-exit.json').is_file())
            return receipt, process

    def test_mock_positive_compile25(self):
        receipt, process = self.exercise_guard(25)
        RUNNER.validate_parent(receipt, 25, False)
        self.assertTrue(process.waited)

    def test_mock_positive_unit28(self):
        receipt, process = self.exercise_guard(28)
        RUNNER.validate_parent(receipt, 28, True)
        self.assertTrue(process.waited)

    def test_mock_compile25_expiry_kills_reaps(self):
        receipt, process = self.exercise_guard(25, expire=True)
        self.assertEqual(receipt['failure'], 'external25s-wall-watchdog')
        self.assertTrue(process.killed and process.waited)
        with self.assertRaises(ValueError):
            RUNNER.validate_parent(receipt, 25, False)

    def test_mock_unit28_expiry_kills_reaps(self):
        receipt, process = self.exercise_guard(28, expire=True)
        self.assertEqual(receipt['failure'], 'external28s-wall-watchdog')
        self.assertTrue(process.killed and process.waited)

    def test_mock_registration_failure_kills_reaps(self):
        receipt, process = self.exercise_guard(25, registration_error=True)
        self.assertIsNotNone(receipt['primaryFailure'])
        self.assertTrue(process.killed and process.waited)
        self.assertFalse(receipt['stdoutEOF'])

    def test_mock_popen_failure_owns_no_child(self):
        receipt, process = self.exercise_guard(28, popen_error=True)
        self.assertFalse(receipt['spawned'])
        self.assertFalse(process.killed or process.waited)
        self.assertIsNotNone(receipt['primaryFailure'])

    def test_closed_build_identifier(self):
        for name in ('', '../escape', 'Upper', 'a/b', 'a' * 33):
            with self.assertRaises(ValueError):
                RUNNER.identifier(name)


if __name__ == '__main__':
    unittest.main()
