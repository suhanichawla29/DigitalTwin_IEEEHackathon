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

### Live EV simulator anomaly detector

Live project DBC frames are evaluated by a separate EV simulator classifier,
not by SynCAN. Train it from the repository root with:

```powershell
.\.venv\Scripts\python.exe backend\training\train_ev_simulator_anomaly.py
```

The script generates deterministic, seeded episodes using the existing
`SimulationState`, encodes each sample with the `0x100 ECU_Telemetry` DBC
definition, decodes the resulting CAN bytes, and extracts decoded voltage,
current, temperature, elapsed time, and per-sample changes. Normal episodes
are labelled `normal`; explicitly injected degradation/fault episodes are
labelled `injected_non_normal`. Validation uses separate complete episodes and
seeds, not a random row split. The model and those validation metrics are saved
to `backend\models\ev_simulator_anomaly.joblib`.

The Dashboard CAN Message History labels the result as an EV simulator
detector output and shows SynCAN separately as incompatible for these frames.
`GET /api/models` and `GET /api/health` expose live detector readiness and
SynCAN offline evaluation as separate fields. The EV score is a classifier
score against simulator-generated episode labels, not a calibrated real-world
probability, trained-vehicle result, or causal fault diagnosis. All CAN
messages remain simulated; no physical vehicle or CAN hardware is connected.

## Persistent telemetry and multi-level forecasts

The backend creates `backend\ev_ecu.db` automatically. The project previously
had `backend\ev_ecu.dbc` (the CAN message definition), but no SQLite database
file. The SQLite database adds a separate `telemetry_history` table; the
telemetry writer does not remove or replace other tables. It stores each
decoded simulated reading once per episode/sample, including its timestamp,
voltage (V), current (A), temperature (°C), source, CAN ID, and decoded signal
metadata. Resetting the simulator does not erase persisted telemetry.

The endpoints are:

- `GET /api/telemetry/history?limit=100` — recent stored rows in chronological
  order; `limit` is 1–600. An optional `before` Unix timestamp excludes later
  samples.
- `GET /api/forecast/multilevel` — short- and medium-term forecasts, actual
  trend points, warning-threshold assessment, and chronological comparisons
  against persistence.
- `GET /api/forecast/status` — sample readiness and the separate long-term
  capacity-model input status.

Short-term (30-second) and medium-term (5-minute) values use an ordinary
least-squares trend over at most the latest 30 persisted readings. At least 15
samples are required by default (`EV_FORECAST_MIN_HISTORY` can change this);
the frontend polls the existing readings endpoint every two seconds, so
collect at least about 30 seconds of live samples before expecting a numeric
forecast. Rolling-origin chronological MAE comparisons are returned only when
there are at least 10 valid horizon pairs. These simulated-data results are
descriptive backtests, not real-vehicle accuracy claims.

The existing NASA artifact predicts discharge capacity from complete NASA
discharge-cycle measurement arrays. It cannot infer live EV capacity, SOH,
degradation rate, or RUL from the dashboard's three signals, so the dashboard
shows only the short- and medium-term telemetry forecasts. The NASA model,
forecast metadata, and `POST /api/battery/capacity` endpoint remain available
for compatible NASA discharge-cycle inputs.

### Run and test the dashboard

From the repository root, start the backend in one PowerShell window:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --reload
```

Start the static frontend server in a second PowerShell window:

```powershell
.\.venv\Scripts\python.exe -m http.server 5173
```

Open `http://127.0.0.1:5173/index.html`. The API and forecast endpoints are
available on port 8000. A new database needs about 30 seconds of the normal
two-second simulator polling to collect the default 15 samples; previously
stored readings are retained across restarts and may make forecasts ready
immediately. The long-term NASA capacity card remains unavailable until
compatible discharge-cycle measurements are supplied to its existing endpoint.