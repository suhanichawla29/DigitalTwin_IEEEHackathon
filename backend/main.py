
from pathlib import Path
import sys
import time
import math
import random

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# Make the backend folder available for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from can_decoder import decode_can_frame
from diagnostics import diagnose

app = FastAPI(title="EV Digital Twin API")

# Development only: restrict origins before deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------
# Simulated sensor noise
# --------------------------------------------------

_start_time = time.time()
_sample_count = 0

BASE_VOLTAGE = 400.0
BASE_CURRENT = 35.0
BASE_TEMPERATURE = 45.0


def gaussian_noise(sigma):
    """Simulate small sensor measurement variations."""
    return random.gauss(0, sigma)


def low_frequency_drift(t, freq=0.05, amplitude=0.5):
    """Simulate slow changes in sensor readings."""
    return amplitude * math.sin(2 * math.pi * freq * t)


def generate_realistic_reading():
    """Generate simulated healthy readings with small variations."""
    t = time.time() - _start_time

    voltage = (
        BASE_VOLTAGE
        + gaussian_noise(0.5)
        + low_frequency_drift(t, amplitude=0.4)
    )

    current = (
        BASE_CURRENT
        + gaussian_noise(0.4)
        + low_frequency_drift(t, freq=0.03, amplitude=0.3)
    )

    temperature = (
        BASE_TEMPERATURE
        + gaussian_noise(0.2)
        + low_frequency_drift(t, freq=0.02, amplitude=0.5)
    )

    voltage = max(0, min(1000, voltage))
    current = max(0, min(1000, current))
    temperature = max(-40, min(200, temperature))

    return round(voltage, 2), round(current, 2), round(temperature, 2)


# --------------------------------------------------
# CAN frame encoding
# --------------------------------------------------

def make_demo_frame(voltage, current, temperature):
    """Encode values into the custom DBC-compatible CAN format."""

    raw_values = [
        round(voltage * 10),
        round(current * 10),
        round((temperature + 40) * 10),
    ]

    data = bytearray()

    for value in raw_values:
        data.extend(int(value).to_bytes(2, "little"))

    data.extend([0, 0])
    return bytes(data)


# --------------------------------------------------
# Selectable demo scenarios
# --------------------------------------------------

SCENARIOS = {
    "normal": (400, 35, 45),
    "low_voltage": (270, 35, 45),
    "over_voltage": (450, 35, 45),
    "over_current": (400, 120, 45),
    "over_temperature": (400, 35, 85),
    "multiple_faults": (270, 120, 85),
}


# --------------------------------------------------
# API endpoints
# --------------------------------------------------

@app.get("/")
def home():
    return {
        "message": "EV Digital Twin API is running",
        "docs": "/docs",
        "scenarios": list(SCENARIOS.keys()),
    }


@app.get("/api/readings")
def get_readings(
    scenario: str = Query(default="normal")
):
    """
    Return simulated CAN readings and diagnostic results.

    Examples:
      /api/readings
      /api/readings?scenario=normal
      /api/readings?scenario=over_temperature
      /api/readings?scenario=multiple_faults
    """
    global _sample_count

    if scenario not in SCENARIOS:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Unknown scenario",
                "available_scenarios": list(SCENARIOS.keys()),
            },
        )

    if scenario == "normal":
        # Healthy baseline with small sensor variations
        voltage, current, temperature = generate_realistic_reading()
    else:
        # Fixed values make fault scenarios repeatable
        voltage, current, temperature = SCENARIOS[scenario]

    _sample_count += 1

    # Encode simulated readings into a CAN frame
    frame = make_demo_frame(voltage, current, temperature)

    # Decode the frame using the existing DBC decoder
    readings = decode_can_frame(0x100, frame)

    # Run the existing Python diagnostic rules
    diagnostics = diagnose(
        voltage=readings["voltage"],
        current=readings["current"],
        temperature=readings["temperature"],
    )

    return {
        **readings,
        "ecu_status": diagnostics["status"],
        "diagnostics": diagnostics,
        "source": "SIMULATED_CAN",
        "scenario": scenario,
        "sample_index": _sample_count,
        "timestamp": time.time(),
    }


@app.get("/api/scenarios")
def get_scenarios():
    """List the available demonstration scenarios."""
    return {
        "scenarios": [
            {
                "id": name,
                "values": {
                    "voltage": values[0],
                    "current": values[1],
                    "temperature": values[2],
                },
            }
            for name, values in SCENARIOS.items()
        ]
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}
