"""Train a battery discharge capacity estimator on downloaded NASA PCoE runs."""

import argparse
from pathlib import Path
import sys

import joblib
import numpy as np
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import LeaveOneGroupOut

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from training.prepare_nasa_data import (
    FEATURE_NAMES,
    RATED_CAPACITY_AH,
    load_battery_runs,
)

DATA_DIR = BACKEND_DIR / "data" / "nasa"
MODEL_PATH = BACKEND_DIR / "models" / "nasa_capacity.joblib"


def train(input_dir=DATA_DIR, output_path=MODEL_PATH, seed=2026):
    paths = sorted(Path(input_dir).glob("*.mat"))
    if not paths:
        raise FileNotFoundError(
            f"No NASA .mat runs found in {input_dir}. See backend/data/README.md."
        )

    samples = list(load_battery_runs(paths))
    batteries = sorted({sample["battery_id"] for sample in samples})
    if len(batteries) < 2:
        raise ValueError(
            "At least two complete battery runs are required for held-out-battery evaluation."
        )

    x = np.asarray([
        [sample["features"][name] for name in FEATURE_NAMES]
        for sample in samples
    ], dtype=float)
    y = np.asarray([sample["capacity_ah"] for sample in samples], dtype=float)
    groups = np.asarray([sample["battery_id"] for sample in samples])

    predictions = np.full(len(y), np.nan)
    baseline_predictions = np.full(len(y), np.nan)
    split_summary = []
    splitter = LeaveOneGroupOut()
    for train_idx, test_idx in splitter.split(x, y, groups):
        model = RandomForestRegressor(
            n_estimators=250,
            min_samples_leaf=2,
            random_state=seed,
            n_jobs=1,
        )
        model.fit(x[train_idx], y[train_idx])
        predictions[test_idx] = model.predict(x[test_idx])

        baseline = DummyRegressor(strategy="median")
        baseline.fit(x[train_idx], y[train_idx])
        baseline_predictions[test_idx] = baseline.predict(x[test_idx])
        split_summary.append({
            "held_out_battery": str(groups[test_idx][0]),
            "test_cycles": int(len(test_idx)),
        })

    model = RandomForestRegressor(
        n_estimators=250,
        min_samples_leaf=2,
        random_state=seed,
        n_jobs=1,
    )
    model.fit(x, y)

    metrics = {
        "mae_ah": float(mean_absolute_error(y, predictions)),
        "rmse_ah": float(np.sqrt(mean_squared_error(y, predictions))),
        "r2": float(r2_score(y, predictions)),
        "median_baseline_mae_ah": float(mean_absolute_error(y, baseline_predictions)),
    }
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    artifact = {
        "model": model,
        "metadata": {
            "model_type": "RandomForestRegressor",
            "task": "NASA battery discharge capacity estimation",
            "target": "discharge Capacity in Ah",
            "rated_capacity_ah_for_soh": RATED_CAPACITY_AH,
            "feature_names": FEATURE_NAMES,
            "batteries": batteries,
            "discharge_cycles": int(len(y)),
            "split": "leave-one-battery-run-out",
            "held_out_battery_folds": split_summary,
            "metrics": metrics,
            "seed": seed,
            "source": "NASA Ames PCoE Li-ion Battery Aging Dataset",
        },
    }
    joblib.dump(artifact, output_path)
    verified = joblib.load(output_path)
    if verified["metadata"]["feature_names"] != FEATURE_NAMES:
        raise RuntimeError("Saved NASA model feature schema failed verification")
    if len(verified["model"].predict(x[:1])) != 1:
        raise RuntimeError("Saved NASA model failed a reload prediction check")
    return artifact["metadata"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    result = train(args.input_dir, args.output, args.seed)
    print(
        f"Trained on {result['discharge_cycles']} discharge cycles "
        f"from {len(result['batteries'])} batteries."
    )
    print(f"Evaluation split: {result['split']}")
    for name, value in result["metrics"].items():
        print(f"{name}: {value}")
