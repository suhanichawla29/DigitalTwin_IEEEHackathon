"""Train per-ID SynCAN anomaly detectors and evaluate official test labels."""

import argparse
import csv
from collections import defaultdict
from pathlib import Path
import random
import zipfile

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from syncan_predictor import MODEL_PATH, SIGNAL_COUNTS, feature_names, record_features

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_DIR / "data" / "synCAN"
TRAIN_FILES = [DATA_DIR / f"train_{index}.zip" for index in range(1, 5)]
TEST_FILES = [
    DATA_DIR / name
    for name in (
        "test_normal.zip",
        "test_plateau.zip",
        "test_continuous.zip",
        "test_playback.zip",
        "test_suppress.zip",
        "test_flooding.zip",
    )
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
                with archive.open(member) as source:
                    import io
                    yield path.name, io.TextIOWrapper(
                        source, encoding="utf-8-sig", newline=""
                    )
        return
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        yield path.name, source


def iter_rows(paths):
    """Yield validated, ID-specific records from the official CSV/ZIP schema."""
    for path in map(Path, paths):
        if not path.is_file():
            raise FileNotFoundError(
                f"Missing SynCAN file: {path}. See backend/data/README.md."
            )
        for source_name, stream in _csv_sources(path):
            previous = {}
            try:
                reader = csv.DictReader(stream)
                columns = {
                    name.strip().lstrip("\ufeff")
                    for name in (reader.fieldnames or [])
                }
                if not REQUIRED_COLUMNS.issubset(columns):
                    raise ValueError(
                        f"{source_name}: expected Label, ID, Time, and signal columns"
                    )
                for raw in reader:
                    row = {
                        str(key).strip().lstrip("\ufeff"): value
                        for key, value in raw.items()
                        if key is not None
                    }
                    can_id = row.get("ID", "").strip().casefold()
                    if can_id not in SIGNAL_COUNTS:
                        continue
                    try:
                        label = int(row["Label"])
                        if label not in (0, 1):
                            continue
                        record = {
                            "ID": can_id,
                            "Time": float(row["Time"]),
                        }
                        for index in range(1, SIGNAL_COUNTS[can_id] + 1):
                            record[f"Signal{index}_of_ID"] = float(
                                row[f"Signal{index}_of_ID"]
                            )
                        _, vector, current = record_features(
                            record,
                            previous.get(can_id),
                        )
                    except (KeyError, TypeError, ValueError, OverflowError):
                        continue
                    previous[can_id] = current
                    yield {
                        "source": source_name,
                        "ID": can_id,
                        "label": label,
                        "features": vector.reshape(-1),
                    }
            finally:
                stream.close()


def _training_samples(paths, limit, seed):
    rng = random.Random(seed)
    vectors = {can_id: [] for can_id in SIGNAL_COUNTS}
    seen = {can_id: 0 for can_id in SIGNAL_COUNTS}
    for row in iter_rows(paths):
        if row["label"] != 0:
            continue
        can_id = row["ID"]
        seen[can_id] += 1
        bucket = vectors[can_id]
        if len(bucket) < limit:
            bucket.append(row["features"])
        else:
            replacement = rng.randrange(seen[can_id])
            if replacement < limit:
                bucket[replacement] = row["features"]
    return vectors, seen


def _metrics(counts):
    false_positives = counts[0]["positive"]
    true_positives = counts[1]["positive"]
    missed_intrusions = counts[1]["negative"]
    true_negatives = counts[0]["negative"]
    precision_denominator = true_positives + false_positives
    recall_denominator = true_positives + missed_intrusions
    precision = (
        true_positives / precision_denominator
        if precision_denominator else 0.0
    )
    recall = (
        true_positives / recall_denominator
        if recall_denominator else 0.0
    )
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall else 0.0
    )
    return {
        "rows_evaluated": sum(count["rows"] for count in counts.values()),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "false_positives": int(false_positives),
        "missed_intrusions": int(missed_intrusions),
    }


