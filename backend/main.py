from pathlib import Path
import sys
import time
import math
import os
import random
import threading
from collections import deque
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, str(Path(__file__).resolve().parent))

from can_decoder import decode_can_frame
from diagnostics import diagnose
from predictor import FailurePredictor, HORIZON_SECONDS

app = FastAPI(title="EV Digital Twin API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

SIMULATION_SPEED = float(os.environ.get("EV_SIMULATION_SPEED", "1.0"))
if not math.isfinite(SIMULATION_SPEED) or SIMULATION_SPEED <= 0:
    raise ValueError("EV_SIMULATION_SPEED must be a positive finite number")

SAMPLE_INTERVAL_SECONDS = 2
CAN_HISTORY_LIMIT = 500

SCENARIOS = {
    "normal": (400, 35, 45),
    "low_voltage": (270, 35, 45),
    "over_voltage": (450, 35, 45),
    "over_current": (400, 120, 45),
    "over_temperature": (400, 35, 85),
    "multiple_faults": (270, 120, 85),
}

FAULT_SCENARIOS = {
    "low_voltage",
    "over_voltage",
    "over_current",
    "over_temperature",
}

SCENARIO_FAULTS = {
    name: (name,)
    for name in FAULT_SCENARIOS
}
SCENARIO_FAULTS["multiple_faults"] = (
    "low_voltage",
    "over_current",
    "over_temperature",
)


class SimulationState:
    """Gradual, persistent telemetry state for the current demo episode."""

    NOISE = {
        "voltage": 0.55,
        "current": 0.4,
        "temperature": 0.2,
    }

    def __init__(self, seed=None):
        self.random = random.Random(seed)
        self.reset()

    def reset(self):
        self.baseline = {
            "voltage": self.random.uniform(397, 403),
            "current": self.random.uniform(33, 37),
            "temperature": self.random.uniform(43, 47),
        }
        self.values = dict(self.baseline)
        self.faults = ()
        self.scenario = "normal"
        self.sample_index = 0

    def select(self, scenario, faults):
        self.scenario = scenario
        self.faults = tuple(faults)

    def _rates(self):
        rates = {
            "voltage": 0.0,
            "current": 0.0,
            "temperature": 0.0,
        }
        if "low_voltage" in self.faults:
            rates["voltage"] = -1.1
        elif "over_voltage" in self.faults:
            rates["voltage"] = 0.75
        if "over_current" in self.faults:
            rates["current"] = 0.75
        if "over_temperature" in self.faults:
            rates["temperature"] = 0.5
        return {
            signal: rate * SIMULATION_SPEED
            for signal, rate in rates.items()
        }

    def advance(self):
        rates = self._rates()
        reading = {}
        for signal, value in self.values.items():
            rate = rates[signal]
            if rate == 0:
                difference = self.baseline[signal] - value
                recovery_limit = 2.0 * SIMULATION_SPEED
                rate = max(
                    -recovery_limit,
                    min(
                        recovery_limit,
                        difference * 0.12 * SIMULATION_SPEED,
                    ),
                )

            self.values[signal] = max(0.0, min(1000.0, value + rate))
            reading[signal] = round(
                self.values[signal] +
                self.random.gauss(0, self.NOISE[signal]),
                2,
            )

        self.sample_index += 1
        return reading


simulation = SimulationState()
predictor = FailurePredictor()
_simulation_lock = threading.RLock()
_can_history = deque(maxlen=CAN_HISTORY_LIMIT)
_sample_count = 0


def make_demo_frame(voltage, current, temperature):
    """Encode the simulated telemetry using the existing ECU DBC layout."""
    raw_values = [
        round(voltage * 10),
        round(current * 10),
        round((temperature + 40) * 10),
    ]
    payload = bytearray()
    for value in raw_values:
        payload.extend(int(value).to_bytes(2, "little"))
    payload.extend([0, 0])
    return bytes(payload)


def _resolve_selection(scenario, faults):
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
        unknown_faults = sorted(set(faults) - FAULT_SCENARIOS)
        if unknown_faults:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Unknown fault selection",
                    "invalid_faults": unknown_faults,
                    "available_faults": sorted(FAULT_SCENARIOS),
                },
            )
        if {"low_voltage", "over_voltage"}.issubset(faults):
            raise HTTPException(
                status_code=400,
                detail="Low-voltage and over-voltage cannot be selected together.",
            )
        selected = tuple(faults)
        name = (
            "normal" if not selected
            else selected[0] if len(selected) == 1
            else "combined"
        )
        return name, selected

    name = scenario or "normal"
    if name not in SCENARIOS:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Unknown scenario",
                "available_scenarios": list(SCENARIOS),
            },
        )
    return name, SCENARIO_FAULTS.get(name, ())


@app.get("/")
def home():
    return {
        "message": "EV Digital Twin API is running",
        "docs": "/docs",
        "scenarios": list(SCENARIOS),
    }


@app.get("/api/readings")
def get_readings(
    scenario: Annotated[str | None, Query()] = None,
    faults: Annotated[list[str] | None, Query()] = None,
):
    """Advance one simulated sample and return its DBC-decoded data."""
    global _sample_count
    scenario_name, selected_faults = _resolve_selection(scenario, faults)

    with _simulation_lock:
        simulation.select(scenario_name, selected_faults)
        sensor_sample = simulation.advance()
        frame = make_demo_frame(**sensor_sample)
        readings = decode_can_frame(0x100, frame)
        if readings["decode_status"] != "decoded":
            raise RuntimeError(
                "Generated CAN telemetry did not decode: " +
                str(readings["decode_error"])
            )

        timestamp = time.time()
        _sample_count += 1
        sample_index = _sample_count
        diagnostics = diagnose(
            voltage=readings["voltage"],
            current=readings["current"],
            temperature=readings["temperature"],
        )
        prediction = predictor.add_reading(readings)
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

    return {
        **readings,
        "ecu_status": diagnostics["status"],
        "diagnostics": diagnostics,
        "prediction": prediction,
        "model_status": prediction["model_status"],
        "history_count": prediction["history_count"],
        "failure_probability": prediction["failure_probability"],
        "forecast_horizon_seconds": prediction["forecast_horizon_seconds"],
        "simulation_speed": SIMULATION_SPEED,
        "source": "SIMULATED_CAN",
        "can_message": can_message,
        "scenario": scenario_name,
        "faults": list(selected_faults),
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
    """Return bounded, newest-first simulated CAN frame history."""
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

    with _simulation_lock:
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
        "history_limit": CAN_HISTORY_LIMIT,
        "count": min(len(messages), limit),
        "messages": messages[:limit],
    }


@app.get("/api/scenarios")
def get_scenarios():
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
    return {
        "status": "ok",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "model": predictor.metadata,
        "model_error": predictor.model_error,
        "simulation_speed": SIMULATION_SPEED,
        "forecast_horizon_seconds": HORIZON_SECONDS,
    }


@app.post("/api/reset")
def reset_simulation():
    """Reset simulation episode, CAN history, and model inference window."""
    global _sample_count
    with _simulation_lock:
        simulation.reset()
        predictor.reset()
        _can_history.clear()
        _sample_count = 0
    return {
        "status": "reset",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "history_count": 0,
    }
