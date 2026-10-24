"""Synthetic source contracts only; no Go build, graph, audio or timers."""
import importlib.util
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('private_node_visit_producer', pathlib.Path(__file__).with_name('producer.py'))
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class SourceContract(unittest.TestCase):
    def test_exact_single_node_move_matches_candidate(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_bytes()
        candidate = (RUNNER.SOURCE / 'studio_gain_envelope.go.source').read_bytes()
        self.assertEqual(RUNNER.candidate_from_original(original), candidate)
        self.assertEqual(RUNNER.digest(RUNNER.ROOT / RUNNER.PRODUCTION), RUNNER.ORIGINAL_SHA)
        self.assertEqual(RUNNER.digest(RUNNER.SOURCE / 'studio_gain_envelope.go.source'), RUNNER.CANDIDATE_SHA)

    def test_candidate_transform_refuses_missing_or_duplicate_original(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_bytes()
        candidate = (RUNNER.SOURCE / 'studio_gain_envelope.go.source').read_bytes()
        for bad in (b'', candidate, original + original):
            with self.subTest(size=len(bad)):
                with self.assertRaises(ValueError):
                    RUNNER.candidate_from_original(bad)

    def test_control_is_original_body_not_candidate(self):
        original = (RUNNER.ROOT / RUNNER.PRODUCTION).read_bytes()
        control = (RUNNER.SOURCE / 'node_visit_test.go.source').read_bytes()
        RUNNER.check_oracle(original, control)
        bad = control.replace(b'e.node(tree, index, epoch)\n\tif from <= low', b'if from <= low')
        with self.assertRaises(ValueError):
            RUNNER.check_oracle(original, bad)

    def test_unit_selects_only_envelope_controls(self):
        source = (RUNNER.SOURCE / 'producer.py').read_text()
        self.assertIn('-run=^TestStudioEnvelopeNodeVisit', source)
        self.assertNotIn("'build'", source)
        self.assertNotIn("'measure'", source)
        self.assertEqual(RUNNER.EXTRA, 'internal/audio/dsp/studio_extrema_screen_test.go')

    def test_unit_log_requires_exact_four_unskipped_tests(self):
        log = ''.join('=== RUN   ' + name + '\n--- PASS: ' + name + ' (0.01s)\n' for name in RUNNER.TESTS) + 'PASS\n'
        self.assertEqual(RUNNER.validate_unit_log(log), list(RUNNER.TESTS))
        for bad in ('PASS\n', log.replace(RUNNER.TESTS[0], 'TestWrong'), log + '--- SKIP: TestExtra (0.00s)\n', log + '=== RUN   TestExtra\n'):
            with self.subTest(log=bad):
                with self.assertRaises(ValueError):
                    RUNNER.validate_unit_log(bad)

    def test_closed_identifier_refuses_paths(self):
        for bad in ('', '../outside', 'Upper', 'a/b', 'a'*33):
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):
                    RUNNER.identifier(bad)


if __name__ == '__main__':
    unittest.main()
