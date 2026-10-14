import unittest

from fastapi import HTTPException

from diagnostics import diagnose
from main import get_readings, reset_simulation


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        reset_simulation()

    def advance_until_faults(self, faults, limit=180):
        result = None
        for _ in range(limit):
            result = get_readings(faults=faults)
            active = {fault["code"] for fault in result["diagnostics"]["faults"]}
            expected = {
                {
                    "low_voltage": "under-voltage",
                    "over_voltage": "over-voltage",
                    "over_current": "over-current",
                    "over_temperature": "over-temperature",
                }[fault]
                for fault in faults
            }
            if active == expected:
                return result
        self.fail(f"Faults did not become active: {faults}")

    def test_normal_readings_have_no_faults(self):
        result = diagnose(400, 35, 45)
        sample = get_readings(scenario="normal")

        self.assertEqual(result["status"], "NORMAL")
        self.assertEqual(result["faults"], [])
        self.assertEqual(sample["diagnostics"]["faults"], [])

    def test_rule_diagnostics_detect_individual_faults(self):
        cases = [
            ((400, 35, 85), "over-temperature"),
            ((270, 35, 45), "under-voltage"),
            ((400, 120, 45), "over-current"),
            ((450, 35, 45), "over-voltage"),
        ]
        for readings, expected_code in cases:
            with self.subTest(fault=expected_code):
                result = diagnose(*readings)
                self.assertEqual(
                    [fault["code"] for fault in result["faults"]],
                    [expected_code],
                )

    def test_single_fault_scenarios_degrade_gradually(self):
        cases = [
            ("low_voltage", "under-voltage", "voltage", "down"),
            ("over_voltage", "over-voltage", "voltage", "up"),
            ("over_current", "over-current", "current", "up"),
            ("over_temperature", "over-temperature", "temperature", "up"),
        ]
        for scenario, code, signal, direction in cases:
            with self.subTest(scenario=scenario):
                reset_simulation()
                first = get_readings(faults=[scenario])
                second = get_readings(faults=[scenario])
                for _ in range(150):
                    result = get_readings(faults=[scenario])
                    if result["diagnostics"]["faults"]:
                        break
                self.assertEqual(
                    [fault["code"] for fault in result["diagnostics"]["faults"]],
                    [code],
                )
                first_step = second[signal] - first[signal]
                self.assertLess(abs(first_step), 5)
                self.assertTrue(
                    result[signal] < 300 if direction == "down" and code == "under-voltage"
                    else result[signal] > 430 if code == "over-voltage"
                    else result[signal] > 100 if code == "over-current"
                    else result[signal] > 80
                )

    def test_combined_fault_scenarios_preserve_all_selected_faults(self):
        cases = [
            (
                ["low_voltage", "over_current", "over_temperature"],
                {"under-voltage", "over-current", "over-temperature"},
            ),
            (
                ["over_voltage", "over_current", "over_temperature"],
                {"over-voltage", "over-current", "over-temperature"},
            ),
            (
                ["over_voltage", "over_current"],
                {"over-voltage", "over-current"},
            ),
        ]
        for selected, expected in cases:
            with self.subTest(selected=selected):
                reset_simulation()
                result = self.advance_until_faults(selected)
                active = {fault["code"] for fault in result["diagnostics"]["faults"]}
                self.assertEqual(active, expected)

    def test_legacy_multiple_fault_scenario_id_remains_supported(self):
        for _ in range(125):
            result = get_readings(scenario="multiple_faults")
        self.assertEqual(
            set(result["faults"]),
            {"low_voltage", "over_current", "over_temperature"},
        )
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"under-voltage", "over-current", "over-temperature"},
        )

    def test_switching_to_normal_recovers_and_clears_faults(self):
        for _ in range(120):
            active = get_readings(faults=["low_voltage", "over_current"])
        self.assertTrue(active["diagnostics"]["faults"])

        for _ in range(100):
            recovered = get_readings(scenario="normal")
            if not recovered["diagnostics"]["faults"]:
                break
        self.assertEqual(recovered["diagnostics"]["faults"], [])
        self.assertEqual(recovered["faults"], [])
        self.assertGreater(recovered["voltage"], 300)
        self.assertLess(recovered["current"], 100)

    def test_reset_clears_the_simulation_episode(self):
        get_readings(scenario="normal")
        reset_simulation()
        restarted = get_readings(scenario="normal")
        self.assertEqual(restarted["sample_index"], 1)
        self.assertEqual(restarted["prediction"]["history_count"], 1)

    def test_invalid_fault_selections_return_http_400(self):
        invalid_selections = [
            {"faults": ["not_a_fault"]},
            {"faults": ["low_voltage", "over_voltage"]},
            {"scenario": "normal", "faults": ["over_current"]},
            {"scenario": "not_a_scenario"},
        ]
        for selection in invalid_selections:
            with self.subTest(selection=selection):
                with self.assertRaises(HTTPException) as raised:
                    get_readings(**selection)
                self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
