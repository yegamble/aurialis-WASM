"""Pure source, synthetic binary and mocked binding checks; no WASM runtime."""
# cspell:ignore gojs GOVERSION GOMAXPROCS GOWORK GOEXPERIMENT GOWASM GOARM GOFLAGS GOTOOLDIR
import ast
import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('held_gojs_host', pathlib.Path(__file__).with_name('host.py'))
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)


def u32(value):
    data = bytearray()
    while value > 127:
        data.append((value & 127) | 128)
        value >>= 7
    data.append(value)
    return bytes(data)


def string(value):
    data = value.encode()
    return u32(len(data)) + data


def section(identity, data):
    return bytes([identity]) + u32(len(data)) + data


def tiny_module(names):
    body = b'\x00\x42\x00\xb9\x1a\x0b'
    functions = section(3, u32(len(names)) + b'\x00' * len(names))
    code = section(10, u32(len(names)) + (u32(len(body)) + body) * len(names))
    mapping = u32(len(names)) + b''.join(u32(index) + string(name) for index, name in enumerate(names))
    return b'\0asm\x01\0\0\0' + functions + code + section(0, string('name') + b'\x01' + u32(len(mapping)) + mapping)


class Contract(unittest.TestCase):
    def test_python_source_parses(self):
        for file in HOST.SOURCE.glob('*.py'):
            ast.parse(file.read_text(), filename=str(file))

    def test_all44_inputs_and_native_folder_unchanged(self):
        snapshot = HOST.source_snapshot()
        self.assertEqual(snapshot['runnerCount'], 44)
        self.assertEqual(snapshot['test'], HOST.TEST)
        self.assertEqual(len(snapshot['mapping']), 8)
        self.assertEqual(sum(value == '' for value in snapshot['mapping'].values()), 6)
        self.assertEqual(len(list(HOST.NATIVE.SOURCE.iterdir())), 7)
        self.assertIn(str(HOST.GO), snapshot['toolchainPins'])
        self.assertEqual(snapshot['selectedToolchain']['GOVERSION'], 'go1.26.10')
        self.assertEqual(snapshot['work']['pairedDirectQueries'], 4911)

    def test_guard_reused_without_copy_or_patch(self):
        self.assertIs(HOST.GUARD, HOST.NATIVE.GUARD)
        self.assertEqual(pathlib.Path(HOST.GUARD.__file__).parent, HOST.NATIVE.SOURCE)
        text = (HOST.SOURCE / 'host.py').read_text()
        self.assertNotIn('def bounded_unit', text)
        self.assertIn('seconds=25', text)
        self.assertIn('seconds=28', text)

    def test_actual_go_execution_block_unchanged(self):
        old = (HOST.NATIVE.UNIT.SOURCE / 'wasm-unit.mjs').read_text()
        new = (HOST.SOURCE / 'child.mjs').read_text()
        self.assertEqual(old[old.index('const io ='):old.index('const receipt =')], new[new.index('const io ='):new.index('const receipt =')])
        self.assertEqual(old[old.index('const bytes ='):], new[new.index('const bytes ='):])

    def test_child_exact_whitelist_and_real_argv(self):
        text = (HOST.SOURCE / 'child.mjs').read_text()
        self.assertIn("const name = '" + HOST.TEST + "'", text)
        self.assertIn('source.runnerCount !== 44', text)
        self.assertIn('nodeArgv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)]', text)
        self.assertIn('goArgv: go?.argv', text)
        self.assertNotIn('const [sourceId, runId, label, name]', text)

    def test_explicit_local_toolchain_mode_and_caps(self):
        env = HOST.expected_env(pathlib.Path('/fixture/overlay.json'))
        self.assertEqual(env, {'GOOS': 'js', 'GOARCH': 'wasm', 'CGO_ENABLED': '0', 'GOMAXPROCS': '1', 'GOWORK': 'off', 'GOEXPERIMENT': '', 'GOWASM': '', 'GOARM64': 'v8.0', 'GOFLAGS': '-overlay=/fixture/overlay.json', 'GOTOOLCHAIN': 'local'})
        self.assertEqual(HOST.GUARD.LOG_CAP, 262144)
        self.assertEqual(HOST.GUARD.RSS_CAP, 1073741824)

    def test_freezer_suffix_and_post_freeze_recheck(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'fixture.go').write_bytes(b'package fixture\n')
            snapshot = {'runnerFiles': {'fixture.go': HOST.digest(root / 'fixture.go')}}
            with mock.patch.object(HOST, 'ROOT', root), mock.patch.object(HOST, 'PROOF', root / 'proof'), mock.patch.object(HOST, 'source_snapshot', return_value=snapshot) as source:
                HOST.freeze('source-fixture')
                self.assertEqual(source.call_count, 2)
            self.assertTrue((root / 'proof/source-fixture/source-frozen/fixture.go.source').is_file())
            self.assertEqual(list((root / 'proof').rglob('*.go')), [])

    def receipt(self):
        module = {'file': '/fixture/candidate.wasm', 'sha256': 'module', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay'}
        runtime = {'sha256': 'runtime'}
        argv = ['node', '--stack-size=8192', '--max-old-space-size=192', 'child.mjs', 'fixture']
        receipt = {'schema': HOST.SCHEMA, 'scope': 'one direct oracle/allocation unit; no PCM/timing', 'sourceId': 'fixture', 'name': HOST.TEST, 'nodeVersion': 'v26.12.0', 'sourceSHA256': 'source', 'manifestSHA256': 'build', 'moduleSHA256': 'module', 'runtimeSHA256': 'runtime', 'sourceSetSHA256': 'set', 'overlaySHA256': 'overlay', 'nodeArgv': argv, 'goArgv': [module['file'], '-test.run=^' + HOST.TEST + '$', '-test.count=1', '-test.v', '-test.timeout=25s'], 'goExit': 0, 'goExited': True, 'failure': None, 'io': {'file': '/aurialis-private-fixture/rate8000.bin', 'flags': 1, 'mode': 384, 'failure': None, 'openAttempts': 0, 'everOpened': False, 'opened': False, 'closed': False, 'bytes': 0, 'logBytes': 319, 'requests': [{'operation': 'writeSync', 'fd': 1, 'result': 'ok'}]}}
        return receipt, ('fixture', 'source', 'build', module, runtime, argv, 319)

    def test_exact_positive_receipt(self):
        receipt, args = self.receipt()
        HOST.validate_child(receipt, *args)

    def test_receipt_rejects_wrong_test_argv_module_exit_and_data(self):
        receipt, args = self.receipt()
        for path, value in [(('name',), 'TestOther'), (('nodeArgv',), ['substituted']), (('goArgv',), []), (('moduleSHA256',), 'wrong'), (('goExit',), 1), (('goExited',), False), (('io', 'openAttempts'), 1), (('io', 'bytes'), 1), (('io', 'closed'), True), (('io', 'logBytes'), 318), (('io', 'requests'), [{'operation': 'open', 'fd': 7, 'result': 'ok'}])]:
            bad = copy.deepcopy(receipt)
            if len(path) == 1:
                bad[path[0]] = value
            else:
                bad[path[0]][path[1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                HOST.validate_child(bad, *args)

    def test_receipt_rejects_missing_extra_and_duplicate_schema(self):
        receipt, args = self.receipt()
        for bad in ({**receipt, 'extra': 1}, {key: value for key, value in receipt.items() if key != 'goArgv'}):
            with self.assertRaises(ValueError):
                HOST.validate_child(bad, *args)
        with self.assertRaises(ValueError):
            HOST.INSPECT.PARSER.decode_json(b'{"x":1,"x":2}')

    def test_signed_immediate_and_hoisted_cycle(self):
        names = HOST.INSPECT.emitter_names()
        report = HOST.INSPECT.decode(b'\x00\x42\x7f\x1a\x42\x00\xb9\x1a\x03\x40\x01\x0c\x00\x0b\x0b', names)
        self.assertEqual(report['instructions'][0]['args'], [-1])
        self.assertFalse(report['conversionInReachableCycle'])
        self.assertTrue(report['conversionReachableDispatchValues'])
        self.assertEqual(len(report['normalizedOperations']), len(report['instructions']))

    def test_dynamic_conversion_cycle_and_comparison(self):
        names = HOST.INSPECT.emitter_names()
        dynamic = HOST.INSPECT.decode(b'\x00\x03\x40\x42\x00\xb9\x1a\x0c\x00\x0b\x0b', names)
        hoisted = HOST.INSPECT.decode(b'\x00\x42\x00\xb9\x1a\x03\x40\x0c\x00\x0b\x0b', names)
        self.assertTrue(dynamic['conversionInReachableCycle'])
        for report, sha in ((dynamic, 'old'), (hoisted, 'new')):
            report.update({'body': {'sha256': sha}, 'calls': []})
        self.assertTrue(HOST.INSPECT.compare(dynamic, hoisted)['shapeConsistentWithProposedHoist'])
        self.assertFalse(HOST.INSPECT.compare(dynamic, dynamic)['shapeConsistentWithProposedHoist'])

    def test_decoder_refuses_bad_control_opcode_truncation_and_caps(self):
        names = HOST.INSPECT.emitter_names()
        for data in (b'', b'x' * (HOST.INSPECT.BODY_CAP + 1), b'\x00\x0c\x02\x0b', b'\x00\xff\x0b', b'\x00\x42\x80', b'\x00\x42\x00\xb9\x1a', b'\x00\x42\x00\x1a\x0b'):
            with self.subTest(data=data[:10]), self.assertRaises(ValueError):
                HOST.INSPECT.decode(data, names)

    def test_exact_name_not_prefix_index_or_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            file = pathlib.Path(temp) / 'synthetic.wasm'
            file.write_bytes(tiny_module([HOST.INSPECT.NAME + 'XBits', HOST.INSPECT.NAME]))
            _, report = HOST.INSPECT.inspect(file, HOST.digest(file), file.stat().st_size)
            self.assertEqual(report['functionIndex'], 1)
            self.assertEqual(report['functionName'], HOST.INSPECT.NAME)
            for names in ([HOST.INSPECT.NAME + 'XBits'], [HOST.INSPECT.NAME, HOST.INSPECT.NAME]):
                file.write_bytes(tiny_module(names))
                with self.assertRaises(ValueError):
                    HOST.INSPECT.inspect(file, HOST.digest(file), file.stat().st_size)

    def test_empty_evidence_is_bounded_and_modified_bytes_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            file = root / 'empty.log'
            file.write_bytes(b'')
            index = root / 'INDEX.json'
            index.write_text(json.dumps({'files': {'empty.log': {'bytes': 0, 'sha256': HOST.digest(file)}}}))
            HOST.check_index(index, HOST.digest(index))
            file.write_bytes(b'x')
            with self.assertRaises(ValueError):
                HOST.check_index(index, HOST.digest(index))

    def test_mock_single_compiler_guard_env_and_exclusive_claim(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'SOURCE.json').write_text('{}')
            source = {'mapping': {}, 'effectiveSourceSet': {}, 'selectedToolchain': {'GOVERSION': 'go1.26.10', 'GOROOT': '/selected', 'GOTOOLDIR': '/selected/tool'}, 'toolchainPins': {}, 'runtime': {}}
            def metadata(argv, **kwargs):
                self.assertNotIn('GOMAXPROCS', argv)
                return json.dumps({**{key: value for key, value in HOST.expected_env(root / 'candidate-overlay.json').items() if key != 'GOMAXPROCS'}, **source['selectedToolchain']})
            parent = {'spawned': True, 'exit': 0, 'failure': None, 'stdoutEOF': True, 'exitObservation': None, 'primaryFailure': None, 'cleanupFailure': None, 'processGroupSignal': None, 'wallLimitSeconds': 25, 'logCapBytes': 262144, 'logBytes': 0, 'resident': {'samples': 1, 'capBytes': 1073741824, 'pollSeconds': .025, 'maxObservedBytes': 4096, 'instantaneousHardCeilingClaim': False}}
            def compiler(argv, output, env, reader, seconds):
                self.assertEqual(seconds, 25)
                self.assertEqual(env['GOMAXPROCS'], '1')
                self.assertEqual(env['GOTOOLCHAIN'], 'local')
                (root / 'candidate.wasm').write_bytes(tiny_module([HOST.INSPECT.NAME]))
                return parent
            with mock.patch.object(HOST, 'read_source', return_value=(root, source)), mock.patch.object(HOST.subprocess, 'check_output', side_effect=metadata), mock.patch.object(HOST.GUARD, 'rss_reader', return_value=None), mock.patch.object(HOST.GUARD, 'bounded_unit', side_effect=compiler) as guard:
                HOST.build('fixture')
                self.assertEqual(guard.call_count, 1)
                with self.assertRaises(FileExistsError):
                    HOST.build('fixture')
                self.assertEqual(guard.call_count, 1)
            self.assertTrue((root / 'BUILD.json').is_file())

    def test_module_pre_read_size_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            file = pathlib.Path(temp) / 'oversize.wasm'
            with file.open('wb') as stream:
                stream.truncate(HOST.INSPECT.PARSER.MODULE_CAP + 1)
            with mock.patch.object(HOST.INSPECT.PARSER.os, 'open', side_effect=AssertionError('must not open')):
                with self.assertRaises(ValueError):
                    HOST.INSPECT.PARSER.bounded_bytes(file, HOST.INSPECT.PARSER.MODULE_CAP)
            link = pathlib.Path(temp) / 'link.wasm'
            link.symlink_to(file)
            with self.assertRaises(ValueError):
                HOST.INSPECT.PARSER.bounded_bytes(link, HOST.INSPECT.PARSER.MODULE_CAP)


if __name__ == '__main__':
    unittest.main()
