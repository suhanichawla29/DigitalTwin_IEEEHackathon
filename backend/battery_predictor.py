"""Inference for NASA battery discharge-capacity estimates."""

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
        self.lock = threading.RLock()
        self._load()

    def _load(self):
        if not self.model_path.is_file():
            self.error = None
            return
        try:
            artifact = joblib.load(self.model_path)
            model = artifact["model"]
            metadata = artifact["metadata"]
            if metadata.get("feature_names") != FEATURE_NAMES:
                raise ValueError("NASA model feature schema mismatch")
            if not callable(getattr(model, "predict", None)):
                raise ValueError("NASA artifact has no regression model")
            self.model = model
            self.metadata = metadata
            self.error = None
        except (
            OSError,
            EOFError,
            ImportError,
            KeyError,
            TypeError,
            ValueError,
            AttributeError,
        ) as error:
            self.error = f"Could not load NASA model: {error}"

    def status(self):
        return {
            "model_type": "RandomForestRegressor",
            "purpose": "NASA discharge capacity and capacity-derived SOH estimation",
            "input_domain": "complete NASA discharge-cycle sensor arrays",
            "artifact_path": str(self.model_path),
            "metadata": self.metadata,
            "load_error": self.error,
        }

    def estimate(self, data):
        if self.model is None:
            raise RuntimeError(self.error or "NASA capacity model is not trained.")
        features = discharge_features(data)
        vector = np.asarray(
            [[features[name] for name in FEATURE_NAMES]],
            dtype=float,
        )
        with self.lock:
            capacity = float(self.model.predict(vector)[0])
        return {
            "capacity_ah": capacity,
            "capacity_soh_percent": capacity / RATED_CAPACITY_AH * 100.0,
            "rated_capacity_ah": RATED_CAPACITY_AH,
            "model_type": "RandomForestRegressor",
            "target": "NASA discharge Capacity in Ah",
        }
