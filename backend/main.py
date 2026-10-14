
from pathlib import Path
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Make the backend folder available for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from can_decoder import decode_can_frame
from diagnostics import diagnose

app = FastAPI(title="EV Digital Twin API")

# Allow your local frontend to access the API
# Development only; restrict origins before deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def make_demo_frame(voltage, current, temperature):
    """Encode example readings into our custom CAN message format."""

    raw_values = [
        round(voltage * 10),
        round(current * 10),
        round((temperature + 40) * 10),
    ]

    data = bytearray()

    for value in raw_values:
        data.extend(value.to_bytes(2, "little"))

    data.extend([0, 0])
    return bytes(data)


@app.get("/")
def home():
    return {
        "message": "EV Digital Twin API is running",
        "docs": "/docs",
    }


@app.get("/api/readings")
def get_readings():
    # Simulated CAN data for now; later replace with incoming CAN frames.
    frame = make_demo_frame(400, 35, 85)

    # Decode the simulated CAN frame into sensor readings.
    readings = decode_can_frame(0x100, frame)

    # Run our Python fault-detection rules on the decoded readings.
    diagnostics = diagnose(
        voltage=readings["voltage"],
        current=readings["current"],
        temperature=readings["temperature"],
    )

    # Return the sensor readings and diagnostic results.
    return {
        **readings,
        "ecu_status": diagnostics["status"],
        "diagnostics": diagnostics,
        "source": "SIMULATED_CAN",
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}
