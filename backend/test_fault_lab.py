import tempfile
import unittest
import uuid
from pathlib import Path

import main
from fault_lab import FaultSimulationLab, SCENARIOS
from main import SimulationState
from telemetry_store import TelemetryStore


class FaultLabTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "fault-lab-test.db"
        self.originals = {
            "simulation": main.simulation,
            "fault_lab": main.fault_lab,
            "telemetry_store": main.telemetry_store,
            "episode_id": main._episode_id,
            "sample_count": main._sample_count,
        }
        main.simulation = SimulationState(seed=42)
        main.fault_lab = FaultSimulationLab(database_path)
        main.telemetry_store = TelemetryStore(database_path)
        main._episode_id = uuid.uuid4().hex
        main._sample_count = 0
        main._can_messages.clear()
        main.predictor.reset()
        main.ev_simulator_predictor.reset()

    def tearDown(self):
        main.predictor.reset()
        main.ev_simulator_predictor.reset()
        main.simulation = self.originals["simulation"]
        main.fault_lab = self.originals["fault_lab"]
        main.telemetry_store = self.originals["telemetry_store"]
        main._episode_id = self.originals["episode_id"]
        main._sample_count = self.originals["sample_count"]
        main._can_messages.clear()
        self.temp_dir.cleanup()

    def _run_until_detected(self, scenario_id, expected_code):
        started = main.start_fault_lab({"scenario_id": scenario_id})
        self.assertEqual(started["status"], "active")
        result = None
        for _ in range(40):
            result = main.get_readings()
            fault_codes = {
                fault["code"]
                for fault in result["diagnostics"]["faults"]
            }
            if expected_code in fault_codes:
                break

        self.assertIsNotNone(result)
        self.assertIn(expected_code, {
            fault["code"] for fault in result["diagnostics"]["faults"]
        })
        self.assertTrue(result["fault_lab"]["active"]["detected"])
        self.assertEqual(
            result["fault_lab"]["active"]["detection_at"],
            result["fault_lab"]["active"]["timeline"][-1]["timestamp"],
        )
        self.assertGreaterEqual(
            result["fault_lab"]["active"]["detection_delay_seconds"],
            0,
        )
        return result

    def test_all_scenarios_trigger_their_real_rule_diagnostic(self):
        scenario_rules = {
            "battery_temperature_rise": "over-temperature",
            "battery_voltage_drop": "under-voltage",
            "temperature_sensor_failure": "temperature-sensor-failure",
            "abnormal_can_activity": "abnormal-can-activity",
        }
        self.assertEqual(set(SCENARIOS), set(scenario_rules))

        for scenario_id, fault_code in scenario_rules.items():
            with self.subTest(scenario=scenario_id):
                result = self._run_until_detected(scenario_id, fault_code)
                run_id = result["fault_lab"]["active"]["run_id"]
                if scenario_id != "temperature_sensor_failure":
                    saved = main.telemetry_store.recent_readings(limit=1)[0]
                    self.assertEqual(saved["scenario_run_id"], run_id)
                    self.assertEqual(
                        saved["scenario_name"],
                        SCENARIOS[scenario_id]["name"],
                    )
                if scenario_id == "temperature_sensor_failure":
                    self.assertIsNone(result["temperature"])
                    self.assertFalse(result["sensor_availability"]["temperature"])
                    self.assertEqual(
                        result["can_message"]["ev_anomaly"]["status"],
                        "not_evaluated",
                    )
                if scenario_id == "abnormal_can_activity":
                    self.assertEqual(
                        result["diagnostics"]["faults"][0]["code"],
                        "abnormal-can-activity",
                    )
                    self.assertEqual(
                        result["fault_lab"]["active"]["latest_reading"][
                            "can_frame_count"
                        ],
                        6,
                    )
                stopped = main.stop_fault_lab()
                self.assertEqual(stopped["status"], "stopped")
                recovered = main.reset_fault_lab()
                self.assertEqual(recovered["status"], "recovered")
                timeline = recovered["latest"]["timeline"]
                self.assertEqual(timeline[-1]["type"], "recovery")
                self.assertEqual(
                    main.fault_lab.recent_runs(limit=1)[0]["run_id"],
                    run_id,
                )

    def test_normal_api_sample_is_stored_and_has_no_diagnostics(self):
        result = main.get_readings(scenario="normal")
        self.assertEqual(result["diagnostics"]["faults"], [])
        self.assertEqual(result["fault_lab"]["status"], "normal")
        self.assertEqual(main.telemetry_store.count(), 1)

    def test_start_rejects_unknown_scenario_and_concurrent_run(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as invalid:
            main.start_fault_lab({"scenario_id": "unknown"})
        self.assertEqual(invalid.exception.status_code, 400)

        main.start_fault_lab({
            "scenario_id": "temperature_sensor_failure"
        })
        with self.assertRaises(HTTPException) as concurrent:
            main.start_fault_lab({"scenario_id": "battery_voltage_drop"})
        self.assertEqual(concurrent.exception.status_code, 409)

    def test_sensor_failure_is_persisted_without_fabricating_telemetry(self):
        result = self._run_until_detected(
            "temperature_sensor_failure",
            "temperature-sensor-failure",
        )
        self.assertEqual(main.telemetry_store.count(), 0)
        self.assertIsNone(
            result["fault_lab"]["active"]["latest_reading"]["temperature"]
        )
        self.assertTrue(main.get_fault_lab_status()["active"])
        recovered = main.reset_fault_lab()
        self.assertEqual(recovered["status"], "recovered")
        normal = main.get_readings(scenario="normal")
        self.assertEqual(normal["diagnostics"]["faults"], [])
        self.assertTrue(normal["sensor_availability"]["temperature"])

    def test_stopping_before_detection_records_not_detected_explicitly(self):
        main.start_fault_lab({"scenario_id": "battery_temperature_rise"})
        stopped = main.stop_fault_lab()
        run = stopped["latest"]
        self.assertFalse(run["detected"])
        self.assertEqual(run["timeline"][-2]["type"], "not_detected")
        self.assertEqual(run["timeline"][-1]["type"], "scenario_stopped")
        self.assertIsNone(run["detection_at"])

    def test_backend_restart_closes_persisted_active_run_as_interrupted(self):
        main.start_fault_lab({
            "scenario_id": "temperature_sensor_failure"
        })
        restarted_lab = FaultSimulationLab(main.fault_lab.database_path)
        snapshot = restarted_lab.snapshot()
        self.assertIsNone(snapshot["active"])
        self.assertEqual(snapshot["status"], "interrupted")
        self.assertEqual(
            snapshot["latest"]["timeline"][-1]["title"],
            "Simulator resumed normal after backend restart",
        )


if __name__ == "__main__":
    unittest.main()
