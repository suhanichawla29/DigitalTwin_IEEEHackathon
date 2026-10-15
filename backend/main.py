
from pathlib import Path
import sys
import time
import random
import threading
import math
import os
import uuid
from collections import deque
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

# Make the backend folder available for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from can_decoder import decode_can_frame, encode_can_frame
from diagnostics import diagnose
from fault_lab import (
    CAN_ACTIVITY_FRAMES_PER_SAMPLE,
    CAN_POLL_WINDOW_SECONDS,
    CAN_ACTIVITY_THRESHOLD_PER_SECOND,
    SCENARIOS as FAULT_LAB_SCENARIOS,
    FaultSimulationLab,
)
from predictor import (
    FailurePredictor,
    HORIZON_SECONDS,
)
from battery_predictor import BatteryCapacityPredictor
from syncan_predictor import SIGNAL_COUNTS, SynCANPredictor
from ev_simulator_predictor import EVSimulatorAnomalyPredictor
from telemetry_store import DATABASE_PATH, TelemetryStore
from manual_lab import (
    MANUAL_SOURCES,
    SUPPORTED_UNITS,
    ManualBatchInput,
    ManualLabStore,
    ManualReadingInput,
    validation_errors,
)
from forecasting import (
    MAX_HISTORY as FORECAST_MAX_HISTORY,
    MIN_HISTORY as FORECAST_MIN_HISTORY,
    build_forecast_status,
    build_multilevel_forecast,
)
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
_episode_id = uuid.uuid4().hex
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
ev_simulator_predictor = EVSimulatorAnomalyPredictor()
telemetry_store = TelemetryStore(DATABASE_PATH)
fault_lab = FaultSimulationLab(DATABASE_PATH)
manual_lab_store = ManualLabStore(DATABASE_PATH)
manual_ev_simulator_predictor = EVSimulatorAnomalyPredictor()


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


def _advance_fault_lab(step):
    """Apply exact, repeatable scenario changes to the current simulator baseline."""
    scenario_id = step["scenario_id"]
    baseline = step["baseline"]
    tick = step["tick"]
    values = dict(baseline)

    if scenario_id == "battery_temperature_rise":
        values["temperature"] = min(
            110.0,
            baseline["temperature"] + tick * 2.5,
        )
    elif scenario_id == "battery_voltage_drop":
        values["voltage"] = max(
            240.0,
            baseline["voltage"] - tick * 7.0,
        )
    elif scenario_id == "temperature_sensor_failure":
        values["temperature"] = None

    simulation.sample_index += 1
    simulation.values.update({
        key: value
        for key, value in values.items()
        if value is not None
    })
    return values


