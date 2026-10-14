
def diagnose(voltage, current, temperature):
    """Detect faults using illustrative prototype thresholds."""

    faults = []

    if temperature > 80:
        faults.append({
            "code": "over-temperature",
            "label": "High Temperature",
            "severity": "critical",
            "description": "Temperature exceeds the demo limit."
        })

    if current > 100:
        faults.append({
            "code": "over-current",
            "label": "Excessive Current",
            "severity": "critical",
            "description": "Current exceeds the demo limit."
        })

    if voltage < 300:
        faults.append({
            "code": "under-voltage",
            "label": "Low Voltage",
            "severity": "warning",
            "description": "Voltage is below the demo limit."
        })

    if voltage > 430:
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

