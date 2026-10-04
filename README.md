# AquaFix – Smart Paddy Water Management System

A local Flask and SQLite prototype for monitoring simulated paddy water level, temperature and turbidity. Every submitted reading is stored and assessed by a synthetic-data Random Forest risk classifier and an Isolation Forest anomaly detector. The dashboard charts readings, estimates water level three hours ahead from recent changes, and updates its recommendations and alerts.

**Prototype models trained on synthetic data.** The Random Forest reports condition risk; the Isolation Forest compares readings against a synthetic normal baseline and reports Normal, Warning or Abnormal. These models have not been validated against real Malaysian paddy field data. Field cards are illustrative; no farms are connected.

## Run locally

Python 3.10 or newer is recommended. On first startup, AquaFix inserts one clearly synthetic baseline reading so the dashboard is populated before the simulation starts.

In VS Code, open this project folder and press **F5**, then select **AquaFix: Run Flask**. The launch task creates the virtual environment at `%LOCALAPPDATA%\AquaFixVenv`, installs the dependencies, and starts Flask. Stop the server with **Shift+F5**.

For a PowerShell terminal, run:

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv "$env:LOCALAPPDATA\AquaFixVenv"
& "$env:LOCALAPPDATA\AquaFixVenv\Scripts\python.exe" -m pip install -r requirements.txt
$env:AQUIFIX_DB_PATH = Join-Path $env:LOCALAPPDATA "AquaFixVenv\aquafix.db"
& "$env:LOCALAPPDATA\AquaFixVenv\Scripts\python.exe" app.py
```

Open <http://127.0.0.1:5000>. With the included VS Code profile, SQLite is stored at `%LOCALAPPDATA%\AquaFixVenv\aquafix.db`; otherwise it defaults to `data/aquafix.db`. On page load the prototype starts a bounded repeating 2.5-minute sensor simulation (stable readings, gradual water stress, recovery), with new readings every 2.5 seconds. About half the generated water-level readings fall below the 3 cm guide to exercise the alert, risk model and simulated pump. Pause and reset remain available. The local database keeps only the latest 2,000 readings so unattended streaming stays bounded. The simulated pump changes only Field A's generated reading toward a 5 cm target and does not control hardware. The Kubang Semang map uses illustrative pins; map tiles, Leaflet and Chart.js need internet access. The four field lines use distinct colors; B–D are illustrative, not connected sensors.

The pump simulation requires a fresh, in-range reading, refuses to start below 0.5 cm or at/above its configured target, and stops at the target, after the configured maximum run time, or when readings pause, become stale, or fail validation. Target is configurable from 3.1–6 cm; maximum run time is configurable from 10–120 seconds. Settings are saved in the browser. Current API input bounds are water level 0–20 cm, temperature −5–60 °C and turbidity 0–1000 NTU; these are software checks, not agronomic safety thresholds. The UI shows reading age and marks a reading stale after 15 seconds. Active alerts can be acknowledged; acknowledgement remains until that alert clears or changes.

## API

- `GET /` – dashboard
- `GET /api/latest` – latest stored reading and model output (or a no-data message)
- `GET /api/history` – up to 60 recent readings, oldest first
- `POST /api/sensor` – classify and store a reading

Example request:

```json
{"water_level": 4.8, "temperature": 28.5, "turbidity": 5.2}
```

The response includes a UTC timestamp, risk class and confidence, prototype risk factors, Isolation Forest status and decision score, data-quality status, three-hour water estimate and recommendation. The models were trained on synthetic data and are not validated against field observations. To evaluate the prototype against real, independently labelled readings, download `static/field_validation_template.csv`, fill the sensor columns plus `actual_risk` (`Normal`, `Medium Risk` or `High Risk`) and `actual_anomaly` (`Normal` or `Anomaly`), then run:

```powershell
& "$env:LOCALAPPDATA\AquaFixVenv\Scripts\python.exe" validate_model.py path\to\your_labelled_readings.csv
```

The report prints accuracy, per-class precision/recall/F1 and confusion matrices for risk labels and anomaly alerts. Synthetic simulation output must not be used as real field validation.

## Project files

- `app.py` – Flask routes and input validation
- `database.py` – SQLite initialization and queries
- `ml_model.py` – synthetic prototype model and short-horizon estimate
- `validate_model.py` – compare prototype predictions with independently labelled CSV field readings
- `templates/index.html`, `static/style.css`, `static/app.js` – dashboard UI