@app.post("/api/fault-lab/start")
def start_fault_lab(payload: dict):
    scenario_id = payload.get("scenario_id")
    if not isinstance(scenario_id, str) or scenario_id not in FAULT_LAB_SCENARIOS:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Unknown fault-lab scenario.",
                "available_scenarios": list(FAULT_LAB_SCENARIOS),
            },
        )
    with _episode_lock:
        if fault_lab.active is not None:
            raise HTTPException(
                status_code=409,
                detail="A fault-lab scenario is already active.",
            )
        simulation.reset()
        predictor.reset()
        ev_simulator_predictor.reset()
        try:
            return fault_lab.start(
                scenario_id,
                simulation.values,
                time.time(),
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/fault-lab/stop")
def stop_fault_lab():
    with _episode_lock:
        try:
            return fault_lab.stop(time.time())
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/fault-lab/reset")
def reset_fault_lab():
    with _episode_lock:
        fault_lab.recover(time.time())
        simulation.reset()
        predictor.reset()
        ev_simulator_predictor.reset()
        return fault_lab.snapshot()


@app.get("/api/fault-lab/status")
def get_fault_lab_status():
    return fault_lab.snapshot()


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
        lab_step = fault_lab.advance()
        if lab_step is not None:
            selected_scenario = "fault-lab:" + lab_step["scenario_id"]
            values = _advance_fault_lab(lab_step)
        else:
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
            values = simulation.advance()

        _sample_count += 1
        sample_timestamp = time.time()
        sample_id = f"{_episode_id}:{_sample_count}"
        sensor_available = values["temperature"] is not None
        if sensor_available:
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
        else:
            readings = {
                "can_id": "0x100",
                "message_name": "ECU_Telemetry",
                "source_ecu": "ECU",
                "dlc": 0,
                "payload_hex": "",
                "payload_bytes": [],
                "decoded_signals": [],
                "decode_status": "error",
                "error": (
                    "Temperature sensor reading is unavailable; no telemetry "
                    "frame was encoded for this sample."
                ),
                "voltage": values["voltage"],
                "current": values["current"],
                "temperature": None,
            }
        if (
            ev_simulator_predictor.model is None
            and ev_simulator_predictor.error is None
        ):
            ev_simulator_predictor.reload()
        syncan_available = bool(syncan_predictor.models)
        active_lab = lab_step is not None
        burst_size = (
            CAN_ACTIVITY_FRAMES_PER_SAMPLE
            if active_lab and lab_step["scenario_id"] == "abnormal_can_activity"
            else 1
        )
        ev_anomaly = ev_simulator_predictor.evaluate({
            "timestamp": sample_timestamp,
            **readings,
        })
        can_message = None
        for burst_index in range(burst_size):
            can_message = {
                "timestamp": sample_timestamp + burst_index * 0.01,
                "sample_id": sample_id,
                "burst_index": burst_index,
                "burst_size": burst_size,
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
                "error": readings.get("error"),
                "source": "SIMULATED_CAN",
                "scenario": selected_scenario,
                "ev_anomaly": ev_anomaly,
                "synCAN_status": (
                    "incompatible_features"
                    if syncan_available
                    else "model_unavailable"
                ),
                "synCAN_note": (
                    "Not evaluated: project DBC frame 0x100 provides Voltage, "
                    "Current, and Temperature, while SynCAN models require IDs "
                    "id1-id10 and ID-specific SignalN_of_ID values with Time (ms). "
                    "No validated mapping exists."
                    if syncan_available
                    else syncan_predictor.error
                    or "SynCAN model is not trained or could not be loaded."
                ),
            }
            _can_messages.append(can_message)

        if sensor_available:
            lab_run = fault_lab.active
            telemetry_store.insert_reading(
                sample_id=sample_id,
                episode_id=_episode_id,
                sample_index=_sample_count,
                timestamp=sample_timestamp,
                voltage=readings["voltage"],
                current=readings["current"],
                temperature=readings["temperature"],
                source="simulator",
                can_id=readings["can_id"],
                decoded_signals=readings["decoded_signals"],
                scenario_run_id=lab_run["run_id"] if lab_run else None,
                scenario_name=lab_run["scenario_name"] if lab_run else None,
            )
        diagnostics = diagnose(
            voltage=readings["voltage"],
            current=readings["current"],
            temperature=readings["temperature"],
            can_frame_count=burst_size,
            can_window_seconds=CAN_POLL_WINDOW_SECONDS,
        )
        prediction = (
            predictor.add_reading(readings)
            if sensor_available
            else {
                "status": "unavailable",
                "history_count": len(predictor.history),
                "window_size": predictor.history.maxlen,
                "failure_probability": None,
                "horizon_seconds": HORIZON_SECONDS,
                "sample_interval_seconds": 2,
                "model": dict(predictor.metadata),
                "message": (
                    "Prediction skipped because the temperature sensor "
                    "reading is unavailable."
                ),
            }
        )
        lab_status = fault_lab.record_sample(
            timestamp=sample_timestamp,
            readings=readings,
            diagnostics=diagnostics,
            detector_output=ev_anomaly,
            can_frame_count=burst_size,
        )

    dataset_models = get_dataset_model_status()
    recent_telemetry = telemetry_store.recent_readings(
        limit=FORECAST_MAX_HISTORY,
        before=sample_timestamp,
        source="simulator",
    )
    total_telemetry_count = telemetry_store.count(
        before=sample_timestamp,
        source="simulator",
    )
    forecasts = build_multilevel_forecast(
        recent_telemetry,
        as_of=sample_timestamp,
        minimum_history=FORECAST_MIN_HISTORY,
        nasa_model_status=dataset_models["nasa_battery_capacity"],
        total_history_count=total_telemetry_count,
    )
    if not sensor_available:
        for horizon_name in ("short_term", "medium_term"):
            horizon = forecasts[horizon_name]
            horizon["signals"]["temperature"].update({
                "actual": None,
                "predicted": None,
                "trend": "unavailable",
                "slope_per_second": None,
                "warning_assessment": [{
                    "status": "sensor_unavailable",
                    "message": (
                        "Temperature forecast unavailable while the simulated "
                        "temperature sensor is missing."
                    ),
                }],
            })
            for point in horizon["forecast_series"]:
                point["temperature"] = None
    return {
        **readings,
        "ecu_status": diagnostics["status"],
        "diagnostics": diagnostics,
        "source": "SIMULATED_CAN",
        "scenario": selected_scenario,
        "faults": faults if faults is not None else [],
        "sample_id": sample_id,
        "sample_index": _sample_count,
        "timestamp": sample_timestamp,
        "can_message": can_message,
        "can_messages": list(_can_messages),
        "sensor_availability": {
            "voltage": True,
            "current": True,
            "temperature": sensor_available,
        },
        "fault_lab": lab_status,
        "prediction": prediction,
        "dataset_models": dataset_models,
        "live_can_detector": ev_simulator_detector_status(),
        "forecasts": forecasts,
    }


@app.get("/api/telemetry/history")
def get_telemetry_history(
    limit: Annotated[int, Query(ge=1, le=FORECAST_MAX_HISTORY)] = 100,
    before: Annotated[float | None, Query()] = None,
    source: Annotated[str, Query()] = "simulator",
):
    """Return recent persisted simulator readings in chronological order."""
    if before is not None and not math.isfinite(before):
        raise HTTPException(
            status_code=400,
            detail="before must be a finite Unix timestamp in seconds.",
        )
    if source not in {"simulator", *MANUAL_SOURCES}:
        raise HTTPException(
            status_code=400,
            detail="source must be simulator, manual, or preset_simulated.",
        )
    try:
        readings = telemetry_store.recent_readings(
            limit=limit,
            before=before,
            source=source,
        )
        count = telemetry_store.count(before=before, source=source)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {
        "status": "ok",
        "database": str(DATABASE_PATH),
        "source": source,
        "count": count,
        "returned": len(readings),
        "limit": limit,
        "before": before,
        "readings": readings,
    }


def _current_forecast(source="simulator"):
    as_of = time.time()
    readings = telemetry_store.recent_readings(
        limit=FORECAST_MAX_HISTORY,
        before=as_of,
        source=source,
    )
    total_history_count = telemetry_store.count(
        before=as_of,
        source=source,
    )
    dataset_models = get_dataset_model_status()
    return (
        readings,
        as_of,
        dataset_models["nasa_battery_capacity"],
        total_history_count,
    )


@app.get("/api/forecast/multilevel")
def get_multilevel_forecast(
    source: Annotated[str, Query()] = "simulator",
):
    """Return current 30-second, five-minute, and supported long-term status."""
    if source not in {"simulator", *MANUAL_SOURCES}:
        raise HTTPException(
            status_code=400,
            detail="source must be simulator, manual, or preset_simulated.",
        )
    readings, as_of, nasa_status, total_history_count = _current_forecast(source)
    return build_multilevel_forecast(
        readings,
        as_of=as_of,
        minimum_history=FORECAST_MIN_HISTORY,
        nasa_model_status=nasa_status,
        total_history_count=total_history_count,
    )


@app.get("/api/forecast/status")
def get_forecast_status(
    source: Annotated[str, Query()] = "simulator",
):
    """Return readiness and sample requirements for each forecast horizon."""
    if source not in {"simulator", *MANUAL_SOURCES}:
        raise HTTPException(
            status_code=400,
            detail="source must be simulator, manual, or preset_simulated.",
        )
    readings, as_of, nasa_status, total_history_count = _current_forecast(source)
    return build_forecast_status(
        readings,
        as_of=as_of,
        minimum_history=FORECAST_MIN_HISTORY,
        nasa_model_status=nasa_status,
        total_history_count=total_history_count,
    )


def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _invalid_manual_result(payload, errors, *, source=None, key=None):
    safe_payload = _json_safe(payload)
    provided_key = (
        key or (
            safe_payload.get("idempotency_key")
            if isinstance(safe_payload, dict)
            else None
        )
    )
    if not isinstance(provided_key, str) or not provided_key.strip():
        provided_key = uuid.uuid4().hex
    provided_key = provided_key[:128]
    existing = manual_lab_store.get(provided_key)
    if existing is not None:
        if existing["submitted"] != safe_payload:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key was already used for a different submission.",
            )
        return existing

    source_value = source or (
        safe_payload.get("source")
        if isinstance(safe_payload, dict)
        else None
    )
    if source_value not in MANUAL_SOURCES:
        source_value = "manual"
    result = {
        "status": "invalid_input",
        "assessment": {
            "status": "invalid_input",
            "label": "Invalid input",
        },
        "errors": errors,
        "event_ids": [],
    }
    record = {
        "idempotency_key": provided_key,
        "event_id": None,
        "source": source_value,
        "timestamp": None,
        "submission_status": "invalid_input",
        "submitted": safe_payload,
        "validation": {"valid": False, "errors": errors},
        "result": result,
        "created_at": time.time(),
    }
    manual_lab_store.save(record)
    return record


