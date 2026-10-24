"""Pure binary/profile fixtures and mocked ownership; no WASM/profile child."""
# cspell:words cpuprofile GOMAXPROCS uleb WRONLY CREAT
import copy
import hashlib
import importlib.util
import inspect
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('profile_source_contract_host', SOURCE / 'run-profile.py')
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
PARSER = HOST.PARSER
OLD = HOST.SCREEN.load('frozen_profile_owner_contract', SOURCE.with_name('envelope_node_visit_screen_host') / 'source-contract.test.py')


def number(value):
    data = bytearray()
    while value >= 128:
        data.append((value & 127) | 128)
        value >>= 7
    data.append(value)
    return bytes(data)


def string(value):
    data = value.encode()
    return number(len(data)) + data


def section(identity, data):
    return bytes([identity]) + number(len(data)) + data


def module_bytes(names=None):
    names = names or {1: next(iter(sorted(PARSER.GRAPH_ROOTS))), 2: PARSER.PREFIX + '__studioGainEnvelope_.insertRange'}
    imports = section(2, number(1) + string('host') + string('call') + b'\0' + number(0))
    functions = section(3, number(2) + b'\0\0')
    code = section(10, number(2) + number(2) + b'\0\x0b' + number(2) + b'\0\x0b')
    name_data = number(len(names)) + b''.join(number(index) + string(name) for index, name in names.items())
    return b'\0asm\x01\0\0\0' + imports + functions + code + section(0, string('name') + section(1, name_data))


def mapping():
    names = {1: sorted(PARSER.GRAPH_ROOTS)[0], 2: PARSER.PREFIX + '__studioGainEnvelope_.insertRange'}
    return {'moduleSHA256': 'a' * 64, 'names': names, 'reverse': {name: [index] for index, name in names.items()},
            'bodies': {index: {'offset': 100 + index, 'bytes': 2, 'sha256': 'b' * 64} for index in names}}


def frame(name, url=''):
    return {'functionName': name, 'scriptId': '1', 'url': url, 'lineNumber': 0, 'columnNumber': 100}


def profile():
    return {'startTime': 1000, 'endTime': 3000,
            'nodes': [{'id': 1, 'callFrame': frame('(root)'), 'children': [2]},
                      {'id': 2, 'callFrame': frame('wasm-function[1]', 'wasm://wasm/1234'), 'children': [3]},
                      {'id': 3, 'callFrame': frame('wasm-function[2]', 'wasm://wasm/1234'), 'children': [4]},
                      {'id': 4, 'callFrame': frame('wasm-function[2]', 'wasm://wasm/1234')}],
            'samples': [3, 4, 1], 'timeDeltas': [10, 100, 1000]}


def summarize(value, used=None):
    return PARSER.profile_summary(json.dumps(value).encode(), mapping(), {} if used is None else used)


