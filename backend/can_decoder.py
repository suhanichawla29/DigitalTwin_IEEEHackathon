
from pathlib import Path
import cantools

dbc_path = Path(__file__).with_name("ev_ecu.dbc")
db = cantools.database.load_file(str(dbc_path))


def decode_can_frame(can_id, data):
    payload = bytes(data)

    try:
        message = db.get_message_by_frame_id(can_id)
        decoded = db.decode_message(can_id, payload)

        return {
            "can_id": f"0x{can_id:03X}",
            "message_name": message.name,
            "source_ecu": ", ".join(message.senders) or None,
            "dlc": len(payload),
            "decode_status": "decoded",
            "decode_error": None,
            "decoded_signals": [
                {
                    "name": signal.name,
                    "value": decoded[signal.name],
                    "unit": signal.unit or "",
                }
                for signal in message.signals
                if signal.name in decoded
            ],
            "voltage": decoded["Voltage"],
            "current": decoded["Current"],
            "temperature": decoded["Temperature"],
        }

    except Exception as error:
        return {
            "can_id": f"0x{can_id:03X}",
            "message_name": None,
            "source_ecu": None,
            "dlc": len(payload),
            "decode_status": "error",
            "decode_error": str(error),
            "decoded_signals": [],
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
