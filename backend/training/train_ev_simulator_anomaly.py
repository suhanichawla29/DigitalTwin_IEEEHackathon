"""Train and hold out-test an anomaly classifier on independent simulator episodes."""

import argparse
import json
import os
from pathlib import Path
import tempfile

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)

BACKEND_DIR = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(BACKEND_DIR))

from ev_simulator_predictor import (  # noqa: E402
    ARTIFACT_SOURCE,
    FEATURE_NAMES,
    frame_features,
)
from main import SIMULATION_SPEED, SimulationState, make_demo_frame  # noqa: E402
from can_decoder import decode_can_frame  # noqa: E402


MODEL_PATH = BACKEND_DIR / "models" / "ev_simulator_anomaly.joblib"
SCENARIOS = (
    "normal",
    "gradual_degradation",
    "severe_degradation",
    "low_voltage",
    "over_voltage",
    "over_current",
    "over_temperature",
    "multiple_faults",
)


def build_episode(scenario, episode_seed, samples_per_episode):
    """Generate one labelled episode through the same simulation and DBC path as live API data."""
    state = SimulationState(seed=episode_seed)
    state.select(scenario, ())
    features = []
    labels = []
    previous = None
    label = int(scenario != "normal")
    for sample_index in range(samples_per_episode):
        values = state.advance()
        payload = make_demo_frame(
            values["voltage"],
            values["current"],
            values["temperature"],
        )
        decoded = decode_can_frame(0x100, payload)
        if decoded["decode_status"] != "decoded":
            raise RuntimeError(
                "Training episode did not decode through the project DBC: "
                + decoded.get("error", "unknown decoder error")
            )
        frame = {
            **decoded,
            "timestamp": sample_index * 2.0,
        }
        vector, current = frame_features(frame, previous)
        previous = current
        if sample_index:
            features.append(vector[0])
            labels.append(label)
    return np.asarray(features, dtype=float), np.asarray(labels, dtype=int)


def _dataset(
    episodes_per_scenario,
    samples_per_episode,
    seed_offset,
    normal_episode_multiplier,
):
    feature_batches = []
    label_batches = []
    episode_labels = []
    sample_scenarios = []
    episode_index = 0
    for scenario_index, scenario in enumerate(SCENARIOS):
        scenario_episode_count = episodes_per_scenario * (
            normal_episode_multiplier if scenario == "normal" else 1
        )
        for episode_number in range(scenario_episode_count):
            episode_seed = seed_offset + scenario_index * 100_000 + episode_number
            features, labels = build_episode(
                scenario,
                episode_seed,
                samples_per_episode,
            )
            feature_batches.append(features)
            label_batches.append(labels)
            episode_labels.append(scenario)
            sample_scenarios.extend([scenario] * len(labels))
            episode_index += 1
    return (
        np.concatenate(feature_batches),
        np.concatenate(label_batches),
        episode_labels,
        sample_scenarios,
        episode_index,
    )


def _metrics(actual, predicted):
    matrix = confusion_matrix(actual, predicted, labels=[0, 1])
    return {
        "accuracy": float(accuracy_score(actual, predicted)),
        "precision": float(precision_score(actual, predicted, zero_division=0)),
        "recall": float(recall_score(actual, predicted, zero_division=0)),
        "f1": float(f1_score(actual, predicted, zero_division=0)),
        "confusion_matrix_labels": ["normal", "injected_non_normal"],
        "confusion_matrix": matrix.tolist(),
        "false_positives": int(matrix[0, 1]),
        "missed_injected_non_normal": int(matrix[1, 0]),
        "true_negatives": int(matrix[0, 0]),
        "true_positives": int(matrix[1, 1]),
    }


