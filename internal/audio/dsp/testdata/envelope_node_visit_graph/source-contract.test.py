"""Synthetic source/admission tests only; no compilation/DSP/audio/timing."""
# cspell:ignore GOWORK GOEXPERIMENT GOWASM GOARM GOFLAGS
import copy
import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('private_graph_source_contract', pathlib.Path(__file__).with_name('run-pair.py'))
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
PRODUCER = RUNNER.PRODUCER


def counter_text(**changes):
    values = {'cases': 27, 'rate': 192000, 'baseFrames': 10, 'numericWords': 20, 'outputBytes': 32, 'fixedGraphBytes': 1024, 'inputSHA256': 'a' * 64}
    values.update(changes)
    return ' '.join(key + str(value) for key, value in values.items())


class SourceContract(unittest.TestCase):
    def test_closed_backend_rate_and_archive_are_current_candidate(self):
        for backend in PRODUCER.BACKENDS:
            for rate in PRODUCER.RATES:
                self.assertIn('candidate', str(PRODUCER.archived(backend, rate)))
        for backend, rate in (('other', 8000), ('native', 1234)):
            with self.assertRaises(ValueError):
                PRODUCER.archived(backend, rate)

    def test_effective_flags_are_exact_for_both_targets(self):
        for backend in PRODUCER.BACKENDS:
            expected = PRODUCER.expected_env(backend, pathlib.Path('/private/overlay.json'))
            actual = copy.deepcopy(expected)
            PRODUCER.validate_env(actual, expected)
            for key in ('GOOS', 'GOARCH', 'CGO_ENABLED', 'GOWORK', 'GOEXPERIMENT', 'GOWASM', 'GOARM64', 'GOFLAGS'):
                bad = {**actual, key: 'unexpected'}
                with self.subTest(backend=backend, key=key):
                    with self.assertRaises(ValueError):
                        PRODUCER.validate_env(bad, expected)

    def test_only_exact_six_seven_overlay_shapes_admitted(self):
        snapshot = {'baseline': {str(i): '' for i in range(6)}, 'candidate': {str(i): '' for i in range(7)}}
        for label in PRODUCER.LABELS:
            self.assertEqual(PRODUCER.expected_mapping(snapshot, label), snapshot[label])
            bad = copy.deepcopy(snapshot)
            bad[label]['extra'] = ''
            with self.assertRaises(ValueError):
                PRODUCER.expected_mapping(bad, label)
        with self.assertRaises(ValueError):
            PRODUCER.expected_mapping(snapshot, 'other')

    def test_counter_requires_exactly_one_closed_original_receipt(self):
        log = counter_text()
        expected = RUNNER.SUPERVISOR.parse_counter_receipt(log, 192000)
        self.assertEqual(RUNNER.validate_counter(log, 192000, expected), expected)
        for bad in ('', log + '\n' + log, counter_text(cases=26), counter_text(rate=48000), counter_text(baseFrames=200001), counter_text(numericWords=16777217), counter_text(outputBytes=8388609), counter_text(fixedGraphBytes=2097153)):
            with self.subTest(log=bad):
                with self.assertRaises(ValueError):
                    RUNNER.validate_counter(bad, 192000, expected)

    def test_pair_equality_alone_cannot_replace_current_archive_equality(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-node-visit-source-') as temporary:
            directory = pathlib.Path(temporary)
            files = [directory / name for name in ('first.bin', 'second.bin', 'archive.bin')]
            for file in files:
                file.write_bytes(b'synthetic contract bytes only')
            with mock.patch.object(PRODUCER, 'archived', return_value=files[2]):
                self.assertTrue(RUNNER.compare_outputs(files[:2], 'native', 8000)['accepted'])
                files[2].write_bytes(b'different accepted archive')
                result = RUNNER.compare_outputs(files[:2], 'native', 8000)
                self.assertTrue(result['baselineCandidate']['byteEqual'])
                self.assertFalse(result['accepted'])

    def test_output_mode_size_and_symlink_are_closed(self):
        with tempfile.TemporaryDirectory(prefix='aurialis-node-visit-source-') as temporary:
            file = pathlib.Path(temporary) / 'bytes.bin'
            file.write_bytes(b'bytes')
            file.chmod(0o600)
            RUNNER.validate_output(file, {'outputBytes': 5})
            with self.assertRaises(ValueError):
                RUNNER.validate_output(file, {'outputBytes': 6})
            file.chmod(0o644)
            with self.assertRaises(ValueError):
                RUNNER.validate_output(file, {'outputBytes': 5})
            link = file.with_name('link.bin')
            link.symlink_to(file)
            with self.assertRaises(ValueError):
                RUNNER.validate_output(link, {'outputBytes': 5})

    def test_source_has_no_timing_or_benchmark_entry(self):
        producer = (PRODUCER.SOURCE / 'producer.py').read_text()
        parent = (PRODUCER.SOURCE / 'run-pair.py').read_text()
        child = (PRODUCER.SOURCE / 'wasm-child.mjs').read_text()
        for text in (producer, parent, child):
            self.assertNotIn('-test.bench', text)
            self.assertNotIn("'measure'", text)
        self.assertIn('-test.run=^TestWriteStudioExtremaGraphFixtures$', child)
        self.assertIn("'candidate-native-final'", producer)


if __name__ == '__main__':
    unittest.main()
