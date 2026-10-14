"""Train and evaluate a NASA battery discharge-capacity regressor."""

import argparse
from pathlib import Path

import joblib
import numpy as np
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import LeaveOneGroupOut

from training.prepare_nasa_data import (
    FEATURE_NAMES,
    RATED_CAPACITY_AH,
    load_battery_runs,
)

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_DIR / "data" / "nasa"
MODEL_PATH = BACKEND_DIR / "models" / "nasa_capacity.joblib"


def train(input_dir=DATA_DIR, output_path=MODEL_PATH, seed=2026):
    paths = sorted(Path(input_dir).glob("*.mat"))
    if not paths:
        raise FileNotFoundError(
            f"No NASA .mat battery runs found in {input_dir}. "
            "See backend/data/README.md."
        )
    samples = list(load_battery_runs(paths))
    batteries = sorted({sample["battery_id"] for sample in samples})
    if len(batteries) < 2:
        raise ValueError(
            "At least two valid battery runs are required for held-out-run evaluation."
        )

    x = np.asarray([
        [sample["features"][name] for name in FEATURE_NAMES]
        for sample in samples
    ], dtype=float)
    y = np.asarray([sample["capacity_ah"] for sample in samples], dtype=float)
    groups = np.asarray([sample["battery_id"] for sample in samples])
    predictions = np.full(len(y), np.nan)
    baseline_predictions = np.full(len(y), np.nan)
    folds = []

    for train_indices, test_indices in LeaveOneGroupOut().split(x, y, groups):
        model = RandomForestRegressor(
            n_estimators=200,
            min_samples_leaf=2,
            random_state=seed,
            n_jobs=1,
        )
        model.fit(x[train_indices], y[train_indices])
        predictions[test_indices] = model.predict(x[test_indices])

        baseline = DummyRegressor(strategy="median")
        baseline.fit(x[train_indices], y[train_indices])
        baseline_predictions[test_indices] = baseline.predict(x[test_indices])
        folds.append({
            "held_out_battery": str(groups[test_indices][0]),
            "cycles": int(len(test_indices)),
        })

    model = RandomForestRegressor(
        n_estimators=200,
        min_samples_leaf=2,
        random_state=seed,
        n_jobs=1,
    )
    model.fit(x, y)
    metrics = {
        "mae_ah": float(mean_absolute_error(y, predictions)),
        "rmse_ah": float(np.sqrt(mean_squared_error(y, predictions))),
        "r2": float(r2_score(y, predictions)),
        "median_baseline_mae_ah": float(
            mean_absolute_error(y, baseline_predictions)
        ),
    }
    artifact = {
        "model": model,
        "metadata": {
            "model_type": "RandomForestRegressor",
            "task": "NASA battery discharge capacity estimation",
            "target": "discharge Capacity in Ah",
            "feature_names": FEATURE_NAMES,
            "rated_capacity_ah_for_soh": RATED_CAPACITY_AH,
            "batteries": batteries,
            "discharge_cycles": int(len(y)),
            "evaluation": "leave-one-battery-run-out",
            "folds": folds,
            "metrics": metrics,
            "seed": seed,
            "source": "NASA Ames PCoE Li-ion Battery Aging Dataset",
        },
    }
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, output_path)
    loaded = joblib.load(output_path)
    if loaded["metadata"]["feature_names"] != FEATURE_NAMES:
        raise RuntimeError("Saved NASA model feature schema failed verification")
    if len(loaded["model"].predict(x[:1])) != 1:
        raise RuntimeError("Saved NASA model failed its reload prediction check")
    return artifact["metadata"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    metadata = train(args.input_dir, args.output, args.seed)
    print(
        f"Verified {args.output}: {metadata['discharge_cycles']} discharge "
        f"cycles from {len(metadata['batteries'])} battery runs."
    )
    print(f"Evaluation: {metadata['evaluation']}; metrics: {metadata['metrics']}")


if __name__ == "__main__":
    main()