def train(
    output_path=MODEL_PATH,
    train_episodes_per_scenario=20,
    validation_episodes_per_scenario=6,
    samples_per_episode=140,
    random_state=34_911,
):
    if train_episodes_per_scenario < 1 or validation_episodes_per_scenario < 1:
        raise ValueError("Training and validation must each contain complete episodes.")
    if samples_per_episode < 2:
        raise ValueError("Each episode must contain at least two CAN frames.")

    (
        x_train,
        y_train,
        train_scenarios,
        _,
        train_episode_count,
    ) = _dataset(
        train_episodes_per_scenario,
        samples_per_episode,
        seed_offset=100_000,
        normal_episode_multiplier=7,
    )
    (
        x_validation,
        y_validation,
        validation_scenarios,
        validation_sample_scenarios,
        validation_episode_count,
    ) = _dataset(
        validation_episodes_per_scenario,
        samples_per_episode,
        seed_offset=900_000,
        normal_episode_multiplier=7,
    )

    model = RandomForestClassifier(
        n_estimators=160,
        min_samples_leaf=3,
        class_weight="balanced_subsample",
        random_state=random_state,
        n_jobs=1,
    )
    model.fit(x_train, y_train)
    validation_predictions = model.predict(x_validation)

    per_scenario_metrics = {}
    for scenario in SCENARIOS:
        mask = np.asarray(validation_sample_scenarios) == scenario
        per_scenario_metrics[scenario] = _metrics(
            y_validation[mask],
            validation_predictions[mask],
        )

    metadata = {
        "source": ARTIFACT_SOURCE,
        "model_type": "RandomForestClassifier",
        "target": (
            "Known simulator episode label: normal=0; any explicitly selected "
            "degradation/fault scenario=1. This is not a real-vehicle fault label."
        ),
        "generation": (
            "Independent seeded SimulationState episodes; each telemetry sample "
            "is encoded as DBC ECU_Telemetry CAN ID 0x100 and decoded before "
            "feature extraction. Train and validation use disjoint episode seeds."
        ),
        "can_frame": {
            "can_id": "0x100",
            "message_name": "ECU_Telemetry",
            "source_ecu": "ECU",
            "decoded_signals": ["Voltage", "Current", "Temperature"],
        },
        "feature_names": FEATURE_NAMES,
        "feature_units": {
            "Voltage": "V",
            "Current": "A",
            "Temperature": "degC",
            "delta_time_seconds": "s",
            "Voltage_delta": "V per sample",
            "Current_delta": "A per sample",
            "Temperature_delta": "degC per sample",
        },
        "simulation_speed": SIMULATION_SPEED,
        "seed": random_state,
        "train_episodes_per_scenario": train_episodes_per_scenario,
        "validation_episodes_per_scenario": validation_episodes_per_scenario,
        "normal_episode_multiplier": 7,
        "samples_per_episode": samples_per_episode,
        "train_episode_count": train_episode_count,
        "validation_episode_count": validation_episode_count,
        "train_scenario_counts": {
            scenario: train_scenarios.count(scenario) for scenario in SCENARIOS
        },
        "validation_scenario_counts": {
            scenario: validation_scenarios.count(scenario) for scenario in SCENARIOS
        },
        "train_sample_count": int(len(y_train)),
        "validation_sample_count": int(len(y_validation)),
        "train_label_counts": {
            "normal": int(np.sum(y_train == 0)),
            "injected_non_normal": int(np.sum(y_train == 1)),
        },
        "validation_label_counts": {
            "normal": int(np.sum(y_validation == 0)),
            "injected_non_normal": int(np.sum(y_validation == 1)),
        },
        "validation_episode_split": "whole episodes; no episode shared with training",
        "evaluation": _metrics(y_validation, validation_predictions),
        "per_scenario_validation": per_scenario_metrics,
    }

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=target.name + ".",
            suffix=".tmp",
            dir=target.parent,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
        joblib.dump({"model": model, "metadata": metadata}, temporary_path)
        os.replace(temporary_path, target)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    parser.add_argument("--train-episodes-per-scenario", type=int, default=20)
    parser.add_argument("--validation-episodes-per-scenario", type=int, default=6)
    parser.add_argument("--samples-per-episode", type=int, default=140)
    parser.add_argument("--random-state", type=int, default=34_911)
    args = parser.parse_args()
    metadata = train(
        args.output,
        args.train_episodes_per_scenario,
        args.validation_episodes_per_scenario,
        args.samples_per_episode,
        args.random_state,
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
