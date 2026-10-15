import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

import main
from ev_simulator_predictor import EVSimulatorAnomalyPredictor
from manual_lab import ManualLabStore
from telemetry_store import TelemetryStore


def timestamp(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


class ManualLabTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "manual-test.db"
        self.originals = {
            "manual_store": main.manual_lab_store,
            "telemetry_store": main.telemetry_store,
            "manual_predictor": main.manual_ev_simulator_predictor,
        }
        main.manual_lab_store = ManualLabStore(database_path)
        main.telemetry_store = TelemetryStore(database_path)
        main.manual_ev_simulator_predictor = EVSimulatorAnomalyPredictor()
        main.manual_ev_simulator_predictor.reset()

    def tearDown(self):
        main.manual_lab_store = self.originals["manual_store"]
        main.telemetry_store = self.originals["telemetry_store"]
        main.manual_ev_simulator_predictor = self.originals["manual_predictor"]
        self.temp_dir.cleanup()

    def _reading(self, *, key=None, stamp=1_700_000_000, **overrides):
        payload = {
            "idempotency_key": key or uuid.uuid4().hex,
            "source": "manual",
            "timestamp": timestamp(stamp),
            "voltage": 400.0,
            "current": 35.0,
            "temperature": 45.0,
            "units": {
                "voltage": "V",
                "current": "A",
                "temperature": "°C",
            },
        }
        payload.update(overrides)
        return payload

    def test_normal_input_is_valid_persisted_and_retry_idempotent(self):
        payload = self._reading()
        first = main.submit_manual_reading(payload)
        retry = main.submit_manual_reading(payload)
        self.assertEqual(first["result"]["assessment"]["status"], "normal")
        self.assertEqual(first["submission_status"], "processed")
        self.assertEqual(first["result"]["source"], "manual")
        self.assertEqual(first["result"]["units"]["voltage"], "V")
        self.assertEqual(first["idempotency_key"], retry["idempotency_key"])
        self.assertEqual(main.telemetry_store.count(source="manual"), 1)
        self.assertEqual(main.telemetry_store.count(source="simulator"), 0)
        self.assertEqual(
            len(main.manual_lab_store.history(source="manual")),
            1,
        )

    def test_threshold_warning_and_critical_results_are_distinct_from_model(self):
        low = main.submit_manual_reading(
            self._reading(stamp=1_700_000_010, voltage=280)
        )["result"]
        hot = main.submit_manual_reading(
            self._reading(stamp=1_700_000_012, temperature=90)
        )["result"]
        self.assertEqual(low["assessment"]["status"], "warning")
        self.assertEqual(low["triggered_rules"][0]["limit"], 300.0)
        self.assertEqual(hot["assessment"]["status"], "critical")
        self.assertEqual(hot["triggered_rules"][0]["limit"], 80.0)
        self.assertIn(hot["assessment"]["model_result"], {
            "normal",
            "model_detected_anomaly",
            "insufficient_data",
            "model_unavailable",
        })

    def test_invalid_ranges_units_unsupported_fields_and_missing_values_are_recorded(self):
        cases = [
            self._reading(voltage=1001),
            self._reading(units={"voltage": "kV"}),
            self._reading(soc=80),
            self._reading(voltage=None, current=None, temperature=None),
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                result = main.submit_manual_reading(payload)
                self.assertEqual(result["submission_status"], "invalid_input")
                self.assertTrue(result["validation"]["errors"])
        self.assertEqual(len(main.manual_lab_store.history()), len(cases))

    def test_missing_sensor_is_warning_and_model_input_is_incompatible(self):
        result = main.submit_manual_reading(
            self._reading(stamp=1_700_000_020, temperature=None)
        )
        self.assertEqual(result["result"]["assessment"]["status"], "warning")
        self.assertEqual(
            result["result"]["model_result"]["status"],
            "incompatible_input",
        )
        self.assertEqual(
            result["result"]["missing_fields"],
            ["temperature"],
        )
        self.assertEqual(main.telemetry_store.count(source="manual"), 0)

    def test_temporal_comparison_and_compatible_ev_model_warmup(self):
        first = main.submit_manual_reading(
            self._reading(stamp=1_700_000_030)
        )["result"]
        second = main.submit_manual_reading(
            self._reading(stamp=1_700_000_032, voltage=399.0)
        )["result"]
        self.assertEqual(first["model_result"]["status"], "warming_up")
        self.assertEqual(second["comparison"]["voltage"]["change"], -1.0)
        self.assertEqual(second["model_result"]["status"], "evaluated")
        self.assertIn(
            "not a real-world probability",
            second["model_result"]["score_type"],
        )

    def test_valid_and_invalid_dbc_frames(self):
        valid = main.submit_manual_reading(self._reading(
            stamp=1_700_000_040,
            voltage=None,
            current=None,
            temperature=None,
            can_id="0x100",
            raw_payload="A0 0F 5E 01 52 03 00 00",
        ))
        self.assertEqual(valid["submission_status"], "processed")
        self.assertEqual(valid["result"]["can_result"]["status"], "decoded")
        self.assertAlmostEqual(
            valid["result"]["normalized_readings"]["temperature"],
            45.0,
        )

        failures = [
            self._reading(
                stamp=1_700_000_042,
                can_id="0x999",
                raw_payload="00 00 00 00 00 00 00 00",
            ),
            self._reading(
                stamp=1_700_000_044,
                can_id="0x100",
                raw_payload="00 00",
            ),
            self._reading(
                stamp=1_700_000_046,
                can_id="0x100",
                raw_payload="GG 00",
            ),
        ]
        for payload in failures:
            with self.subTest(payload=payload):
                result = main.submit_manual_reading(payload)
                self.assertEqual(result["submission_status"], "invalid_input")

    def test_duplicate_timestamp_is_rejected_and_manual_sources_are_isolated(self):
        payload = self._reading(stamp=1_700_000_050)
        main.submit_manual_reading(payload)
        duplicate = main.submit_manual_reading(
            self._reading(stamp=1_700_000_050)
        )
        self.assertEqual(duplicate["submission_status"], "invalid_input")
        preset = main.submit_manual_reading(
            self._reading(
                stamp=1_700_000_050,
                source="preset_simulated",
            )
        )
        self.assertEqual(preset["submission_status"], "processed")
        self.assertEqual(main.telemetry_store.count(source="manual"), 1)
        self.assertEqual(
            main.telemetry_store.count(source="preset_simulated"),
            1,
        )
        self.assertEqual(
            main.get_multilevel_forecast(source="simulator")["total_history_count"],
            main.telemetry_store.count(source="simulator"),
        )
        self.assertEqual(
            main.get_multilevel_forecast(source="manual")["total_history_count"],
            1,
        )

    def test_batch_orders_rows_reports_duplicate_timestamps_and_can_rate(self):
        payload = []
        for index in range(6):
            payload.append({
                **self._reading(
                    key=f"batch-{index}",
                    stamp=1_700_000_100 + index / 10,
                    source="preset_simulated",
                    voltage=None,
                    current=None,
                    temperature=None,
                    can_id="0x100",
                    raw_payload="A0 0F 5E 01 52 03 00 00",
                )
            })
        payload[0], payload[5] = payload[5], payload[0]
        duplicate = self._reading(
            key="batch-duplicate",
            stamp=1_700_000_100.5,
            source="preset_simulated",
            voltage=400,
            current=35,
            temperature=45,
        )
        response = main.submit_manual_batch({
            "rows": [*payload, duplicate, {"timestamp": "not-a-time"}]
        })
        self.assertEqual(response["submitted"], 8)
        self.assertEqual(response["processed"], 6)
        self.assertEqual(response["invalid"], 2)
        first_stored = main.manual_lab_store.history(
            source="preset_simulated",
            limit=8,
        )
        first_stored = next(
            item for item in first_stored
            if item["submission_status"] == "processed"
        )
        self.assertEqual(first_stored["result"]["source"], "preset_simulated")
        decoded = [
            row for row in response["results"]
            if row["submission_status"] == "processed"
        ]
        self.assertTrue(any(
            any(
                fault["code"] == "abnormal-can-activity"
                for fault in row["result"]["diagnostics"]["faults"]
            )
            for row in decoded
        ))


if __name__ == "__main__":
    unittest.main()
