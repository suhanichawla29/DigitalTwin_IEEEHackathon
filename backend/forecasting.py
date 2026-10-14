"""Explainable recent-trend forecasts and chronological persistence comparisons."""

from bisect import bisect_left
from datetime import datetime, timezone
import math
import os

from diagnostics import (
    HIGH_TEMPERATURE_WARNING_C,
    HIGH_VOLTAGE_WARNING_V,
    LOW_VOLTAGE_WARNING_V,
)
from telemetry_store import TelemetryStore

MIN_HISTORY = int(os.environ.get("EV_FORECAST_MIN_HISTORY", "15"))
TREND_WINDOW = 30
MAX_HISTORY = 600
BACKTEST_MIN_ORIGINS = 10
SAMPLE_INTERVAL_SECONDS = 2.0
WARNING_LIMITS = {
    "voltage": {
        "low": LOW_VOLTAGE_WARNING_V,
        "high": HIGH_VOLTAGE_WARNING_V,
        "unit": "V",
        "label": "Voltage",
    },
    "temperature": {
        "high": HIGH_TEMPERATURE_WARNING_C,
        "unit": "°C",
        "label": "Temperature",
    },
}

if not 2 <= MIN_HISTORY <= MAX_HISTORY:
    raise ValueError(
        "EV_FORECAST_MIN_HISTORY must be between 2 and "
        f"{MAX_HISTORY}, got {MIN_HISTORY}"
    )


def _fit_slope(readings, signal):
    origin = readings[-1]["timestamp"]
    points = [
        (reading["timestamp"] - origin, float(reading[signal]))
        for reading in readings[-TREND_WINDOW:]
    ]
    mean_x = sum(point[0] for point in points) / len(points)
    mean_y = sum(point[1] for point in points) / len(points)
    denominator = sum((x - mean_x) ** 2 for x, _ in points)
    if denominator <= 0:
        return 0.0
    return sum(
        (x - mean_x) * (y - mean_y)
        for x, y in points
    ) / denominator


def _trend_name(slope):
    if slope > 1e-6:
        return "increasing"
    if slope < -1e-6:
        return "decreasing"
    return "stable"


def _warning_status(signal, current, projected, slope, horizon_seconds):
    limits = WARNING_LIMITS[signal]
    checks = []
    if signal == "voltage":
        checks = [
            (limits["low"], current < limits["low"], slope < 0, "below"),
            (limits["high"], current > limits["high"], slope > 0, "above"),
        ]
    else:
        checks = [
            (limits["high"], current > limits["high"], slope > 0, "above"),
        ]

    warnings = []
    for limit, already_outside, moving_toward, direction in checks:
        projected_outside = projected < limit if direction == "below" else projected > limit
        if already_outside:
            status = "already_outside_limit"
            message = (
                f"{limits['label']} is already {direction} the "
                f"{limit:g} {limits['unit']} warning limit."
            )
        elif projected_outside:
            status = "projected_to_cross_limit"
            message = (
                f"{limits['label']} is projected to cross the "
                f"{limit:g} {limits['unit']} warning limit within "
                f"{horizon_seconds} seconds using recent-trend extrapolation."
            )
        elif moving_toward:
            status = "moving_toward_limit"
            message = (
                f"{limits['label']} is moving toward the "
                f"{limit:g} {limits['unit']} warning limit."
            )
        else:
            continue
        warnings.append({
            "status": status,
            "limit": limit,
            "unit": limits["unit"],
            "message": message,
        })
    return warnings


