
from pathlib import Path
import sys
import time
import random
import threading
import math
import os
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# Make the backend folder available for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from can_decoder import decode_can_frame
from diagnostics import diagnose
from predictor import (
    FailurePredictor,
    HORIZON_SECONDS,
)

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

_sample_count = 0
SIMULATION_SPEED = float(os.environ.get("EV_SIMULATION_SPEED", "1.0"))
if not math.isfinite(SIMULATION_SPEED) or SIMULATION_SPEED <= 0:
    raise ValueError("EV_SIMULATION_SPEED must be a positive finite number")

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
    "gradual_degradation": (390, 42, 52),
    "severe_degradation": (340, 75, 70),
    "low_voltage": (270, 35, 45),
    "over_voltage": (450, 35, 45),
    "over_current": (400, 120, 45),
    "over_temperature": (400, 35, 85),
    "multiple_faults": (270, 120, 85),
}

FAILURE_SCENARIOS = {
    "normal",
    "gradual_degradation",
    "severe_degradation",
    "low_voltage",
    "over_voltage",
    "over_current",
    "over_temperature",
    "multiple_faults",
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


class SimulationState:
    """Persistent gradual telemetry state for one independent demo episode."""

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
            "voltage": self.random.uniform(395, 405),
            "current": self.random.uniform(32, 38),
            "temperature": self.random.uniform(42, 48),
        }
        self.values = dict(self.baseline)
        self.scenario = "normal"
        self.faults = ()
        self.sample_index = 0

    def select(self, scenario, faults):
        if scenario not in FAILURE_SCENARIOS:
            raise ValueError(f"Unsupported simulation scenario: {scenario}")

        if scenario == "multiple_faults":
            faults = (
                "low_voltage",
                "over_current",
                "over_temperature",
            )
        elif scenario in FAULT_SCENARIOS:
            faults = (scenario,)

        if scenario in {"normal", "gradual_degradation", "severe_degradation"}:
            faults = ()

        self.scenario = scenario
        self.faults = tuple(faults)

    def _rates(self):
        if self.scenario == "gradual_degradation":
            rates = {"voltage": -0.18, "current": 0.12, "temperature": 0.07}
            return self._scaled_rates(rates)
        if self.scenario == "severe_degradation":
            rates = {"voltage": -0.72, "current": 0.48, "temperature": 0.28}
            return self._scaled_rates(rates)

        rates = {"voltage": 0.0, "current": 0.0, "temperature": 0.0}
        if "low_voltage" in self.faults:
            rates["voltage"] = -0.9
        if "over_voltage" in self.faults:
            rates["voltage"] = 0.45
        if "over_current" in self.faults:
            rates["current"] = 0.65
        if "over_temperature" in self.faults:
            rates["temperature"] = 0.4
        return self._scaled_rates(rates)

    @staticmethod
    def _scaled_rates(rates):
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
                # Recover gradually after switching back to Normal.
                difference = self.baseline[signal] - value
                recovery_limit = 1.2 * SIMULATION_SPEED
                rate = max(
                    -recovery_limit,
                    min(
                        recovery_limit,
                        difference * 0.04 * SIMULATION_SPEED,
                    ),
                )

            self.values[signal] = max(
                0.0,
                min(1000.0, value + rate),
            )
            reading[signal] = round(
                self.values[signal] +
                self.random.gauss(0, self.NOISE[signal]),
                2,
            )

        self.sample_index += 1
        return reading


_episode_lock = threading.RLock()
simulation = SimulationState()
predictor = FailurePredictor()


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
      /api/readings?scenario=gradual_degradation
    """
    global _sample_count

    scenario_was_provided = scenario is not None
    scenario = scenario or "normal"
    if scenario not in SCENARIOS:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Unknown scenario",
                "available_scenarios": list(SCENARIOS.keys()),
            },
        )

    if faults is not None and scenario_was_provided:
        raise HTTPException(
            status_code=400,
            detail="Use either scenario or faults, not both.",
        )

    if faults is not None:
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

        if {"low_voltage", "over_voltage"}.issubset(faults):
            raise HTTPException(
                status_code=400,
                detail="Low-voltage and over-voltage cannot be selected together.",
            )

    with _episode_lock:
        if faults is not None:
            selected_scenario = (
                "normal" if not faults
                else faults[0] if len(faults) == 1
                else "combined"
            )
            state_scenario = (
                "normal" if not faults
                else "multiple_faults" if set(faults) == {
                    "low_voltage",
                    "over_current",
                    "over_temperature",
                }
                else "combined"
            )
            if state_scenario == "combined":
                simulation.scenario = state_scenario
                simulation.faults = tuple(faults)
            else:
                simulation.select(state_scenario, faults)
        else:
            selected_scenario = scenario
            if scenario == "combined":
                raise HTTPException(
                    status_code=400,
                    detail="Combined faults must be supplied as repeated faults parameters.",
                )
            simulation.select(scenario, ())

        _sample_count += 1
        values = simulation.advance()

        # The gradual synthetic sensors retain the project's CAN encoding path.
        frame = make_demo_frame(
            values["voltage"],
            values["current"],
            values["temperature"],
        )
        readings = decode_can_frame(0x100, frame)
        diagnostics = diagnose(
            voltage=readings["voltage"],
            current=readings["current"],
            temperature=readings["temperature"],
        )
        prediction = predictor.add_reading(readings)

    return {
        **readings,
        "ecu_status": diagnostics["status"],
        "diagnostics": diagnostics,
        "source": "SIMULATED_CAN",
        "scenario": selected_scenario,
        "faults": faults if faults is not None else [],
        "sample_index": _sample_count,
        "timestamp": time.time(),
        "prediction": prediction,
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
    return {
        "status": "ok",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "model": predictor.metadata,
        "model_error": predictor.model_error,
        "forecast_horizon_seconds": HORIZON_SECONDS,
    }


@app.post("/api/reset")
def reset_simulation():
    """Start a new independent episode and clear the predictor's rolling window."""
    global _sample_count

    with _episode_lock:
        simulation.reset()
        predictor.reset()
        _sample_count = 0

    return {
        "status": "reset",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "history_count": 0,
    }
