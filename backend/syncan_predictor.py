"""Inference and feature validation for per-ID SynCAN anomaly models."""

from pathlib import Path
import pickle
import threading

import joblib
import numpy as np

MODEL_PATH = Path(__file__).resolve().parent / "models" / "synCAN_isolation_forest.joblib"
SIGNAL_COUNTS = {
    "id1": 2,
    "id2": 3,
    "id3": 2,
    "id4": 1,
    "id5": 2,
    "id6": 2,
    "id7": 2,
    "id8": 1,
    "id9": 1,
    "id10": 4,
}


def feature_names(can_id):
    if can_id not in SIGNAL_COUNTS:
        raise ValueError(f"Unknown SynCAN ID {can_id!r}")
    count = SIGNAL_COUNTS[can_id]
    return (
        ["delta_time_ms"]
        + [f"Signal{index}_of_ID" for index in range(1, count + 1)]
        + [f"Signal{index}_delta" for index in range(1, count + 1)]
    )


def record_features(record, previous=None):
    can_id = str(record.get("ID", "")).strip().casefold()
    names = feature_names(can_id)
    timestamp = float(record["Time"])
    signals = [
        float(record[f"Signal{index}_of_ID"])
        for index in range(1, SIGNAL_COUNTS[can_id] + 1)
    ]
    if not np.isfinite(timestamp) or not np.isfinite(signals).all():
        raise ValueError("SynCAN timestamp and signals must be finite numbers")

    previous = previous or {}
    previous_time = previous.get("time_ms")
    if previous_time is not None and timestamp < previous_time:
        raise ValueError("SynCAN Time must be nondecreasing within an ID stream")
    delta_time = timestamp - previous_time if previous_time is not None else 0.0
    previous_signals = previous.get("signals", [])
    deltas = [
        value - previous_signals[index]
        if index < len(previous_signals) else 0.0
        for index, value in enumerate(signals)
    ]
    vector = np.asarray([[delta_time, *signals, *deltas]], dtype=float)
    if vector.shape[1] != len(names):
        raise ValueError(f"Unexpected signal schema for {can_id}")
    return can_id, vector, {"time_ms": timestamp, "signals": signals}


class SynCANPredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = Path(model_path)
        self.models = {}
        self.metadata = {}
        self.error = None
        self.previous = {}
        self.lock = threading.RLock()
        self._load()

    def _load(self):
        if not self.model_path.is_file():
            return
        try:
            artifact = joblib.load(self.model_path)
            models = artifact["models"]
            metadata = artifact["metadata"]
            expected_ids = set(SIGNAL_COUNTS)
            if set(models) != expected_ids:
                raise ValueError("SynCAN model artifact is missing one or more IDs")
            if metadata["source"] != "ETAS SynCAN dataset":
                raise ValueError("SynCAN model artifact has an unknown data source")
            if metadata["training_labels_used"] != "Label=0 rows only":
                raise ValueError("SynCAN model was not fitted on normal-only rows")
            for can_id in expected_ids:
                if metadata["feature_names_by_id"][can_id] != feature_names(can_id):
                    raise ValueError(f"SynCAN feature schema mismatch for {can_id}")
                model = models[can_id]
                steps = getattr(model, "named_steps", {})
                if (
                    list(steps) != ["standardscaler", "isolationforest"] or
                    model.n_features_in_ != len(feature_names(can_id))
                ):
                    raise ValueError(
                        f"SynCAN preprocessing/model schema mismatch for {can_id}"
                    )
            self.models = models
            self.metadata = metadata
            self.error = None
        except (
            OSError,
            EOFError,
            ImportError,
            pickle.UnpicklingError,
            KeyError,
            TypeError,
            ValueError,
            AttributeError,
        ) as error:
            self.error = f"Could not load SynCAN model: {error}"

    def reload(self):
        """Retry loading an artifact that became available after startup."""
        with self.lock:
            self._load()
            return bool(self.models)

    def status(self):
        return {
            "model_type": "per-ID StandardScaler + IsolationForest",
            "purpose": "unsupervised SynCAN CAN intrusion detection",
            "input_domain": (
                "SynCAN ID and dataset signal fields; not project DBC frames"
            ),
            "artifact_path": str(self.model_path),
            "metadata": self.metadata,
            "load_error": self.error,
        }

    def reset(self):
        with self.lock:
            self.previous.clear()

    def score(self, record):
        if not self.models:
            raise RuntimeError(self.error or "SynCAN model is not trained.")
        with self.lock:
            can_id = str(record.get("ID", "")).strip().casefold()
            if can_id not in self.models:
                raise ValueError(f"No trained SynCAN model exists for {can_id!r}")
            can_id, vector, current = record_features(
                record,
                self.previous.get(can_id),
            )
            model = self.models[can_id]
            self.previous[can_id] = current
            label = int(model.predict(vector)[0])
            score = float(model.decision_function(vector)[0])
        return {
            "ID": can_id,
            "is_anomaly": label == -1,
            "decision_score": score,
            "model_type": "IsolationForest",
            "label_semantics": "anomaly flag and decision score, not a probability",
        }
