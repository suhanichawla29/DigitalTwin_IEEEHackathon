"""Fit per-ID unsupervised CAN detectors and evaluate official SynCAN labels."""

import argparse
import csv
from pathlib import Path
import random
import sys
import zipfile

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import confusion_matrix, f1_score, precision_score, recall_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from synCAN_predictor import (
    MODEL_PATH,
    SIGNAL_COUNTS,
    feature_names_for_id,
    record_features,
)

DATA_DIR = BACKEND_DIR / "data" / "synCAN"
TRAIN_FILES = [DATA_DIR / f"train_{index}.zip" for index in range(1, 5)]
TEST_FILES = [
    DATA_DIR / "test_normal.zip",
    DATA_DIR / "test_plateau.zip",
    DATA_DIR / "test_continuous.zip",
    DATA_DIR / "test_playback.zip",
    DATA_DIR / "test_suppress.zip",
    DATA_DIR / "test_flooding.zip",
]
REQUIRED_COLUMNS = {"Label", "ID", "Time"}


def _csv_sources(path):
    path = Path(path)
    if path.suffix.casefold() == ".zip":
        with zipfile.ZipFile(path) as archive:
            members = [
                name for name in archive.namelist()
                if name.casefold().endswith(".csv")
            ]
            if not members:
                raise ValueError(f"{path.name} contains no CSV files")
            for member in members:
                with archive.open(member) as raw:
                    import io
                    yield f"{path.name}:{member}", io.TextIOWrapper(
                        raw, encoding="utf-8-sig", newline=""
                    )
        return
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        yield path.name, stream


def _normalized_row(row):
    return {
        str(key).strip().lstrip("\ufeff"): value
        for key, value in row.items()
        if key is not None
    }


def iter_rows(paths):
    for path in map(Path, paths):
        if not path.is_file():
            raise FileNotFoundError(
                f"Missing SynCAN file: {path}. See backend/data/README.md."
            )
        for source_name, stream in _csv_sources(path):
            try:
                reader = csv.DictReader(stream)
                if not reader.fieldnames or not REQUIRED_COLUMNS.issubset(
                    {name.strip() for name in reader.fieldnames}
                ):
                    raise ValueError(
                        f"{source_name}: expected Label, ID, Time and signal columns"
                    )
                previous = {}
                for raw_row in reader:
                    row = _normalized_row(raw_row)
                    can_id = row.get("ID", "").strip().casefold()
                    if can_id not in SIGNAL_COUNTS:
                        continue
                    try:
                        label = int(row["Label"])
                        if label not in (0, 1):
                            continue
                        time_ms = float(row["Time"])
                        count = SIGNAL_COUNTS[can_id]
                        sample = {
                            "ID": can_id,
                            "Time": time_ms,
                        }
                        for index in range(1, count + 1):
                            sample[f"Signal{index}_of_ID"] = float(
                                row[f"Signal{index}_of_ID"]
                            )
                        if not np.isfinite(time_ms):
                            continue
                        can_id, features, current = record_features(
                            sample,
                            previous.get(can_id),
                        )
                    except (KeyError, TypeError, ValueError, OverflowError):
                        continue
                    previous[can_id] = current
                    yield {
                        "source": source_name,
                        "ID": can_id,
                        "label": label,
                        "features": features.reshape(-1),
                    }
            finally:
                stream.close()


def _reservoir_by_id(paths, maximum, seed):
    rng = random.Random(seed)
    samples = {can_id: [] for can_id in SIGNAL_COUNTS}
    seen = {can_id: 0 for can_id in SIGNAL_COUNTS}
    for row in iter_rows(paths):
        if row["label"] != 0:
            continue
        can_id = row["ID"]
        seen[can_id] += 1
        values = samples[can_id]
        if len(values) < maximum:
            values.append(row["features"])
        else:
            replacement = rng.randrange(seen[can_id])
            if replacement < maximum:
                values[replacement] = row["features"]
    return samples, seen


