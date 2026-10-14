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