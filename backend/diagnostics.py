
LOW_VOLTAGE_WARNING_V = 300.0
HIGH_VOLTAGE_WARNING_V = 430.0
HIGH_TEMPERATURE_WARNING_C = 80.0
HIGH_CURRENT_WARNING_A = 100.0


def diagnose(voltage, current, temperature):
    """Detect faults using illustrative prototype thresholds."""

    faults = []

    if temperature > HIGH_TEMPERATURE_WARNING_C:
        faults.append({
            "code": "over-temperature",
            "label": "High Temperature",
            "severity": "critical",
            "description": "Temperature exceeds the demo limit."
        })

    if current > HIGH_CURRENT_WARNING_A:
        faults.append({
            "code": "over-current",
            "label": "Excessive Current",
            "severity": "critical",
            "description": "Current exceeds the demo limit."
        })

    if voltage < LOW_VOLTAGE_WARNING_V:
        faults.append({
            "code": "under-voltage",
            "label": "Low Voltage",
            "severity": "warning",
            "description": "Voltage is below the demo limit."
        })

    if voltage > HIGH_VOLTAGE_WARNING_V:
        faults.append({
            "code": "over-voltage",
            "label": "High Voltage",
            "severity": "warning",
            "description": "Voltage exceeds the demo limit."
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
