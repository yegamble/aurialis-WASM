"""Read-only actual-receipt/pure/source controls; no DSP or WASM instance."""
# cspell:ignore ENOENT
import copy
import hashlib
import importlib.util
import json
import pathlib
import unittest

SPEC = importlib.util.spec_from_file_location('separate_recorder_admission', pathlib.Path(__file__).with_name('admission.py'))
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
HOST = POLICY.HOST
PROOF = HOST.PROOF / 'source-v2'
RAW = PROOF / 'runs/recorder-wasm-8000/receipt.json'
RAW_SHA = 'a2dac38118238856e275e970b3c739f857632e6c2fccf7dc466407c4568a0968'
SOURCE_SHA = '66b73fb4c12f909e5395ec4c516964c7a54ae60248b1de1b9716eaf8d139ee73'


class Contract(unittest.TestCase):
    def inputs(self):
        raw = RAW.read_bytes()
        self.assertEqual(len(raw), 9195)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), RAW_SHA)
        source_raw = (PROOF / 'SOURCE.json').read_bytes()
        self.assertEqual(hashlib.sha256(source_raw).hexdigest(), SOURCE_SHA)
        source = json.loads(source_raw)
        job = next(job for job in source['jobs'] if job['id'] == 'recorder-wasm-8000')
        child = json.loads(raw)
        counter = HOST.PAIR.validate_counter((RAW.parent / 'child.log').read_text(), 8000, source['nativeCounterReceipts']['8000'])
        argv = HOST.child_argv('source-v2', job, SOURCE_SHA, source['modules']['wasm']['module'])
        return child, ('source-v2', job, source, SOURCE_SHA, argv, 323, counter, 'c373b6ad62e32af443d5093d94d4cf3cab5c08a21c619c4c4d2d4a6d85204ef0')

    def test_actual_trace_new_policy_passes_old_gate_stays_red(self):
        child, args = self.inputs()
        before = copy.deepcopy(child)
        with self.assertRaisesRegex(ValueError, 'closed recorder IO/counter completion refused'):
            HOST.validate_child(child, *args)
        POLICY.validate_recorder(child, *args)
        self.assertEqual(child, before)
        self.assertEqual(hashlib.sha256(RAW.read_bytes()).hexdigest(), RAW_SHA)
        self.assertTrue((RAW.parent / 'REJECTED.json').is_file())
        self.assertFalse((RAW.parent / 'ACCEPTED.json').exists())

    def test_copied_validator_changes_only_explicit_request_policy(self):
        old = (HOST.SOURCE / 'host.py').read_text()
        old = old[old.index('def validate_child('):old.index('\n\ndef validate_result(')]
        new = (POLICY.SOURCE / 'admission.py').read_text()
        new = new[new.index('def _validate_recorded_child('):new.index('\n\ndef validate_recorder(')]
        restored = new.replace('def _validate_recorded_child(', 'def validate_child(', 1).replace("not recorder_requests(io, job['rate'])", "any(item.get('result') != 'ok' for item in io['requests'])")
        self.assertEqual(restored.strip(), old.strip())

    def test_all56_old_inputs_and_seven_files_remain_exact(self):
        source = json.loads((PROOF / 'SOURCE.json').read_text())
        self.assertEqual(len(source['runnerFiles']), 56)
        self.assertEqual(len(list(HOST.SOURCE.iterdir())), 7)
        for name, sha in source['runnerFiles'].items():
            self.assertEqual(hashlib.sha256((HOST.ROOT / name).read_bytes()).hexdigest(), sha)
        for name in source['frozenFiles']:
            self.assertEqual((HOST.ROOT / name).read_bytes(), (PROOF / 'source-frozen' / pathlib.Path(name).name).read_bytes())

    def test_wrong_absence_path_error_operation_and_duplicates_fail(self):
        child, _ = self.inputs()
        requests = child['io']['requests']
        missing = next(index for index, item in enumerate(requests) if item['result'] == 'ENOENT')
        opened = next(index for index, item in enumerate(requests) if item['operation'] == 'open')
        cases = []
        for key, value in (('path', '/aurialis-private-fixture/rate48000.bin'), ('result', 'EACCES'), ('operation', 'stat')):
            wrong = copy.deepcopy(requests);wrong[missing][key] = value;cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong.append(copy.deepcopy(wrong[missing]));cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong[missing], wrong[opened] = wrong[opened], wrong[missing];cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong.append(copy.deepcopy(wrong[opened]));cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong[opened]['flags'] = 1;cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong[0]['result'] = 'EIO';cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong.append({'operation': 'stat', 'path': '/elsewhere', 'result': 'ok'});cases.append(wrong)
        wrong = copy.deepcopy(requests);wrong[-3]['fd'] = 4;cases.append(wrong)
        for index, requests in enumerate(cases):
            with self.subTest(case=index):
                self.assertFalse(POLICY.recorder_requests({**child['io'], 'requests': requests}, 8000))
        self.assertFalse(POLICY.recorder_requests(child['io'], 44100))

    def test_unchanged_provenance_counter_output_and_closed_io_refusals(self):
        child, args = self.inputs()
        for key, value in (('nodeArgv', []), ('goArgv', []), ('sourceSHA256', 'wrong'), ('moduleSHA256', 'wrong'), ('goExit', 1), ('counterReceipt', {}), ('outputSHA256', 'wrong')):
            with self.subTest(key=key), self.assertRaises(ValueError):
                POLICY.validate_recorder({**child, key: value}, *args)
        for key, value in (('failure', 'bad'), ('closed', False), ('bytes', 1)):
            wrong = copy.deepcopy(child);wrong['io'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                POLICY.validate_recorder(wrong, *args)

    def test_only_eight_remaining_jobs_no_completed_work_repeated(self):
        plan = json.loads((POLICY.SOURCE / 'PLAN.json').read_text())
        expected = ['recorder-' + backend + '-' + str(rate) for rate in (44100, 48000, 96000, 192000) for backend in ('native', 'wasm')]
        self.assertEqual(plan['remainingJobs'], expected)
        self.assertEqual(plan['oldChildSourceSHA256'], SOURCE_SHA)
        self.assertTrue(all(not job.endswith('-8000') and not job.startswith('unit-') for job in expected))


if __name__ == '__main__':
    unittest.main(verbosity=2)
