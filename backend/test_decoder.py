
from can_decoder import decode_can_frame


def make_frame(voltage, current, temperature):
    values = [
        round(voltage * 10),
        round(current * 10),
        round((temperature + 40) * 10)
    ]

    data = bytearray()

    for value in values:
        data.extend(value.to_bytes(2, "little"))

    data.extend([0, 0])
    return bytes(data)


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
