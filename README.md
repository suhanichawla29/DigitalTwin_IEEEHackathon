# DigitalTwin_IEEEHackathon

## Synthetic ML diagnostics prototype

The FastAPI backend advances simulated CAN sensor values on each poll. Fault
selections change degradation rates instead of setting sensor values
instantaneously. Rule-based alerts remain separate from the trained model's
five-minute failure probability.

The predictor is initially trained on synthetic labelled episodes. Its
metrics describe only held-out synthetic episodes; they do not establish
real-world EV accuracy or safety.

From the repository root in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\.venv\Scripts\python.exe backend\train_model.py
.\.venv\Scripts\python.exe -m unittest discover -s backend -p "test_*.py"
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --reload
```

Training saves the model and its feature schema to
`backend/models/failure_predictor.joblib`. Train before starting the API;
the model is loaded once when the backend starts. The dashboard polls every
two seconds and needs 30 readings before the model can return a prediction.

The forecast is the model's probability of failure in the next five minutes.
That horizon is fixed; the displayed probability updates as readings arrive,
and it is not a countdown or an estimated time to failure.

Simulation degradation speed can be adjusted for the API process with the
`EV_SIMULATION_SPEED` environment variable. The default is `1.0`; values above
`1.0` accelerate degradation and values between `0` and `1.0` slow it down.
For example, set `$env:EV_SIMULATION_SPEED = "1.0"` in PowerShell before
starting Uvicorn. Restart the API after changing the setting.

## Separate NASA and SynCAN models

The NASA model estimates discharge capacity and capacity-derived battery SOH
from complete NASA discharge-cycle measurement arrays. The SynCAN model
performs per-ID anomaly detection on SynCAN message records. They have distinct
inputs and outputs; neither is merged with the dashboard's synthetic
five-minute failure predictor or project DBC telemetry.

See [backend/data/README.md](backend/data/README.md) for the official dataset
schemas, Windows data-folder structure, download caveats, and licensing.
After placing the source datasets, train from the repository root:

```powershell
.\.venv\Scripts\python.exe backend\training\train_nasa_model.py
.\.venv\Scripts\python.exe backend\training\train_syncan_model.py
```

The artifacts are `backend\models\nasa_capacity.joblib` and
`backend\models\synCAN_isolation_forest.joblib`. Restart FastAPI after
training. `GET /api/models` reports each model's dataset presence, artifact
load status, and metadata. Dataset-specific inference endpoints are
`POST /api/battery/capacity` and `POST /api/can/anomaly`.

## Simulated CAN dashboard monitor

The home dashboard's ECU Encoder & CAN Message Monitor uses the current
FastAPI simulation sample, encodes the DBC-defined `ECU_Telemetry` message
(CAN ID `0x100`, sender `ECU`, DLC 8) with cantools, and decodes the same bytes
before diagnostics consume the readings. The dashboard monitor and its CAN
Message History are views of the same backend-bounded 100-frame history.
`GET /api/can/messages` supports CAN ID and message-name filters, and
`DELETE /api/can/messages` clears the history. All traffic is simulated; no
physical CAN adapter is connected. The project DBC frame is not mapped to
SynCAN's separate IDs/signals, so those frames are correctly shown as not
evaluated by the SynCAN detector.