def _parse_manual_can(can_id, raw_payload):
    if can_id is None:
        return None
    try:
        can_value = (
            int(can_id, 0)
            if isinstance(can_id, str)
            else int(can_id)
        )
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("CAN ID must be a decimal or 0x-prefixed integer") from error
    if not 0 <= can_value <= 0x1FFFFFFF:
        raise ValueError("CAN ID must be between 0x000 and 0x1FFFFFFF")
    if not isinstance(raw_payload, str):
        raise ValueError("CAN payload must be hexadecimal text")
    compact = "".join(
        character for character in raw_payload
        if character not in " \t\r\n:-_"
    )
    if not compact or len(compact) % 2:
        raise ValueError("CAN payload must contain complete hexadecimal bytes")
    try:
        payload = bytes.fromhex(compact)
    except ValueError as error:
        raise ValueError(
            "CAN payload must contain hexadecimal byte pairs"
        ) from error
    if len(payload) > 8:
        raise ValueError(
            "This project DBC uses classic CAN and supports payloads up to 8 bytes"
        )
    decoded = decode_can_frame(can_value, payload)
    if decoded["decode_status"] != "decoded":
        raise ValueError(
            "CAN frame is not compatible with the project DBC: "
            + decoded.get("error", "decoder rejected the frame")
        )
    if not {"Voltage", "Current", "Temperature"}.issubset(
        {signal["name"] for signal in decoded["decoded_signals"]}
    ):
        raise ValueError(
            "Decoded CAN message does not contain the supported EV telemetry signals"
        )
    return decoded


