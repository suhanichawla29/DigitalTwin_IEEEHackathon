import unittest

from fastapi import HTTPException

from can_decoder import decode_can_frame
from main import get_can_messages, get_readings


class CanMessageTests(unittest.TestCase):
    def test_api_reading_payload_decodes_to_the_same_telemetry(self):
        reading = get_readings(scenario="over_current")
        message = reading["can_message"]
        payload = bytes(
            int(byte, 16)
            for byte in message["data"].split()
        )

        decoded = decode_can_frame(0x100, payload)

        self.assertEqual(reading["source"], "SIMULATED_CAN")
        self.assertEqual(message["can_id"], "0x100")
        self.assertEqual(message["message_name"], "ECU_Telemetry")
        self.assertEqual(message["source_ecu"], "ECU")
        self.assertEqual(message["dlc"], 8)
        self.assertEqual(message["decode_status"], "decoded")
        self.assertEqual(decoded["voltage"], reading["voltage"])
        self.assertEqual(decoded["current"], reading["current"])
        self.assertEqual(decoded["temperature"], reading["temperature"])
        self.assertEqual(
            [signal["name"] for signal in message["decoded_signals"]],
            ["Voltage", "Current", "Temperature"],
        )

    def test_recent_messages_support_dbc_backed_filters(self):
        get_readings(scenario="normal")

        result = get_can_messages(
            ecu="ECU",
            can_id="0x100",
            message_name="telemetry",
            limit=1,
        )

        self.assertEqual(result["source"], "SIMULATED_CAN")
        self.assertEqual(result["count"], 1)
        self.assertEqual(
            result["messages"][0]["message_name"],
            "ECU_Telemetry",
        )

    def test_invalid_can_id_returns_http_400(self):
        with self.assertRaises(HTTPException) as raised:
            get_can_messages(can_id="not-an-id")

        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
