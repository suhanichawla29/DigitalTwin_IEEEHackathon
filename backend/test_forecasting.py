from contextlib import closing
from datetime import datetime, timezone
import math
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

import main
from forecasting import build_multilevel_forecast
from telemetry_store import TelemetryStore


def linear_readings(count, *, voltage_start=400.0, voltage_rate=-0.02,
                    temperature_start=45.0, temperature_rate=0.005,
                    start=1_800_000_000.0):
    return [
        {
            "timestamp": start + index * 2.0,
            "voltage": voltage_start + voltage_rate * index * 2.0,
            "current": 35.0,
            "temperature": temperature_start + temperature_rate * index * 2.0,
        }
        for index in range(count)
    ]


class TelemetryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ev_ecu.db"
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute(
                "CREATE TABLE ecu_records (id INTEGER PRIMARY KEY, name TEXT)"
            )
            connection.execute(
                "INSERT INTO ecu_records (name) VALUES (?)",
                ("existing ECU row",),
            )
            connection.commit()
        self.store = TelemetryStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def insert(self, index, *, timestamp=None, voltage=400.0):
        return self.store.insert_reading(
            sample_id=f"episode:{index}",
            episode_id="episode",
            sample_index=index,
            timestamp=1_800_000_000.0 + index * 2
            if timestamp is None else timestamp,
            voltage=voltage,
            current=35.0,
            temperature=45.0,
            source="simulator",
            can_id="0x100",
            decoded_signals=[
                {"name": "Voltage", "value": voltage, "unit": "V"}
            ],
        )

    def test_initialization_preserves_existing_tables_and_adds_index(self):
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT name FROM ecu_records"
                ).fetchone()[0],
                "existing ECU row",
            )
            self.assertIsNotNone(connection.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = 'telemetry_history'
                """
            ).fetchone())
            self.assertIsNotNone(connection.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'index'
                  AND name = 'idx_telemetry_history_timestamp'
                """
            ).fetchone())

    def test_idempotent_insert_recent_order_and_timestamp_filter(self):
        self.assertTrue(self.insert(1))
        self.assertFalse(self.insert(1))
        self.assertTrue(self.insert(2))
        rows = self.store.recent_readings(limit=1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sample_index"], 2)
        self.assertEqual(rows[0]["source"], "simulator")
        self.assertEqual(rows[0]["can_id"], "0x100")
        self.assertEqual(rows[0]["decoded_signals"][0]["name"], "Voltage")
        self.assertIsInstance(
            datetime.fromisoformat(rows[0]["timestamp_utc"]),
            datetime,
        )
        reopened_store = TelemetryStore(self.path)
        self.assertEqual(reopened_store.count(), 2)
        self.assertEqual(
            reopened_store.recent_readings(limit=2)[0]["sample_id"],
            "episode:1",
        )
        before = self.store.recent_readings(
            limit=10,
            before=1_800_000_003.0,
        )
        self.assertEqual([row["sample_index"] for row in before], [1])
        self.assertEqual(self.store.count(), 2)

    def test_invalid_sensor_values_and_limits_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "finite number"):
            self.insert(1, voltage=math.nan)
        with self.assertRaisesRegex(ValueError, "finite number"):
            self.insert(1, voltage=None)
        with self.assertRaisesRegex(ValueError, "positive integer"):
            self.store.recent_readings(limit=0)


