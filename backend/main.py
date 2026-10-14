
from pathlib import Path
import sys
import time
import random
import threading
import math
import os
from collections import deque
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# Make the backend folder available for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from can_decoder import decode_can_frame, encode_can_frame
from diagnostics import diagnose
from predictor import (
    FailurePredictor,
    HORIZON_SECONDS,
)
from battery_predictor import BatteryCapacityPredictor
from syncan_predictor import SynCANPredictor
from training.train_nasa_model import DATA_DIR as NASA_DATA_DIR
from training.train_syncan_model import (
    DATA_DIR as SYNCAN_DATA_DIR,
    TEST_FILES as SYNCAN_TEST_FILES,
    TRAIN_FILES as SYNCAN_TRAIN_FILES,
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
CAN_HISTORY_LIMIT = 100
_can_messages = deque(maxlen=CAN_HISTORY_LIMIT)
SIMULATION_SPEED = float(os.environ.get("EV_SIMULATION_SPEED", "1.0"))
if not math.isfinite(SIMULATION_SPEED) or SIMULATION_SPEED <= 0:
    raise ValueError("EV_SIMULATION_SPEED must be a positive finite number")

# --------------------------------------------------
# CAN frame encoding
# --------------------------------------------------

def make_demo_frame(voltage, current, temperature):
    """Encode the current authoritative telemetry using the project DBC."""
    return encode_can_frame(
        "ECU_Telemetry",
        {
            "Voltage": voltage,
            "Current": current,
            "Temperature": temperature,
        },
    )


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
        maximum = {"voltage": 1000.0, "current": 1000.0, "temperature": 200.0}
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
                min(maximum[signal], value + rate),
            )
            reading[signal] = round(
                max(
                    0.0,
                    min(
                        maximum[signal],
                        self.values[signal] +
                        self.random.gauss(0, self.NOISE[signal]),
                    ),
                ),
                2,
            )

        self.sample_index += 1
        return reading


_episode_lock = threading.RLock()
simulation = SimulationState()
predictor = FailurePredictor()
battery_capacity_predictor = BatteryCapacityPredictor()
syncan_predictor = SynCANPredictor()


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

        frame = make_demo_frame(
            values["voltage"],
            values["current"],
            values["temperature"],
        )
        readings = decode_can_frame(0x100, frame)
        if readings["decode_status"] != "decoded":
            raise RuntimeError(
                "DBC telemetry frame could not be decoded: "
                + readings.get("error", "unknown decoder error")
            )
        sample_timestamp = time.time()
        can_message = {
            "timestamp": sample_timestamp,
            **{
                key: readings[key]
                for key in (
                    "can_id",
                    "message_name",
                    "source_ecu",
                    "dlc",
                    "payload_hex",
                    "payload_bytes",
                    "decoded_signals",
                    "decode_status",
                )
            },
            "source": "SIMULATED_CAN",
            "synCAN_status": "not_evaluated",
            "synCAN_note": (
                "Project DBC frame has no verified mapping to SynCAN IDs/signals."
            ),
        }
        _can_messages.append(can_message)
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
        "timestamp": sample_timestamp,
        "can_message": can_message,
        "can_messages": list(_can_messages),
        "prediction": prediction,
        "dataset_models": get_dataset_model_status(),
    }


@app.get("/api/can/messages")
def get_can_messages(
    can_id: Annotated[str | None, Query()] = None,
    message_name: Annotated[str | None, Query()] = None,
):
    """Return bounded history of DBC-decoded simulated CAN frames."""
    with _episode_lock:
        messages = list(_can_messages)

    if can_id:
        normalized_id = can_id.casefold()
        messages = [
            message for message in messages
            if message["can_id"].casefold() == normalized_id
        ]
    if message_name:
        query = message_name.casefold()
        messages = [
            message for message in messages
            if query in (message["message_name"] or "").casefold()
        ]
    return {
        "source": "SIMULATED_CAN",
        "history_limit": CAN_HISTORY_LIMIT,
        "count": len(messages),
        "messages": messages,
    }


@app.delete("/api/can/messages")
def clear_can_messages():
    """Clear the bounded CAN history without resetting the simulation."""
    with _episode_lock:
        _can_messages.clear()
    return {"status": "cleared", "count": 0}


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


def _model_readiness(predictor_instance, *, dataset_status, minimum_inputs,
                     training_command, source_url):
    artifact = predictor_instance.model_path
    is_loaded = (
        predictor_instance.model is not None
        if isinstance(predictor_instance, BatteryCapacityPredictor)
        else bool(predictor_instance.models)
    )
    if not is_loaded and artifact.is_file():
        predictor_instance.reload()

    model_status = predictor_instance.status()
    load_error = model_status["load_error"]
    is_loaded = (
        predictor_instance.model is not None
        if isinstance(predictor_instance, BatteryCapacityPredictor)
        else bool(predictor_instance.models)
    )

    if load_error:
        status = "load_error"
        message = load_error
    elif is_loaded:
        status = "ready"
        message = "Model artifact loaded and verified."
    elif dataset_status["available_count"] < minimum_inputs:
        status = "missing_dataset"
        message = (
            f"Dataset files are missing. Place the required files in "
            f"{dataset_status['directory']} before training."
        )
    elif not artifact.is_file():
        status = "not_trained"
        message = (
            "Dataset files are present, but no trained model artifact exists. "
            f"Train using: {training_command}"
        )
    else:
        status = "load_error"
        message = f"Model artifact exists but did not load: {artifact}"

    return {
        **model_status,
        "status": status,
        "error": message if status != "ready" else None,
        "dataset": dataset_status,
        "training_command": training_command,
        "download_url": source_url,
        "artifact_exists": artifact.is_file(),
    }