def _backtest(readings, signal, horizon_seconds, minimum_history):
    timestamps = [reading["timestamp"] for reading in readings]
    errors = {"linear_trend": [], "persistence": []}
    interval_tolerance = max(
        SAMPLE_INTERVAL_SECONDS * 2.0,
        horizon_seconds * 0.02,
    )
    for origin_index in range(minimum_history - 1, len(readings)):
        origin = readings[origin_index]
        target_timestamp = origin["timestamp"] + horizon_seconds
        target_index = bisect_left(
            timestamps,
            target_timestamp,
            lo=origin_index + 1,
        )
        if target_index >= len(readings):
            break
        target = readings[target_index]
        if target["timestamp"] - target_timestamp > interval_tolerance:
            continue

        past = readings[
            max(0, origin_index + 1 - TREND_WINDOW):origin_index + 1
        ]
        slope = _fit_slope(past, signal)
        projected = float(origin[signal]) + slope * horizon_seconds
        actual = float(target[signal])
        errors["linear_trend"].append(abs(projected - actual))
        errors["persistence"].append(
            abs(float(origin[signal]) - actual)
        )

    count = len(errors["linear_trend"])
    if count < BACKTEST_MIN_ORIGINS:
        return {
            "status": "insufficient_chronological_test_pairs",
            "horizon_seconds": horizon_seconds,
            "sample_count": count,
            "minimum_test_pairs": BACKTEST_MIN_ORIGINS,
            "metrics": None,
        }

    trend_mae = sum(errors["linear_trend"]) / count
    persistence_mae = sum(errors["persistence"]) / count
    return {
        "status": "evaluated",
        "horizon_seconds": horizon_seconds,
        "sample_count": count,
        "validation": "rolling-origin chronological; each forecast uses past samples only",
        "metrics": {
            "linear_trend_mae": trend_mae,
            "persistence_mae": persistence_mae,
            "linear_trend_improvement_percent": (
                (persistence_mae - trend_mae) / persistence_mae * 100.0
                if persistence_mae > 0
                else None
            ),
        },
    }


def _make_horizon(readings, horizon_seconds, minimum_history):
    status = (
        "ready"
        if len(readings) >= minimum_history
        else "collecting_data"
    )
    result = {
        "status": status,
        "type": "forecast",
        "horizon_seconds": horizon_seconds,
        "horizon_label": (
            "30 seconds" if horizon_seconds == 30 else "5 minutes"
        ),
        "model": "Recent 30-sample linear trend (untrained baseline)",
        "history_count": len(readings),
        "minimum_history": minimum_history,
        "signals": {},
        "forecast_series": [],
        "chronological_comparison": {},
        "limitations": (
            "Extrapolates a recent simulator trend; it is not a trained "
            "vehicle model or a guarantee of future sensor values."
        ),
    }
    for signal in ("voltage", "temperature"):
        actual = float(readings[-1][signal]) if readings else None
        if status != "ready":
            result["signals"][signal] = {
                "unit": "V" if signal == "voltage" else "°C",
                "actual": actual,
                "predicted": None,
                "trend": "unavailable",
                "slope_per_second": None,
                "warning_assessment": [],
            }
            result["chronological_comparison"][signal] = _backtest(
                readings,
                signal,
                horizon_seconds,
                minimum_history,
            ) if readings else {
                "status": "insufficient_chronological_test_pairs",
                "horizon_seconds": horizon_seconds,
                "sample_count": 0,
                "minimum_test_pairs": BACKTEST_MIN_ORIGINS,
                "metrics": None,
            }
            continue

        slope = _fit_slope(readings, signal)
        predicted = actual + slope * horizon_seconds
        unit = "V" if signal == "voltage" else "°C"
        result["signals"][signal] = {
            "unit": unit,
            "actual": actual,
            "predicted": predicted,
            "trend": _trend_name(slope),
            "slope_per_second": slope,
            "warning_assessment": _warning_status(
                signal,
                actual,
                predicted,
                slope,
                horizon_seconds,
            ),
        }
        result["chronological_comparison"][signal] = _backtest(
            readings,
            signal,
            horizon_seconds,
            minimum_history,
        )

    if status == "ready":
        point_count = 5 if horizon_seconds == 30 else 11
        for index in range(point_count + 1):
            future_seconds = horizon_seconds * index / point_count
            row = {
                "timestamp": readings[-1]["timestamp"] + future_seconds,
                "voltage": (
                    float(readings[-1]["voltage"])
                    + _fit_slope(readings, "voltage") * future_seconds
                ),
                "temperature": (
                    float(readings[-1]["temperature"])
                    + _fit_slope(readings, "temperature") * future_seconds
                ),
            }
            result["forecast_series"].append(row)
    return result


