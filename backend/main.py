
from pathlib import Path
import sys
import time
import math
import random
import threading
from collections import deque
from typing import Annotated

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
_can_history = deque(maxlen=500)
_can_history_lock = threading.RLock()

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

FAULT_SCENARIOS = {
    name: values
    for name, values in SCENARIOS.items()
    if name in {
        "low_voltage",
        "over_voltage",
        "over_current",
        "over_temperature",
    }
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
    scenario: Annotated[str | None, Query()] = None,
    faults: Annotated[list[str] | None, Query()] = None,
):
    """
    Return simulated CAN readings and diagnostic results.

    Examples:
      /api/readings
      /api/readings?scenario=normal
      /api/readings?scenario=over_temperature
      /api/readings?scenario=multiple_faults
      /api/readings?faults=low_voltage&faults=over_current
    """
    global _sample_count

    if faults is not None:
        if scenario is not None:
            raise HTTPException(
                status_code=400,
                detail="Use either scenario or faults, not both.",
            )

        if len(faults) != len(set(faults)):
            raise HTTPException(
                status_code=400,
                detail="Duplicate fault selections are not allowed.",
            )

        unknown_faults = sorted(set(faults) - set(FAULT_SCENARIOS))
        if unknown_faults:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Unknown fault selection",
                    "invalid_faults": unknown_faults,
                    "available_faults": list(FAULT_SCENARIOS),
                },
            )

        if "low_voltage" in faults and "over_voltage" in faults:
            raise HTTPException(
                status_code=400,
                detail="Low-voltage and over-voltage cannot occur in the same sample.",
            )

        if faults:
            values = [400, 35, 45]
            for fault in faults:
                fault_values = FAULT_SCENARIOS[fault]
                if fault in {"low_voltage", "over_voltage"}:
                    values[0] = fault_values[0]
                elif fault == "over_current":
                    values[1] = fault_values[1]
                elif fault == "over_temperature":
                    values[2] = fault_values[2]

            voltage, current, temperature = values
            scenario_name = faults[0] if len(faults) == 1 else "combined"
        else:
            voltage, current, temperature = generate_realistic_reading()
            scenario_name = "normal"
    else:
        scenario = scenario or "normal"

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

        scenario_name = scenario

    # Encode simulated readings into a CAN frame
    frame = make_demo_frame(voltage, current, temperature)

    # Decode the frame using the existing DBC decoder
    readings = decode_can_frame(0x100, frame)
    timestamp = time.time()

    with _can_history_lock:
        _sample_count += 1
        sample_index = _sample_count
        can_message = {
            "timestamp": timestamp,
            "sample_index": sample_index,
            "source_type": "SIMULATED_CAN",
            "can_id": readings["can_id"],
            "message_name": readings["message_name"],
            "source_ecu": readings["source_ecu"],
            "dlc": readings["dlc"],
            "data": " ".join(f"{byte:02X}" for byte in frame),
            "decoded_signals": readings["decoded_signals"],
            "decode_status": readings["decode_status"],
            "decode_error": readings["decode_error"],
        }
        _can_history.append(can_message)

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
        "can_message": can_message,
        "scenario": scenario_name,
        "faults": faults if faults is not None else [],
        "sample_index": sample_index,
        "timestamp": timestamp,
    }


@app.get("/api/can/messages")
def get_can_messages(
    ecu: Annotated[str | None, Query()] = None,
    can_id: Annotated[str | None, Query()] = None,
    message_name: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
):
    """Return a bounded, newest-first view of decoded simulated CAN frames."""
    requested_id = None
    if can_id is not None:
        try:
            requested_id = int(can_id, 0)
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail="CAN ID must be a decimal or hexadecimal identifier.",
            ) from error

        if not 0 <= requested_id <= 0x1FFFFFFF:
            raise HTTPException(
                status_code=400,
                detail="CAN ID must be in the valid 29-bit identifier range.",
            )

    with _can_history_lock:
        messages = list(reversed(_can_history))

    if ecu:
        ecu_filter = ecu.strip().casefold()
        messages = [
            message for message in messages
            if (message["source_ecu"] or "").casefold() == ecu_filter
        ]

    if requested_id is not None:
        messages = [
            message for message in messages
            if int(message["can_id"], 16) == requested_id
        ]

    if message_name:
        name_filter = message_name.strip().casefold()
        messages = [
            message for message in messages
            if name_filter in (message["message_name"] or "").casefold()
        ]

    return {
        "source": "SIMULATED_CAN",
        "history_limit": _can_history.maxlen,
        "count": min(len(messages), limit),
        "messages": messages[:limit],
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
