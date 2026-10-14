"""Train and evaluate the synthetic five-minute failure predictor."""

import argparse
from pathlib import Path
import random

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, confusion_matrix, precision_score, recall_score
from sklearn.model_selection import GroupShuffleSplit

from predictor import (
    FEATURE_NAMES,
    HORIZON_SECONDS,
    SAMPLE_INTERVAL_SECONDS,
    WINDOW_SIZE,
    extract_features,
)

FAULT_LIMITS = {
    "low_voltage": ("voltage", -1, 270.0),
    "over_voltage": ("voltage", 1, 465.0),
    "over_current": ("current", 1, 120.0),
    "over_temperature": ("temperature", 1, 95.0),
}
FAULT_OPTIONS = list(FAULT_LIMITS)


def generate_episode(episode_id, rng, length=420):
    baselines = {
        "voltage": rng.uniform(397.0, 403.0),
        "current": rng.uniform(33.0, 37.0),
        "temperature": rng.uniform(43.0, 47.0),
    }
    noise = {"voltage": 0.55, "current": 0.4, "temperature": 0.2}
    values = dict(baselines)
    readings = []
    selected = ()
    outcome = rng.random()
    if outcome >= 0.25:
        count = 1 if outcome < 0.65 else rng.randint(2, 3)
        selected = tuple(rng.sample(FAULT_OPTIONS, count))
        if "low_voltage" in selected and "over_voltage" in selected:
            selected = tuple(f for f in selected if f != "over_voltage")

    onset = rng.randint(25, 100) if selected else None
    rates = {}
    failure_index = None
    if selected:
        for fault in selected:
            signal, direction, _ = FAULT_LIMITS[fault]
            rate_min, rate_max = {
                "voltage": (0.55, 1.2) if direction < 0 else (0.35, 0.8),
                "current": (0.35, 1.05),
                "temperature": (0.2, 0.6),
            }[signal]
            rates[signal] = direction * rng.uniform(rate_min, rate_max)

        crossing_steps = []
        for fault in selected:
            signal, direction, threshold = FAULT_LIMITS[fault]
            rate = rates[signal]
            crossing_steps.append(max(
                1,
                int(np.ceil((threshold - baselines[signal]) / rate)),
            ))
        failure_index = onset + min(crossing_steps)
        if failure_index >= length:
            failure_index = None

    for index in range(length):
        for signal in values:
            active_rate = rates.get(signal, 0.0) if onset is not None and index >= onset else 0.0
            values[signal] += active_rate
        readings.append({
            signal: round(
                values[signal] + rng.gauss(0, noise[signal]),
                2,
            )
            for signal in values
        })

    features, labels = [], []
    for end in range(WINDOW_SIZE - 1, length - 1, 3):
        window = readings[end - WINDOW_SIZE + 1:end + 1]
        label = int(
            failure_index is not None
            and end < failure_index <= end + HORIZON_SECONDS // SAMPLE_INTERVAL_SECONDS
        )
        features.append(extract_features(window))
        labels.append(label)
    return np.asarray(features), np.asarray(labels), episode_id


def train(episodes=180, seed=2026, output_path=None):
    rng = random.Random(seed)
    all_features, all_labels, groups = [], [], []
    for episode_id in range(episodes):
        features, labels, group = generate_episode(episode_id, rng)
        all_features.append(features)
        all_labels.append(labels)
        groups.extend([group] * len(labels))

    x = np.vstack(all_features)
    y = np.concatenate(all_labels)
    groups = np.asarray(groups)
    splitter = GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=seed)
    train_indices, test_indices = next(splitter.split(x, y, groups))
    model = RandomForestClassifier(
        n_estimators=120,
        min_samples_leaf=3,
        class_weight="balanced_subsample",
        random_state=seed,
        n_jobs=1,
    )
    model.fit(x[train_indices], y[train_indices])
    probabilities = model.predict_proba(x[test_indices])[:, 1]
    predictions = (probabilities >= 0.5).astype(int)
    precision = precision_score(y[test_indices], predictions, zero_division=0)
    recall = recall_score(y[test_indices], predictions, zero_division=0)
    pr_auc = average_precision_score(y[test_indices], probabilities)
    true_negative, false_alarm, missed_failure, _ = confusion_matrix(
        y[test_indices],
        predictions,
        labels=[0, 1],
    ).ravel()
    metadata = {
        "model_type": "RandomForestClassifier",
        "training_data": "synthetic labelled simulation episodes",
        "synthetic_failure_thresholds": {
            fault: limit for fault, (_, _, limit) in FAULT_LIMITS.items()
        },
        "seed": seed,
        "episode_count": episodes,
        "window_count": int(len(y)),
        "positive_window_count": int(np.sum(y)),
        "window_size": WINDOW_SIZE,
        "sampling_interval_seconds": SAMPLE_INTERVAL_SECONDS,
        "forecast_horizon_seconds": HORIZON_SECONDS,
        "feature_names": FEATURE_NAMES,
        "test_episode_count": len(np.unique(groups[test_indices])),
        "metrics": {
            "precision": float(precision),
            "recall": float(recall),
            "pr_auc": float(pr_auc),
            "false_alarms": int(false_alarm),
            "missed_failures": int(missed_failure),
            "true_negatives": int(true_negative),
        },
    }
    output_path = Path(output_path) if output_path else (
        Path(__file__).resolve().parent / "models" / "failure_model.joblib"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "metadata": metadata}, output_path)
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes", type=int, default=180)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.episodes < 8:
        parser.error("--episodes must be at least 8 for episode-level evaluation")
    result = train(args.episodes, args.seed, args.output)
    print(
        f"Dataset: {result['window_count']} windows "
        f"({result['positive_window_count']} positive) from "
        f"{result['episode_count']} episodes"
    )
    print(f"Evaluation episodes: {result['test_episode_count']}")
    for name, value in result["metrics"].items():
        print(f"{name}: {value}")
