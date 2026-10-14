"""Inference service for discharge-cycle capacity estimates from NASA data."""

from pathlib import Path
import threading

import joblib
import numpy as np

from training.prepare_nasa_data import (
    FEATURE_NAMES,
    RATED_CAPACITY_AH,
    discharge_features,
)

MODEL_PATH = Path(__file__).resolve().parent / "models" / "nasa_capacity.joblib"


class BatteryCapacityPredictor:
    def __init__(self, model_path=MODEL_PATH):
        self.model_path = Path(model_path)
        self.model = None
        self.metadata = {}
        self.error = None
        self._lock = threading.RLock()
        self._load()

    def _load(self):
        if not self.model_path.is_file():
            self.error = "NASA capacity model has not been trained."
            return
        try:
            artifact = joblib.load(self.model_path)
            metadata = artifact["metadata"]
            model = artifact["model"]
            if metadata.get("feature_names") != FEATURE_NAMES:
                raise ValueError("NASA model feature schema mismatch")
            self.model = model
            self.metadata = metadata
            self.error = None
        except (OSError, KeyError, TypeError, ValueError, AttributeError) as error:
            self.error = f"Could not load NASA capacity model: {error}"

    def status(self):
        return {
            "status": "ready" if self.model is not None else "unavailable",
            "model_type": "RandomForestRegressor",
            "purpose": "NASA discharge capacity and capacity-derived SOH estimation",
            "input_domain": "complete discharge-cycle time series, not live point telemetry",
            "error": self.error,
            "metadata": self.metadata,
        }

    def estimate(self, data):
        if self.model is None:
            raise RuntimeError(self.error or "NASA capacity model is unavailable")
        features = discharge_features(data)
        vector = np.asarray(
            [[features[name] for name in FEATURE_NAMES]],
            dtype=float,
        )
        with self._lock:
            capacity_ah = float(self.model.predict(vector)[0])
        return {
            "capacity_ah": capacity_ah,
            "capacity_soh_percent": capacity_ah / RATED_CAPACITY_AH * 100.0,
            "rated_capacity_ah": RATED_CAPACITY_AH,
            "model_type": "RandomForestRegressor",
            "target": "NASA discharge Capacity in Ah",
            "source": "NASA PCoE battery aging model",
        }
