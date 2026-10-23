"""Independent metric edge cases; no trained model inference or fixture download."""
import importlib.util
import math
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("measure_quality", Path(__file__).with_name("measure_quality.py"))
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


class QualityMetricTests(unittest.TestCase):
    def setUp(self):
        index = np.arange(10000)
        self.source = np.column_stack((np.sin(index * .13), np.cos(index * .17)))

    def test_silent_truth_and_zero_prediction_are_explicitly_unavailable(self):
        self.assertFalse(metrics.quality(np.zeros_like(self.source), self.source)["available"])
        result = metrics.quality(self.source, np.zeros_like(self.source))
        self.assertIsNone(result["siSdrDb"])
        self.assertIsNone(result["rawRmsRatioDb"])
        self.assertEqual(result["siSdrUnavailableReason"], "zero aligned prediction energy")

    def test_scale_invariance_does_not_hide_actual_gain_or_dc_error(self):
        scaled = metrics.quality(self.source, 2 * self.source)
        self.assertGreater(scaled["siSdrDb"], 100)
        self.assertAlmostEqual(scaled["rawRmsRatioDb"], 20 * math.log10(2), places=12)
        self.assertAlmostEqual(scaled["rawScaleDependentSdrDb"], 0, places=12)
        dc = metrics.quality(self.source, self.source + .2)
        self.assertGreater(dc["siSdrDb"], 100)
        self.assertLess(dc["rawScaleDependentSdrDb"], 20)
        for value in dc["dcError"]:
            self.assertAlmostEqual(value, .2, places=12)

    def test_time_shift_is_not_automatically_aligned(self):
        shifted = metrics.quality(self.source, np.roll(self.source, 1, axis=0))
        self.assertLess(shifted["siSdrDb"], 50)
        self.assertGreater(shifted["siSdrDb"], 0)


if __name__ == "__main__":
    unittest.main()
