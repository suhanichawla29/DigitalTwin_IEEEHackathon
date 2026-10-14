from collections import deque
from pathlib import Path
import threading

import joblib
import numpy as np

WINDOW_SIZE = 30
HORIZON_SECONDS = 300
SAMPLE_INTERVAL_SECONDS = 2
FEATURE_NAMES = [
    "voltage_latest",
    "voltage_mean",
    "voltage_std",
    "voltage_slope",
    "voltage_range",
    "voltage_delta",
    "current_latest",
    "current_mean",
    "current_std",
    "current_slope",
    "current_range",
    "current_delta",
    "temperature_latest",
    "temperature_mean",
    "temperature_std",
    "temperature_slope",
    "temperature_range",
    "temperature_delta",
    "current_per_voltage",
    "temperature_per_current",
]
MODEL_PATH = Path(__file__).resolve().parent / "models" / "failure_model.joblib"


def extract_features(readings):
    """Extract the shared fixed-schema feature vector from 30 readings."""
    if len(readings) != WINDOW_SIZE:
        raise ValueError(f"Expected exactly {WINDOW_SIZE} readings")

    signals = {
        name: np.asarray([float(row[name]) for row in readings], dtype=float)
        for name in ("voltage", "current", "temperature")
    }
    features = []
    for name in ("voltage", "current", "temperature"):
        values = signals[name]
        features.extend([
            values[-1],
            float(np.mean(values)),
            float(np.std(values)),
            float(np.polyfit(np.arange(WINDOW_SIZE), values, 1)[0]),
            float(np.max(values) - np.min(values)),
            float(values[-1] - values[0]),
        ])

    # Cross-signal ratios make concurrent changes visible to the classifier.
    features.extend([
        float(signals["current"][-1] / max(abs(signals["voltage"][-1]), 1.0)),
        float(
            signals["temperature"][-1] /
            max(abs(signals["current"][-1]), 1.0)
        ),
    ])
    return np.asarray(features, dtype=float)


class FailurePredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = Path(model_path)
        self.history = deque(maxlen=WINDOW_SIZE)
        self._lock = threading.RLock()
        self.model = None
        self.model_error = None
        self.metadata = {}
        self._load_model()

    def _load_model(self):
        if not self.model_path.is_file():
            self.model_error = "Trained model file is not present."
            return

        try:
            artifact = joblib.load(self.model_path)
            model = artifact["model"]
            metadata = artifact["metadata"]
            if metadata.get("feature_names") != FEATURE_NAMES:
                raise ValueError("Trained model feature schema does not match.")
            self.model = model
            self.metadata = metadata
            self.model_error = None
        except (OSError, KeyError, TypeError, ValueError, AttributeError) as error:
            self.model_error = f"Unable to load trained model: {error}"

    def reset(self):
        with self._lock:
            self.history.clear()

    def add_reading(self, reading):
        with self._lock:
            self.history.append({
                "voltage": float(reading["voltage"]),
                "current": float(reading["current"]),
                "temperature": float(reading["temperature"]),
            })
            count = len(self.history)
            common = {
                "model_status": (
                    "unavailable" if self.model is None
                    else "warming_up" if count < WINDOW_SIZE
                    else "ready"
                ),
                "history_count": count,
                "history_required": WINDOW_SIZE,
                "failure_probability": None,
                "forecast_horizon_seconds": HORIZON_SECONDS,
            }
            if self.model is None or count < WINDOW_SIZE:
                return common

            vector = extract_features(list(self.history)).reshape(1, -1)
            probability = float(self.model.predict_proba(vector)[0][1])
            common["failure_probability"] = probability
            return common
