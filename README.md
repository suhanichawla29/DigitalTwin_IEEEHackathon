# EV Digital Twin — Predictive Diagnostics

The dashboard uses one FastAPI simulation to produce telemetry, encode its
CAN frame, decode the project DBC, and run rule diagnostics. Dataset-trained
models described below are separate tools with separate input domains; they
do not relabel or replace live DBC readings.

## Install and run

From the repository root in PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m uvicorn backend.main:app --reload
```

Open `index.html` with the existing XAMPP/Apache site or another static
web-server. The FastAPI service defaults to `http://127.0.0.1:8000`.

## Dataset models (independent)

Dataset placement, schemas, target definitions, and licensing notes are in
[backend/data/README.md](backend/data/README.md). Raw datasets are not checked
in and are ignored by Git.

NASA trains a RandomForestRegressor to estimate recorded discharge capacity
(Ah) and derived capacity-based SOH from complete NASA discharge-cycle
measurement arrays. It uses leave-one-battery-run-out evaluation. It is not
inferred from the dashboard's one-sample live telemetry.

```powershell
python backend\training\train_nasa_model.py
```

SynCAN trains ID-specific unsupervised IsolationForest models on normal rows
only, then evaluates against the repository's labelled normal and intrusion
test archives. Anomaly scores/flags are not failure probabilities and do not
map SynCAN IDs to the project's DBC IDs/signals.

```powershell
python backend\training\train_synCAN_model.py
```

Only after these commands succeed and verify the artifacts are saved will
`/api/models` report the corresponding dataset model as ready. Model files
are written under `backend/models/` and should be generated locally from
datasets you are permitted to use.
Restart FastAPI after training so the new joblib artifact is loaded.

### Dataset-specific API

- `GET /api/models` — model readiness and domain information.
- `POST /api/battery/capacity` — estimate a capacity from a complete
  NASA-shaped `{ "battery_id": "...", "cycle": { "data": { ... } } }`
  discharge record.
- `POST /api/can/anomaly` — score one SynCAN-shaped row (`ID`, `Time`, and
  that ID's defined `SignalN_of_ID` fields).

The NASA response is in Ah and capacity-derived percent SOH. SynCAN returns
an anomaly flag and IsolationForest decision score. Neither endpoint accepts
or predicts from the live simulated DBC CAN frame.

## Focused tests

```powershell
$env:PYTHONPATH = 'backend'
python -m unittest backend.test_decoder backend.test_can_messages backend.test_diagnostics backend.test_predictor backend.test_dataset_models
```

## Data citations and limitations

- NASA Ames PCoE, [Li-ion Battery Aging Datasets](https://data.nasa.gov/dataset/li-ion-battery-aging-datasets). The catalog page documents MATLAB cycle fields, a 2 Ah rated capacity, and discharge `Capacity` in Ah. It currently advertises zero data resources; follow [backend/data/README.md](backend/data/README.md) for the official-file prerequisite.
- M. Hanselmann, T. Strauss, K. Dormann, and H. Ulmer, “CANet: An Unsupervised Intrusion Detection System for High Dimensional CAN Bus Data,” *IEEE Access*, vol. 8, 2020, pp. 58194–58205. [ETAS SynCAN repository](https://github.com/etas/SynCAN). SynCAN's license restricts use to non-commercial research/teaching/publication/personal simulation and prohibits field use.

No dataset model is claimed trained until its input files are present,
training/evaluation completes, and the saved joblib artifact reloads
successfully. The current dashboard CAN traffic remains simulated; no
physical vehicle is connected.
