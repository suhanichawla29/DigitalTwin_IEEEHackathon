import csv
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
from scipy.io import savemat

from battery_predictor import BatteryCapacityPredictor
from main import _model_readiness, get_dataset_model_status
from syncan_predictor import (
    SIGNAL_COUNTS,
    SynCANPredictor,
    feature_names,
    record_features,
)
from training.prepare_nasa_data import (
    FEATURE_NAMES,
    discharge_features,
    load_battery_runs,
)
from training.train_nasa_model import train as train_nasa
from training.train_syncan_model import (
    evaluate_saved_model,
    train as train_syncan,
)


def _write_nasa_run(path, battery_offset):
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
    for index in range(2):
        sample = np.empty((1,), dtype=data_dtype)
        sample["Time"][0] = np.arange(6, dtype=float)
        sample["Voltage_measured"][0] = np.linspace(
            4.2, 3.5 - battery_offset * 0.01 - index * 0.02, 6
        )
        sample["Current_measured"][0] = np.full(6, -1.0 - index * 0.1)
        sample["Temperature_measured"][0] = np.linspace(24, 27 + index, 6)
        sample["Capacity"][0] = 1.8 - battery_offset * 0.02 - index * 0.03
        cycles["type"][0, index] = "discharge"
        cycles["ambient_temperature"][0, index] = 24
        cycles["time"][0, index] = np.asarray([2020, 1, 1, 0, 0, index])
        cycles["data"][0, index] = sample
    savemat(path, {path.stem: {"cycle": cycles}})


def _write_syncan_zip(
    path,
    rows_per_id=105,
    test=False,
    header_style="full",
    include_header=True,
):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for can_id, signal_count in SIGNAL_COUNTS.items():
            columns = [
                "Label",
                "Time",
                "ID",
                *[
                    (
                        f"Signal{index}_of_ID"
                        if header_style == "full"
                        else f"Signal{index}"
                    )
                    for index in range(1, signal_count + 1)
                ],
            ]
            from io import StringIO
            output = StringIO()
            writer = csv.DictWriter(output, fieldnames=columns)
            if include_header:
                writer.writeheader()
            for index in range(rows_per_id):
                row = {
                    "Label": int(test and index == rows_per_id - 1),
                    "ID": can_id,
                    "Time": index * 10,
                }
                for signal_index in range(1, signal_count + 1):
                    column = (
                        f"Signal{signal_index}_of_ID"
                        if header_style == "full"
                        else f"Signal{signal_index}"
                    )
                    row[column] = (
                        signal_index * 0.5 + index * 0.001
                    )
                if test and index == rows_per_id - 1:
                    column = (
                        "Signal1_of_ID"
                        if header_style == "full"
                        else "Signal1"
                    )
                    row[column] += 20
                writer.writerow(row)
            content = output.getvalue()
            if not include_header:
                content = content.split("\n", 1)[1]
            archive.writestr(f"{can_id}.csv", content)


