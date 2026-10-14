"""Read NASA PCoE MATLAB battery runs and extract discharge-cycle features."""

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


def _vector(value):
    if value is None:
        return np.asarray([], dtype=float)
    try:
        return np.asarray(value, dtype=float).reshape(-1)
    except (TypeError, ValueError):
        return np.asarray([], dtype=float)


def discharge_features(data):
    """Extract features from a discharge's observed arrays, excluding Capacity."""
    names = (
        "Time",
        "Voltage_measured",
        "Current_measured",
        "Temperature_measured",
    )
    arrays = [_vector(_field(data, name)) for name in names]
    length = min(map(len, arrays), default=0)
    if length < 2:
        raise ValueError("Discharge needs at least two time/sensor samples")

    time_values, voltage, current, temperature = (
        array[:length] for array in arrays
    )
    valid = (
        np.isfinite(time_values)
        & np.isfinite(voltage)
        & np.isfinite(current)
        & np.isfinite(temperature)
    )
    time_values = time_values[valid]
    voltage = voltage[valid]
    current = current[valid]
    temperature = temperature[valid]
    if len(time_values) < 2:
        raise ValueError("Discharge needs two aligned finite sensor samples")
    if np.any(np.diff(time_values) <= 0):
        raise ValueError("Discharge time must be strictly increasing")

    elapsed = time_values - time_values[0]
    duration = float(elapsed[-1])
    if duration <= 0:
        raise ValueError("Discharge duration must be positive")

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


def _items(value):
    if isinstance(value, np.ndarray):
        return list(value.reshape(-1))
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def load_battery_runs(paths):
    """Yield one labelled observation per discharge cycle in MATLAB .mat runs."""
    try:
        from scipy.io import loadmat
    except ImportError as error:
        raise RuntimeError(
            "NASA MATLAB files require scipy; install backend requirements."
        ) from error

    for path in sorted(Path(item) for item in paths):
        if path.suffix.casefold() != ".mat":
            continue
        content = loadmat(path, squeeze_me=True, struct_as_record=False)
        root = content.get(path.stem)
        if root is None:
            candidates = [
                value for key, value in content.items()
                if not key.startswith("__")
            ]
            if len(candidates) != 1:
                raise ValueError(
                    f"{path.name}: cannot identify the MATLAB battery structure"
                )
            root = candidates[0]

        cycles = _field(root, "cycle")
        if cycles is None:
            raise ValueError(f"{path.name}: expected a top-level cycle structure")

        for cycle_index, cycle in enumerate(_items(cycles), start=1):
            if _text(_field(cycle, "type")).casefold() != "discharge":
                continue
            data = _field(cycle, "data")
            capacity = _vector(_field(data, "Capacity"))
            if not len(capacity) or not math.isfinite(capacity[0]) or capacity[0] <= 0:
                continue
            try:
                features = discharge_features(data)
            except ValueError:
                continue
            yield {
                "battery_id": path.stem,
                "cycle_index": cycle_index,
                "features": features,
                "capacity_ah": float(capacity[0]),
            }
