"""Validated manual EV submissions and their durable diagnostic results."""

from contextlib import closing
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
import uuid

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

SUPPORTED_UNITS = {
    "voltage": "V",
    "current": "A",
    "temperature": "°C",
}
SIGNAL_LIMITS = {
    "voltage": (0.0, 1000.0),
    "current": (0.0, 1000.0),
    "temperature": (-40.0, 200.0),
}
MANUAL_SOURCES = {"manual", "preset_simulated"}


class ManualReadingInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    idempotency_key: str = Field(default_factory=lambda: uuid.uuid4().hex, min_length=1, max_length=128)
    source: str = "manual"
    timestamp: datetime | float | int | str | None = None
    voltage: float | None = Field(default=None, ge=0, le=1000)
    current: float | None = Field(default=None, ge=0, le=1000)
    temperature: float | None = Field(default=None, ge=-40, le=200)
    units: dict[str, str] | None = None
    can_id: str | int | None = None
    raw_payload: str | None = Field(default=None, max_length=128)

    @field_validator("timestamp", mode="before")
    @classmethod
    def parse_timestamp(cls, value):
        if value is None:
            return datetime.now(timezone.utc)
        if isinstance(value, bool):
            raise ValueError("timestamp must be an ISO-8601 datetime or Unix timestamp")
        if isinstance(value, (int, float)):
            if not math.isfinite(float(value)):
                raise ValueError("timestamp must be finite")
            return datetime.fromtimestamp(float(value), timezone.utc)
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError(
                    "timestamp must be an ISO-8601 datetime or Unix timestamp"
                ) from error
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
        return value

    @field_validator("voltage", "current", "temperature", mode="before")
    @classmethod
    def finite_signal(cls, value, info):
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueError(f"{info.field_name} must be a finite number")
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError(f"{info.field_name} must be a finite number") from error
        if not math.isfinite(number):
            raise ValueError(f"{info.field_name} must be a finite number")
        lower, upper = SIGNAL_LIMITS[info.field_name]
        if not lower <= number <= upper:
            raise ValueError(
                f"{info.field_name} must be between {lower:g} and {upper:g} "
                f"{SUPPORTED_UNITS[info.field_name]}"
            )
        return number

    @field_validator("source")
    @classmethod
    def valid_source(cls, value):
        if value not in MANUAL_SOURCES:
            raise ValueError("source must be 'manual' or 'preset_simulated'")
        return value

    @field_validator("units")
    @classmethod
    def valid_units(cls, value):
        if value is None:
            return value
        unknown = sorted(set(value) - set(SUPPORTED_UNITS))
        if unknown:
            raise ValueError("unsupported sensor unit fields: " + ", ".join(unknown))
        incorrect = [
            f"{name} must use {SUPPORTED_UNITS[name]}"
            for name, unit in value.items()
            if unit != SUPPORTED_UNITS[name]
        ]
        if incorrect:
            raise ValueError("; ".join(incorrect))
        return value

    @field_validator("can_id")
    @classmethod
    def valid_can_id_format(cls, value):
        if value is not None and isinstance(value, bool):
            raise ValueError("can_id must be an integer or hexadecimal/decimal ID")
        if value is not None and not isinstance(value, (str, int)):
            raise ValueError("can_id must be an integer or hexadecimal/decimal ID")
        return value

    @model_validator(mode="after")
    def require_reading_or_can(self):
        if all(getattr(self, name) is None for name in SIGNAL_LIMITS):
            if self.can_id is None or not self.raw_payload:
                raise ValueError(
                    "provide at least one supported sensor value or a CAN ID and payload"
                )
        if (self.can_id is None) != (self.raw_payload is None):
            raise ValueError("can_id and raw_payload must be provided together")
        return self

    def timestamp_seconds(self):
        value = self.timestamp
        if isinstance(value, datetime):
            return value.timestamp()
        return float(value)


class ManualBatchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[dict] = Field(min_length=1, max_length=500)


class ManualLabStore:
    def __init__(self, database_path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def _connect(self):
        return sqlite3.connect(self.database_path, timeout=10)

    def initialize(self):
        with closing(self._connect()) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS manual_submissions (
                    idempotency_key TEXT PRIMARY KEY,
                    event_id TEXT,
                    source TEXT NOT NULL,
                    timestamp REAL,
                    submission_status TEXT NOT NULL,
                    submitted_json TEXT NOT NULL,
                    validation_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_manual_submissions_timestamp
                ON manual_submissions (source, timestamp DESC)
                """
            )
            connection.commit()

    @staticmethod
    def _dump(value):
        return json.dumps(value, allow_nan=False, separators=(",", ":"))

    @staticmethod
    def _load(value):
        return json.loads(value)

    def get(self, idempotency_key):
        with closing(self._connect()) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                "SELECT * FROM manual_submissions WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        return self._to_dict(row) if row else None

    def _to_dict(self, row):
        return {
            "idempotency_key": row["idempotency_key"],
            "event_id": row["event_id"],
            "source": row["source"],
            "timestamp": row["timestamp"],
            "submission_status": row["submission_status"],
            "submitted": self._load(row["submitted_json"]),
            "validation": self._load(row["validation_json"]),
            "result": self._load(row["result_json"]),
            "created_at": row["created_at"],
        }

    def save(self, record):
        with closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO manual_submissions (
                    idempotency_key, event_id, source, timestamp,
                    submission_status, submitted_json, validation_json,
                    result_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["idempotency_key"],
                    record.get("event_id"),
                    record["source"],
                    record.get("timestamp"),
                    record["submission_status"],
                    self._dump(record["submitted"]),
                    self._dump(record["validation"]),
                    self._dump(record["result"]),
                    record["created_at"],
                ),
            )
            connection.commit()

    def has_timestamp(self, source, timestamp):
        with closing(self._connect()) as connection:
            return connection.execute(
                """
                SELECT 1 FROM manual_submissions
                WHERE source = ? AND timestamp = ?
                  AND submission_status = 'processed'
                LIMIT 1
                """,
                (source, timestamp),
            ).fetchone() is not None

    def previous_reading(self, source, timestamp):
        with closing(self._connect()) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT timestamp, result_json
                FROM manual_submissions
                WHERE source = ? AND timestamp < ?
                  AND submission_status = 'processed'
                ORDER BY timestamp DESC LIMIT 1
                """,
                (source, timestamp),
            ).fetchone()
        if row is None:
            return None
        result = self._load(row["result_json"])
        readings = result.get("normalized_readings", {})
        if any(readings.get(name) is None for name in SIGNAL_LIMITS):
            return None
        return {
            "timestamp": row["timestamp"],
            "values": [
                readings["voltage"],
                readings["current"],
                readings["temperature"],
            ],
        }

    def history(self, *, source=None, limit=100):
        query = "SELECT * FROM manual_submissions"
        parameters = []
        if source is not None:
            query += " WHERE source = ?"
            parameters.append(source)
        query += " ORDER BY COALESCE(timestamp, created_at) DESC LIMIT ?"
        parameters.append(limit)
        with closing(self._connect()) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(query, parameters).fetchall()
        return [self._to_dict(row) for row in rows]


def validation_errors(error):
    return [
        {
            "field": ".".join(str(part) for part in item["loc"]) or "reading",
            "message": item["msg"],
        }
        for item in error.errors()
    ]