def _process_manual_reading(payload, *, can_frame_count=0):
    safe_payload = _json_safe(payload)
    try:
        reading_input = ManualReadingInput.model_validate(payload)
    except ValidationError as error:
        return _invalid_manual_result(
            payload,
            validation_errors(error),
        )

    idempotency_key = reading_input.idempotency_key
    source_name = reading_input.source
    existing = manual_lab_store.get(idempotency_key)
    if existing is not None:
        if existing["submitted"] != safe_payload:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key was already used for a different submission.",
            )
        return existing

    timestamp = reading_input.timestamp_seconds()
    if not math.isfinite(timestamp) or timestamp < 0:
        return _invalid_manual_result(
            payload,
            [{"field": "timestamp", "message": "timestamp must be a non-negative finite Unix time"}],
            source=source_name,
            key=idempotency_key,
        )
    if manual_lab_store.has_timestamp(source_name, timestamp):
        return _invalid_manual_result(
            payload,
            [{
                "field": "timestamp",
                "message": (
                    "A processed submission from this source already uses "
                    "this timestamp."
                ),
            }],
            source=source_name,
            key=idempotency_key,
        )

    values = {
        "voltage": reading_input.voltage,
        "current": reading_input.current,
        "temperature": reading_input.temperature,
    }
    can_result = {"status": "not_provided"}
    decoded_frame = None
    if reading_input.can_id is not None:
        try:
            decoded_frame = _parse_manual_can(
                reading_input.can_id,
                reading_input.raw_payload,
            )
        except ValueError as error:
            return _invalid_manual_result(
                payload,
                [{"field": "raw_payload", "message": str(error)}],
                source=source_name,
                key=idempotency_key,
            )
        decoded_values = {
            "voltage": decoded_frame["voltage"],
            "current": decoded_frame["current"],
            "temperature": decoded_frame["temperature"],
        }
        conflicts = [
            name for name, value in values.items()
            if value is not None and abs(value - decoded_values[name]) > 0.051
        ]
        if conflicts:
            return _invalid_manual_result(
                payload,
                [{
                    "field": name,
                    "message": (
                        "Submitted value conflicts with the decoded CAN "
                        "signal; the valid DBC frame is authoritative."
                    ),
                } for name in conflicts],
                source=source_name,
                key=idempotency_key,
            )
        values = decoded_values
        can_result = {
            "status": "decoded",
            "can_id": decoded_frame["can_id"],
            "message_name": decoded_frame["message_name"],
            "dlc": decoded_frame["dlc"],
            "payload_hex": decoded_frame["payload_hex"],
            "decoded_signals": decoded_frame["decoded_signals"],
            "source_ecu": decoded_frame["source_ecu"],
        }

    missing_fields = [
        name for name, value in values.items()
        if value is None
    ]
    validation = {
        "valid": True,
        "errors": [],
        "missing_fields": missing_fields,
        "units": dict(SUPPORTED_UNITS),
        "normalization": (
            "Timestamp normalized to Unix seconds; sensor values use "
            "the project's DBC physical ranges."
        ),
    }
    if decoded_frame is not None:
        decoded_frame["timestamp"] = timestamp
        detector_frame = decoded_frame
    elif not missing_fields:
        try:
            encoded = make_demo_frame(
                values["voltage"],
                values["current"],
                values["temperature"],
            )
            detector_frame = {
                **decode_can_frame(0x100, encoded),
                "timestamp": timestamp,
            }
        except (KeyError, TypeError, ValueError) as error:
            return _invalid_manual_result(
                payload,
                [{"field": "readings", "message": str(error)}],
                source=source_name,
                key=idempotency_key,
            )
    else:
        detector_frame = None

    diagnostics = diagnose(
        values["voltage"],
        values["current"],
        values["temperature"],
        can_frame_count=can_frame_count,
        can_window_seconds=CAN_POLL_WINDOW_SECONDS,
    )
    previous = manual_lab_store.previous_reading(source_name, timestamp)
    comparisons = {}
    if previous is not None:
        for name in ("voltage", "current", "temperature"):
            current_value = values[name]
            previous_value = previous["values"][
                ("voltage", "current", "temperature").index(name)
            ]
            if current_value is not None:
                comparisons[name] = {
                    "previous": previous_value,
                    "change": current_value - previous_value,
                    "unit": SUPPORTED_UNITS[name],
                    "previous_timestamp": previous["timestamp"],
                }
    if detector_frame is None:
        model_result = {
            "status": "incompatible_input",
            "source": "project EV simulator DBC-encoded episodes",
            "reason": (
                "The EV simulator model requires Voltage, Current, and "
                "Temperature from a compatible decoded DBC frame."
            ),
        }
    elif (
        manual_ev_simulator_predictor.model is None
        and manual_ev_simulator_predictor.error is None
    ):
        manual_ev_simulator_predictor.reload()
        if previous is None:
            manual_ev_simulator_predictor.reset()
        model_result = manual_ev_simulator_predictor.evaluate(
            detector_frame,
            previous=previous,
        )
    else:
        if previous is None:
            manual_ev_simulator_predictor.reset()
        model_result = manual_ev_simulator_predictor.evaluate(
            detector_frame,
            previous=previous,
        )

    threshold_rules = [
        {
            "code": fault["code"],
            "label": fault["label"],
            "severity": fault["severity"],
            "observed": (
                None if fault["code"] == "temperature-sensor-failure"
                else values.get({
                    "over-temperature": "temperature",
                    "over-current": "current",
                    "under-voltage": "voltage",
                    "over-voltage": "voltage",
                }.get(fault["code"], ""))
            ),
            "threshold": fault.get("threshold"),
            "limit": fault.get("limit"),
            "unit": fault.get("unit"),
            "description": fault["description"],
        }
        for fault in diagnostics["faults"]
    ]
    critical = any(rule["severity"] == "critical" for rule in threshold_rules)
    warning = bool(threshold_rules)
    assessment_status = (
        "critical" if critical else
        "warning" if warning else
        "insufficient_data" if missing_fields else
        "normal"
    )
    if model_result.get("status") == "evaluated" and model_result.get("is_anomaly"):
        model_category = "model_detected_anomaly"
    elif model_result.get("status") == "evaluated":
        model_category = "normal"
    elif model_result.get("status") in {"warming_up", "incompatible_input"}:
        model_category = "insufficient_data"
    else:
        model_category = model_result.get("status", "model_unavailable")

    event_id = (
        uuid.uuid4().hex
        if threshold_rules or model_category == "model_detected_anomaly"
        else None
    )
    result = {
        "status": "processed",
        "source": source_name,
        "timestamp": timestamp,
        "normalized_readings": values,
        "units": dict(SUPPORTED_UNITS),
        "validation": validation,
        "assessment": {
            "status": assessment_status,
            "label": {
                "normal": "Normal",
                "warning": "Warning",
                "critical": "Critical",
                "insufficient_data": "Insufficient data",
            }[assessment_status],
            "model_result": model_category,
        },
        "diagnostics": diagnostics,
        "triggered_rules": threshold_rules,
        "model_result": model_result,
        "can_result": can_result,
        "comparison": comparisons,
        "missing_fields": missing_fields,
        "limitations": [
            "Rule thresholds are illustrative prototype limits, not vehicle safety limits.",
            "A single reading cannot establish battery failure, state of health, or remaining useful life.",
            "The EV model score is a classifier score for simulator-generated labels, not a real-world probability.",
        ],
        "suggested_checks": [
            "Suggestion only: verify the submitted sensor value, unit, timestamp, and source."
        ] if threshold_rules or missing_fields else [],
        "event_ids": [event_id] if event_id else [],
    }
    if model_category == "model_detected_anomaly":
        result["suggested_checks"].append(
            "Suggestion only: compare this sample with adjacent compatible readings."
        )
    record = {
        "idempotency_key": idempotency_key,
        "event_id": event_id,
        "source": source_name,
        "timestamp": timestamp,
        "submission_status": "processed",
        "submitted": safe_payload,
        "validation": validation,
        "result": result,
        "created_at": time.time(),
    }

    if not missing_fields:
        sample_index = max(1, int(round(timestamp * 1_000_000)))
        telemetry_store.insert_reading(
            sample_id="manual:" + idempotency_key,
            episode_id="manual:" + source_name,
            sample_index=sample_index,
            timestamp=timestamp,
            voltage=values["voltage"],
            current=values["current"],
            temperature=values["temperature"],
            source=source_name,
            can_id=can_result.get("can_id"),
            decoded_signals=(
                can_result.get("decoded_signals")
                if can_result["status"] == "decoded"
                else detector_frame["decoded_signals"]
            ),
        )
    manual_lab_store.save(record)
    return record


