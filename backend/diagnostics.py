
LOW_VOLTAGE_WARNING_V = 300.0
HIGH_VOLTAGE_WARNING_V = 430.0
HIGH_TEMPERATURE_WARNING_C = 80.0
HIGH_CURRENT_WARNING_A = 100.0
HIGH_CAN_ACTIVITY_WARNING_PER_SECOND = 2.0


def diagnose(
    voltage,
    current,
    temperature,
    *,
    can_frame_count=1,
    can_window_seconds=2.0,
):
    """Detect faults using illustrative prototype thresholds."""

    faults = []

    if temperature is None:
        faults.append({
            "code": "temperature-sensor-failure",
            "label": "Temperature Sensor Unavailable",
            "severity": "warning",
            "description": "Temperature reading is missing; no value was inferred.",
            "threshold": "Temperature signal must be present and finite",
            "unit": "°C",
        })
    elif temperature > HIGH_TEMPERATURE_WARNING_C:
        faults.append({
            "code": "over-temperature",
            "label": "High Temperature",
            "severity": "critical",
            "description": "Temperature exceeds the demo limit.",
            "threshold": f"Temperature > {HIGH_TEMPERATURE_WARNING_C:g} °C",
            "limit": HIGH_TEMPERATURE_WARNING_C,
            "unit": "°C",
        })

    if current is not None and current > HIGH_CURRENT_WARNING_A:
        faults.append({
            "code": "over-current",
            "label": "Excessive Current",
            "severity": "critical",
            "description": "Current exceeds the demo limit.",
            "threshold": f"Current > {HIGH_CURRENT_WARNING_A:g} A",
            "limit": HIGH_CURRENT_WARNING_A,
            "unit": "A",
        })

    if voltage is not None and voltage < LOW_VOLTAGE_WARNING_V:
        faults.append({
            "code": "under-voltage",
            "label": "Low Voltage",
            "severity": "warning",
            "description": "Voltage is below the demo limit.",
            "threshold": f"Voltage < {LOW_VOLTAGE_WARNING_V:g} V",
            "limit": LOW_VOLTAGE_WARNING_V,
            "unit": "V",
        })

    if voltage is not None and voltage > HIGH_VOLTAGE_WARNING_V:
        faults.append({
            "code": "over-voltage",
            "label": "High Voltage",
            "severity": "warning",
            "description": "Voltage exceeds the demo limit.",
            "threshold": f"Voltage > {HIGH_VOLTAGE_WARNING_V:g} V",
            "limit": HIGH_VOLTAGE_WARNING_V,
            "unit": "V",
        })

    if (
        can_window_seconds > 0
        and can_frame_count / can_window_seconds
        > HIGH_CAN_ACTIVITY_WARNING_PER_SECOND
    ):
        observed_rate = can_frame_count / can_window_seconds
        faults.append({
            "code": "abnormal-can-activity",
            "label": "Abnormal CAN Message Activity",
            "severity": "warning",
            "description": (
                f"Observed {observed_rate:.1f} simulated telemetry frames/s; "
                f"the demo threshold is "
                f"{HIGH_CAN_ACTIVITY_WARNING_PER_SECOND:.1f} frames/s."
            ),
            "threshold": (
                "CAN rate > "
                f"{HIGH_CAN_ACTIVITY_WARNING_PER_SECOND:.1f} frames/s"
            ),
            "limit": HIGH_CAN_ACTIVITY_WARNING_PER_SECOND,
            "unit": "frames/s",
            "observed_rate": observed_rate,
        })

    if not faults:
        return {
            "status": "NORMAL",
            "faults": [],
            "message": "No demo fault rules were triggered."
        }

    return {
        "status": "FAULT",
        "faults": faults,
        "message": f"{len(faults)} fault(s) detected."
    }
