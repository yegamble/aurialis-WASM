"""Pure replay of the actual held257-byte command; no process/API operation."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from attention_contract import check_static_runtime

ROOT = Path(__file__).parent
OBSERVATION = json.loads((ROOT / 'attention-static-runtime-observation.json').read_text())
RECORD = OBSERVATION['record']
PINS = json.loads((ROOT / 'attention-launch-pins.json').read_text())
SOURCE = '/Users/yosefgamble/.codex/worktrees/measured-analysis/Aurialis-WASM/internal/audio/steminfer/testdata/webgpu/attention/serve.py'


class ExactRuntime(unittest.TestCase):
    def check(self, record=None, runtime=None, text=None, expected=None):
        value = copy.deepcopy(RECORD) if record is None else record
        return check_static_runtime(value['rawCommandText'].strip() if text is None else text, value, PINS['python'], PINS['pythonRuntime'] if runtime is None else runtime, SOURCE, value['expectedIdentity'] if expected is None else expected)

    def raw(self, value):
        record = copy.deepcopy(RECORD)
        encoded = value.encode()
        record.update(rawCommandText=value, rawCommandBytes=len(encoded), rawCommandSHA256=hashlib.sha256(encoded).hexdigest())
        return record

    def test_actual_saved257bytes_matches_only_exact_named_runtime(self):
        self.assertEqual(RECORD['rawCommandBytes'], 257)
        self.assertFalse(RECORD['kernelPathMatchesExpected'])
        self.assertFalse(RECORD['kernelHashMatchesExpected'])
        self.assertEqual(self.check(), [PINS['pythonRuntime']['path'], SOURCE])
        self.assertNotEqual(PINS['python']['path'], PINS['pythonRuntime']['path'])
        self.assertNotEqual(PINS['python']['sha256'], PINS['pythonRuntime']['sha256'])

    def test_wrong_kernel_path_hash_or_size_refuses_even_correct_raw(self):
        for key, changed in [('path', '/somewhere/Python'), ('path', PINS['python']['path']), ('bytes', PINS['pythonRuntime']['bytes'] + 1), ('sha256', '0' * 64)]:
            record = copy.deepcopy(RECORD)
            record['kernelExecutable'][key] = changed
            with self.subTest(key=key, changed=changed), self.assertRaisesRegex(RuntimeError, 'kernel runtime'):
                self.check(record)

    def test_no_basename_launchwrapper_alias_or_generic_realpath_allowlist(self):
        for prefix in ('Python', '/usr/bin/python3', PINS['python']['path'], PINS['pythonRuntime']['path'] + '-other', PINS['pythonRuntime']['path'].replace('/Resources/', '/Resources/../Resources/')):
            with self.subTest(prefix=prefix), self.assertRaises(RuntimeError):
                self.check(self.raw(prefix + ' ' + SOURCE + '\n'))

    def test_exact_source_argv_refuses_extra_missing_altered_or_shell_argument(self):
        for suffix in ('', SOURCE + ' --extra', SOURCE + '.other', SOURCE + ' ;echo x'):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(RuntimeError, 'argv mismatch'):
                self.check(self.raw(PINS['pythonRuntime']['path'] + ' ' + suffix + '\n'))

    def test_process_evidence_pid_start_group_parent_missing_or_zombie_refuses(self):
        for phase in ('before', 'after'):
            for field, changed in [('pid', 999), ('ppid', 999), ('pgid', 999), ('start', 'reused'), ('state', 'Z')]:
                record = copy.deepcopy(RECORD)
                record[phase][field] = changed
                with self.subTest(phase=phase, field=field), self.assertRaisesRegex(RuntimeError, 'process evidence'):
                    self.check(record)
        record = copy.deepcopy(RECORD); record['pid'] += 1
        with self.assertRaisesRegex(RuntimeError, 'expected process'):
            self.check(record)
        with self.assertRaisesRegex(RuntimeError, 'expected process'):
            self.check(expected={**RECORD['expectedIdentity'], 'start': 'wrong'})

    def test_incomplete_corrupt_or_cleanup_uncertain_record_refuses(self):
        for key, changed in [('rawCommandComplete', False), ('rawCommandTruncated', True), ('rawCommandHex', 'bad'), ('rawCommandBytes', 1), ('rawCommandSHA256', '0' * 64), ('error', {'message': 'failed'}), ('errors', [{'message': 'failed'}]), ('commandCleanup', [{'phase': 'unreaped'}]), ('fileCleanup', [{'phase': 'close'}]), ('commandPrimary', {'message': 'first'}), ('filePrimary', {'message': 'first'})]:
            record = copy.deepcopy(RECORD); record[key] = changed
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.check(record)
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            self.check(text='changed text')

    def test_launcher_record_cannot_be_swapped_to_runtime_or_other_pin(self):
        record = copy.deepcopy(RECORD); record['expectedExecutable'] = PINS['pythonRuntime']
        with self.assertRaisesRegex(RuntimeError, 'launch identity'):
            self.check(record)


if __name__ == '__main__':
    unittest.main()
