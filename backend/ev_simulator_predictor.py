"""Anomaly detection for the project's own DBC-decoded EV telemetry stream."""

from pathlib import Path
import pickle
import threading

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier

MODEL_PATH = (
    Path(__file__).resolve().parent
    / "models"
    / "ev_simulator_anomaly.joblib"
)
FEATURE_NAMES = [
    "Voltage",
    "Current",
    "Temperature",
    "delta_time_seconds",
    "Voltage_delta",
    "Current_delta",
    "Temperature_delta",
]
SIGNAL_NAMES = ("Voltage", "Current", "Temperature")
ARTIFACT_SOURCE = "project EV simulator DBC-encoded episodes"


def frame_features(frame, previous=None):
    """Build ordered classifier inputs from decoded DBC signals and timing."""
    if frame.get("decode_status") != "decoded":
        raise ValueError("EV anomaly features require a successfully decoded DBC frame")

    timestamp = float(frame["timestamp"])
    signal_values = {
        signal["name"]: float(signal["value"])
        for signal in frame.get("decoded_signals", [])
        if signal.get("name") in SIGNAL_NAMES
    }
    if set(signal_values) != set(SIGNAL_NAMES):
        raise ValueError(
            "EV DBC frame must contain decoded Voltage, Current, and Temperature"
        )
    values = [signal_values[name] for name in SIGNAL_NAMES]
    if not np.isfinite(timestamp) or not np.isfinite(values).all():
        raise ValueError("EV DBC timestamp and signals must be finite numbers")

    previous = previous or {}
    previous_time = previous.get("timestamp")
    previous_values = previous.get("values", [])
    if previous_time is not None and timestamp < previous_time:
        raise ValueError("EV CAN timestamps must be nondecreasing")
    delta_time = timestamp - previous_time if previous_time is not None else 0.0
    deltas = [
        value - previous_values[index]
        if index < len(previous_values) else 0.0
        for index, value in enumerate(values)
    ]
    vector = np.asarray([[*values, delta_time, *deltas]], dtype=float)
    if vector.shape[1] != len(FEATURE_NAMES):
        raise ValueError("Unexpected EV simulator anomaly feature schema")
    current = {"timestamp": timestamp, "values": values}
    return vector, current


class EVSimulatorAnomalyPredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = Path(model_path)
        self.model = None
        self.metadata = {}
        self.error = None
        self.previous = None
        self.lock = threading.RLock()
        self._load()

    def _load(self):
        if not self.model_path.is_file():
            return
        try:
            artifact = joblib.load(self.model_path)
            model = artifact["model"]
            metadata = artifact["metadata"]
            if metadata["source"] != ARTIFACT_SOURCE:
                raise ValueError("EV anomaly artifact has an unknown data source")
            if metadata["feature_names"] != FEATURE_NAMES:
                raise ValueError("EV anomaly artifact feature schema mismatch")
            if (
                not isinstance(model, RandomForestClassifier) or
                model.n_features_in_ != len(FEATURE_NAMES) or
                set(model.classes_) != {0, 1}
            ):
                raise ValueError("EV anomaly artifact model schema mismatch")
            self.model = model
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
            self.error = f"Could not load EV simulator anomaly model: {error}"

    def status(self):
        return {
            "status": (
                "ready" if self.model is not None
                else "load_error" if self.error
                else "not_trained"
            ),
            "model_type": "RandomForestClassifier",
            "source": ARTIFACT_SOURCE,
            "artifact_path": str(self.model_path),
            "input_domain": (
                "Project DBC ECU_Telemetry frame 0x100: decoded Voltage, "
                "Current, Temperature and per-sample changes"
            ),
            "feature_names": FEATURE_NAMES,
            "metadata": self.metadata,
            "load_error": self.error,
        }

    def reset(self):
        with self.lock:
            self.previous = None

    def reload(self):
        with self.lock:
            self._load()
            return self.model is not None

    def evaluate(self, frame, previous=None):
        """Evaluate one decoded project DBC frame without using SynCAN."""
        with self.lock:
            if frame.get("decode_status") != "decoded":
                return {
                    "status": "not_evaluated",
                    "source": ARTIFACT_SOURCE,
                    "reason": "DBC decoder did not produce a valid frame.",
                }
            if self.model is None:
                return {
                    "status": "model_unavailable",
                    "source": ARTIFACT_SOURCE,
                    "reason": self.error or (
                        "EV simulator anomaly model has not been trained."
                    ),
                }

            previous = self.previous if previous is None else previous
            vector, current = frame_features(frame, previous)
            self.previous = current
            if not self.metadata.get("feature_names"):
                return {
                    "status": "model_unavailable",
                    "source": ARTIFACT_SOURCE,
                    "reason": "EV simulator model feature metadata is unavailable.",
                }
            if vector.shape[1] != self.model.n_features_in_:
                raise ValueError("EV simulator model input feature count mismatch")
            if previous is None or vector[0, 3] <= 0:
                return {
                    "status": "warming_up",
                    "source": ARTIFACT_SOURCE,
                    "reason": "Waiting for a second timestamped DBC frame to calculate signal changes.",
                }

            label = int(self.model.predict(vector)[0])
            probabilities = self.model.predict_proba(vector)[0]
            classes = list(self.model.classes_)
            anomaly_score = float(probabilities[classes.index(1)])
            is_anomaly = label == 1
            return {
                "status": "evaluated",
                "source": ARTIFACT_SOURCE,
                "is_anomaly": is_anomaly,
                "anomaly_score": anomaly_score,
                "score_type": (
                    "classifier score for simulator-generated episode labels; "
                    "not a real-world probability"
                ),
                "reason": (
                    "Classifier detected a pattern associated with injected "
                    "non-normal simulator episodes."
                    if is_anomaly
                    else "Classifier matched the learned normal simulator pattern."
                ),
            }