def get_dataset_model_status():
    nasa_expected = ["B0005.mat", "B0006.mat", "B0007.mat", "B0018.mat"]
    nasa_files = sorted(path.name for path in NASA_DATA_DIR.glob("*.mat"))
    nasa_dataset = {
        "status": "present" if len(nasa_files) >= 2 else "missing",
        "directory": str(
            NASA_DATA_DIR.relative_to(Path(__file__).resolve().parent.parent)
        ),
        "expected_files": nasa_expected,
        "files_found": nasa_files,
        "missing_files": [
            filename for filename in nasa_expected
            if not (NASA_DATA_DIR / filename).is_file()
        ],
        "available_count": len(nasa_files),
        "minimum_files": 2,
    }
    syncan_expected_paths = SYNCAN_TRAIN_FILES + SYNCAN_TEST_FILES
    syncan_files = [
        path.name for path in syncan_expected_paths if path.is_file()
    ]
    syncan_dataset = {
        "status": (
            "present"
            if len(syncan_files) == len(syncan_expected_paths)
            else "missing"
        ),
        "directory": str(
            SYNCAN_DATA_DIR.relative_to(Path(__file__).resolve().parent.parent)
        ),
        "expected_files": [path.name for path in syncan_expected_paths],
        "files_found": syncan_files,
        "missing_files": [
            path.name for path in syncan_expected_paths if not path.is_file()
        ],
        "available_count": len(syncan_files),
        "minimum_files": len(syncan_expected_paths),
    }
    return {
        "nasa_battery_capacity": _model_readiness(
            battery_capacity_predictor,
            dataset_status=nasa_dataset,
            minimum_inputs=2,
            training_command=(
                ".\\.venv\\Scripts\\python.exe "
                "backend\\training\\train_nasa_model.py"
            ),
            source_url="https://data.nasa.gov/dataset/li-ion-battery-aging-datasets",
        ),
        "syncan_intrusion_detection": _model_readiness(
            syncan_predictor,
            dataset_status=syncan_dataset,
            minimum_inputs=len(syncan_expected_paths),
            training_command=(
                ".\\.venv\\Scripts\\python.exe "
                "backend\\training\\train_syncan_model.py"
            ),
            source_url="https://github.com/etas/SynCAN",
        ),
    }


@app.get("/api/models")
def get_models():
    """Report actual readiness for the separate NASA and SynCAN models."""
    return {"dataset_models": get_dataset_model_status()}


@app.post("/api/battery/capacity")
def estimate_battery_capacity(payload: dict):
    """Estimate capacity from a NASA MATLAB discharge cycle's data fields."""
    if battery_capacity_predictor.model is None:
        battery_capacity_predictor.reload()
    if battery_capacity_predictor.model is None:
        raise HTTPException(
            status_code=503,
            detail=battery_capacity_predictor.status()["load_error"]
            or "NASA battery model is not ready; see GET /api/models.",
        )
    cycle = payload.get("cycle")
    data = cycle.get("data") if isinstance(cycle, dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=400,
            detail="Expected cycle.data with NASA discharge measurement arrays.",
        )
    try:
        result = battery_capacity_predictor.estimate(data)
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {
        **result,
        "battery_id": payload.get("battery_id"),
        "cycle_index": payload.get("cycle_index"),
    }


@app.post("/api/can/anomaly")
def detect_syncan_anomaly(record: dict):
    """Score one official SynCAN-format row, not a project DBC frame."""
    if not syncan_predictor.models:
        syncan_predictor.reload()
    if not syncan_predictor.models:
        raise HTTPException(
            status_code=503,
            detail=syncan_predictor.status()["load_error"]
            or "SynCAN model is not ready; see GET /api/models.",
        )
    try:
        return syncan_predictor.score(record)
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "model": predictor.metadata,
        "model_error": predictor.model_error,
        "forecast_horizon_seconds": HORIZON_SECONDS,
        "dataset_models": get_dataset_model_status(),
    }


@app.post("/api/reset")
def reset_simulation():
    """Start a new independent episode and clear the predictor's rolling window."""
    global _sample_count

    with _episode_lock:
        simulation.reset()
        predictor.reset()
        _can_messages.clear()
        _sample_count = 0

    return {
        "status": "reset",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "history_count": 0,
    }
