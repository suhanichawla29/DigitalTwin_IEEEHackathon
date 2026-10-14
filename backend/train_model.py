"""Train and evaluate a five-minute failure predictor on synthetic episodes."""

import argparse
from collections import Counter
import json
from pathlib import Path
import random

from predictor import (
    FEATURE_SCHEMA,
    HORIZON_SECONDS,
    MODEL_NAME,
    MODEL_VERSION,
    SAMPLE_INTERVAL_SECONDS,
    WINDOW_SIZE,
    extract_features,
)


def make_episode(rng, episode_id, length):
    baselines = {
        "voltage": rng.uniform(395, 405),
        "current": rng.uniform(32, 38),
        "temperature": rng.uniform(42, 48),
    }
    noise = {
        "voltage": rng.uniform(0.25, 0.85),
        "current": rng.uniform(0.15, 0.65),
        "temperature": rng.uniform(0.08, 0.3),
    }
    mode, active_faults = rng.choices(
        [
            ("normal", ()),
            ("gradual_over_current", ("over_current",)),
            ("gradual_over_temperature", ("over_temperature",)),
            ("gradual_under_voltage", ("low_voltage",)),
            ("gradual_over_voltage", ("over_voltage",)),
            (
                "combined_current_under_voltage",
                ("over_current", "low_voltage"),
            ),
            (
                "combined_current_over_voltage",
                ("over_current", "over_voltage"),
            ),
            (
                "combined_current_temperature",
                ("over_current", "over_temperature"),
            ),
            (
                "combined_under_voltage_current_temperature",
                ("low_voltage", "over_current", "over_temperature"),
            ),
            (
                "combined_over_voltage_current_temperature",
                ("over_voltage", "over_current", "over_temperature"),
            ),
        ],
        weights=[2, 4, 1, 1, 1, 2, 1, 2, 2, 2],
        k=1,
    )[0]
    failure_index = None
    onset = None
    rates = {
        "voltage": 0.0,
        "current": 0.0,
        "temperature": 0.0,
    }

    if active_faults:
        onset = rng.randint(5, min(100, length - 230))
        failure_index = min(
            length - 1,
            onset + rng.randint(80, 220),
        )
        if "low_voltage" in active_faults:
            rates["voltage"] = -rng.uniform(0.55, 1.25)
        elif "over_voltage" in active_faults:
            rates["voltage"] = rng.uniform(0.35, 0.8)
        if "over_current" in active_faults:
            rates["current"] = rng.uniform(0.35, 1.15)
        if "over_temperature" in active_faults:
            rates["temperature"] = rng.uniform(0.2, 0.65)

    values = dict(baselines)
    readings = []
    for index in range(length):
        if onset is not None and index >= onset:
            for signal in values:
                rate = rates[signal]
                values[signal] += rate + rng.gauss(0, abs(rate) * 0.06)
        elif mode == "normal":
            for signal in values:
                values[signal] += rng.gauss(0, noise[signal] * 0.015)

        readings.append({
            signal: values[signal] + rng.gauss(0, noise[signal])
            for signal in values
        })

    return episode_id, readings, failure_index, mode


def build_dataset(episodes=300, length=480, seed=20261014, stride=2):
    rng = random.Random(seed)
    feature_rows = []
    labels = []
    groups = []
    episode_modes = Counter()

    for episode_id in range(episodes):
        group, readings, failure_index, mode = make_episode(
            rng,
            episode_id,
            length,
        )
        episode_modes[mode] += 1

        for end_index in range(WINDOW_SIZE - 1, length, stride):
            window = readings[end_index - WINDOW_SIZE + 1:end_index + 1]
            features = extract_features(window)
            rows = [features[name] for name in FEATURE_SCHEMA]
            is_failure_soon = (
                failure_index is not None
                and 0 < failure_index - end_index
                <= HORIZON_SECONDS // SAMPLE_INTERVAL_SECONDS
            )

            feature_rows.append(rows)
            labels.append(int(is_failure_soon))
            groups.append(group)

    return feature_rows, labels, groups, episode_modes


def train(episodes=300, length=480, seed=20261014, output=None):
    try:
        import joblib
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.metrics import (
            average_precision_score,
            confusion_matrix,
            precision_score,
            recall_score,
        )
        from sklearn.model_selection import GroupShuffleSplit
    except ImportError as error:
        raise RuntimeError(
            "Install backend dependencies with "
            "`python -m pip install -r backend/requirements.txt`."
        ) from error

    feature_rows, labels, groups, episode_modes = build_dataset(
        episodes=episodes,
        length=length,
        seed=seed,
    )
    splitter = GroupShuffleSplit(
        n_splits=1,
        test_size=0.25,
        random_state=seed,
    )
    train_indices, test_indices = next(
        splitter.split(feature_rows, labels, groups)
    )

    model = RandomForestClassifier(
        n_estimators=120,
        min_samples_leaf=2,
        class_weight="balanced_subsample",
        random_state=seed,
        n_jobs=-1,
    )
    model.fit(
        [feature_rows[index] for index in train_indices],
        [labels[index] for index in train_indices],
    )

    test_features = [feature_rows[index] for index in test_indices]
    test_labels = [labels[index] for index in test_indices]
    failure_class_index = list(model.classes_).index(1)
    probabilities = model.predict_proba(test_features)[:, failure_class_index]
    predictions = (probabilities >= 0.5).astype(int)
    false_alarms, _, _, missed_failures = confusion_matrix(
        test_labels,
        predictions,
        labels=[0, 1],
    ).ravel()
    metrics = {
        "precision_at_0_5": float(precision_score(
            test_labels,
            predictions,
            zero_division=0,
        )),
        "recall_at_0_5": float(recall_score(
            test_labels,
            predictions,
            zero_division=0,
        )),
        "pr_auc": float(average_precision_score(
            test_labels,
            probabilities,
        )),
        "false_alarms_at_0_5": int(false_alarms),
        "missed_failures_at_0_5": int(missed_failures),
        "decision_threshold": 0.5,
        "evaluation_split": "complete episodes held out from training",
    }

    output_path = Path(output) if output else (
        Path(__file__).with_name("models") / "failure_predictor.joblib"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bundle = {
        "model": model,
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "feature_schema": list(FEATURE_SCHEMA),
        "window_size": WINDOW_SIZE,
        "horizon_seconds": HORIZON_SECONDS,
        "sample_interval_seconds": SAMPLE_INTERVAL_SECONDS,
        "random_seed": seed,
        "training_episode_count": episodes,
        "training_window_count": len(train_indices),
        "evaluation_window_count": len(test_indices),
        "metrics": metrics,
    }
    joblib.dump(bundle, output_path, compress=3)

    return {
        "model_path": str(output_path),
        "synthetic_data_only": True,
        "episode_count": episodes,
        "episode_types": dict(episode_modes),
        "dataset_windows": len(feature_rows),
        "positive_windows": sum(labels),
        "negative_windows": len(labels) - sum(labels),
        "training_windows": len(train_indices),
        "evaluation_windows": len(test_indices),
        "features": len(FEATURE_SCHEMA),
        "window_size": WINDOW_SIZE,
        "horizon_seconds": HORIZON_SECONDS,
        "metrics": metrics,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--episodes", type=int, default=300)
    parser.add_argument("--length", type=int, default=480)
    parser.add_argument("--seed", type=int, default=20261014)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.episodes < 8:
        parser.error("--episodes must be at least 8 for held-out episode evaluation")
    if args.length < 280:
        parser.error("episode length must be at least 280 readings")

    results = train(
        episodes=args.episodes,
        length=args.length,
        seed=args.seed,
        output=args.output,
    )
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