def train(train_files=TRAIN_FILES, test_files=TEST_FILES, output_path=MODEL_PATH,
          max_samples_per_id=30000, seed=2026):
    samples, seen = _reservoir_by_id(train_files, max_samples_per_id, seed)
    models = {}
    trained_counts = {}
    for can_id, vectors in samples.items():
        if len(vectors) < 100:
            raise ValueError(
                f"Only {len(vectors)} normal samples found for {can_id}; "
                "check all four SynCAN train archives and their CSV schema."
            )
        model = make_pipeline(
            StandardScaler(),
            IsolationForest(
                n_estimators=150,
                contamination="auto",
                random_state=seed,
                n_jobs=1,
            ),
        )
        model.fit(np.asarray(vectors, dtype=float))
        models[can_id] = model
        trained_counts[can_id] = len(vectors)

    y_true, y_pred = [], []
    by_file = {}
    for row in iter_rows(test_files):
        can_id = row["ID"]
        prediction = int(models[can_id].predict(row["features"].reshape(1, -1))[0] == -1)
        y_true.append(row["label"])
        y_pred.append(prediction)
        metric = by_file.setdefault(row["source"], {"y_true": [], "y_pred": []})
        metric["y_true"].append(row["label"])
        metric["y_pred"].append(prediction)

    if not y_true:
        raise ValueError("SynCAN evaluation files contained no valid labelled rows.")

    matrix = confusion_matrix(y_true, y_pred, labels=[0, 1])
    metrics = {
        "rows_evaluated": len(y_true),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "false_positives": int(matrix[0, 1]),
        "missed_intrusions": int(matrix[1, 0]),
        "per_test_file": {},
    }
    for filename, result in by_file.items():
        labels, predictions = result["y_true"], result["y_pred"]
        metrics["per_test_file"][filename] = {
            "rows": len(labels),
            "precision": float(precision_score(labels, predictions, zero_division=0)),
            "recall": float(recall_score(labels, predictions, zero_division=0)),
            "f1": float(f1_score(labels, predictions, zero_division=0)),
        }

    metadata = {
        "model_type": "StandardScaler + IsolationForest, one model per SynCAN ID",
        "task": "unsupervised CAN signal anomaly detection",
        "training_label_use": "Label=0 rows only; labels are not used to fit models",
        "evaluation_labels": "official SynCAN Label column",
        "source": "ETAS SynCAN dataset, CANet supplementary data",
        "citation": (
            "Hanselmann et al., CANet: An Unsupervised Intrusion Detection "
            "System for High Dimensional CAN Bus Data, IEEE Access, 2020."
        ),
        "input_schema": "Label, ID, Time(ms), SignalN_of_ID; signals kept per ID",
        "signal_counts": SIGNAL_COUNTS,
        "feature_names_by_id": {
            can_id: feature_names_for_id(can_id)
            for can_id in SIGNAL_COUNTS
        },
        "training_source_files": [Path(path).name for path in train_files],
        "training_rows_seen_by_id": seen,
        "training_rows_sampled_by_id": trained_counts,
        "max_samples_per_id": max_samples_per_id,
        "evaluation_source_files": [Path(path).name for path in test_files],
        "metrics": metrics,
        "seed": seed,
        "seeded_training_data": "SynCAN official dataset",
    }
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"models": models, "metadata": metadata}, output_path)
    verified = joblib.load(output_path)
    if set(verified["models"]) != set(SIGNAL_COUNTS):
        raise RuntimeError("Saved SynCAN model is missing an ID-specific detector")
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    parser.add_argument("--max-samples-per-id", type=int, default=30000)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    train_files = [args.data_dir / f"train_{index}.zip" for index in range(1, 5)]
    test_files = [
        args.data_dir / name
        for name in (
            "test_normal.zip",
            "test_plateau.zip",
            "test_continuous.zip",
            "test_playback.zip",
            "test_suppress.zip",
            "test_flooding.zip",
        )
    ]
    result = train(
        train_files,
        test_files,
        args.output,
        args.max_samples_per_id,
        args.seed,
    )
    print(f"Evaluated {result['metrics']['rows_evaluated']} labelled SynCAN rows.")
    for key in ("precision", "recall", "f1", "false_positives", "missed_intrusions"):
        print(f"{key}: {result['metrics'][key]}")
    for name, metrics in result["metrics"]["per_test_file"].items():
        print(f"{name}: {metrics}")
