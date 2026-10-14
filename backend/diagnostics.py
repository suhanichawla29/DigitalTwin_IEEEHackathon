
def diagnose(voltage, current, temperature):
    """Apply illustrative rules to simulated EV readings."""

    if temperature > 80:
        return {
            "code": "over-temperature",
            "label": "High Temperature",
            "severity": "critical",
            "description": "Temperature exceeds the demo limit.",
            "risk": 90,
            "health": 40,
        }

    if current > 100:
        return {
            "code": "over-current",
            "label": "Excessive Current",
            "severity": "critical",
            "description": "Current exceeds the demo limit.",
            "risk": 85,
            "health": 50,
        }

    if voltage < 300:
        return {
            "code": "under-voltage",
            "label": "Low Voltage",
            "severity": "warning",
            "description": "Voltage is below the demo limit.",
            "risk": 60,
            "health": 70,
        }

    if voltage > 430:
        return {
            "code": "over-voltage",
            "label": "High Voltage",
            "severity": "warning",
            "description": "Voltage exceeds the demo limit.",
            "risk": 60,
            "health": 70,
        }

    return {
        "code": "normal",
        "label": "Normal Operation",
        "severity": "normal",
        "description": "No demo fault rules were triggered.",
        "risk": 8,
        "health": 92,
    }
