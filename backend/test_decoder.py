
import unittest

from can_decoder import decode_can_frame, encode_can_frame


def make_frame(voltage, current, temperature):
    return encode_can_frame(
        "ECU_Telemetry",
        {
            "Voltage": voltage,
            "Current": current,
            "Temperature": temperature,
        },
    )


class DecoderTests(unittest.TestCase):
    def test_dbc_encoder_round_trips_supported_telemetry(self):
        frame = make_frame(400.04, 35.06, 45.06)
        result = decode_can_frame(0x100, frame)

        self.assertEqual(len(frame), 8)
        self.assertEqual(result["can_id"], "0x100")
        self.assertEqual(result["message_name"], "ECU_Telemetry")
        self.assertEqual(result["source_ecu"], "ECU")
        self.assertEqual(result["dlc"], 8)
        self.assertEqual(result["decode_status"], "decoded")
        self.assertEqual(
            [signal["name"] for signal in result["decoded_signals"]],
            ["Voltage", "Current", "Temperature"],
        )
        self.assertAlmostEqual(result["voltage"], 400.0)
        self.assertAlmostEqual(result["current"], 35.1)
        self.assertAlmostEqual(result["temperature"], 45.1)

    def test_unknown_can_id_returns_decoder_error_details(self):
        result = decode_can_frame(0x999, bytes(8))

        self.assertEqual(result["decode_status"], "error")
        self.assertTrue(result["error"])
        self.assertEqual(result["decoded_signals"], [])


scenarios = [
    ("Normal", 400, 35, 45),
    ("Over-temperature", 400, 35, 85),
    ("Under-voltage", 270, 35, 45),
    ("Over-current", 400, 120, 45),
    ("Over-voltage", 450, 35, 45),
]

for name, voltage, current, temperature in scenarios:
    frame = make_frame(voltage, current, temperature)
    result = decode_can_frame(0x100, frame)

    print(f"\n{name}:")
    print(result)
