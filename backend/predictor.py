"""Synthetic-data failure prediction shared by model training and inference."""

from collections import deque
from pathlib import Path
import math
import threading

WINDOW_SIZE = 30
HORIZON_SECONDS = 300
SAMPLE_INTERVAL_SECONDS = 2
MODEL_PATH = Path(__file__).with_name("models") / "failure_predictor.joblib"
MODEL_NAME = "Synthetic episode failure predictor"
MODEL_VERSION = "synthetic-rf-v2"

SIGNALS = ("voltage", "current", "temperature")
STATISTICS = (
    "latest",
    "mean",
    "std",
    "min",
    "max",
    "slope",
    "delta",
    "recent_slope",
    "mean_abs_change",
)
FEATURE_SCHEMA = tuple(
    f"{signal}_{statistic}"
    for signal in SIGNALS
    for statistic in STATISTICS
) + (
    "voltage_current_correlation",
    "voltage_temperature_correlation",
    "current_temperature_correlation",
    "voltage_current_mean_ratio",
    "temperature_current_mean_ratio",
)


def _mean(values):
    return sum(values) / len(values)


def _std(values, mean):
    return math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))


def _slope(values):
    count = len(values)
    x_mean = (count - 1) / 2
    y_mean = _mean(values)
    denominator = sum((index - x_mean) ** 2 for index in range(count))

    if denominator == 0:
        return 0.0

    return sum(
        (index - x_mean) * (value - y_mean)
        for index, value in enumerate(values)
    ) / denominator


def _correlation(left, right):
    left_mean = _mean(left)
    right_mean = _mean(right)
    left_deviations = [value - left_mean for value in left]
    right_deviations = [value - right_mean for value in right]
    left_energy = sum(value ** 2 for value in left_deviations)
    right_energy = sum(value ** 2 for value in right_deviations)

    if left_energy == 0 or right_energy == 0:
        return 0.0

    return sum(
        left_value * right_value
        for left_value, right_value in zip(
            left_deviations,
            right_deviations,
        )
    ) / math.sqrt(left_energy * right_energy)


def extract_features(readings):
    """Extract the fixed-schema feature vector used by training and serving."""
    if len(readings) < WINDOW_SIZE:
        raise ValueError(
            f"At least {WINDOW_SIZE} readings are required for features"
        )

    window = list(readings)[-WINDOW_SIZE:]
    values_by_signal = {}
    features = {}

    for signal in SIGNALS:
        values = [float(reading[signal]) for reading in window]
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"Non-finite value in {signal} feature window")

        values_by_signal[signal] = values
        average = _mean(values)
        changes = [
            right - left
            for left, right in zip(values, values[1:])
        ]
        recent_start = max(0, len(values) - 10)

        features.update({
            f"{signal}_latest": values[-1],
            f"{signal}_mean": average,
            f"{signal}_std": _std(values, average),
            f"{signal}_min": min(values),
            f"{signal}_max": max(values),
            f"{signal}_slope": _slope(values),
            f"{signal}_delta": values[-1] - values[0],
            f"{signal}_recent_slope": _slope(values[recent_start:]),
            f"{signal}_mean_abs_change": (
                _mean([abs(change) for change in changes])
                if changes else 0.0
            ),
        })

    pairs = (
        ("voltage", "current"),
        ("voltage", "temperature"),
        ("current", "temperature"),
    )
    for left, right in pairs:
        features[f"{left}_{right}_correlation"] = _correlation(
            values_by_signal[left],
            values_by_signal[right],
        )

    voltage_mean = _mean(values_by_signal["voltage"])
    current_mean = _mean(values_by_signal["current"])
    temperature_mean = _mean(values_by_signal["temperature"])
    features["voltage_current_mean_ratio"] = (
        voltage_mean / current_mean if current_mean else 0.0
    )
    features["temperature_current_mean_ratio"] = (
        temperature_mean / current_mean if current_mean else 0.0
    )

    return {name: features[name] for name in FEATURE_SCHEMA}


class FailurePredictor:
    """Thread-safe rolling inference over the latest 30 CAN-decoded samples."""

    def __init__(self, model_path=MODEL_PATH):
        self.history = deque(maxlen=WINDOW_SIZE)
        self.lock = threading.RLock()
        self.model = None
        self.model_error = None
        self.metadata = {
            "name": MODEL_NAME,
            "version": MODEL_VERSION,
            "training_data": "synthetic_episodes",
            "feature_count": len(FEATURE_SCHEMA),
            "window_size": WINDOW_SIZE,
            "horizon_seconds": HORIZON_SECONDS,
        }
        self._load_model(model_path)

    def _load_model(self, model_path):
        try:
            import joblib

            bundle = joblib.load(model_path)
            if bundle.get("feature_schema") != list(FEATURE_SCHEMA):
                raise ValueError("Trained model feature schema does not match")
            if not hasattr(bundle.get("model"), "predict_proba"):
                raise ValueError("Trained model does not support probabilities")

            self.model = bundle["model"]
            self.metadata.update({
                "name": bundle.get("model_name", MODEL_NAME),
                "version": bundle.get("model_version", MODEL_VERSION),
                "training_episode_count": bundle.get(
                    "training_episode_count"
                ),
            })
        except (ImportError, OSError, ValueError, KeyError, AttributeError) as error:
            self.model_error = str(error)

    def reset(self):
        with self.lock:
            self.history.clear()

    def add_reading(self, reading):
        with self.lock:
            self.history.append({
                signal: float(reading[signal])
                for signal in SIGNALS
            })

            prediction = {
                "status": "unavailable" if self.model is None else "warming_up",
                "history_count": len(self.history),
                "window_size": WINDOW_SIZE,
                "failure_probability": None,
                "horizon_seconds": HORIZON_SECONDS,
                "sample_interval_seconds": SAMPLE_INTERVAL_SECONDS,
                "model": dict(self.metadata),
            }

            if self.model is None:
                prediction["message"] = (
                    "Train or load the synthetic model to enable predictions."
                )
                return prediction

            if len(self.history) < WINDOW_SIZE:
                prediction["message"] = (
                    f"Collecting readings ({len(self.history)}/{WINDOW_SIZE})."
                )
                return prediction

            features = extract_features(self.history)
            feature_row = [[features[name] for name in FEATURE_SCHEMA]]
            probabilities = self.model.predict_proba(feature_row)[0]
            classes = list(self.model.classes_)
            failure_index = classes.index(1)

            prediction.update({
                "status": "ready",
                "failure_probability": float(probabilities[failure_index]),
                "message": (
                    "Synthetic model estimate; not validated for real vehicles."
                ),
            })
            return prediction
