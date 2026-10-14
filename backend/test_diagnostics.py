import unittest

from fastapi import HTTPException

from diagnostics import diagnose
from main import get_readings, predictor, reset_simulation


class FixedProbabilityModel:
    classes_ = [0, 1]

    def predict_proba(self, rows):
        return [[0.5, 0.5] for _ in rows]


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.trained_model = predictor.model
        predictor.model = FixedProbabilityModel()
        reset_simulation()

    def tearDown(self):
        predictor.model = self.trained_model
        reset_simulation()

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

    def test_combined_readings_report_all_rule_faults(self):
        result = diagnose(270, 120, 85)

        self.assertEqual(
            {fault["code"] for fault in result["faults"]},
            {"under-voltage", "over-current", "over-temperature"},
        )

    def test_over_voltage_can_be_reported_with_other_faults(self):
        result = diagnose(450, 120, 85)

        self.assertEqual(
            {fault["code"] for fault in result["faults"]},
            {"over-voltage", "over-current", "over-temperature"},
        )

    def test_existing_multiple_fault_scenario_is_preserved(self):
        result = get_readings(scenario="multiple_faults")

        self.assertEqual(result["scenario"], "multiple_faults")
        self.assertGreater(result["voltage"], 300)
        self.assertLess(result["current"], 100)
        self.assertLess(result["temperature"], 80)

    def test_each_selected_fault_reaches_its_diagnostic_threshold(self):
        cases = {
            "low_voltage": "under-voltage",
            "over_voltage": "over-voltage",
            "over_current": "over-current",
            "over_temperature": "over-temperature",
        }

        for scenario, expected_code in cases.items():
            with self.subTest(scenario=scenario):
                reset_simulation()
                result = None
                for _ in range(100):
                    result = get_readings(faults=[scenario])
                    if result["diagnostics"]["faults"]:
                        break

                self.assertEqual(result["scenario"], scenario)
                self.assertEqual(
                    [fault["code"] for fault in result["diagnostics"]["faults"]],
                    [expected_code],
                )

    def test_three_selected_faults_combine_readings_and_diagnostics(self):
        faults = ["low_voltage", "over_current", "over_temperature"]
        result = None
        for _ in range(100):
            result = get_readings(faults=faults)
            if len(result["diagnostics"]["faults"]) == 3:
                break

        self.assertEqual(result["scenario"], "combined")
        self.assertEqual(set(result["faults"]), set(faults))
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"under-voltage", "over-current", "over-temperature"},
        )
        self.assertLess(result["voltage"], 300)
        self.assertGreater(result["current"], 80)
        self.assertGreater(result["temperature"], 70)

    def test_two_selected_faults_report_only_those_faults(self):
        faults = ["over_voltage", "over_current"]
        result = None
        for _ in range(100):
            result = get_readings(faults=faults)
            if len(result["diagnostics"]["faults"]) == 2:
                break

        self.assertEqual(result["scenario"], "combined")
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"over-voltage", "over-current"},
        )
        self.assertGreater(result["voltage"], 430)
        self.assertGreater(result["current"], 100)

    def test_over_voltage_combines_with_current_and_temperature(self):
        faults = ["over_voltage", "over_current", "over_temperature"]
        result = None
        for _ in range(100):
            result = get_readings(faults=faults)
            if len(result["diagnostics"]["faults"]) == 3:
                break

        self.assertEqual(result["scenario"], "combined")
        self.assertEqual(
            {fault["code"] for fault in result["diagnostics"]["faults"]},
            {"over-voltage", "over-current", "over-temperature"},
        )

    def test_switching_back_to_normal_clears_faults(self):
        faults = ["low_voltage", "over_current", "over_temperature"]
        result = None
        for _ in range(100):
            result = get_readings(faults=faults)
            if len(result["diagnostics"]["faults"]) == 3:
                break

        self.assertEqual(len(result["diagnostics"]["faults"]), 3)

        for _ in range(200):
            result = get_readings(scenario="normal")
            if not result["diagnostics"]["faults"]:
                break

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
