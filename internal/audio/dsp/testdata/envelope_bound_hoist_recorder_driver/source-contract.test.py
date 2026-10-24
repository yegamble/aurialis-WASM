"""Pure/static/mocked fixed8 host controls; no preparation or actual child."""
import ast
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('fixed8_source_host', pathlib.Path(__file__).with_name('host.py'))
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
OLD = HOST.OLD
LEGACY_SOURCE = OLD.read_json(OLD.PROOF / 'source-v2/SOURCE.json')
JOBS = [job for name in HOST.JOBS for job in LEGACY_SOURCE['jobs'] if job['id'] == name]


class Contract(unittest.TestCase):
    def test_source_syntax_and_exact_recording_block_reuse(self):
        for file in HOST.SOURCE.glob('*.py'):
            ast.parse(file.read_text())
        old = (OLD.SOURCE / 'host.py').read_text()
        old = old[old.index('def validate_result('):old.index('\n\ndef recorder_log(')]
        new = (HOST.SOURCE / 'host.py').read_text()
        block = new[new.index('def validate_recording('):new.index('\ndef run(')]
        restored = block.replace('def validate_recording(', 'def validate_result(', 1).replace('POLICY.validate_recorder(child,', 'validate_child(child,')
        self.assertEqual(restored.strip(), old.strip())
        self.assertNotIn('def bounded_unit', new)
        self.assertNotIn('subprocess.', new)
        self.assertIs(HOST.GUARD, OLD.GUARD)

    def test_actual_new7_and_unchanged_old56_bindings(self):
        source = HOST.source_snapshot()
        self.assertEqual(len(source['files']), 7)
        self.assertEqual(len(source['legacy56Inputs']), 56)
        self.assertEqual(len(source['frozen']), 7)
        self.assertEqual([job['id'] for job in source['jobs']], list(HOST.JOBS))
        self.assertEqual(HOST.digest(OLD.PROOF / 'source-v2/SOURCE.json'), HOST.SOURCE_SHA)
        self.assertEqual(source['modules'], LEGACY_SOURCE['modules'])
        self.assertEqual(source['runtime'], LEGACY_SOURCE['runtime'])
        self.assertFalse(HOST.LEGACY.exists())
        self.assertFalse(HOST.DRIVER.exists())

    def test_fixed8_only_original_argv_and_work(self):
        self.assertEqual(list(HOST.JOBS), ['recorder-' + backend + '-' + str(rate) for rate in (44100, 48000, 96000, 192000) for backend in ('native', 'wasm')])
        for job in JOBS:
            self.assertFalse(job['id'].endswith('-8000'))
            self.assertEqual(job['kind'], 'recorder')
            self.assertEqual(job['name'], 'TestWriteStudioExtremaGraphFixtures')
            argv = HOST.child_argv(HOST.LEGACY_ID, job, HOST.SOURCE_SHA, LEGACY_SOURCE['modules'][job['backend']]['module'])
            if job['backend'] == 'native':
                self.assertEqual(argv[1:], ['-test.run=^TestWriteStudioExtremaGraphFixtures$', '-test.count=1', '-test.v', '-test.timeout=25s'])
            else:
                self.assertEqual(argv[1:4], ['--stack-size=8192', '--max-old-space-size=192', str(OLD.SOURCE / 'recorder.mjs')])
                self.assertEqual(argv[4:], [HOST.LEGACY_ID, job['id'], HOST.SOURCE_SHA])
        self.assertEqual(HOST.GUARD.LOG_CAP, 262144)
        self.assertEqual(HOST.GUARD.RSS_CAP, 1073741824)

    def test_finite_metadata_caps_and_fresh_publication(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(HOST, 'DRIVER', pathlib.Path(temp)):
            self.assertLessEqual(HOST.audit_metadata(), 4 * 1024 * 1024)
            self.assertEqual(len(HOST.metadata_slots()), 28)
            gate = mock.Mock()
            HOST.publish('PREPARED.json', {'fixture': True}, gate)
            gate.check.assert_called_once_with('new-driver-publication:PREPARED.json')
            with self.assertRaises(FileExistsError):
                HOST.publish('PREPARED.json', {}, gate)
            with self.assertRaises(ValueError):
                HOST.publish('unknown', {}, gate)
            with self.assertRaises(ValueError):
                HOST.publish('PREPARE-ERROR.json', b'x' * (65536 + 1), gate, raw=True)
            (HOST.DRIVER / 'unknown').write_text('x')
            with self.assertRaises(ValueError):
                HOST.audit_metadata()

    def test_metadata_root_symlink_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'link').symlink_to(root / 'actual')
            (root / 'actual').mkdir()
            with mock.patch.object(HOST, 'DRIVER', root / 'link'), self.assertRaises(ValueError):
                HOST.audit_metadata()

    def test_fixed_order_claims_and_no_old_job_workaround(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(HOST, 'DRIVER', pathlib.Path(temp) / 'host'):
            directory = pathlib.Path(temp) / 'legacy';directory.mkdir()
            HOST.DRIVER.mkdir();(HOST.DRIVER / 'SOURCE.json').write_text('{}')
            source = {'jobs': JOBS}
            self.assertEqual(HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[0]), JOBS[0])
            for wrong in (HOST.JOBS[1], 'unit-native-00', 'recorder-wasm-8000'):
                with self.assertRaises(ValueError):
                    HOST.next_job(directory, source, LEGACY_SOURCE, wrong)
            (directory / 'claims').mkdir()
            (directory / 'claims' / (HOST.JOBS[0] + '.json')).write_text(json.dumps({'job': JOBS[0], 'driverSourceSHA256': HOST.digest(HOST.DRIVER / 'SOURCE.json')}))
            with self.assertRaises(ValueError):
                HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[0])
            (directory / 'claims/unit-native-00.json').write_text('{}')
            with self.assertRaises(ValueError):
                HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[0])

    def test_retained_prepare_error_refuses_read_run_and_seal_authority(self):
        with tempfile.TemporaryDirectory() as temp:
            driver = pathlib.Path(temp) / 'driver';driver.mkdir()
            directory = pathlib.Path(temp) / 'legacy';directory.mkdir()
            snapshot = {'files': {}, 'frozen': {}}
            (driver / 'SOURCE.json').write_text(json.dumps(snapshot))
            (driver / 'PREPARED.json').write_text(json.dumps({'sourceSHA256': HOST.digest(driver / 'SOURCE.json'),
                'legacySourceSHA256': HOST.SOURCE_SHA, 'jobs': list(HOST.JOBS)}))
            original_digest = HOST.digest
            def pinned(file):
                return HOST.SOURCE_SHA if file == directory / 'SOURCE.json' else original_digest(file)
            with mock.patch.object(HOST, 'DRIVER', driver), mock.patch.object(HOST, 'source_snapshot', return_value=snapshot) as source, mock.patch.object(HOST, 'digest', side_effect=pinned), mock.patch.object(OLD, 'read_source', return_value=(directory, {})) as legacy, mock.patch.object(OLD, 'budget') as budget, mock.patch.object(HOST, 'next_job') as next_job, mock.patch.object(HOST.GUARD, 'bounded_unit') as child:
                self.assertEqual(HOST.read_prepared()[0], snapshot)
                error = driver / 'PREPARE-ERROR.json'
                for kind in ('retained error after complete PREPARED close failure', 'dangling error symlink'):
                    if kind.startswith('retained'):
                        error.write_text(json.dumps({'primaryFailure': {'type': 'OSError', 'message': kind}}))
                    else:
                        error.symlink_to(driver / 'missing-error-target')
                        self.assertFalse(error.exists())
                        self.assertTrue(error.is_symlink())
                    source.reset_mock();legacy.reset_mock()
                    for entry in (lambda: HOST.read_prepared(), lambda: HOST.run(HOST.JOBS[0], '/coord'), lambda: HOST.seal('/coord')):
                        with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, '^retained preparation failure; no execution or seal authority$'):
                            entry()
                    source.assert_not_called();legacy.assert_not_called()
                    budget.assert_not_called();next_job.assert_not_called();child.assert_not_called()
                    error.unlink()

    def test_prior_raw_acceptance_needs_exact_confirmed_host_settlement(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(HOST, 'DRIVER', pathlib.Path(temp) / 'host'):
            directory = pathlib.Path(temp) / 'legacy';directory.mkdir()
            HOST.DRIVER.mkdir();(HOST.DRIVER / 'SOURCE.json').write_text('{}')
            source = {'jobs': JOBS, 'files': {str((HOST.SOURCE / 'host.py').relative_to(HOST.ROOT)): 'host', str((HOST.POLICY.SOURCE / 'admission.py').relative_to(HOST.ROOT)): 'policy'}}
            job = JOBS[0]
            with mock.patch.object(HOST.sys, 'argv', [str(HOST.SOURCE / 'host.py'), 'run', job['id'], '/coord']):
                provenance = HOST.host_provenance(source)
            raw_result = {'job': job, 'sourceSHA256': HOST.SOURCE_SHA, 'parentSHA256': 'actual-raw'}
            output = directory / 'runs' / job['id'];output.mkdir(parents=True)
            accepted = output / 'ACCEPTED.json'
            accepted.write_text(json.dumps({**raw_result, 'executedNewHost': provenance}))
            (directory / 'claims').mkdir()
            claim = directory / 'claims' / (job['id'] + '.json')
            correct_claim = {'job': job, 'driverSourceSHA256': HOST.digest(HOST.DRIVER / 'SOURCE.json')}
            claim.write_text(json.dumps(correct_claim))
            invocations = HOST.DRIVER / 'invocations';invocations.mkdir()
            start = invocations / (job['id'] + '-START.json')
            start.write_text(json.dumps({'job': job, 'executedNewHost': provenance}))
            settled = invocations / (job['id'] + '-SETTLED.json')
            correct = {'job': job, 'disposition': 'accepted', 'executedNewHost': provenance, 'primaryFailure': None, 'cleanupFailure': None, 'parentReceiptPresent': True, 'rawAcceptedPresent': True}
            with mock.patch.object(HOST, 'validate_recording', return_value=raw_result) as raw:
                self.assertFalse((directory / 'ACTIVE.lock').exists())
                with self.assertRaises(ValueError):
                    HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1])
                for value in ({}, {**correct, 'disposition': 'RED'}, {**correct, 'primaryFailure': {'type': 'error'}}, {**correct, 'cleanupFailure': {'type': 'error'}}, {**correct, 'executedNewHost': {**provenance, 'driverSourceSHA256': 'wrong'}}):
                    settled.write_text(json.dumps(value))
                    with self.subTest(value=value), self.assertRaises(ValueError):
                        HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1])
                settled.write_text('not-json')
                with self.assertRaises(ValueError):
                    HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1])
                settled.write_text(json.dumps(correct))
                self.assertEqual(HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1]), JOBS[1])
                raw.assert_called()
                accepted.write_text(json.dumps({**raw_result, 'parentSHA256': 'changed', 'executedNewHost': provenance}))
                with self.assertRaises(ValueError):
                    HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1])
                accepted.write_text(json.dumps({**raw_result, 'executedNewHost': provenance}))
                claim.write_text(json.dumps({**correct_claim, 'driverSourceSHA256': 'wrong'}))
                with self.assertRaises(ValueError):
                    HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1])
                claim.write_text(json.dumps(correct_claim))
                start.unlink()
                with self.assertRaises(ValueError):
                    HOST.next_job(directory, source, LEGACY_SOURCE, HOST.JOBS[1])

    def test_final_scope_rejects_extra_or_incomplete_claims_and_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            HOST.fixed_scope(directory)
            with self.assertRaises(ValueError):
                HOST.fixed_scope(directory, complete=True)
            (directory / 'claims').mkdir();(directory / 'runs').mkdir()
            for name in HOST.JOBS:
                (directory / 'claims' / (name + '.json')).write_text('{}')
                (directory / 'runs' / name).mkdir()
            HOST.fixed_scope(directory, complete=True)
            (directory / 'runs/unit-native-00').mkdir()
            with self.assertRaises(ValueError):
                HOST.fixed_scope(directory, complete=True)
            (directory / 'runs/unit-native-00').rmdir()
            (directory / 'claims/unit-native-00.json').write_text('{}')
            with self.assertRaises(ValueError):
                HOST.fixed_scope(directory)

    def test_actual_host_policy_argv_provenance_no_substitution(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(HOST, 'DRIVER', pathlib.Path(temp)):
            (HOST.DRIVER / 'SOURCE.json').write_text('{}')
            source = {'files': {str((HOST.SOURCE / 'host.py').relative_to(HOST.ROOT)): 'host', str((HOST.POLICY.SOURCE / 'admission.py').relative_to(HOST.ROOT)): 'policy'}}
            argv = [str(HOST.SOURCE / 'host.py'), 'run', HOST.JOBS[0], '/coord']
            with mock.patch.object(HOST.sys, 'argv', argv):
                provenance = HOST.host_provenance(source)
                HOST.validate_provenance(source, JOBS[0], provenance)
                self.assertEqual(provenance['observedPythonScriptArgv'], argv)
                for key, value in (('hostSHA256', 'wrong'), ('policySHA256', 'wrong'), ('legacySourceSHA256', 'wrong'), ('observedPythonScriptArgv', ['substituted'])):
                    with self.subTest(key=key), self.assertRaises(ValueError):
                        HOST.validate_provenance(source, JOBS[0], {**provenance, key: value})

    def test_mocked_guard_and_cleanup_failures_retain_primary_and_claim(self):
        for cleanup_failure in (False, True):
            with self.subTest(cleanup=cleanup_failure), tempfile.TemporaryDirectory() as temp:
                root = pathlib.Path(temp);directory = root / 'legacy';directory.mkdir();driver = root / 'host';driver.mkdir();(driver / 'SOURCE.json').write_text('{}')
                source = {'jobs': JOBS, 'modules': LEGACY_SOURCE['modules'], 'files': {str((HOST.SOURCE / 'host.py').relative_to(HOST.ROOT)): 'host', str((HOST.POLICY.SOURCE / 'admission.py').relative_to(HOST.ROOT)): 'policy'}}
                events = []
                class Gate:
                    def publish(self, name, data):
                        events.append(name);target=directory/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
                    def json(self, name, value):
                        self.publish(name,json.dumps(value).encode())
                    def check(self, event):
                        events.append(event)
                unlink = pathlib.Path.unlink
                def remove(file,*args,**kwargs):
                    if cleanup_failure and file.name=='ACTIVE.lock':
                        raise OSError('synthetic lock cleanup denied')
                    return unlink(file,*args,**kwargs)
                def denied(*args,**kwargs):
                    (args[1]/'child.log').write_bytes(b'synthetic retained raw')
                    raise RuntimeError('synthetic guard setup denied')
                with mock.patch.object(HOST,'DRIVER',driver), mock.patch.object(HOST,'read_prepared',return_value=(source,directory,LEGACY_SOURCE)), mock.patch.object(OLD,'budget',return_value=Gate()), mock.patch.object(HOST.GUARD,'rss_reader',return_value=lambda _:1), mock.patch.object(HOST.GUARD,'bounded_unit',side_effect=denied) as child, mock.patch.object(pathlib.Path,'unlink',remove):
                    with self.assertRaisesRegex(RuntimeError,'^synthetic guard setup denied$'):
                        HOST.run(HOST.JOBS[0],'/coord')
                    child.assert_called_once();self.assertEqual(child.call_args.kwargs,{'seconds':28})
                final=json.loads((driver/('invocations/'+HOST.JOBS[0]+'-SETTLED.json')).read_text())
                self.assertEqual(final['disposition'],'RED');self.assertEqual(final['primaryFailure']['type'],'RuntimeError')
                self.assertEqual(final['cleanupFailure'] is not None,cleanup_failure)
                self.assertTrue((directory/('claims/'+HOST.JOBS[0]+'.json')).is_file())
                self.assertTrue((directory/('runs/'+HOST.JOBS[0]+'/REJECTED.json')).is_file())
                self.assertIn('fixed8-child-transaction:'+HOST.JOBS[0],events)

    def test_old_index_empty_hash_regular_and_symlink_controls(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);file=root/'empty';file.write_bytes(b'');index=root/'index.json'
            index.write_text(json.dumps({'files':{'empty':{'bytes':0,'sha256':hashlib.sha256(b'').hexdigest()}}}))
            with mock.patch.object(HOST,'ROOT',root),mock.patch.object(HOST,'RED_INDEX',index),mock.patch.object(HOST,'RED_SHA',HOST.digest(index)):
                HOST.verify_old_index()
                file.unlink();file.symlink_to(root/'index.json')
                with self.assertRaises(ValueError):
                    HOST.verify_old_index()


if __name__ == '__main__':
    unittest.main(verbosity=2)
