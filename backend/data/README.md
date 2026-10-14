# NASA and SynCAN dataset placement

Raw datasets are not included in this repository. Download the source files
from the official providers, follow their terms, and keep the files in these
directories:

```text
backend\data\nasa\
    B0005.mat
    B0006.mat
    B0007.mat
    B0018.mat

backend\data\synCAN\
    train_1.zip
    train_2.zip
    train_3.zip
    train_4.zip
    test_normal.zip
    test_plateau.zip
    test_continuous.zip
    test_playback.zip
    test_suppress.zip
    test_flooding.zip
```

## NASA Ames PCoE Li-ion Battery Aging Dataset

Official page: <https://data.nasa.gov/dataset/li-ion-battery-aging-datasets>.
The catalog describes MATLAB battery structs with a top-level `cycle` array.
Each cycle has an operation `type` and a `data` struct. Discharge records
contain `Time` in seconds, `Voltage_measured` in volts, `Current_measured` in
amps, `Temperature_measured` in degrees C, and `Capacity` in Ah. Capacity is
the target only; it is not used as an input feature. Features are extracted
from that same discharge's measured arrays. The model estimates capacity and
capacity-derived SOH (`Capacity / 2.0 Ah * 100`), not remaining life or failure
probability.

The training command reads `.mat` files directly in `backend\data\nasa` and
requires at least two battery IDs for leave-one-battery-run-out evaluation.
The four filenames above are the expected NASA runs. The NASA catalog may not
provide direct downloads; if so, use the NASA Ames PCoE official dataset
download channel. Do not substitute unverified mirrors.

## ETAS SynCAN

Official repository: <https://github.com/etas/SynCAN>. Its CSV data uses
`Label`, `ID`, `Time`, and ID-specific `SignalN_of_ID` fields. `Time` is in
milliseconds; `Label=0` means normal and `Label=1` means intrusion. IDs
`id1` through `id10` have respectively 2, 3, 2, 1, 2, 2, 2, 1, 1, and 4
signals. The four training archives are concatenated logically; only their
normal (`Label=0`) rows train each per-ID StandardScaler/IsolationForest.
Evaluation uses the six official labelled test archives. SynCAN IDs/signals
are not mapped onto this project's DBC identifiers/signals.

The dataset is for non-commercial research, teaching, publication, or
personal simulation, not field use. Read the repository's
[license terms](https://github.com/etas/SynCAN/blob/master/License%20terms.txt)
and cite Hanselmann et al., “CANet: An Unsupervised Intrusion Detection
System for High Dimensional CAN Bus Data,” IEEE Access, 2020.

## Windows training

From the project root in PowerShell, after downloading and placing the files:

```powershell
New-Item -ItemType Directory -Force backend\data\nasa, backend\data\synCAN | Out-Null
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\.venv\Scripts\python.exe backend\training\train_nasa_model.py
.\.venv\Scripts\python.exe backend\training\train_syncan_model.py
```

For NASA, download the original `B0005.mat`, `B0006.mat`, `B0007.mat`, and
`B0018.mat` files from the official NASA Ames PCoE channel, then copy them into
`backend\data\nasa`. The catalog page may not expose direct file links; do not
use an unverified mirror.

For SynCAN, clone the official repository and copy its archives into the
project data folder:

```powershell
git clone https://github.com/etas/SynCAN.git "$env:TEMP\SynCAN"
Copy-Item "$env:TEMP\SynCAN\train_1.zip", "$env:TEMP\SynCAN\train_2.zip", "$env:TEMP\SynCAN\train_3.zip", "$env:TEMP\SynCAN\train_4.zip", "$env:TEMP\SynCAN\test_normal.zip", "$env:TEMP\SynCAN\test_plateau.zip", "$env:TEMP\SynCAN\test_continuous.zip", "$env:TEMP\SynCAN\test_playback.zip", "$env:TEMP\SynCAN\test_suppress.zip", "$env:TEMP\SynCAN\test_flooding.zip" -Destination backend\data\synCAN
```

The scripts write and reload-verify:

```text
backend\models\nasa_capacity.joblib
backend\models\synCAN_isolation_forest.joblib
```

Restart FastAPI after training so its predictors load the saved models. Check
`GET /api/models` for the actual dataset and artifact status. A model is not
reported ready before its artifact loads and its saved feature schema passes
validation.