class ProfileContract(unittest.TestCase):
    def test_validator_is_literal_argv_only_transform_and_guard_reused(self):
        self.assertEqual(inspect.getsource(HOST.read_result), HOST.validator_source())
        source = (SOURCE / 'run-profile.py').read_text()
        self.assertIn('SCREEN.bounded_child(argv, output)', source)
        self.assertNotIn('subprocess.Popen', source)
        self.assertNotIn('WebAssembly.', source)
        self.assertNotIn('max-old-space-size', source)
        self.assertNotIn('rss_reader', source)

    def test_exact_closed_diagnostic_argv(self):
        argv = HOST.profile_argv('profile-node-visit-synthetic', 'candidate')
        self.assertEqual(argv[:2], [str(HOST.NODE), '--cpu-prof'])
        self.assertEqual(argv[3:5], ['--cpu-prof-name=diagnostic.cpuprofile', '--cpu-prof-interval=100'])
        self.assertEqual(argv[-4:], ['candidate', 'verify', 'steady', 'gate'])
        self.assertEqual(argv[5], str(HOST.SCREEN.SOURCE / 'screen-child.mjs'))
        for identity, label in [('source-v1', 'candidate'), ('../outside', 'baseline'), ('profile-node-visit-test', 'other')]:
            with self.assertRaises(ValueError):
                HOST.profile_argv(identity, label)

    def test_current_sources_modules_and_prerequisites_read_only(self):
        value = HOST.snapshot()
        self.assertEqual(len(value['runnerFiles']), 45)
        self.assertEqual(len(value['screenBinding']['runnerFiles']), 37)
        self.assertEqual(value['moduleMappings']['candidate']['defined'], 4197)
        self.assertEqual(value['moduleMappings']['baseline']['imports'], 21)
        self.assertEqual(value['requestedIntervalMicroseconds'], 100)

    def test_module_mapping_import_index_body_and_pre_read_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'synthetic.wasm'
            data = module_bytes()
            path.write_bytes(data)
            result = PARSER.parse_module(path, hashlib.sha256(data).hexdigest(), len(data))
            self.assertEqual((result['imports'], result['defined']), (1, 2))
            self.assertEqual(result['names'], mapping()['names'])
            self.assertEqual(result['bodies'][2]['sha256'], hashlib.sha256(b'\0\x0b').hexdigest())
            with self.assertRaises(ValueError):
                PARSER.parse_module(path, '0' * 64)
            link = pathlib.Path(temporary) / 'link.wasm'
            link.symlink_to(path)
            with patch.object(PARSER.os, 'open', side_effect=AssertionError('must reject before open')):
                with self.assertRaises(ValueError):
                    PARSER.parse_module(link, '0' * 64)
                with path.open('r+b') as stream:
                    stream.truncate(PARSER.MODULE_CAP + 1)
                with self.assertRaises(ValueError):
                    PARSER.parse_module(path, '0' * 64)

    def test_binary_malformed_bounds_and_duplicate_names_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'synthetic.wasm'
            valid = module_bytes()
            malformed = [b'wrong', valid + b'\x00\xff\xff\xff\xff\xff\x00', valid + section(3, b'\0'),
                         module_bytes({999: 'outside'}), valid + section(0, string('name') + section(1, b'\0'))]
            for data in malformed:
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    PARSER.parse_module(path, hashlib.sha256(data).hexdigest())

    def test_positive_recursion_leaf_inclusive_edges_and_actual_intervals(self):
        used = {}
        report = summarize(profile(), used)
        self.assertEqual(report['graphSamples'], 2)
        self.assertEqual(report['graphSelfLeafCounts'], {'w2': 2})
        self.assertEqual(report['graphInclusiveMembershipCounts']['w2'], 2)
        self.assertEqual(report['recursiveMembershipBeyondFirst']['w2'], 1)
        self.assertIn({'caller': 'w2', 'callee': 'w2', 'samples': 1}, report['graphCallerCalleeMembershipCounts'])
        self.assertEqual(report['observedTimeDeltaMicroseconds']['minimum'], 10)
        self.assertEqual(report['observedTimeDeltaMicroseconds']['maximum'], 1000)
        self.assertEqual(report['exclusiveSampleCategories'], {'graph': 2, 'host-or-idle': 1})
        self.assertEqual(used['samples'], 3)

    def test_symbolic_names_require_wasm_url_and_exact_membership(self):
        value = profile()
        value['nodes'][1]['callFrame']['functionName'] = mapping()['names'][1]
        value['nodes'][2]['callFrame']['functionName'] = mapping()['names'][2]
        self.assertEqual(summarize(value)['graphSamples'], 2)
        value['nodes'][1]['callFrame']['url'] = 'file:///host.js'
        self.assertEqual(summarize(value)['graphSamples'], 0)
        value['nodes'][1]['callFrame']['url'] = 'wasm://wasm/1234'
        value['nodes'][1]['callFrame']['functionName'] += '.invented'
        self.assertEqual(summarize(value)['graphSamples'], 0)

    def test_unknown_wasm_names_retained_and_multiple_modules_refused(self):
        value = profile()
        value['nodes'][2]['callFrame']['functionName'] = 'wasm-function[999]'
        report = summarize(value)
        self.assertEqual(report['unresolvedWasmNodes'], 1)
        self.assertEqual(report['unresolvedGraphSamples'], 2)
        self.assertIn('n3', report['graphSelfLeafCounts'])
        value['nodes'][2]['callFrame']['url'] = 'wasm://wasm/abcd'
        with self.assertRaises(ValueError):
            summarize(value)

    def test_tree_duplicate_unknown_cycle_disconnected_and_self_refused(self):
        original = profile()
        variants = []
        value = copy.deepcopy(original);value['nodes'][3]['id'] = 3;variants.append(value)
        value = copy.deepcopy(original);value['nodes'][0]['children'].append(3);variants.append(value)
        value = copy.deepcopy(original);value['nodes'][3]['children'] = [4];variants.append(value)
        value = copy.deepcopy(original);value['nodes'][0]['children'] = [99];variants.append(value)
        value = copy.deepcopy(original);value['nodes'][0]['children'] = [];value['nodes'][3]['children'] = [2];variants.append(value)
        value = copy.deepcopy(original);value['nodes'].append({'id': 5, 'callFrame': frame('orphan')});variants.append(value)
        value = copy.deepcopy(original);value['samples'] = [99];value['timeDeltas'] = [10];variants.append(value)
        for value in variants:
            with self.assertRaises(ValueError):
                summarize(value)

    def test_strict_schema_numeric_clocks_and_duplicate_json_keys(self):
        variants = []
        value = profile();value['extra'] = 1;variants.append(value)
        value = profile();value['startTime'] = float('nan');variants.append(value)
        value = profile();value['timeDeltas'] = [-1, 0, 0];variants.append(value)
        value = profile();value['timeDeltas'] = [True, 0, 0];variants.append(value)
        value = profile();value['timeDeltas'] = [2001, 0, 0];variants.append(value)
        value = profile();value['samples'][0] = True;variants.append(value)
        value = profile();value['nodes'][2]['callFrame']['functionName'] = 'x' * 4097;variants.append(value)
        value = profile();value['nodes'][1]['positionTicks'] = [{'line': 1, 'ticks': -1}];variants.append(value)
        for value in variants:
            with self.assertRaises(ValueError):
                summarize(value)
        with self.assertRaises(ValueError):
            PARSER.profile_summary(b'{"nodes":[],"nodes":[]}', mapping(), {})

    def test_aggregate_caps_report_cap_and_zero_samples_fail_without_consumption(self):
        for key, cap in [('bytes', PARSER.PROFILE_CAP), ('nodes', PARSER.NODE_CAP), ('samples', PARSER.SAMPLE_CAP), ('steps', PARSER.STEP_CAP)]:
            used = {key: cap}
            with self.assertRaises(ValueError):
                summarize(profile(), used)
            self.assertEqual(used, {key: cap})
        value = profile();value['samples'] = [];value['timeDeltas'] = []
        with self.assertRaises(ValueError):
            summarize(value)
        with patch.object(PARSER, 'REPORT_CAP', 1):
            with self.assertRaises(ValueError):
                summarize(profile())

    def test_whole_raw_bytes_and_profile_permissions(self):
        HOST.admit_profile_output(b'entire finite repeat counter bytes', b'entire finite repeat counter bytes')
        with self.assertRaises(ValueError):
            HOST.admit_profile_output(b'entire finite repeat counter bytes!', b'entire finite repeat counter bytes')
        with tempfile.TemporaryDirectory() as temporary:
            file = pathlib.Path(temporary) / 'synthetic.cpuprofile'
            file.write_bytes(b'{}');file.chmod(0o644)
            with patch.object(PARSER.os, 'open', side_effect=AssertionError('pre-read mode/size refusal required')):
                with self.assertRaises(ValueError):
                    PARSER.bounded_bytes(file, 4096, 0o600)
                file.chmod(0o600)
                with self.assertRaises(ValueError):
                    PARSER.bounded_bytes(file, 0, 0o600)

    def test_diagnostic_validator_actual_argv_and_closed_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary) / 'profile-node-visit-synthetic'
            child = directory / 'runs/verify-steady-gate-baseline'
            child.mkdir(parents=True)
            binding = {'modules': {'baseline': {'sha256': 'module', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay'}}, 'runtime': {'sha256': 'runtime'}}
            (directory / 'BINDING.json').write_text(json.dumps(binding))
            data = OLD.OLD.stream('verify')[0]
            output = child / 'rate192000.bin'
            output.write_bytes(data)
            output.chmod(0o600)
            log = ('=== RUN   TestWriteStudioExtremaScreen\n' + 'cases2 rate192000 baseFrames24576 numericWords128 outputBytes' + str(len(data)) + ' fixedGraphBytes1073080 inputSHA256' + 'a' * 64 + '\n--- PASS: TestWriteStudioExtremaScreen (0.00s)\nPASS\n').encode()
            (child / 'child.log').write_bytes(log)
            parent = {'argv': HOST.profile_argv(directory.name, 'baseline'), 'spawned': True, 'exit': 0, 'failure': None, 'primaryFailure': None, 'cleanupFailure': None, 'processGroupSignal': None, 'wallLimitSeconds': 28, 'logCapBytes': 262144, 'logBytes': len(log), 'stdoutEOF': True}
            parent_file = child / 'parent-exit.json'
            parent_file.write_text(json.dumps(parent))
            state = {'file': '/aurialis-private-fixture/rate192000.bin', 'flags': os.O_WRONLY | os.O_CREAT | os.O_EXCL, 'mode': 0o600, 'failure': None, 'everOpened': True, 'opened': False, 'closed': True, 'bytes': len(data), 'logBytes': len(log), 'requests': [{'operation': 'open', 'result': 'ok'}, {'operation': 'close', 'result': 'ok'}]}
            receipt = {'buildId': directory.name, 'label': 'baseline', 'phase': 'verify', 'workload': 'steady', 'leg': 'gate', 'moduleSHA256': 'module', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay', 'runtimeSHA256': 'runtime', 'bindingSHA256': HOST.digest(directory / 'BINDING.json'), 'baseBUILD_SHA256': HOST.BUILD_SHA, 'goExit': 0, 'goExited': True, 'failure': None, 'outputSHA256': HOST.METHOD.sha(data), 'io': state}
            receipt_file = child / 'receipt.json'
            receipt_file.write_text(json.dumps(receipt))
            self.assertEqual(HOST.read_result(directory, binding, 'baseline', 'verify', 'steady', 'gate')['frames'], 24576)
            for argv in (parent['argv'][0:1] + parent['argv'][5:], parent['argv'] + ['--max-old-space-size=192']):
                changed = copy.deepcopy(parent);changed['argv'] = argv;parent_file.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    HOST.read_result(directory, binding, 'baseline', 'verify', 'steady', 'gate')
            parent_file.write_text(json.dumps(parent))
            for key, value in [('moduleSHA256', 'wrong'), ('goExited', False), ('goExit', 1)]:
                changed = copy.deepcopy(receipt);changed[key] = value;receipt_file.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    HOST.read_result(directory, binding, 'baseline', 'verify', 'steady', 'gate')

    def test_closed_label_refused_before_any_directory_or_child_work(self):
        with patch.object(HOST, 'read_diagnostic', side_effect=AssertionError('must not reach source or paths')):
            with self.assertRaises(ValueError):
                HOST.execute('profile-node-visit-synthetic', '../outside', {})

    def test_fd_setup_failure_closes_owned_descriptor(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = pathlib.Path(temporary) / 'synthetic.bin'
            file.write_bytes(b'1')
            with patch.object(PARSER.os, 'fdopen', side_effect=MemoryError('setup')), patch.object(PARSER.os, 'close', wraps=os.close) as close:
                with self.assertRaises(MemoryError):
                    PARSER.bounded_bytes(file, 16)
                close.assert_called_once()

    def test_wrapper_restores_umask_and_removes_lock_on_guard_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary) / 'profile-node-visit-synthetic'
            directory.mkdir()
            with patch.object(HOST, 'read_diagnostic', return_value=(directory, {'screenBinding': {}})), patch.object(HOST.SCREEN, 'bounded_child', side_effect=RuntimeError('synthetic owned-guard RED')) as guarded, patch.object(HOST.os, 'umask', side_effect=[0o022, 0o077]) as mask:
                with self.assertRaises(RuntimeError):
                    HOST.execute(directory.name, 'baseline', {})
                self.assertEqual(mask.call_args_list[0].args, (0o077,))
                self.assertEqual(mask.call_args_list[1].args, (0o022,))
                guarded.assert_called_once()
                self.assertFalse((directory / 'ACTIVE.lock').exists())
                self.assertEqual(json.loads((directory / 'runs/verify-steady-gate-baseline/ERROR.json').read_text())['type'], 'RuntimeError')


def load_tests(loader, tests, _pattern):
    for name in ('test_success_retains_original_parent_caps_and_eof', 'test_registration_constructor_and_spawn_failure_owned_cleanup',
                 'test_primary_and_cleanup_errors_remain_separate', 'test_original_wall_and_log_caps_fail_closed', 'test_closed_io_completion_and_caps'):
        tests.addTest(OLD.ScreenHostContract(name))
    return tests


if __name__ == '__main__':
    unittest.main()
