import tempfile
import unittest
from pathlib import Path

from can_decoder import decode_can_frame
from ev_simulator_predictor import (
    ARTIFACT_SOURCE,
    FEATURE_NAMES,
    EVSimulatorAnomalyPredictor,
    frame_features,
)
from main import SimulationState, get_models, get_readings, make_demo_frame, reset_simulation
from training.train_ev_simulator_anomaly import SCENARIOS, train


def decoded_frame(values, timestamp):
    payload = make_demo_frame(
        values["voltage"],
        values["current"],
        values["temperature"],
    )
    return {
        **decode_can_frame(0x100, payload),
        "timestamp": timestamp,
    }


class EVSimulatorAnomalyTests(unittest.TestCase):
    def test_features_are_extracted_from_round_tripped_dbc_signals(self):
        first = decoded_frame(
            {"voltage": 400, "current": 35, "temperature": 45},
            10.0,
        )
        vector, previous = frame_features(first)
        self.assertEqual(first["message_name"], "ECU_Telemetry")
        self.assertEqual(vector.shape, (1, len(FEATURE_NAMES)))
        self.assertEqual(
            vector[0].tolist(),
            [400.0, 35.0, 45.0, 0.0, 0.0, 0.0, 0.0],
        )

        second = decoded_frame(
            {"voltage": 399, "current": 36, "temperature": 46},
            12.0,
        )
        vector, _ = frame_features(second, previous)
        self.assertEqual(
            vector[0].tolist(),
            [399.0, 36.0, 46.0, 2.0, -1.0, 1.0, 1.0],
        )

    def test_training_uses_disjoint_complete_episodes_and_live_inference(self):
        with tempfile.TemporaryDirectory() as temp:
            artifact = Path(temp) / "ev_simulator_anomaly.joblib"
            metadata = train(
                artifact,
                train_episodes_per_scenario=3,
                validation_episodes_per_scenario=2,
                samples_per_episode=130,
                random_state=347,
            )
            self.assertTrue(artifact.is_file())
            self.assertEqual(metadata["source"], ARTIFACT_SOURCE)
            self.assertEqual(metadata["train_episode_count"], 42)
            self.assertEqual(metadata["validation_episode_count"], 28)
            self.assertEqual(
                metadata["validation_episode_split"],
                "whole episodes; no episode shared with training",
            )
            self.assertEqual(
                sum(sum(row) for row in metadata["evaluation"]["confusion_matrix"]),
                metadata["validation_sample_count"],
            )
            self.assertEqual(set(metadata["per_scenario_validation"]), set(SCENARIOS))

            predictor = EVSimulatorAnomalyPredictor(artifact)
            self.assertEqual(predictor.status()["status"], "ready")

            normal = SimulationState(seed=7_654_321)
            normal.select("normal", ())
            normal_results = []
            for index in range(60):
                result = predictor.evaluate(
                    decoded_frame(normal.advance(), index * 2.0)
                )
                if result["status"] == "evaluated":
                    normal_results.append(result)
            self.assertGreater(len(normal_results), 50)
            self.assertGreater(
                sum(not result["is_anomaly"] for result in normal_results),
                len(normal_results) * 0.7,
            )

            predictor.reset()
            anomalous = SimulationState(seed=8_765_432)
            anomalous.select("multiple_faults", ())
            anomaly_results = []
            for index in range(130):
                result = predictor.evaluate(
                    decoded_frame(anomalous.advance(), index * 2.0)
                )
                if result["status"] == "evaluated":
                    anomaly_results.append(result)
            self.assertGreater(len(anomaly_results), 100)
            self.assertTrue(any(result["is_anomaly"] for result in anomaly_results))
            self.assertTrue(
                all(
                    0.0 <= result["anomaly_score"] <= 1.0
                    for result in anomaly_results
                )
            )
            self.assertIn("not a real-world probability", anomaly_results[-1]["score_type"])

    def test_incompatible_frames_are_never_labelled_normal_or_anomalous(self):
        with tempfile.TemporaryDirectory() as temp:
            predictor = EVSimulatorAnomalyPredictor(
                Path(temp) / "not-trained.joblib"
            )
            result = predictor.evaluate({
                "timestamp": 1.0,
                "decode_status": "error",
                "decoded_signals": [],
            })
            self.assertEqual(result["status"], "not_evaluated")
            self.assertNotIn("is_anomaly", result)
            self.assertNotIn("anomaly_score", result)

    def test_live_api_and_model_status_keep_evaluators_separate(self):
        reset_simulation()
        first = get_readings()
        second = get_readings()
        self.assertEqual(first["can_message"]["can_id"], "0x100")
        self.assertEqual(first["can_message"]["ev_anomaly"]["source"], ARTIFACT_SOURCE)
        self.assertIn(
            first["can_message"]["ev_anomaly"]["status"],
            {"warming_up", "model_unavailable"},
        )
        self.assertIn(
            second["can_message"]["ev_anomaly"]["status"],
            {"evaluated", "model_unavailable"},
        )
        self.assertNotEqual(
            second["can_message"]["synCAN_status"],
            "evaluated",
        )
        statuses = get_models()
        self.assertIn("dataset_models", statuses)
        self.assertIn("syncan_offline_evaluation", statuses)
        self.assertIn("live_can_detector", statuses)
        self.assertEqual(
            statuses["live_can_detector"]["source"],
            ARTIFACT_SOURCE,
        )
        reset_simulation()


if __name__ == "__main__":
    unittest.main()
