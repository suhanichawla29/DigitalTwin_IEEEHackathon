import unittest
from collections import deque
from pathlib import Path
import random

from predictor import (
    FEATURE_SCHEMA,
    FailurePredictor,
    MODEL_PATH,
    WINDOW_SIZE,
    extract_features,
)
from train_model import make_episode


class FixedProbabilityModel:
    classes_ = [0, 1]

    def predict_proba(self, rows):
        self.rows = rows
        return [[0.35, 0.65]]


def make_reading(index):
    return {
        "voltage": 400 - index * 0.12,
        "current": 35 + index * 0.08,
        "temperature": 45 + index * 0.04,
    }


class PredictorTests(unittest.TestCase):
    def test_features_include_trends_variability_and_relationships(self):
        readings = [make_reading(index) for index in range(WINDOW_SIZE)]

        features = extract_features(readings)

        self.assertEqual(tuple(features), FEATURE_SCHEMA)
        self.assertLess(features["voltage_slope"], 0)
        self.assertGreater(features["current_slope"], 0)
        self.assertGreater(features["temperature_slope"], 0)
        self.assertGreater(features["voltage_std"], 0)
        self.assertIn("voltage_current_correlation", features)

    def test_model_warms_until_30_then_returns_probability(self):
        predictor = FailurePredictor(
            model_path=Path(__file__).with_name("missing-model.joblib")
        )
        predictor.model = FixedProbabilityModel()

        for index in range(WINDOW_SIZE - 1):
            result = predictor.add_reading(make_reading(index))

        self.assertEqual(result["status"], "warming_up")
        self.assertEqual(result["history_count"], WINDOW_SIZE - 1)
        self.assertIsNone(result["failure_probability"])

        result = predictor.add_reading(make_reading(WINDOW_SIZE - 1))

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["history_count"], WINDOW_SIZE)
        self.assertEqual(result["failure_probability"], 0.65)
        self.assertEqual(result["horizon_seconds"], 300)
        self.assertEqual(len(predictor.model.rows[0]), len(FEATURE_SCHEMA))

    def test_inference_uses_features_from_actual_latest_30_readings(self):
        predictor = FailurePredictor(
            model_path=Path(__file__).with_name("missing-model.joblib")
        )
        predictor.model = FixedProbabilityModel()
        readings = [make_reading(index) for index in range(WINDOW_SIZE + 8)]

        for reading in readings:
            result = predictor.add_reading(reading)

        expected = extract_features(readings[-WINDOW_SIZE:])
        self.assertEqual(
            predictor.model.rows[0],
            [expected[name] for name in FEATURE_SCHEMA],
        )
        self.assertEqual(result["history_count"], WINDOW_SIZE)

    def test_training_episodes_include_gradual_and_combined_current_faults(self):
        modes = set()
        rng = random.Random(20261014)

        for episode_id in range(100):
            _, _, _, mode = make_episode(rng, episode_id, 360)
            modes.add(mode)

        self.assertIn("gradual_over_current", modes)
        self.assertIn("combined_current_under_voltage", modes)
        self.assertIn("combined_current_temperature", modes)

    def test_history_is_bounded_to_latest_30_and_reset_clears_it(self):
        predictor = FailurePredictor(
            model_path=Path(__file__).with_name("missing-model.joblib")
        )

        for index in range(WINDOW_SIZE + 7):
            predictor.add_reading(make_reading(index))

        self.assertIsInstance(predictor.history, deque)
        self.assertEqual(len(predictor.history), WINDOW_SIZE)
        self.assertEqual(
            predictor.history[-1]["current"],
            make_reading(WINDOW_SIZE + 6)["current"],
        )

        predictor.reset()

        self.assertEqual(len(predictor.history), 0)

    def test_untrained_model_reports_unavailable(self):
        predictor = FailurePredictor(
            model_path=Path(__file__).with_name("missing-model.joblib")
        )

        result = predictor.add_reading(make_reading(0))

        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["failure_probability"])
        self.assertIn("model", result)

    def test_trained_artifact_predicts_after_30_readings(self):
        predictor = FailurePredictor(model_path=MODEL_PATH)
        if predictor.model is None:
            self.skipTest("Train the model to verify its saved artifact")

        for index in range(WINDOW_SIZE):
            result = predictor.add_reading(make_reading(index))

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["history_count"], WINDOW_SIZE)
        self.assertTrue(
            0 <= result["failure_probability"] <= 1
        )
        self.assertEqual(result["model"]["feature_count"], len(FEATURE_SCHEMA))


if __name__ == "__main__":
    unittest.main()
