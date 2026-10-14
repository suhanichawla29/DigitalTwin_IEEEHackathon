"""Load NASA PCoE Li-ion aging MATLAB runs and derive discharge features."""

from pathlib import Path
import math

import numpy as np

FEATURE_NAMES = [
    "duration_seconds",
    "voltage_start_v",
    "voltage_end_v",
    "voltage_min_v",
    "voltage_mean_v",
    "voltage_std_v",
    "voltage_slope_v_per_s",
    "current_abs_mean_a",
    "current_std_a",
    "temperature_mean_c",
    "temperature_max_c",
    "temperature_delta_c",
]
RATED_CAPACITY_AH = 2.0


def _field(value, name):
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _text(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    if isinstance(value, np.ndarray):
        if value.size == 1:
            return _text(value.reshape(-1)[0])
        return "".join(str(part) for part in value.reshape(-1)).strip()
    return str(value).strip()


def _finite_vector(value):
    if value is None:
        return np.asarray([], dtype=float)
    try:
        values = np.asarray(value, dtype=float).reshape(-1)
    except (TypeError, ValueError):
        return np.asarray([], dtype=float)
    return values[np.isfinite(values)]


def _numeric_vector(value):
    if value is None:
        return np.asarray([], dtype=float)
    try:
        return np.asarray(value, dtype=float).reshape(-1)
    except (TypeError, ValueError):
        return np.asarray([], dtype=float)


def discharge_features(data):
    """Return features from a single discharge cycle; capacity is never an input."""
    time_values = _numeric_vector(_field(data, "Time"))
    voltage = _numeric_vector(_field(data, "Voltage_measured"))
    current = _numeric_vector(_field(data, "Current_measured"))
    temperature = _numeric_vector(_field(data, "Temperature_measured"))

    length = min(map(len, (time_values, voltage, current, temperature)), default=0)
    if length < 2:
        raise ValueError("Discharge needs at least two valid time/sensor samples")

    time_values = time_values[:length]
    voltage = voltage[:length]
    current = current[:length]
    temperature = temperature[:length]

    valid = (
        np.isfinite(time_values) &
        np.isfinite(voltage) &
        np.isfinite(current) &
        np.isfinite(temperature)
    )
    time_values = time_values[valid]
    voltage = voltage[valid]
    current = current[valid]
    temperature = temperature[valid]
    if len(time_values) < 2:
        raise ValueError("Discharge needs two aligned finite sensor samples")

    elapsed = time_values - time_values[0]
    duration = float(elapsed[-1])
    if duration <= 0 or np.any(np.diff(time_values) <= 0):
        raise ValueError("Discharge time must be strictly increasing")

    return {
        "duration_seconds": duration,
        "voltage_start_v": float(voltage[0]),
        "voltage_end_v": float(voltage[-1]),
        "voltage_min_v": float(np.min(voltage)),
        "voltage_mean_v": float(np.mean(voltage)),
        "voltage_std_v": float(np.std(voltage)),
        "voltage_slope_v_per_s": float(np.polyfit(elapsed, voltage, 1)[0]),
        "current_abs_mean_a": float(np.mean(np.abs(current))),
        "current_std_a": float(np.std(current)),
        "temperature_mean_c": float(np.mean(temperature)),
        "temperature_max_c": float(np.max(temperature)),
        "temperature_delta_c": float(temperature[-1] - temperature[0]),
    }


def _cycle_items(cycles):
    if isinstance(cycles, np.ndarray):
        return list(cycles.reshape(-1))
    if isinstance(cycles, (list, tuple)):
        return list(cycles)
    return [cycles]


def load_battery_runs(paths):
    """Read MATLAB .mat runs, yielding one labelled sample per discharge."""
    try:
        from scipy.io import loadmat
    except ImportError as error:
        raise RuntimeError(
            "NASA .mat files require scipy. Install backend requirements first."
        ) from error

    for path in sorted(Path(p) for p in paths):
        if path.suffix.casefold() != ".mat":
            continue
        mat = loadmat(path, squeeze_me=True, struct_as_record=False)
        root_key = path.stem
        root = mat.get(root_key)
        if root is None:
            candidates = [
                value for key, value in mat.items()
                if not key.startswith("__")
            ]
            if len(candidates) != 1:
                raise ValueError(
                    f"{path.name}: cannot identify the top-level MATLAB battery struct"
                )
            root = candidates[0]

        cycles = _field(root, "cycle")
        if cycles is None:
            raise ValueError(f"{path.name}: expected top-level cycle struct")

        for cycle_index, cycle in enumerate(_cycle_items(cycles), start=1):
            operation = _text(_field(cycle, "type")).casefold()
            if operation != "discharge":
                continue
            data = _field(cycle, "data")
            capacity_values = _finite_vector(_field(data, "Capacity"))
            if not len(capacity_values) or capacity_values[0] <= 0:
                continue
            try:
                features = discharge_features(data)
            except ValueError:
                continue
            target_capacity = float(capacity_values[0])
            if not math.isfinite(target_capacity):
                continue
            yield {
                "battery_id": path.stem,
                "cycle_index": cycle_index,
                "features": features,
                "capacity_ah": target_capacity,
                "soh_percent": target_capacity / RATED_CAPACITY_AH * 100.0,
            }
