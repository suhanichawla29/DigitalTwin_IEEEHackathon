
from pathlib import Path
import cantools

dbc_path = Path(__file__).with_name("ev_ecu.dbc")
db = cantools.database.load_file(str(dbc_path))


def decode_can_frame(can_id, data):
    try:
        decoded = db.decode_message(can_id, bytes(data))

        return {
            "can_id": hex(can_id),
            "voltage": decoded["Voltage"],
            "current": decoded["Current"],
            "temperature": decoded["Temperature"]
        }

    except Exception as error:
        return {"error": str(error)}


if __name__ == "__main__":
    raw_data = bytes([
        0xA0, 0x0F,
        0x5E, 0x01,
        0x52, 0x03,
        0x00, 0x00
    ])

    print(decode_can_frame(0x100, raw_data))