class ForecastingTests(unittest.TestCase):
    def test_insufficient_history_has_no_predicted_values(self):
        result = build_multilevel_forecast(
            linear_readings(14),
            as_of=1_800_000_026.0,
            minimum_history=15,
            nasa_model_status={"status": "ready"},
        )
        self.assertEqual(result["status"], "collecting_data")
        self.assertEqual(result["short_term"]["status"], "collecting_data")
        self.assertEqual(result["medium_term"]["status"], "collecting_data")
        self.assertIsNone(
            result["short_term"]["signals"]["voltage"]["predicted"]
        )
        self.assertEqual(result["long_term"]["status"], "unavailable")
        self.assertIsNone(result["long_term"]["capacity_ah"])
        self.assertEqual(result["long_term"]["model_status"], "ready")

    def test_future_readings_are_excluded_from_forecast_as_of_time(self):
        readings = linear_readings(20)
        as_of = readings[14]["timestamp"]
        result = build_multilevel_forecast(
            readings,
            as_of=as_of,
            minimum_history=15,
        )
        self.assertEqual(result["history_count"], 15)
        self.assertEqual(
            result["last_reading"]["timestamp"],
            as_of,
        )
        self.assertGreater(
            result["short_term"]["signals"]["voltage"]["predicted"],
            0,
        )
        self.assertEqual(
            result["short_term"]["signals"]["voltage"]["unit"],
            "V",
        )
        self.assertEqual(
            result["short_term"]["signals"]["temperature"]["unit"],
            "°C",
        )
        self.assertGreater(
            result["short_term"]["forecast_series"][-1]["timestamp"],
            as_of,
        )

    def test_chronological_backtest_compares_trend_with_persistence(self):
        readings = linear_readings(
            400,
            voltage_start=400,
            voltage_rate=-0.02,
            temperature_start=45,
            temperature_rate=0.005,
        )
        result = build_multilevel_forecast(
            readings,
            as_of=readings[-1]["timestamp"],
            minimum_history=15,
        )
        comparison = result["short_term"]["chronological_comparison"]["voltage"]
        self.assertEqual(comparison["status"], "evaluated")
        self.assertGreaterEqual(comparison["sample_count"], 10)
        self.assertLess(
            comparison["metrics"]["linear_trend_mae"],
            comparison["metrics"]["persistence_mae"],
        )
        self.assertIn("past samples only", comparison["validation"])

    def test_warning_limits_use_same_values_as_rule_diagnostics(self):
        readings = linear_readings(
            20,
            voltage_start=310.0,
            voltage_rate=-0.5,
            temperature_start=75.0,
            temperature_rate=0.2,
        )
        result = build_multilevel_forecast(
            readings,
            as_of=readings[-1]["timestamp"],
            minimum_history=15,
        )
        voltage_warnings = result["short_term"]["signals"][
            "voltage"
        ]["warning_assessment"]
        temperature_warnings = result["short_term"]["signals"][
            "temperature"
        ]["warning_assessment"]
        self.assertTrue(voltage_warnings)
        self.assertEqual(voltage_warnings[0]["limit"], 300.0)
        self.assertTrue(temperature_warnings)
        self.assertEqual(temperature_warnings[0]["limit"], 80.0)

    def test_bad_timestamps_and_sensor_values_are_rejected(self):
        readings = linear_readings(15)
        readings[4]["temperature"] = math.inf
        with self.assertRaisesRegex(ValueError, "finite number"):
            build_multilevel_forecast(
                readings,
                as_of=readings[-1]["timestamp"],
                minimum_history=15,
            )
        with self.assertRaisesRegex(ValueError, "finite timestamp"):
            build_multilevel_forecast([], as_of=math.nan)


class ForecastApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_store = main.telemetry_store
        main.telemetry_store = TelemetryStore(
            Path(self.temp.name) / "api-telemetry.db"
        )
        main.reset_simulation()

    def tearDown(self):
        main.telemetry_store = self.previous_store
        main.reset_simulation()
        self.temp.cleanup()

    def test_readings_persist_and_forecast_endpoints_return_valid_shapes(self):
        first = main.get_readings()
        self.assertEqual(first["source"], "SIMULATED_CAN")
        self.assertEqual(first["forecasts"]["status"], "collecting_data")
        self.assertEqual(first["forecasts"]["history_count"], 1)
        self.assertEqual(main.telemetry_store.count(), 1)
        self.assertEqual(
            main.telemetry_store.recent_readings(limit=1)[0]["source"],
            "simulator",
        )

        for _ in range(15):
            main.get_readings()
        history = main.get_telemetry_history(limit=5)
        self.assertEqual(history["count"], 16)
        self.assertEqual(history["returned"], 5)
        self.assertEqual(history["readings"][-1]["can_id"], "0x100")

        forecast = main.get_multilevel_forecast()
        self.assertEqual(forecast["status"], "ready")
        self.assertEqual(forecast["short_term"]["horizon_seconds"], 30)
        self.assertEqual(forecast["medium_term"]["horizon_seconds"], 300)
        self.assertEqual(forecast["total_history_count"], 16)
        self.assertEqual(forecast["long_term"]["status"], "unavailable")
        status = main.get_forecast_status()
        self.assertEqual(status["history_count"], 16)

    def test_invalid_history_parameters_are_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            main.get_telemetry_history(limit=0)
        self.assertEqual(raised.exception.status_code, 400)
        with self.assertRaises(HTTPException) as raised:
            main.get_telemetry_history(limit=5, before=math.nan)
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