@app.post("/api/manual/readings")
def submit_manual_reading(payload: dict):
    """Validate and diagnose one explicitly manual or simulated-preset sample."""
    return _process_manual_reading(payload)


@app.post("/api/manual/readings/batch")
def submit_manual_batch(payload: dict):
    """Process valid CSV-derived rows in chronological order and report failures."""
    try:
        batch = ManualBatchInput.model_validate(payload)
    except ValidationError as error:
        raise HTTPException(
            status_code=422,
            detail=validation_errors(error),
        ) from error
    indexed_rows = list(enumerate(batch.rows))
    parsed_rows = []
    invalid = {}
    seen_keys = set()
    seen_timestamps = set()
    for index, row in indexed_rows:
        try:
            validated = ManualReadingInput.model_validate(row)
        except ValidationError as error:
            invalid[index] = _invalid_manual_result(
                row,
                validation_errors(error),
            )
            continue
        if validated.idempotency_key in seen_keys:
            invalid[index] = _invalid_manual_result(
                row,
                [{
                    "field": "idempotency_key",
                    "message": "Each row in a batch must have a unique idempotency key.",
                }],
            )
            continue
        seen_keys.add(validated.idempotency_key)
        stamp = validated.timestamp_seconds()
        timestamp_key = (validated.source, stamp)
        if timestamp_key in seen_timestamps:
            invalid[index] = _invalid_manual_result(
                row,
                [{
                    "field": "timestamp",
                    "message": "Duplicate timestamp in this batch; edit or skip this row.",
                }],
                source=validated.source,
                key=validated.idempotency_key,
            )
            continue
        seen_timestamps.add(timestamp_key)
        parsed_rows.append((index, row, stamp))

    parsed_rows.sort(key=lambda entry: (entry[2], entry[0]))
    ordered_results = dict(invalid)
    for index, row, timestamp in parsed_rows:
        frame_count = 0
        for _, other, other_timestamp in parsed_rows:
            if (
                other_timestamp > timestamp
                or timestamp - other_timestamp > CAN_POLL_WINDOW_SECONDS
                or other.get("can_id") is None
            ):
                continue
            try:
                _parse_manual_can(
                    other.get("can_id"),
                    other.get("raw_payload"),
                )
            except ValueError:
                continue
            frame_count += 1
        try:
            ordered_results[index] = _process_manual_reading(
                row,
                can_frame_count=frame_count,
            )
        except HTTPException as error:
            if error.status_code != 409:
                raise
            ordered_results[index] = _invalid_manual_result(
                row,
                [{
                    "field": "idempotency_key",
                    "message": str(error.detail),
                }],
            )

    results = [
        {
            "row": index + 1,
            **ordered_results[index],
        }
        for index in range(len(batch.rows))
    ]
    return {
        "status": (
            "processed" if all(
                item["submission_status"] == "processed"
                for item in results
            ) else "partial"
        ),
        "submitted": len(batch.rows),
        "processed": sum(
            item["submission_status"] == "processed"
            for item in results
        ),
        "invalid": sum(
            item["submission_status"] == "invalid_input"
            for item in results
        ),
        "results": results,
    }


