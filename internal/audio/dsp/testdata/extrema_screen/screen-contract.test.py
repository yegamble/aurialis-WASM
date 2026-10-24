"""Synthetic parser/admission tests ONLY: no Go build, DSP, timers, or GPU."""
# cspell:ignore AUEXPS
import copy
import hashlib
import importlib.util
import json
import pathlib
import struct
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('private_screen_contract', pathlib.Path(__file__).with_name('run-screen.py'))
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def stream(phase='measure'):
    data = bytearray()
    offsets = {}
    def number(value, name=None):
        if name:
            offsets[name] = len(data)
        data.extend(struct.pack('<Q', value))
    def blob(value):
        number(len(value))
        data.extend(value)
    def pcm(frames, name):
        number(frames, name + '-frames')
        offsets[name] = len(data)
        # Preserve zero signs/subnormal bits in the synthetic byte contract.
        for _ in range(frames):
            data.extend(struct.pack('<II', 0x80000000, 1))
    data.extend(b'AUEXPS01')
    number(192000)
    blob(phase.encode())
    blob(b'steady')
    blob(b'{"contract":"synthetic only, no actual DSP"}')
    pcm(128, 'source')
    for mode in (0, 1):
        number(mode, f'mode{mode}')
        number(2036)
        number(16777216)
        pcm(4096, f'verify{mode}')
        blob(bytes([mode + 1]) * 32)
        number(12288)
        if phase == 'measure':
            number(8192, f'start{mode}')
            number(12288)
            pcm(4096, f'timed{mode}')
            blob(bytes([mode + 1]) * 32)
            number(32_000_000, f'time{mode}')
            number(0, f'malloc{mode}')
            number(0)
    number(RUNNER.MEASURE_FRAMES if phase == 'measure' else RUNNER.VERIFY_FRAMES, 'frames')
    number(128, 'words')
    number(len(data) + 8, 'bytes')
    return bytes(data), offsets


class ScreenContract(unittest.TestCase):
    def test_fixed_work_accounting_has_no_benchmark_calibration(self):
        self.assertEqual(RUNNER.VERIFY_FRAMES, 24576)
        self.assertEqual(RUNNER.MEASURE_FRAMES, 49152)
        self.assertEqual(3 * RUNNER.MEASURE_FRAMES, 147456)
        self.assertLessEqual(3 * RUNNER.MEASURE_FRAMES * 4, 800000)

    def test_verify_and_measure_normalized_bytes_match(self):
        verify = RUNNER.parse_screen(stream('verify')[0], 'verify', 'steady')
        measured = RUNNER.parse_screen(stream()[0], 'measure', 'steady')
        self.assertEqual(verify['verificationBytes'], measured['verificationBytes'])
        self.assertEqual(verify['verificationSHA256'], measured['verificationSHA256'])
        self.assertEqual(len(measured['timings']), 2)
        self.assertEqual(measured['timings'][0]['meanMsPer128'], 1)
        self.assertNotEqual(measured['timedSHA256'], hashlib.sha256(b'').hexdigest())

    def test_actual_timed_pcm_must_equal_own_reset_verification(self):
        data, at = stream()
        changed = bytearray(data)
        changed[at['timed0']] ^= 1
        with self.assertRaisesRegex(ValueError, 'same-child'):
            RUNNER.parse_screen(bytes(changed), 'measure', 'steady')

    def test_state_digest_must_equal_own_reset_verification(self):
        data, at = stream()
        changed = bytearray(data)
        changed[at['timed1'] + 4096 * 8 + 8] ^= 1
        with self.assertRaisesRegex(ValueError, 'same-child'):
            RUNNER.parse_screen(bytes(changed), 'measure', 'steady')

    def test_time_clock_frames_words_and_bytes_are_closed(self):
        data, at = stream()
        for name, value in (('time0', 0), ('time0', 25_000_000_001), ('start0', 8193), ('frames', 49153), ('words', 16777217), ('bytes', len(data) - 1), ('mode1', 0), ('source-frames', 129)):
            with self.subTest(name=name, value=value):
                changed = bytearray(data)
                struct.pack_into('<Q', changed, at[name], value)
                with self.assertRaises(ValueError):
                    RUNNER.parse_screen(bytes(changed), 'measure', 'steady')

    def test_nonfinite_pcm_and_truncation_trailers_refused(self):
        data, at = stream()
        changed = bytearray(data)
        struct.pack_into('<I', changed, at['verify0'], 0x7f800001)
        for bad in (bytes(changed), data[:-1], data + b'bad', b'', bytes(RUNNER.CAP + 1)):
            with self.subTest(size=len(bad)):
                with self.assertRaises(ValueError):
                    RUNNER.parse_screen(bad, 'measure', 'steady')

    def test_phase_workload_are_closed(self):
        data = stream()[0]
        for phase, workload in (('verify', 'steady'), ('measure', 'peaky'), ('any', 'steady'), ('measure', '../steady')):
            with self.assertRaises(ValueError):
                RUNNER.parse_screen(data, phase, workload)

    def test_observed_allocation_or_cross_module_differences_reject_interpretation(self):
        parsed = RUNNER.parse_screen(stream()[0], 'measure', 'steady')
        parsed['inputSHA256'] = 'a' * 64
        gate = {'verificationSHA256': parsed['verificationSHA256'], 'inputSHA256': parsed['inputSHA256']}
        control = RUNNER.admit_observation(parsed, gate)
        self.assertEqual(control, parsed['timedBytes'])
        for kind in ('malloc', 'bytes', 'verification', 'input'):
            changed = copy.deepcopy(parsed)
            if kind == 'malloc':
                changed['timings'][0]['mallocDelta'] = 1
            elif kind == 'bytes':
                changed['timings'][1]['totalAllocDelta'] = 1
            elif kind == 'verification':
                changed['verificationSHA256'] = 'b' * 64
            else:
                changed['inputSHA256'] = 'b' * 64
            with self.subTest(kind=kind):
                with self.assertRaises(ValueError):
                    RUNNER.admit_observation(changed, gate, control)
        with self.assertRaises(ValueError):
            RUNNER.admit_observation(parsed, gate, control + b'bad')

    def test_identifiers_refuse_paths_and_open_ended_inputs(self):
        self.assertEqual(RUNNER.PRODUCER.identifier('screen-source-v1'), 'screen-source-v1')
        for bad in ('../outside', '', 'a' * 33, 'Upper', 'a/b'):
            with self.assertRaises(ValueError):
                RUNNER.PRODUCER.identifier(bad)

    def test_historical_index_checks_actual_bytes_not_only_index_hash(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-screen-contract-') as temporary:
            directory = pathlib.Path(temporary)
            file = directory / 'old.bin'
            file.write_bytes(b'old retained bytes')
            manifest = {'files': [{'file': file.name, 'bytes': file.stat().st_size, 'sha256': RUNNER.PRODUCER.digest(file)}]}
            index = directory / 'SHA256.json'
            index.write_text(json.dumps(manifest))
            pinned = RUNNER.PRODUCER.digest(index)
            RUNNER.PRODUCER.verify_index(directory, pinned)
            file.write_bytes(b'new retained bytes')
            with self.assertRaises(ValueError):
                RUNNER.PRODUCER.verify_index(directory, pinned)


if __name__ == '__main__':
    unittest.main()
