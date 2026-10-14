import tempfile
import unittest
import csv
import zipfile
from pathlib import Path

import numpy as np
from scipy.io import savemat

from battery_predictor import BatteryCapacityPredictor
from main import (
    detect_synCAN_anomaly,
    estimate_battery_capacity,
    get_models,
)
from synCAN_predictor import (
    SynCANPredictor,
    SIGNAL_COUNTS,
    feature_names_for_id,
    record_features,
)
from training.prepare_nasa_data import load_battery_runs
from training.train_synCAN_model import train as train_synCAN
from fastapi import HTTPException


class StubDetector:
    def predict(self, values):
        self.values = values
        return np.asarray([-1])

    def decision_function(self, values):
        return np.asarray([-0.42])


class DatasetModelTests(unittest.TestCase):
    def test_nasa_discharge_features_use_real_measurement_names_and_seconds(self):
        from training.prepare_nasa_data import FEATURE_NAMES, discharge_features

        data = {
            "Time": [0, 1, 2, 3],
            "Voltage_measured": [4.2, 4.0, 3.8, 3.6],
            "Current_measured": [-1.0, -1.0, -1.0, -1.0],
            "Temperature_measured": [24.0, 25.0, 26.0, 27.0],
            "Capacity": [1.8],
        }
        features = discharge_features(data)

        self.assertEqual(features["duration_seconds"], 3.0)
        self.assertEqual(features["voltage_start_v"], 4.2)
        self.assertEqual(features["voltage_end_v"], 3.6)
        self.assertEqual(features["current_abs_mean_a"], 1.0)
        self.assertEqual(set(features), set(FEATURE_NAMES))
        self.assertNotIn("Capacity", features)

    def test_nasa_invalid_or_too_short_discharge_is_rejected(self):
        from training.prepare_nasa_data import discharge_features

        with self.assertRaises(ValueError):
            discharge_features({
                "Time": [0],
                "Voltage_measured": [4.0],
                "Current_measured": [1.0],
                "Temperature_measured": [25.0],
            })

    def test_nasa_sensor_missing_values_are_removed_without_losing_alignment(self):
        from training.prepare_nasa_data import discharge_features

        features = discharge_features({
            "Time": [0, 1, 2, 3],
            "Voltage_measured": [4.2, np.nan, 3.8, 3.6],
            "Current_measured": [-1.0, -1.0, -1.0, -1.0],
            "Temperature_measured": [24.0, 25.0, 26.0, 27.0],
        })
        self.assertEqual(features["duration_seconds"], 3.0)
        self.assertAlmostEqual(features["voltage_mean_v"], (4.2 + 3.8 + 3.6) / 3)

    def test_nasa_mat_loader_reads_only_discharge_capacity_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "B0005.mat"
            data_dtype = [
                ("Time", "O"),
                ("Voltage_measured", "O"),
                ("Current_measured", "O"),
                ("Temperature_measured", "O"),
                ("Capacity", "O"),
            ]
            cycle_dtype = [
                ("type", "O"),
                ("ambient_temperature", "O"),
                ("time", "O"),
                ("data", "O"),
            ]
            cycles = np.empty((1, 2), dtype=cycle_dtype)
            for index, operation in enumerate(("charge", "discharge")):
                sample_data = np.empty((1,), dtype=data_dtype)
                sample_data["Time"][0] = np.asarray([0, 1, 2, 3])
                sample_data["Voltage_measured"][0] = np.asarray([4.2, 4.0, 3.8, 3.6])
                sample_data["Current_measured"][0] = np.asarray([-1, -1, -1, -1])
                sample_data["Temperature_measured"][0] = np.asarray([24, 25, 26, 27])
                sample_data["Capacity"][0] = 1.8
                cycles["type"][0, index] = operation
                cycles["ambient_temperature"][0, index] = 24
                cycles["time"][0, index] = np.asarray([2020, 1, 1, 0, 0, index])
                cycles["data"][0, index] = sample_data
            savemat(path, {"B0005": {"cycle": cycles}})

            samples = list(load_battery_runs([path]))
            self.assertEqual(len(samples), 1)
            self.assertEqual(samples[0]["battery_id"], "B0005")
            self.assertEqual(samples[0]["cycle_index"], 2)
            self.assertAlmostEqual(samples[0]["capacity_ah"], 1.8)
            self.assertAlmostEqual(samples[0]["soh_percent"], 90.0)
            self.assertNotIn("capacity_ah", samples[0]["features"])

    def test_synCAN_features_are_id_specific_and_use_milliseconds(self):
        row = {
            "ID": "id2",
            "Time": 1000,
            "Signal1_of_ID": 1.25,
            "Signal2_of_ID": 2.5,
            "Signal3_of_ID": 3.75,
        }
        can_id, vector, current = record_features(row)
        self.assertEqual(can_id, "id2")
        self.assertEqual(vector.shape[1], len(feature_names_for_id("id2")))
        self.assertEqual(vector[0, 0], 0.0)

        next_row = {**row, "Time": 1120, "Signal1_of_ID": 1.5}
        _, next_vector, _ = record_features(next_row, current)
        self.assertEqual(next_vector[0, 0], 120.0)
        self.assertEqual(next_vector[0, 1], 1.5)
        self.assertEqual(next_vector[0, 4], 0.25)
        with self.assertRaises(ValueError):
            feature_names_for_id("0x100")

    def test_synCAN_predictor_returns_anomaly_not_probability(self):
        with tempfile.TemporaryDirectory() as directory:
            predictor = SynCANPredictor(Path(directory) / "missing.joblib")
            self.assertEqual(predictor.status()["status"], "unavailable")
            predictor.models["id1"] = StubDetector()
            predictor.error = None
            result = predictor.score({
                "ID": "id1",
                "Time": 120.0,
                "Signal1_of_ID": 12.5,
                "Signal2_of_ID": 42.0,
            })
            self.assertTrue(result["is_anomaly"])
            self.assertEqual(result["decision_score"], -0.42)
            self.assertNotIn("failure_probability", result)

    def test_nasa_capacity_predictor_returns_capacity_units_not_risk(self):
        predictor = BatteryCapacityPredictor("missing-model.joblib")

        class CapacityModel:
            def predict(self, values):
                self.values = values
                return np.asarray([1.7])

        predictor.model = CapacityModel()
        result = predictor.estimate({
            "Time": [0, 1, 2],
            "Voltage_measured": [4.1, 3.9, 3.7],
            "Current_measured": [-1, -1, -1],
            "Temperature_measured": [24, 24.5, 25],
        })
        self.assertAlmostEqual(result["capacity_ah"], 1.7)
        self.assertAlmostEqual(result["capacity_soh_percent"], 85.0)
        self.assertNotIn("failure_probability", result)

    def test_dataset_models_report_unavailable_without_downloaded_data(self):
        result = get_models()["dataset_models"]
        self.assertEqual(
            result["nasa_battery_capacity"]["status"],
            "unavailable",
        )
        self.assertEqual(
            result["synCAN_intrusion_detection"]["status"],
            "unavailable",
        )
        with self.assertRaises(HTTPException) as raised:
            estimate_battery_capacity({"cycle": {"data": {}}})
        self.assertEqual(raised.exception.status_code, 503)
        with self.assertRaises(HTTPException) as raised:
            detect_synCAN_anomaly({
                "ID": "id1",
                "Time": 1,
                "Signal1_of_ID": 1,
                "Signal2_of_ID": 2,
            })
        self.assertEqual(raised.exception.status_code, 503)

    def test_synCAN_training_uses_normal_rows_and_persists_model(self):
        columns = [
            "Label", "ID", "Time",
            "Signal1_of_ID", "Signal2_of_ID",
            "Signal3_of_ID", "Signal4_of_ID",
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            train_path = root / "train_fixture.zip"
            test_path = root / "test_fixture.zip"

            def add_csv(archive, name, rows):
                import io
                text = io.StringIO()
                writer = csv.DictWriter(text, fieldnames=columns)
                writer.writeheader()
                writer.writerows(rows)
                archive.writestr(name, text.getvalue())

            with zipfile.ZipFile(train_path, "w") as archive:
                for id_number in range(1, 11):
                    can_id = f"id{id_number}"
                    count = SIGNAL_COUNTS[can_id]
                    rows = []
                    for index in range(110):
                        row = {
                            "Label": 0,
                            "ID": can_id,
                            "Time": index * 10,
                        }
                        for signal in range(1, count + 1):
                            row[f"Signal{signal}_of_ID"] = (
                                id_number * 10 + signal + index * 0.01
                            )
                        rows.append(row)
                    add_csv(archive, f"{can_id}.csv", rows)

            with zipfile.ZipFile(test_path, "w") as archive:
                rows = []
                for id_number in range(1, 11):
                    can_id = f"id{id_number}"
                    count = SIGNAL_COUNTS[can_id]
                    for label, index in ((0, 111), (1, 112)):
                        row = {
                            "Label": label,
                            "ID": can_id,
                            "Time": index * 10,
                        }
                        for signal in range(1, count + 1):
                            row[f"Signal{signal}_of_ID"] = (
                                10000 if label else
                                id_number * 10 + signal + index * 0.01
                            )
                        rows.append(row)
                add_csv(archive, "labelled.csv", rows)

            artifact_path = root / "synCAN.joblib"
            metadata = train_synCAN(
                [train_path],
                [test_path],
                artifact_path,
                max_samples_per_id=110,
                seed=19,
            )
            self.assertEqual(metadata["training_label_use"], "Label=0 rows only; labels are not used to fit models")
            self.assertEqual(metadata["metrics"]["rows_evaluated"], 20)
            self.assertTrue(artifact_path.is_file())
            predictor = SynCANPredictor(artifact_path)
            self.assertEqual(predictor.status()["status"], "ready")


if __name__ == "__main__":
    unittest.main()
