import tempfile
import unittest
from pathlib import Path

import numpy as np

from predictor import FEATURE_NAMES, FailurePredictor, WINDOW_SIZE, extract_features


class StubModel:
    def predict_proba(self, features):
        self.features = features
        return np.asarray([[0.2, 0.8]])


class PredictorTests(unittest.TestCase):
    def make_reading(self, index):
        return {
            "voltage": 400 - index * 0.1,
            "current": 35 + index * 0.1,
            "temperature": 45 + index * 0.05,
        }

    def test_model_warms_up_then_predicts_from_latest_30_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            predictor = FailurePredictor(Path(directory) / "missing.joblib")
            unavailable = predictor.add_reading(self.make_reading(0))
            self.assertEqual(unavailable["model_status"], "unavailable")
            predictor.reset()
            predictor.model = StubModel()

            for index in range(WINDOW_SIZE - 1):
                result = predictor.add_reading(self.make_reading(index))
            self.assertEqual(result["model_status"], "warming_up")
            self.assertIsNone(result["failure_probability"])

            result = predictor.add_reading(self.make_reading(WINDOW_SIZE - 1))
            self.assertEqual(result["model_status"], "ready")
            self.assertEqual(result["failure_probability"], 0.8)
            self.assertEqual(result["history_count"], WINDOW_SIZE)
            self.assertEqual(predictor.model.features.shape, (1, len(FEATURE_NAMES)))

            result = predictor.add_reading(self.make_reading(WINDOW_SIZE))
            self.assertEqual(result["history_count"], WINDOW_SIZE)

            expected = extract_features([
                self.make_reading(index)
                for index in range(1, WINDOW_SIZE + 1)
            ])
            np.testing.assert_allclose(predictor.model.features[0], expected)

            predictor.reset()
            self.assertEqual(len(predictor.history), 0)


if __name__ == "__main__":
    unittest.main()
