import unittest

from fastapi import HTTPException

from diagnostics import diagnose
from main import get_readings


class DiagnosticsTests(unittest.TestCase):
    def test_normal_readings_have_no_faults(self):
        result = diagnose(400, 35, 45)

        self.assertEqual(result["status"], "NORMAL")
        self.assertEqual(result["faults"], [])

    def test_individual_faults_are_detected(self):
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

    def test_existing_multiple_fault_scenario_is_preserved(self):
        result = get_readings(scenario="multiple_faults")

        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"under-voltage", "over-current", "over-temperature"},
        )

    def test_three_selected_faults_combine_readings_and_diagnostics(self):
        result = get_readings(
            faults=["low_voltage", "over_current", "over_temperature"]
        )

        self.assertLess(result["voltage"], 300)
        self.assertGreater(result["current"], 100)
        self.assertGreater(result["temperature"], 80)
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"under-voltage", "over-current", "over-temperature"},
        )

    def test_two_selected_faults_report_only_those_faults(self):
        result = get_readings(faults=["over_voltage", "over_current"])

        self.assertGreater(result["voltage"], 430)
        self.assertGreater(result["current"], 100)
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"over-voltage", "over-current"},
        )

    def test_over_voltage_combines_with_current_and_temperature(self):
        result = get_readings(
            faults=["over_voltage", "over_current", "over_temperature"]
        )

        self.assertGreater(result["voltage"], 430)
        self.assertGreater(result["current"], 100)
        self.assertGreater(result["temperature"], 80)
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"over-voltage", "over-current", "over-temperature"},
        )

    def test_switching_back_to_normal_clears_faults(self):
        get_readings(faults=["low_voltage", "over_current"])
        result = get_readings(scenario="normal")

        self.assertEqual(result["diagnostics"]["status"], "NORMAL")
        self.assertEqual(result["diagnostics"]["faults"], [])

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
