"""Pure/static/mocked controls only; no compiler, WASM instance or test child."""
# cspell:ignore WRONLY CREAT fstat purgeable statvfs frsize bavail gojs
import ast
import copy
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import types
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('fixed_qualification', pathlib.Path(__file__).with_name('host.py'))
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
DISK = HOST.DISK
PLAN = HOST.read_json(HOST.PLAN)
JOBS = HOST.jobs(PLAN)


class Contract(unittest.TestCase):
    def test_source_and_literal_reuse(self):
        for file in HOST.SOURCE.glob('*.py'):
            ast.parse(file.read_text())
        for kind, file, start in (('unit', HOST.UNIT.SOURCE / 'wasm-unit.mjs', 'const io ='), ('recorder', HOST.PAIR.PRODUCER.SOURCE / 'wasm-child.mjs', 'const sink =')):
            old, new = file.read_text(), (HOST.SOURCE / (kind + '.mjs')).read_text()
            self.assertEqual(old[old.index(start):old.index('const receipt =')], new[new.index(start):new.index('const receipt =')])
            self.assertEqual(old[old.index('const bytes ='):], new[new.index('const bytes ='):])
        self.assertIs(HOST.GUARD, HOST.NATIVE.GUARD)
        text = (HOST.SOURCE / 'host.py').read_text()
        self.assertNotIn('def bounded_unit', text)
        self.assertNotIn('subprocess.', text)
        for file, sha in PLAN['frozenSources'].items():
            self.assertEqual(HOST.digest(HOST.ROOT / file), sha)

    def test_actual56_inputs_before_runtime_and_one_literal_exception(self):
        snapshot = HOST.source_snapshot()
        self.assertEqual(len(snapshot['runnerFiles']), 56)
        artifact = 'artifacts/private-dsp/recovery-20261023/envelope-bound-hoist-proposal/source-v3/inspect-bound.py.source'
        self.assertEqual(snapshot['runnerFiles'][artifact], 'd08bb53eaa21e60ede7afd953df277597bb20897d06c2acc0d8b4e14937011fb')
        with tempfile.TemporaryDirectory() as temp:
            sizing_root = pathlib.Path(temp)
            sizing = sizing_root / artifact
            sizing.parent.mkdir(parents=True)
            sizing.write_bytes(b'x' * 7144)
            script = """
import fs from 'node:fs';
import { admitInput } from 'BINDING_URL';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let runtimeAttempts = 0;
const denied = () => { runtimeAttempts++; throw new Error('runtime forbidden in binding control'); };
globalThis.Go = denied;
globalThis.WebAssembly = Object.freeze({ instantiate: denied, compile: denied, Module: denied, Instance: denied });
let accepted = 0;
for (const [file, sha] of Object.entries(input.files)) {
  const data = admitInput(input.root, file, sha);
  if (file === input.artifact && data.length !== 7143) throw new Error('exact artifact size differs');
  accepted++;
}
let negatives = 0;
for (const [root, file, sha] of [
  [input.root, input.artifact + '-other', input.files[input.artifact]],
  [input.root, input.artifact, '0'.repeat(64)],
  [input.root, 'internal/audio/dsp/../outside', '0'.repeat(64)],
  [input.root, Object.keys(input.files).find((name) => name.startsWith('internal/audio/dsp/')), '0'.repeat(64)],
  [input.sizingRoot, input.artifact, input.files[input.artifact]],
]) {
  let rejected = false;
  try { admitInput(root, file, sha); } catch { rejected = true; }
  if (!rejected) throw new Error('negative binding was accepted');
  negatives++;
}
console.log(JSON.stringify({ accepted, negatives, runtimeAttempts }));
""".replace('BINDING_URL', (HOST.SOURCE / 'binding.mjs').as_uri())
            result = subprocess.run([str(HOST.GRAPH.NODE), '--input-type=module', '-e', script], input=json.dumps({'root': str(HOST.ROOT), 'files': snapshot['runnerFiles'], 'artifact': artifact, 'sizingRoot': str(sizing_root)}).encode(), capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout), {'accepted': 56, 'negatives': 5, 'runtimeAttempts': 0})

    def test_exact_jobs_work_and_module_pins(self):
        self.assertEqual(len(JOBS), 46)
        self.assertEqual(sum(job['kind'] == 'unit' for job in JOBS), 36)
        self.assertEqual([job['name'] for job in JOBS[:36:2]], PLAN['originalUnits']['names'])
        self.assertEqual([job['rate'] for job in JOBS[36::2]], [8000, 44100, 48000, 96000, 192000])
        self.assertEqual(HOST.GUARD.LOG_CAP, 262144)
        self.assertEqual(HOST.GUARD.RSS_CAP, 1073741824)
        for job in JOBS:
            argv = HOST.child_argv('fixture', job, 'a' * 64, {'file': '/candidate'})
            if job['backend'] == 'native':
                self.assertEqual(argv, ['/candidate', '-test.run=^' + job['name'] + '$', '-test.count=1', '-test.v', '-test.timeout=25s'])
            else:
                self.assertEqual(argv[1:3], ['--stack-size=8192', '--max-old-space-size=192'])
        self.assertEqual(HOST.digest(HOST.PLAN), HOST.PLAN_SHA)

    def coord(self, device=1):
        return {'schema': 'dsp46-coordination-v1', 'issuedUnix': 100, 'expiresUnix': 1800,
                'volumeDevice': device, 'otherRemainingBytes': 123, 'concurrentSourceAllowanceBytes': DISK.SOURCE_ALLOWANCE}

    def test_coord_positive_and_all_negative_fields(self):
        value = self.coord()
        self.assertEqual(DISK.decode_coord(json.dumps(value), 101, 1), value)
        for key, wrong in [('issuedUnix', 102), ('expiresUnix', 101), ('expiresUnix', 1901), ('volumeDevice', 2), ('otherRemainingBytes', -1), ('otherRemainingBytes', True), ('concurrentSourceAllowanceBytes', 0), ('schema', 'other')]:
            bad = {**value, key: wrong}
            with self.subTest(key=key, wrong=wrong), self.assertRaises(ValueError):
                DISK.decode_coord(json.dumps(bad), 101, 1)
        with self.assertRaises(ValueError):
            DISK.decode_coord(json.dumps(value)[:-1] + ',"schema":"duplicate"}', 101, 1)
        with self.assertRaises(ValueError):
            DISK.decode_coord(json.dumps(value), 1901, 1)

    def test_complete_ledger_and_allocation_arithmetic(self):
        ledger = DISK.slots(JOBS)
        self.assertEqual(sum(cap for name, cap in ledger.items() if name.endswith('.bin') or name.endswith('child.log')), 95944704)
        self.assertEqual(sum(name.endswith('parent-exit.json') for name in ledger), 46)
        self.assertEqual(sum(name.endswith('receipt.json') for name in ledger), 23)
        self.assertEqual(sum(name.endswith('REJECTED.json') for name in ledger), 46)
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            total = DISK.remaining(directory, ledger)
            self.assertGreater(total, sum(ledger.values()))
            (directory / 'SOURCE.json').write_bytes(b'12345')
            self.assertEqual(DISK.remaining(directory, ledger), total - 5)
            (directory / 'unknown').write_text('x')
            with self.assertRaises(ValueError):
                DISK.remaining(directory, ledger)

    def test_ledger_rejects_symlink_and_over_cap(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            target = directory / 'SOURCE.json'
            target.symlink_to('/dev/null')
            with self.assertRaises(ValueError):
                DISK.remaining(directory, DISK.slots(JOBS))
            target.unlink()
            target.write_bytes(b'xx')
            with self.assertRaises(ValueError):
                DISK.remaining(directory, {'SOURCE.json': 1})

    def test_physical_boundary_freshness_and_exclusive_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp) / 'proof'
            coord = self.coord(pathlib.Path(temp).stat().st_dev)
            ledger = {'disk.jsonl': DISK.JOURNAL_CAP, 'claim.json': 4096}
            gate = DISK.Budget(directory, pathlib.Path('/coord'), ledger, lambda *_: json.dumps(coord).encode())
            need = DISK.FLOOR + DISK.remaining(directory, ledger) + 123 + DISK.SOURCE_ALLOWANCE
            with mock.patch.object(DISK.time, 'time', return_value=101), mock.patch.object(DISK.os, 'statvfs', return_value=types.SimpleNamespace(f_frsize=1, f_bavail=need)) as sample:
                gate.publish('claim.json', b'ok')
                self.assertEqual(sample.call_count, 1)
                with self.assertRaises(FileExistsError):
                    gate.publish('claim.json', b'overwrite')
                self.assertEqual(sample.call_count, 2)
                self.assertEqual((directory / 'claim.json').read_bytes(), b'ok')
            with mock.patch.object(DISK.time, 'time', return_value=101), mock.patch.object(DISK.os, 'statvfs', return_value=types.SimpleNamespace(f_frsize=1, f_bavail=DISK.FLOOR)):
                with self.assertRaises(OSError):
                    gate.check('next-child')
            self.assertEqual(len((directory / 'disk.jsonl').read_text().splitlines()), 2)
            with self.assertRaises(ValueError):
                gate.publish('unknown', b'x')
            with self.assertRaises(ValueError):
                gate.publish('claim.json', b'x' * 4097)

    def test_no_retry_or_out_of_order_after_claim(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            source = {'jobs': JOBS}
            self.assertEqual(HOST.next_job(directory, source, JOBS[0]['id']), JOBS[0])
            with self.assertRaises(ValueError):
                HOST.next_job(directory, source, JOBS[1]['id'])
            (directory / 'claims').mkdir()
            (directory / 'claims' / (JOBS[0]['id'] + '.json')).write_text(json.dumps(JOBS[0]))
            with self.assertRaises(ValueError):
                HOST.next_job(directory, source, JOBS[0]['id'])

    def child(self, recorder=False):
        job = JOBS[37] if recorder else JOBS[1]
        module = PLAN['existingCandidateModules']['wasm']['module']
        source = {'modules': PLAN['existingCandidateModules'], 'runtime': PLAN['existingCandidateModules']['wasm']['runtime'], 'counterBUILD': PLAN['recorder']['expectedCountersFrom']}
        argv = HOST.child_argv('fixture', job, 'source', module)
        receipt = {'schema': HOST.SCHEMA, 'sourceId': 'fixture', 'jobId': job['id'], 'name': job['name'], 'nodeVersion': 'v26.12.0', 'sourceSHA256': 'source', 'manifestSHA256': source['modules']['wasm']['BUILD_SHA256'], 'moduleSHA256': module['sha256'], 'runtimeSHA256': source['runtime']['sha256'], 'sourceSetSHA256': module['sourceSetSHA256'], 'overlaySHA256': module['overlaySHA256'], 'nodeArgv': argv, 'goArgv': [module['file'], '-test.run=^' + job['name'] + '$', '-test.count=1', '-test.v', '-test.timeout=25s'], 'goExit': 0, 'goExited': True, 'failure': None, 'counterReceipt': {'outputBytes': 100} if recorder else None, 'outputSHA256': 'output' if recorder else None, 'counterBUILD_SHA256': source['counterBUILD']['sha256'] if recorder else None,
                   'io': {'file': '/aurialis-private-fixture/rate8000.bin', 'flags': os.O_WRONLY | os.O_CREAT | os.O_EXCL, 'mode': 0o600, 'failure': None, 'bytes': 100 if recorder else 0, 'logBytes': 100, 'opened': False, 'everOpened': recorder, 'closed': recorder, 'requests': [{'operation': 'writeSync', 'fd': 1, 'result': 'ok'}]}}
        if not recorder:
            receipt['io']['openAttempts'] = 0
        return receipt, ('fixture', job, source, 'source', argv, 100, receipt['counterReceipt'], receipt['outputSHA256'])

    def test_exact_unit_and_recorder_receipts(self):
        for recorder in (False, True):
            receipt, args = self.child(recorder)
            HOST.validate_child(receipt, *args)
            for key, value in [('goExit', 1), ('nodeArgv', []), ('goArgv', []), ('moduleSHA256', 'wrong'), ('sourceSHA256', 'wrong'), ('goExited', False), ('counterBUILD_SHA256', 'wrong')]:
                bad = {**receipt, key: value}
                with self.subTest(recorder=recorder, key=key), self.assertRaises(ValueError):
                    HOST.validate_child(bad, *args)
            bad = copy.deepcopy(receipt)
            bad['io']['opened'] = True
            with self.assertRaises(ValueError):
                HOST.validate_child(bad, *args)

    def test_whole_unit_and_recorder_logs_no_skip(self):
        name = JOBS[0]['name']
        log = '=== RUN   ' + name + '\n--- PASS: ' + name + ' (0.00s)\nPASS\n'
        HOST.UNIT.validate_log(log, name)
        name = 'TestWriteStudioExtremaGraphFixtures'
        log = '=== RUN   ' + name + '\n--- PASS: ' + name + ' (0.00s)\nPASS\n'
        HOST.recorder_log(log)
        for wrong in (log[:-1], log + 'extra', log.replace('PASS:', 'SKIP:'), log.replace(name, 'Other')):
            with self.assertRaises(ValueError):
                HOST.recorder_log(wrong)

    def test_secondary_reporting_preserves_primary_on_python39(self):
        primary = RuntimeError('original guard failure')
        with mock.patch.object(HOST.sys.stderr, 'write') as output:
            HOST.report_secondary(primary, 'failure-publication', OSError('disk refused'))
            report = json.loads(output.call_args.args[0])
            self.assertEqual(report['primaryFailure']['message'], 'original guard failure')
            self.assertEqual(report['secondaryFailure']['phase'], 'failure-publication')
        with mock.patch.object(HOST.sys.stderr, 'write', side_effect=BrokenPipeError):
            HOST.report_secondary(primary, 'lock-cleanup', OSError('unlink refused'))
        self.assertNotIn('.add_note(', (HOST.SOURCE / 'host.py').read_text())

    def test_run_mocked_guard_primary_publication_and_cleanup_failures(self):
        for publication_failure, cleanup_failure in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(publication=publication_failure, cleanup=cleanup_failure), tempfile.TemporaryDirectory() as temp:
                directory = pathlib.Path(temp)
                source = {'jobs': JOBS, 'modules': PLAN['existingCandidateModules']}
                (directory / 'SOURCE.json').write_text('{}')
                published = []
                class Gate:
                    def publish(self, name, data):
                        published.append(name)
                        target = directory / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(data)
                    def json(self, name, value):
                        if publication_failure and name.endswith('REJECTED.json'):
                            raise OSError('synthetic publication denied')
                        self.publish(name, json.dumps(value).encode())
                    def check(self, event):
                        published.append(event)
                unlink = pathlib.Path.unlink
                def remove(path, *args, **kwargs):
                    if cleanup_failure and path.name == 'ACTIVE.lock':
                        raise OSError('synthetic lock cleanup denied')
                    return unlink(path, *args, **kwargs)
                def failed_guard(*args, **kwargs):
                    (args[1] / 'child.log').write_bytes(b'synthetic retained raw bytes')
                    raise RuntimeError('synthetic setup failure')
                with mock.patch.object(HOST, 'read_source', return_value=(directory, source)), mock.patch.object(HOST, 'budget', return_value=Gate()), mock.patch.object(HOST.GUARD, 'rss_reader', return_value=lambda _: 1), mock.patch.object(HOST.GUARD, 'bounded_unit', side_effect=failed_guard) as child, mock.patch.object(pathlib.Path, 'unlink', remove), mock.patch.object(HOST.sys.stderr, 'write') as errors:
                    with self.assertRaisesRegex(RuntimeError, '^synthetic setup failure$'):
                        HOST.run('fixture', '/coord', JOBS[0]['id'])
                    child.assert_called_once()
                    self.assertEqual(child.call_args.kwargs, {'seconds': 28})
                    self.assertEqual(errors.call_count, int(publication_failure) + int(cleanup_failure))
                self.assertIn('child-transaction:' + JOBS[0]['id'], published)
                self.assertTrue((directory / 'claims' / (JOBS[0]['id'] + '.json')).is_file())
                self.assertEqual((directory / 'runs' / JOBS[0]['id'] / 'child.log').read_bytes(), b'synthetic retained raw bytes')
                self.assertEqual((directory / 'runs' / JOBS[0]['id'] / 'REJECTED.json').is_file(), not publication_failure)
                self.assertEqual((directory / 'ACTIVE.lock').exists(), cleanup_failure)


if __name__ == '__main__':
    unittest.main(verbosity=2)
