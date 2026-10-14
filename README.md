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

## Simulated CAN message history

The home dashboard shows one CAN Message History table backed by the current
FastAPI simulation sample. The backend encodes the DBC-defined
`ECU_Telemetry` message (CAN ID `0x100`, sender `ECU`, DLC 8) with cantools,
then decodes the same bytes before diagnostics consume the readings.
`GET /api/can/messages` supports CAN ID and message-name filters, and
`DELETE /api/can/messages` clears the history. All traffic is simulated; no
physical CAN adapter is connected.

The SynCAN artifact accepts dataset-specific IDs (`id1` through `id10`),
`Time` in milliseconds, and their `SignalN_of_ID` fields. The project DBC
frame exposes only `Voltage`, `Current`, and `Temperature` at ID `0x100`; no
validated mapping exists, so live frames show “Not evaluated — incompatible
features” rather than a fabricated normal/anomaly result. The
`POST /api/can/anomaly` endpoint accepts compatible SynCAN-format records and
returns an IsolationForest anomaly flag and decision score, not a probability.
To evaluate the existing saved artifact against the official test archives
without retraining or overwriting it, run from the repository root:

```powershell
.\.venv\Scripts\python.exe backend\training\train_syncan_model.py --evaluate-only
```

The report identifies `Label=0` as normal and `Label=1` as intrusion and
includes the confusion matrix, precision, recall, F1, false positives, and
missed intrusions.