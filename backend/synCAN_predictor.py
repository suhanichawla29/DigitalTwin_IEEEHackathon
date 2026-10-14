"""Unsupervised SynCAN per-ID intrusion detector and input validation."""

from pathlib import Path
import threading

import joblib
import numpy as np

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
MODEL_PATH = Path(__file__).resolve().parent / "models" / "synCAN_isolation_forest.joblib"


def feature_names_for_id(can_id):
    if can_id not in SIGNAL_COUNTS:
        raise ValueError(f"Unknown SynCAN ID {can_id!r}")
    count = SIGNAL_COUNTS[can_id]
    return (
        ["delta_time_ms"] +
        [f"Signal{index}_of_ID" for index in range(1, count + 1)] +
        [f"Signal{index}_delta" for index in range(1, count + 1)]
    )


def record_features(record, previous=None):
    can_id = str(record.get("ID", "")).strip().casefold()
    names = feature_names_for_id(can_id)
    time_ms = float(record["Time"])
    count = SIGNAL_COUNTS[can_id]
    signals = []
    for index in range(1, count + 1):
        key = f"Signal{index}_of_ID"
        value = float(record[key])
        if not np.isfinite(value):
            raise ValueError(f"{key} must be finite")
        signals.append(value)

    if not np.isfinite(time_ms):
        raise ValueError("Time must be finite milliseconds")
    prior_time = previous.get("time_ms") if previous else None
    if prior_time is not None and time_ms < prior_time:
        raise ValueError("Time must be nondecreasing within a SynCAN stream")
    delta_time = time_ms - prior_time if prior_time is not None else 0.0
    prior_signals = previous.get("signals", []) if previous else []
    deltas = [
        value - prior_signals[index]
        if index < len(prior_signals) else 0.0
        for index, value in enumerate(signals)
    ]
    vector = np.asarray([[delta_time, *signals, *deltas]], dtype=float)
    if vector.shape[1] != len(names):
        raise ValueError(f"Unexpected signal schema for {can_id}")
    return can_id, vector, {"time_ms": time_ms, "signals": signals}


class SynCANPredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = Path(model_path)
        self.models = {}
        self.metadata = {}
        self.error = None
        self._lock = threading.RLock()
        self._previous = {}
        self._load()

    def _load(self):
        if not self.model_path.is_file():
            self.error = "SynCAN model has not been trained."
            return
        try:
            artifact = joblib.load(self.model_path)
            models = artifact["models"]
            metadata = artifact["metadata"]
            for can_id, model in models.items():
                if metadata["feature_names_by_id"][can_id] != feature_names_for_id(can_id):
                    raise ValueError(f"SynCAN model feature schema mismatch for {can_id}")
            self.models = models
            self.metadata = metadata
            self.error = None
        except (OSError, KeyError, TypeError, ValueError, AttributeError) as error:
            self.error = f"Could not load SynCAN model: {error}"

    def status(self):
        return {
            "status": "ready" if self.models else "unavailable",
            "model_type": "per-ID StandardScaler + IsolationForest",
            "purpose": "unsupervised SynCAN CAN intrusion detection",
            "input_domain": "SynCAN ID and dataset signal fields; not the project DBC frame",
            "error": self.error,
            "metadata": self.metadata,
        }

    def reset(self):
        with self._lock:
            self._previous.clear()

    def score(self, record):
        if not self.models:
            raise RuntimeError(self.error or "SynCAN model is unavailable")
        with self._lock:
            can_id, vector, current = record_features(
                record,
                self._previous.get(str(record.get("ID", "")).strip().casefold()),
            )
            model = self.models.get(can_id)
            if model is None:
                raise ValueError(f"No trained SynCAN model exists for {can_id}")
            self._previous[can_id] = current
            label = int(model.predict(vector)[0])
            score = float(model.decision_function(vector)[0])
        return {
            "ID": can_id,
            "is_anomaly": label == -1,
            "decision_score": score,
            "model_type": "IsolationForest",
            "label_semantics": "anomaly flag; not a failure probability",
        }