@app.get("/api/manual/history")
def get_manual_history(
    source: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
):
    if source is not None and source not in MANUAL_SOURCES:
        raise HTTPException(
            status_code=400,
            detail="source must be manual or preset_simulated.",
        )
    rows = manual_lab_store.history(source=source, limit=limit)
    return {
        "status": "ok",
        "source": source or "manual_lab",
        "count": len(rows),
        "submissions": rows,
    }


@app.get("/api/manual/submissions/{idempotency_key}")
def get_manual_submission(idempotency_key: str):
    result = manual_lab_store.get(idempotency_key)
    if result is None:
        raise HTTPException(status_code=404, detail="Manual submission not found.")
    return result


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
        cleared_at = time.time()
    return {"status": "cleared", "count": 0, "cleared_at": cleared_at}


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


def ev_simulator_detector_status():
    if ev_simulator_predictor.model is None and ev_simulator_predictor.error is None:
        ev_simulator_predictor.reload()
    return ev_simulator_predictor.status()


def syncan_offline_evaluation_status():
    metadata = syncan_predictor.metadata
    evaluation = metadata.get("evaluation")
    return {
        "status": "available" if isinstance(evaluation, dict) else "unavailable",
        "source": metadata.get("source", "ETAS SynCAN dataset"),
        "label_meaning": {
            "0": "normal",
            "1": "intrusion",
            "model_prediction_-1": "anomaly",
            "model_prediction_1": "normal",
        },
        "metrics": evaluation,
        "by_test_file": metadata.get("evaluation_by_test_file"),
        "note": (
            "Offline evaluation uses SynCAN test archives; it does not evaluate "
            "live project DBC frames."
        ),
    }


