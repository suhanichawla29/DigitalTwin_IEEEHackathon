
from diagnostics import diagnose

test_cases = [
    {
        "name": "Normal readings",
        "voltage": 400,
        "current": 35,
        "temperature": 45,
    },
    {
        "name": "High temperature",
        "voltage": 400,
        "current": 35,
        "temperature": 85,
    },
    {
        "name": "Low voltage",
        "voltage": 270,
        "current": 35,
        "temperature": 45,
    },
    {
        "name": "Excessive current",
        "voltage": 400,
        "current": 120,
        "temperature": 45,
    },
    {
        "name": "Multiple faults",
        "voltage": 270,
        "current": 120,
        "temperature": 85,
    },
]

for case in test_cases:
    result = diagnose(
        case["voltage"],
        case["current"],
        case["temperature"],
    )

    print(f"\nTest: {case['name']}")
    print(f"Status: {result['status']}")
    print(f"Message: {result['message']}")

    for fault in result["faults"]:
        print(f" - {fault['label']} ({fault['severity']})")
