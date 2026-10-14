import unittest

from main import (
    CAN_HISTORY_LIMIT,
    SimulationState,
    _can_messages,
    clear_can_messages,
    get_can_messages,
    get_readings,
    make_demo_frame,
    reset_simulation,
    syncan_predictor,
)
from can_decoder import decode_can_frame


class SimulationTests(unittest.TestCase):
    def test_selected_fault_degrades_gradually_between_samples(self):
        simulation = SimulationState(seed=17)
        simulation.select("low_voltage", ())
        initial_voltage = simulation.values["voltage"]

        readings = [simulation.advance() for _ in range(12)]

        self.assertLess(simulation.values["voltage"], initial_voltage)
        self.assertAlmostEqual(
            initial_voltage - simulation.values["voltage"],
            12 * 0.9,
        )
        self.assertLess(abs(readings[-1]["voltage"] - initial_voltage), 21)

    def test_over_current_becomes_diagnostic_within_two_to_four_minutes(self):
        simulation = SimulationState(seed=26)
        simulation.select("over_current", ())

        while simulation.values["current"] <= 100 and simulation.sample_index < 120:
            simulation.advance()

        self.assertGreater(simulation.values["current"], 100)
        self.assertGreaterEqual(simulation.sample_index, 60)
        self.assertLessEqual(simulation.sample_index, 120)

    def test_over_voltage_becomes_diagnostic_within_two_to_four_minutes(self):
        simulation = SimulationState(seed=27)
        simulation.select("over_voltage", ())

        while simulation.values["voltage"] <= 430 and simulation.sample_index < 120:
            simulation.advance()

        self.assertGreater(simulation.values["voltage"], 430)
        self.assertGreaterEqual(simulation.sample_index, 60)
        self.assertLessEqual(simulation.sample_index, 120)

    def test_over_temperature_remains_within_dbc_encoding_range(self):
        simulation = SimulationState(seed=29)
        simulation.select("over_temperature", ())
        reading = None
        for _ in range(500):
            reading = simulation.advance()

        frame = make_demo_frame(
            reading["voltage"],
            reading["current"],
            reading["temperature"],
        )
        decoded = decode_can_frame(0x100, frame)

        self.assertLessEqual(reading["temperature"], 200)
        self.assertEqual(decoded["decode_status"], "decoded")
        self.assertAlmostEqual(
            decoded["temperature"],
            reading["temperature"],
            delta=0.051,
        )

    def test_gradual_and_severe_modes_change_all_three_signals(self):
        gradual = SimulationState(seed=21)
        gradual.select("gradual_degradation", ())
        gradual_start = dict(gradual.values)
        gradual.advance()

        self.assertLess(gradual.values["voltage"], gradual_start["voltage"])
        self.assertGreater(gradual.values["current"], gradual_start["current"])
        self.assertGreater(
            gradual.values["temperature"],
            gradual_start["temperature"],
        )

        severe = SimulationState(seed=22)
        severe.select("severe_degradation", ())
        severe_start = dict(severe.values)
        severe.advance()

        self.assertLess(severe.values["voltage"], severe_start["voltage"])
        self.assertGreater(severe.values["current"], severe_start["current"])
        self.assertGreater(
            severe.values["temperature"],
            severe_start["temperature"],
        )
        self.assertAlmostEqual(
            severe.values["voltage"] - severe_start["voltage"],
            -0.72,
        )

    def test_combined_fault_selection_degrades_each_requested_signal(self):
        simulation = SimulationState(seed=23)
        simulation.scenario = "combined"
        simulation.faults = (
            "low_voltage",
            "over_current",
            "over_temperature",
        )
        initial = dict(simulation.values)
        simulation.advance()

        self.assertLess(simulation.values["voltage"], initial["voltage"])
        self.assertGreater(simulation.values["current"], initial["current"])
        self.assertGreater(
            simulation.values["temperature"],
            initial["temperature"],
        )

    def test_switching_to_normal_recovers_gradually(self):
        simulation = SimulationState(seed=24)
        simulation.select("severe_degradation", ())
        for _ in range(5):
            simulation.advance()

        degraded = dict(simulation.values)
        simulation.select("normal", ())
        simulation.advance()

        self.assertGreater(simulation.values["voltage"], degraded["voltage"])
        self.assertLess(simulation.values["current"], degraded["current"])
        self.assertLess(
            simulation.values["temperature"],
            degraded["temperature"],
        )

    def test_reset_starts_new_episode_at_baseline(self):
        simulation = SimulationState(seed=25)
        simulation.select("gradual_degradation", ())
        for _ in range(5):
            simulation.advance()

        simulation.reset()

        self.assertEqual(simulation.values, simulation.baseline)
        self.assertEqual(simulation.scenario, "normal")
        self.assertEqual(simulation.sample_index, 0)

    def test_api_includes_diagnostics_and_prediction_metadata(self):
        reset_simulation()
        result = get_readings()

        self.assertEqual(result["source"], "SIMULATED_CAN")
        self.assertIn("can_id", result)
        self.assertIn("diagnostics", result)
        self.assertEqual(result["diagnostics"]["status"], "NORMAL")
        self.assertEqual(result["diagnostics"]["faults"], [])
        self.assertIn("prediction", result)
        self.assertEqual(
            result["prediction"]["horizon_seconds"],
            300,
        )
        self.assertEqual(result["prediction"]["history_count"], 1)
        self.assertEqual(result["prediction"]["model"]["feature_count"], 32)
        self.assertIn(
            result["prediction"]["status"],
            {"unavailable", "warming_up"},
        )
        self.assertEqual(result["can_message"]["can_id"], "0x100")
        self.assertEqual(result["can_message"]["message_name"], "ECU_Telemetry")
        self.assertEqual(result["can_message"]["source_ecu"], "ECU")
        self.assertEqual(result["can_message"]["dlc"], 8)
        self.assertEqual(result["can_message"]["decode_status"], "decoded")
        expected_syncan_status = (
            "incompatible_features"
            if syncan_predictor.models
            else "model_unavailable"
        )
        self.assertEqual(
            result["can_message"]["synCAN_status"],
            expected_syncan_status,
        )
        self.assertIn(
            "SynCAN",
            result["can_message"]["synCAN_note"],
        )
        self.assertNotEqual(result["can_message"]["synCAN_status"], "evaluated")
        self.assertAlmostEqual(result["voltage"], result["can_message"]["decoded_signals"][0]["value"])
        self.assertAlmostEqual(result["current"], result["can_message"]["decoded_signals"][1]["value"])
        self.assertAlmostEqual(result["temperature"], result["can_message"]["decoded_signals"][2]["value"])
        self.assertEqual(result["can_messages"][-1], result["can_message"])

    def test_can_message_history_filter_and_clear(self):
        reset_simulation()
        get_readings()

        history = get_can_messages()
        self.assertEqual(history["source"], "SIMULATED_CAN")
        self.assertEqual(history["count"], 1)
        self.assertEqual(get_can_messages(can_id="0x100")["count"], 1)
        self.assertEqual(get_can_messages(message_name="telemetry")["count"], 1)
        self.assertEqual(get_can_messages(can_id="0x999")["count"], 0)

        result = clear_can_messages()
        self.assertEqual(result["status"], "cleared")
        self.assertEqual(result["count"], 0)
        self.assertGreater(result["cleared_at"], 0)
        self.assertEqual(get_can_messages()["messages"], [])

    def test_can_message_history_is_bounded(self):
        reset_simulation()
        for index in range(CAN_HISTORY_LIMIT + 7):
            _can_messages.append({
                "timestamp": index,
                "can_id": "0x100",
                "message_name": "ECU_Telemetry",
                "source_ecu": "ECU",
                "dlc": 8,
                "payload_hex": "",
                "payload_bytes": [],
                "decoded_signals": [],
                "decode_status": "decoded",
                "source": "SIMULATED_CAN",
                "synCAN_status": "not_evaluated",
            })

        history = get_can_messages()
        self.assertEqual(history["count"], CAN_HISTORY_LIMIT)
        self.assertEqual(history["messages"][0]["timestamp"], 7)

        clear_can_messages()

    def test_reset_endpoint_clears_predictor_history_and_sample_index(self):
        for _ in range(4):
            get_readings()

        result = reset_simulation()
        next_reading = get_readings()

        self.assertEqual(result["history_count"], 0)
        self.assertEqual(next_reading["sample_index"], 1)
        self.assertEqual(next_reading["prediction"]["history_count"], 1)
        self.assertEqual(next_reading["can_message"]["decode_status"], "decoded")


if __name__ == "__main__":
    unittest.main()