def _evaluate(models, paths):
    counts = defaultdict(lambda: {
        0: {"rows": 0, "positive": 0, "negative": 0},
        1: {"rows": 0, "positive": 0, "negative": 0},
    })
    buffers = {can_id: [] for can_id in SIGNAL_COUNTS}
    labels = {can_id: [] for can_id in SIGNAL_COUNTS}
    sources = {can_id: [] for can_id in SIGNAL_COUNTS}
    total = 0

    def flush(can_id):
        nonlocal total
        if not buffers[can_id]:
            return
        prediction = models[can_id].predict(
            np.asarray(buffers[can_id], dtype=float)
        )
        for source, label, result in zip(
            sources[can_id], labels[can_id], prediction
        ):
            bucket = counts[source][label]
            bucket["rows"] += 1
            bucket["positive" if result == -1 else "negative"] += 1
            total += 1
        buffers[can_id].clear()
        labels[can_id].clear()
        sources[can_id].clear()

    for row in iter_rows(paths):
        can_id = row["ID"]
        buffers[can_id].append(row["features"])
        labels[can_id].append(row["label"])
        sources[can_id].append(row["source"])
        if len(buffers[can_id]) >= 2048:
            flush(can_id)
    for can_id in SIGNAL_COUNTS:
        flush(can_id)
    if not total:
        raise ValueError("SynCAN test archives contained no valid labelled rows")

    by_file = {
        source: _metrics(source_counts)
        for source, source_counts in counts.items()
    }
    aggregate = defaultdict(lambda: {
        0: {"rows": 0, "positive": 0, "negative": 0},
        1: {"rows": 0, "positive": 0, "negative": 0},
    })
    for source_counts in counts.values():
        for label in (0, 1):
            for key, value in source_counts[label].items():
                aggregate["all"][label][key] += value
    return _metrics(aggregate["all"]), by_file


def train(
    train_files=TRAIN_FILES,
    test_files=TEST_FILES,
    output_path=MODEL_PATH,
    max_samples_per_id=30000,
    seed=2026,
):
    vectors, observed = _training_samples(
        train_files,
        max_samples_per_id,
        seed,
    )
    models = {}
    fitted_counts = {}
    for can_id, samples in vectors.items():
        if len(samples) < 100:
            raise ValueError(
                f"Only {len(samples)} normal samples for {can_id}; "
                "check all four SynCAN training archives."
            )
        model = make_pipeline(
            StandardScaler(),
            IsolationForest(
                n_estimators=100,
                contamination="auto",
                random_state=seed,
                n_jobs=1,
            ),
        )
        model.fit(np.asarray(samples, dtype=float))
        models[can_id] = model
        fitted_counts[can_id] = len(samples)

    metrics, per_file = _evaluate(models, test_files)
    metadata = {
        "model_type": "StandardScaler + IsolationForest, one model per SynCAN ID",
        "task": "unsupervised CAN signal anomaly detection",
        "training_labels_used": "Label=0 rows only",
        "evaluation_labels": "official SynCAN Label column",
        "source": "ETAS SynCAN dataset",
        "input_schema": "Label, ID, Time (ms), and ID-specific SignalN_of_ID",
        "signal_counts": SIGNAL_COUNTS,
        "feature_names_by_id": {
            can_id: feature_names(can_id) for can_id in SIGNAL_COUNTS
        },
        "training_rows_seen_by_id": observed,
        "training_rows_fitted_by_id": fitted_counts,
        "seed": seed,
        "evaluation": metrics,
        "evaluation_by_test_file": per_file,
    }
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"models": models, "metadata": metadata}, output_path)
    loaded = joblib.load(output_path)
    if set(loaded["models"]) != set(SIGNAL_COUNTS):
        raise RuntimeError("Saved SynCAN model is missing an ID-specific detector")
    example = next(iter(vectors.values()))[0]
    first_id = next(iter(SIGNAL_COUNTS))
    loaded["models"][first_id].predict(np.asarray([example], dtype=float))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    parser.add_argument("--max-samples-per-id", type=int, default=30000)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    if args.max_samples_per_id < 100:
        parser.error("--max-samples-per-id must be at least 100")
    metadata = train(
        output_path=args.output,
        max_samples_per_id=args.max_samples_per_id,
        seed=args.seed,
    )
    print(f"Verified {args.output}: {metadata['training_rows_fitted_by_id']}")
    print(f"Evaluation: {metadata['evaluation']}")
    print(f"Per test file: {metadata['evaluation_by_test_file']}")


if __name__ == "__main__":
    main()