class DatasetModelTests(unittest.TestCase):
    def test_nasa_discharge_features_use_documented_fields(self):
        features = discharge_features({
            "Time": [0, 1, 2, 3],
            "Voltage_measured": [4.2, 4.0, 3.8, 3.6],
            "Current_measured": [-1.0, -1.0, -1.0, -1.0],
            "Temperature_measured": [24.0, 25.0, 26.0, 27.0],
            "Capacity": [1.8],
        })
        self.assertEqual(set(features), set(FEATURE_NAMES))
        self.assertEqual(features["duration_seconds"], 3.0)
        self.assertEqual(features["voltage_end_v"], 3.6)
        self.assertEqual(features["current_abs_mean_a"], 1.0)

    def test_nasa_mat_loader_uses_discharge_capacity_only_as_target(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "B0005.mat"
            _write_nasa_run(path, 0)
            samples = list(load_battery_runs([path]))
            self.assertEqual(len(samples), 2)
            self.assertTrue(all(sample["capacity_ah"] > 0 for sample in samples))
            self.assertNotIn("capacity_ah", samples[0]["features"])

    def test_nasa_training_saves_reloadable_capacity_model(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_dir = root / "data"
            input_dir.mkdir()
            _write_nasa_run(input_dir / "B0005.mat", 0)
            _write_nasa_run(input_dir / "B0006.mat", 1)
            artifact = root / "nasa_capacity.joblib"
            metadata = train_nasa(input_dir, artifact)
            self.assertTrue(artifact.is_file())
            self.assertEqual(metadata["evaluation"], "leave-one-battery-run-out")
            predictor = BatteryCapacityPredictor(artifact)
            self.assertIsNone(predictor.error)
            self.assertEqual(predictor.status()["model_type"], "RandomForestRegressor")
            result = predictor.estimate({
                "Time": [0, 1, 2],
                "Voltage_measured": [4.1, 3.9, 3.7],
                "Current_measured": [-1, -1, -1],
                "Temperature_measured": [24, 25, 26],
            })
            self.assertGreater(result["capacity_ah"], 0)

    def test_syncan_schema_and_timing_features_follow_id_fields(self):
        record = {
            "ID": "id2",
            "Time": 1000,
            "Signal1_of_ID": 1.0,
            "Signal2_of_ID": 2.0,
            "Signal3_of_ID": 3.0,
        }
        can_id, _, previous = record_features(record)
        self.assertEqual(can_id, "id2")
        self.assertEqual(
            feature_names(can_id),
            [
                "delta_time_ms",
                "Signal1_of_ID",
                "Signal2_of_ID",
                "Signal3_of_ID",
                "Signal1_delta",
                "Signal2_delta",
                "Signal3_delta",
            ],
        )
        next_record = {**record, "Time": 1120, "Signal1_of_ID": 1.5}
        _, vector, _ = record_features(next_record, previous)
        np.testing.assert_array_equal(
            vector[0],
            [120, 1.5, 2.0, 3.0, 0.5, 0.0, 0.0],
        )
        with self.assertRaises(ValueError):
            record_features({**record, "ID": "0x100"})

    def test_syncan_training_saves_reloadable_per_id_models(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            training_zip = root / "train_1.zip"
            test_zip = root / "test_normal.zip"
            _write_syncan_zip(
                training_zip,
                header_style="short",
                include_header=False,
            )
            _write_syncan_zip(test_zip, rows_per_id=4, test=True)
            artifact = root / "synCAN_isolation_forest.joblib"
            predictor = SynCANPredictor(artifact)
            self.assertFalse(predictor.models)
            metadata = train_syncan(
                [training_zip],
                [test_zip],
                artifact,
                max_samples_per_id=100,
            )
            self.assertTrue(artifact.is_file())
            self.assertEqual(set(metadata["training_rows_fitted_by_id"]), set(SIGNAL_COUNTS))
            status = _model_readiness(
                predictor,
                dataset_status={
                    "available_count": len(SIGNAL_COUNTS),
                    "directory": "backend\\data\\synCAN",
                },
                minimum_inputs=len(SIGNAL_COUNTS),
                training_command="train_syncan_model.py",
                source_url="https://github.com/etas/SynCAN",
            )
            self.assertEqual(status["status"], "ready")
            self.assertIsNone(predictor.error)
            self.assertEqual(len(predictor.models), len(SIGNAL_COUNTS))
            for can_id, model in predictor.models.items():
                self.assertEqual(
                    list(model.named_steps),
                    ["standardscaler", "isolationforest"],
                )
                self.assertEqual(
                    model.n_features_in_,
                    len(feature_names(can_id)),
                )
            result = predictor.score({
                "ID": "id1",
                "Time": 1000,
                "Signal1_of_ID": 1.0,
                "Signal2_of_ID": 2.0,
            })
            self.assertIn("is_anomaly", result)
            self.assertNotIn("failure_probability", result)
            self.assertTrue(np.isfinite(result["decision_score"]))

            evaluation = evaluate_saved_model(artifact, [test_zip])
            self.assertEqual(evaluation["source"], "ETAS SynCAN dataset")
            self.assertEqual(
                evaluation["label_meaning"],
                {
                    "0": "normal",
                    "1": "intrusion",
                    "model_prediction_-1": "anomaly",
                    "model_prediction_1": "normal",
                },
            )
            metrics = evaluation["evaluation"]
            self.assertEqual(metrics["rows_evaluated"], 40)
            self.assertEqual(
                sum(metrics["confusion_matrix"].values()),
                metrics["rows_evaluated"],
            )
            self.assertEqual(
                metrics["false_positives"],
                metrics["confusion_matrix"][
                    "label_0_normal_predicted_intrusion"
                ],
            )
            self.assertEqual(
                metrics["missed_intrusions"],
                metrics["confusion_matrix"][
                    "label_1_intrusion_predicted_normal"
                ],
            )

    def test_untrained_predictors_do_not_claim_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            nasa = BatteryCapacityPredictor(Path(temp) / "missing-nasa.joblib")
            syncan = SynCANPredictor(Path(temp) / "missing-syncan.joblib")
            self.assertIsNone(nasa.model)
            self.assertFalse(syncan.models)
            self.assertIsNone(nasa.error)
            self.assertIsNone(syncan.error)

    def test_backend_reports_separate_dataset_readiness(self):
        statuses = get_dataset_model_status()
        self.assertEqual(
            set(statuses),
            {"nasa_battery_capacity", "syncan_intrusion_detection"},
        )
        for model in statuses.values():
            self.assertIn(
                model["status"],
                {"ready", "missing_dataset", "not_trained", "load_error"},
            )
            self.assertTrue(model["artifact_path"].endswith(".joblib"))
            self.assertIn("backend\\data\\", model["dataset"]["directory"])
            self.assertTrue(model["training_command"].startswith(".\\.venv\\Scripts\\python.exe"))
        self.assertIn(
            "capacity",
            statuses["nasa_battery_capacity"]["purpose"].casefold(),
        )
        self.assertIn(
            "intrusion detection",
            statuses["syncan_intrusion_detection"]["purpose"].casefold(),
        )


if __name__ == "__main__":
    unittest.main()
