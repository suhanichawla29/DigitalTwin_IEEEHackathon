
from pathlib import Path
import cantools

dbc_path = Path(__file__).with_name("ev_ecu.dbc")
db = cantools.database.load_file(str(dbc_path))


def encode_can_frame(message_name, signals):
    """Encode signal values using the message definition in the project DBC."""
    message = db.get_message_by_name(message_name)
    return message.encode(signals, strict=True)


def decode_can_frame(can_id, data):
    payload = bytes(data)
    try:
        message = db.get_message_by_frame_id(can_id)
        decoded = message.decode(payload, decode_choices=False)
        decoded_signals = [
            {
                "name": signal.name,
                "value": decoded[signal.name],
                "unit": signal.unit,
            }
            for signal in message.signals
        ]

        return {
            "can_id": hex(can_id),
            "message_name": message.name,
            "source_ecu": message.senders[0] if message.senders else None,
            "dlc": len(payload),
            "payload_hex": " ".join(f"{byte:02X}" for byte in payload),
            "payload_bytes": list(payload),
            "decoded_signals": decoded_signals,
            "decode_status": "decoded",
            "voltage": decoded.get("Voltage"),
            "current": decoded.get("Current"),
            "temperature": decoded.get("Temperature"),
        }

    except Exception as error:
        return {
            "can_id": hex(can_id),
            "message_name": None,
            "source_ecu": None,
            "dlc": len(payload),
            "payload_hex": " ".join(f"{byte:02X}" for byte in payload),
            "payload_bytes": list(payload),
            "decoded_signals": [],
            "decode_status": "error",
            "error": str(error),
        }


if __name__ == "__main__":
    raw_data = bytes([
        0xA0, 0x0F,
        0x5E, 0x01,
        0x52, 0x03,
        0x00, 0x00
    ])

    print(decode_can_frame(0x100, raw_data))
