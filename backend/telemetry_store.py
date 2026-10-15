"""Persistent, parameterized SQLite storage for decoded simulator telemetry."""

from contextlib import closing
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3

DATABASE_PATH = Path(__file__).resolve().parent / "ev_ecu.db"


class TelemetryStore:
    def __init__(self, database_path=DATABASE_PATH):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def _connect(self):
        return sqlite3.connect(self.database_path, timeout=10)

    def initialize(self):
        with closing(self._connect()) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS telemetry_history (
                    sample_id TEXT PRIMARY KEY,
                    episode_id TEXT NOT NULL,
                    sample_index INTEGER NOT NULL CHECK (sample_index > 0),
                    timestamp REAL NOT NULL,
                    voltage REAL NOT NULL,
                    current REAL NOT NULL,
                    temperature REAL NOT NULL,
                    source TEXT NOT NULL,
                    can_id TEXT,
                    decoded_signals_json TEXT,
                    scenario_run_id TEXT,
                    scenario_name TEXT,
                    UNIQUE (episode_id, sample_index)
                )
                """
            )
            columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(telemetry_history)"
                )
            }
            if "scenario_run_id" not in columns:
                connection.execute(
                    "ALTER TABLE telemetry_history ADD COLUMN scenario_run_id TEXT"
                )
            if "scenario_name" not in columns:
                connection.execute(
                    "ALTER TABLE telemetry_history ADD COLUMN scenario_name TEXT"
                )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_telemetry_history_timestamp
                ON telemetry_history (timestamp DESC)
                """
            )
            connection.commit()

    @staticmethod
    def _finite_number(value, field_name):
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"{field_name} must be a finite number") from error
        if not math.isfinite(number):
            raise ValueError(f"{field_name} must be a finite number")
        return number

    def insert_reading(
        self,
        *,
        sample_id,
        episode_id,
        sample_index,
        timestamp,
        voltage,
        current,
        temperature,
        source,
        can_id=None,
        decoded_signals=None,
        scenario_run_id=None,
        scenario_name=None,
    ):
        if not isinstance(sample_id, str) or not sample_id.strip():
            raise ValueError("sample_id must be a non-empty string")
        if not isinstance(episode_id, str) or not episode_id.strip():
            raise ValueError("episode_id must be a non-empty string")
        if isinstance(sample_index, bool) or not isinstance(sample_index, int):
            raise ValueError("sample_index must be a positive integer")
        if sample_index <= 0:
            raise ValueError("sample_index must be a positive integer")
        if not isinstance(source, str) or not source.strip():
            raise ValueError("source must be a non-empty string")
        if can_id is not None and not isinstance(can_id, str):
            raise ValueError("can_id must be a string or null")
        if decoded_signals is not None and not isinstance(decoded_signals, list):
            raise ValueError("decoded_signals must be an array or null")
        if scenario_run_id is not None and not isinstance(scenario_run_id, str):
            raise ValueError("scenario_run_id must be a string or null")
        if scenario_name is not None and not isinstance(scenario_name, str):
            raise ValueError("scenario_name must be a string or null")

        row = (
            sample_id.strip(),
            episode_id.strip(),
            sample_index,
            self._finite_number(timestamp, "timestamp"),
            self._finite_number(voltage, "voltage"),
            self._finite_number(current, "current"),
            self._finite_number(temperature, "temperature"),
            source.strip(),
            can_id,
            json.dumps(decoded_signals, allow_nan=False),
            scenario_run_id,
            scenario_name,
        )
        with closing(self._connect()) as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO telemetry_history (
                    sample_id, episode_id, sample_index, timestamp,
                    voltage, current, temperature, source, can_id,
                    decoded_signals_json, scenario_run_id, scenario_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                row,
            )
            connection.commit()
            return cursor.rowcount == 1

    def recent_readings(self, *, limit=300, before=None, source=None):
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("limit must be a positive integer")
        parameters = []
        clauses = []
        if before is not None:
            before_timestamp = self._finite_number(before, "before")
            clauses.append("timestamp <= ?")
            parameters.append(before_timestamp)
        if source is not None:
            if not isinstance(source, str) or not source.strip():
                raise ValueError("source must be a non-empty string or null")
            clauses.append("source = ?")
            parameters.append(source.strip())
        where = "WHERE " + " AND ".join(clauses) if clauses else ""
        parameters.append(limit)
        with closing(self._connect()) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                f"""
                SELECT sample_id, episode_id, sample_index, timestamp,
                       voltage, current, temperature, source, can_id,
                       decoded_signals_json, scenario_run_id, scenario_name
                FROM telemetry_history
                {where}
                ORDER BY timestamp DESC, sample_index DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        results = []
        for row in reversed(rows):
            item = dict(row)
            item["timestamp_utc"] = datetime.fromtimestamp(
                item["timestamp"],
                timezone.utc,
            ).isoformat()
            item["decoded_signals"] = (
                json.loads(item.pop("decoded_signals_json"))
                if item["decoded_signals_json"] is not None
                else None
            )
            results.append(item)
        return results

    def count(self, *, before=None, source=None):
        clauses = []
        parameters = []
        if before is not None:
            clauses.append("timestamp <= ?")
            parameters.append(self._finite_number(before, "before"))
        if source is not None:
            if not isinstance(source, str) or not source.strip():
                raise ValueError("source must be a non-empty string or null")
            clauses.append("source = ?")
            parameters.append(source.strip())
        query = "SELECT COUNT(*) FROM telemetry_history"
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        with closing(self._connect()) as connection:
            row = connection.execute(query, tuple(parameters)).fetchone()
        return int(row[0])
