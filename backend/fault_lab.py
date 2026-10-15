"""Deterministic, persisted fault-injection runs for the EV simulator."""

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import threading
import time
import uuid


SCENARIOS = {
    "battery_temperature_rise": {
        "name": "Battery temperature rise",
        "component": "thermal",
        "description": "Deterministic temperature increase from the current simulated baseline.",
        "recommendation": "Suggestion: inspect simulated thermal control and cooling response.",
        "threshold": "Temperature > 80 °C",
    },
    "battery_voltage_drop": {
        "name": "Battery voltage drop",
        "component": "battery",
        "description": "Deterministic voltage decrease from the current simulated baseline.",
        "recommendation": "Suggestion: inspect simulated battery voltage and load behavior.",
        "threshold": "Voltage < 300 V",
    },
    "temperature_sensor_failure": {
        "name": "Temperature sensor failure",
        "component": "thermal",
        "description": "Temperature is omitted as unavailable; no replacement value is generated.",
        "recommendation": "Suggestion: inspect the simulated temperature sensor and signal path.",
        "threshold": "Temperature signal must be present and finite",
    },
    "abnormal_can_activity": {
        "name": "Abnormal CAN message activity",
        "component": "vcu",
        "description": "Six valid DBC-encoded telemetry frames are emitted per two-second poll.",
        "recommendation": "Suggestion: inspect simulated CAN message rate and bus load.",
        "threshold": "More than 2 telemetry frames per second",
    },
}

CAN_ACTIVITY_FRAMES_PER_SAMPLE = 6
CAN_POLL_WINDOW_SECONDS = 2.0
CAN_ACTIVITY_THRESHOLD_PER_SECOND = 2.0