@app.get("/api/models")
def get_models():
    """Report dataset models separately from live simulated-CAN evaluation."""
    return {
        "dataset_models": get_dataset_model_status(),
        "syncan_offline_evaluation": syncan_offline_evaluation_status(),
        "live_can_detector": ev_simulator_detector_status(),
    }


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
    can_id = record.get("ID")
    if (
        not isinstance(can_id, str)
        or can_id.strip().casefold() not in SIGNAL_COUNTS
    ):
        provided_id = can_id if can_id is not None else record.get("can_id")
        raise HTTPException(
            status_code=400,
            detail=(
                f"Incompatible input ID {provided_id!r}; expected a SynCAN "
                "ID from id1 through id10 and its Time and "
                "SignalN_of_ID fields."
            ),
        )
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
        "syncan_offline_evaluation": syncan_offline_evaluation_status(),
        "live_can_detector": ev_simulator_detector_status(),
    }


@app.post("/api/reset")
def reset_simulation():
    """Start a new independent episode and clear the predictor's rolling window."""
    global _sample_count, _episode_id

    with _episode_lock:
        fault_lab.recover(time.time())
        simulation.reset()
        predictor.reset()
        ev_simulator_predictor.reset()
        _can_messages.clear()
        _sample_count = 0
        _episode_id = uuid.uuid4().hex

    return {
        "status": "reset",
        "model_status": "ready" if predictor.model is not None else "unavailable",
        "history_count": 0,
    }