def build_multilevel_forecast(
    readings,
    *,
    as_of,
    minimum_history=MIN_HISTORY,
    nasa_model_status=None,
    total_history_count=None,
):
    """Build 30-second and five-minute forecasts from data available as of time."""
    try:
        as_of_timestamp = float(as_of)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("as_of must be a finite timestamp") from error
    if not math.isfinite(as_of_timestamp):
        raise ValueError("as_of must be a finite timestamp")
    if (
        isinstance(minimum_history, bool)
        or not isinstance(minimum_history, int)
        or not 2 <= minimum_history <= MAX_HISTORY
    ):
        raise ValueError(f"minimum_history must be between 2 and {MAX_HISTORY}")

    normalized = []
    for reading in readings:
        timestamp = TelemetryStore._finite_number(
            reading["timestamp"],
            "timestamp",
        )
        if timestamp > as_of_timestamp:
            continue
        item = {"timestamp": timestamp}
        for signal in ("voltage", "current", "temperature"):
            item[signal] = TelemetryStore._finite_number(
                reading[signal],
                signal,
            )
        normalized.append(item)
    normalized.sort(key=lambda reading: reading["timestamp"])
    normalized = normalized[-MAX_HISTORY:]
    latest = normalized[-1] if normalized else None
    if total_history_count is None:
        total_history_count = len(normalized)
    if (
        isinstance(total_history_count, bool)
        or not isinstance(total_history_count, int)
        or total_history_count < len(normalized)
    ):
        raise ValueError(
            "total_history_count must be an integer no smaller than the supplied history"
        )

    nasa_model_status = nasa_model_status or {}
    nasa_ready = nasa_model_status.get("status") == "ready"
    long_term = {
        "status": "unavailable",
        "type": "estimate",
        "horizon": "long-term",
        "target": "NASA battery discharge capacity (Ah)",
        "model": (
            nasa_model_status.get("model_type")
            if nasa_ready
            else None
        ),
        "model_status": nasa_model_status.get("status", "unavailable"),
        "capacity_ah": None,
        "capacity_soh_percent": None,
        "reason": (
            "The NASA model requires complete NASA discharge-cycle measurement "
            "arrays. Live simulator voltage/current/temperature samples do not "
            "match that input schema. Use POST /api/battery/capacity with a "
            "compatible NASA cycle; no live capacity or degradation rate is "
            "inferred."
        ),
    }
    generated_at = datetime.fromtimestamp(
        as_of_timestamp,
        timezone.utc,
    ).isoformat()
    history_count = len(normalized)
    return {
        "status": (
            "ready"
            if history_count >= minimum_history
            else "collecting_data"
        ),
        "generated_at": generated_at,
        "generated_at_timestamp": as_of_timestamp,
        "data_source": "SQLite telemetry_history populated by simulated CAN readings",
        "history_count": history_count,
        "total_history_count": total_history_count,
        "minimum_history": minimum_history,
        "last_reading": (
            {
                "timestamp": latest["timestamp"],
                "timestamp_utc": datetime.fromtimestamp(
                    latest["timestamp"],
                    timezone.utc,
                ).isoformat(),
                "voltage": latest["voltage"],
                "voltage_unit": "V",
                "temperature": latest["temperature"],
                "temperature_unit": "°C",
            }
            if latest else None
        ),
        "actual_series": [
            {
                "timestamp": reading["timestamp"],
                "voltage": reading["voltage"],
                "temperature": reading["temperature"],
            }
            for reading in normalized[-150:]
        ],
        "short_term": _make_horizon(
            normalized,
            30,
            minimum_history,
        ),
        "medium_term": _make_horizon(
            normalized,
            300,
            minimum_history,
        ),
        "long_term": long_term,
        "warning_limits": {
            "voltage": {
                "low_v": WARNING_LIMITS["voltage"]["low"],
                "high_v": WARNING_LIMITS["voltage"]["high"],
            },
            "temperature": {
                "high_c": WARNING_LIMITS["temperature"]["high"],
            },
        },
    }


def build_forecast_status(
    readings,
    *,
    as_of,
    minimum_history=MIN_HISTORY,
    nasa_model_status=None,
    total_history_count=None,
):
    forecast = build_multilevel_forecast(
        readings,
        as_of=as_of,
        minimum_history=minimum_history,
        nasa_model_status=nasa_model_status,
        total_history_count=total_history_count,
    )
    return {
        "status": forecast["status"],
        "data_source": forecast["data_source"],
        "history_count": forecast["history_count"],
        "total_history_count": forecast["total_history_count"],
        "minimum_history": forecast["minimum_history"],
        "last_reading": forecast["last_reading"],
        "short_term": {
            "status": forecast["short_term"]["status"],
            "horizon_seconds": forecast["short_term"]["horizon_seconds"],
            "model": forecast["short_term"]["model"],
        },
        "medium_term": {
            "status": forecast["medium_term"]["status"],
            "horizon_seconds": forecast["medium_term"]["horizon_seconds"],
            "model": forecast["medium_term"]["model"],
        },
        "long_term": forecast["long_term"],
        "generated_at": forecast["generated_at"],
    }