class FaultSimulationLab:
    def __init__(self, database_path):
        self.database_path = Path(database_path)
        self.lock = threading.RLock()
        self.active = None
        self.latest = None
        self.initialize()

    def _connect(self):
        return sqlite3.connect(self.database_path, timeout=10)

    def initialize(self):
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS fault_lab_runs (
                    run_id TEXT PRIMARY KEY,
                    scenario_id TEXT NOT NULL,
                    scenario_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    stopped_at REAL,
                    first_abnormal_at REAL,
                    detection_at REAL,
                    detected INTEGER,
                    baseline_json TEXT NOT NULL,
                    latest_reading_json TEXT,
                    first_abnormal_reading_json TEXT,
                    detection_reading_json TEXT,
                    timeline_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_fault_lab_runs_started
                ON fault_lab_runs (started_at DESC)
                """
            )
            connection.commit()
        recent = self.recent_runs(limit=1)
        self.latest = recent[0] if recent else None
        if self.latest and self.latest["status"] == "active":
            self.latest["status"] = "interrupted"
            self.latest["stopped_at"] = time.time()
            if self.latest["detected"] is None:
                self.latest["detected"] = False
                self.latest["timeline"].append({
                    "type": "not_detected",
                    "timestamp": self.latest["stopped_at"],
                    "title": "Not detected before backend restart",
                })
            self.latest["timeline"].append({
                "type": "recovery",
                "timestamp": self.latest["stopped_at"],
                "title": "Simulator resumed normal after backend restart",
            })
            self._persist(self.latest)

    @staticmethod
    def _dump(value):
        return json.dumps(value, allow_nan=False)

    @staticmethod
    def _load(value):
        return json.loads(value) if value else None

    def _persist(self, run):
        with closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO fault_lab_runs (
                    run_id, scenario_id, scenario_name, status, started_at,
                    stopped_at, first_abnormal_at, detection_at, detected,
                    baseline_json, latest_reading_json,
                    first_abnormal_reading_json, detection_reading_json,
                    timeline_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    status = excluded.status,
                    stopped_at = excluded.stopped_at,
                    first_abnormal_at = excluded.first_abnormal_at,
                    detection_at = excluded.detection_at,
                    detected = excluded.detected,
                    latest_reading_json = excluded.latest_reading_json,
                    first_abnormal_reading_json =
                        excluded.first_abnormal_reading_json,
                    detection_reading_json = excluded.detection_reading_json,
                    timeline_json = excluded.timeline_json
                """,
                (
                    run["run_id"],
                    run["scenario_id"],
                    run["scenario_name"],
                    run["status"],
                    run["started_at"],
                    run["stopped_at"],
                    run["first_abnormal_at"],
                    run["detection_at"],
                    None if run["detected"] is None else int(run["detected"]),
                    self._dump(run["baseline"]),
                    self._dump(run["latest_reading"])
                    if run["latest_reading"] is not None else None,
                    self._dump(run["first_abnormal_reading"])
                    if run["first_abnormal_reading"] is not None else None,
                    self._dump(run["detection_reading"])
                    if run["detection_reading"] is not None else None,
                    self._dump(run["timeline"]),
                ),
            )
            connection.commit()
        self.latest = self._public_run(run)

    @staticmethod
    def _public_run(run):
        if run is None:
            return None
        result = dict(run)
        result["scenario"] = dict(SCENARIOS[run["scenario_id"]])
        result["detection_delay_seconds"] = (
            run["detection_at"] - run["started_at"]
            if run["detection_at"] is not None else None
        )
        return result

    def _read_rows(self, limit):
        with closing(self._connect()) as connection:
            connection.row_factory = sqlite3.Row
            return connection.execute(
                """
                SELECT * FROM fault_lab_runs
                ORDER BY started_at DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()

    def recent_runs(self, *, limit=10):
        return [
            {
                "run_id": row["run_id"],
                "scenario_id": row["scenario_id"],
                "scenario_name": row["scenario_name"],
                "status": row["status"],
                "started_at": row["started_at"],
                "stopped_at": row["stopped_at"],
                "first_abnormal_at": row["first_abnormal_at"],
                "detection_at": row["detection_at"],
                "detected": (
                    None if row["detected"] is None
                    else bool(row["detected"])
                ),
                "baseline": self._load(row["baseline_json"]),
                "latest_reading": self._load(row["latest_reading_json"]),
                "first_abnormal_reading": self._load(
                    row["first_abnormal_reading_json"]
                ),
                "detection_reading": self._load(row["detection_reading_json"]),
                "timeline": self._load(row["timeline_json"]),
            }
            for row in self._read_rows(limit)
        ]

    def start(self, scenario_id, baseline, timestamp):
        if scenario_id not in SCENARIOS:
            raise ValueError(
                "Unknown fault-lab scenario. Available scenarios: "
                + ", ".join(SCENARIOS)
            )
        clean_baseline = {
            key: float(baseline[key])
            for key in ("voltage", "current", "temperature")
        }
        with self.lock:
            if self.active is not None:
                raise RuntimeError("A fault-lab scenario is already active.")
            scenario = SCENARIOS[scenario_id]
            run = {
                "run_id": uuid.uuid4().hex,
                "scenario_id": scenario_id,
                "scenario_name": scenario["name"],
                "status": "active",
                "started_at": float(timestamp),
                "stopped_at": None,
                "first_abnormal_at": None,
                "detection_at": None,
                "detected": None,
                "baseline": clean_baseline,
                "latest_reading": None,
                "first_abnormal_reading": None,
                "detection_reading": None,
                "timeline": [
                    {
                        "type": "normal_operation",
                        "timestamp": float(timestamp),
                        "title": "Normal operation baseline",
                        "readings": clean_baseline,
                    },
                    {
                        "type": "scenario_started",
                        "timestamp": float(timestamp),
                        "title": "Scenario started",
                        "message": scenario["description"],
                    },
                ],
                "tick": 0,
            }
            self.active = run
            self._persist(run)
            return self.snapshot()

    def advance(self):
        with self.lock:
            if self.active is None:
                return None
            self.active["tick"] += 1
            return {
                "scenario_id": self.active["scenario_id"],
                "tick": self.active["tick"],
                "baseline": dict(self.active["baseline"]),
            }

    def record_sample(
        self,
        *,
        timestamp,
        readings,
        diagnostics,
        detector_output,
        can_frame_count,
    ):
        with self.lock:
            run = self.active
            if run is None:
                return self.snapshot()

            definition = SCENARIOS[run["scenario_id"]]
            sample = {
                "timestamp": float(timestamp),
                "voltage": readings["voltage"],
                "current": readings["current"],
                "temperature": readings["temperature"],
                "can_frame_count": int(can_frame_count),
                "can_window_seconds": CAN_POLL_WINDOW_SECONDS,
                "diagnostic_faults": diagnostics["faults"],
                "ev_simulator_detector": detector_output,
            }
            run["latest_reading"] = sample
            baseline = run["baseline"]
            if run["scenario_id"] == "battery_temperature_rise":
                abnormal = (
                    readings["temperature"] is not None
                    and readings["temperature"] >= baseline["temperature"] + 1.0
                )
                detected = any(
                    fault["code"] == "over-temperature"
                    for fault in diagnostics["faults"]
                )
                detector_name = "Python rule-based diagnostics"
            elif run["scenario_id"] == "battery_voltage_drop":
                abnormal = readings["voltage"] <= baseline["voltage"] - 1.0
                detected = any(
                    fault["code"] == "under-voltage"
                    for fault in diagnostics["faults"]
                )
                detector_name = "Python rule-based diagnostics"
            elif run["scenario_id"] == "temperature_sensor_failure":
                abnormal = readings["temperature"] is None
                detected = any(
                    fault["code"] == "temperature-sensor-failure"
                    for fault in diagnostics["faults"]
                )
                detector_name = "Python signal-availability diagnostic"
            else:
                observed_rate = can_frame_count / CAN_POLL_WINDOW_SECONDS
                abnormal = observed_rate > CAN_ACTIVITY_THRESHOLD_PER_SECOND
                detected = any(
                    fault["code"] == "abnormal-can-activity"
                    for fault in diagnostics["faults"]
                )
                detector_name = "Python CAN activity threshold rule"

            if abnormal and run["first_abnormal_at"] is None:
                run["first_abnormal_at"] = float(timestamp)
                run["first_abnormal_reading"] = sample
                run["timeline"].append({
                    "type": "first_abnormal_reading",
                    "timestamp": float(timestamp),
                    "title": "First abnormal reading",
                    "readings": sample,
                })

            if detected and run["detection_at"] is None:
                run["detection_at"] = float(timestamp)
                run["detected"] = True
                run["detection_reading"] = sample
                run["timeline"].append({
                    "type": "detection",
                    "timestamp": float(timestamp),
                    "title": "Detection result",
                    "detector": detector_name,
                    "faults": diagnostics["faults"],
                    "ev_simulator_detector": detector_output,
                    "readings": sample,
                })

            run["scenario"] = definition
            self._persist(run)
            return self.snapshot()

    def stop(self, timestamp):
        with self.lock:
            if self.active is None:
                raise RuntimeError("No fault-lab scenario is active.")
            run = self.active
            run["status"] = "stopped"
            run["stopped_at"] = float(timestamp)
            if run["detected"] is None:
                run["detected"] = False
                run["timeline"].append({
                    "type": "not_detected",
                    "timestamp": float(timestamp),
                    "title": "Not detected before scenario stopped",
                })
            run["timeline"].append({
                "type": "scenario_stopped",
                "timestamp": float(timestamp),
                "title": "Scenario stopped",
            })
            self.active = None
            self._persist(run)
            return self.snapshot()

    def recover(self, timestamp):
        with self.lock:
            run = self.active or (
                self.latest
                if self.latest and self.latest["status"] in {
                    "stopped",
                    "interrupted",
                }
                else None
            )
            if run is not None:
                run["status"] = "recovered"
                run["stopped_at"] = run["stopped_at"] or float(timestamp)
                if run["detected"] is None:
                    run["detected"] = False
                    run["timeline"].append({
                        "type": "not_detected",
                        "timestamp": float(timestamp),
                        "title": "Not detected before recovery",
                    })
                run["timeline"].append({
                    "type": "recovery",
                    "timestamp": float(timestamp),
                    "title": "Recovery after reset to normal",
                })
                self._persist(run)
            self.active = None
            return self.snapshot()

    def snapshot(self):
        with self.lock:
            active = self._public_run(self.active)
            latest = self._public_run(self.latest)
            recent = self.recent_runs(limit=10)
            return {
                "status": active["status"] if active else (
                    latest["status"] if latest else "normal"
                ),
                "active": active,
                "latest": latest,
                "recent_runs": [
                    self._public_run(run)
                    for run in recent
                ],
                "scenario_definitions": SCENARIOS,
                "can_activity": {
                    "frames_per_sample": CAN_ACTIVITY_FRAMES_PER_SAMPLE,
                    "poll_window_seconds": CAN_POLL_WINDOW_SECONDS,
                    "threshold_frames_per_second": CAN_ACTIVITY_THRESHOLD_PER_SECOND,
                },
            }
