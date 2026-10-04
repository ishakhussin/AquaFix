"""AquaFix: local paddy-water monitoring prototype."""
from datetime import datetime, timezone
from math import isfinite
from flask import Flask, jsonify, render_template, request
from database import init_db, latest_reading, recent_readings, save_reading
from ml_model import analyse_anomaly, classify, explain_risk, forecast_water_level, recommend

app = Flask(__name__)
SENSOR_BOUNDS = {"water_level": (0, 20), "temperature": (-5, 60), "turbidity": (0, 1000)}
SENSOR_STALE_SECONDS = 15


def analyse(payload):
    history = recent_readings(8)
    risk, confidence = classify(payload["water_level"], payload["temperature"], payload["turbidity"])
    risk_explanation = explain_risk(payload["water_level"], payload["temperature"], payload["turbidity"])
    forecast = forecast_water_level(payload["water_level"], history)
    ml_status, anomaly_score, ml_explanation = analyse_anomaly(
        payload["water_level"], payload["temperature"], payload["turbidity"]
    )
    action = recommend(risk, forecast)
    if payload["water_level"] < 3.0:
        action = "Water is below the 3 cm guide. Confirm the reading, inspect the field and inlet, then irrigate only if the sensor is reliable and water is available."
    elif ml_status == "Abnormal":
        action = f"Abnormal sensor pattern ({ml_explanation}) — verify readings and inspect the field."
    elif ml_status == "Warning" and risk == "Normal":
        action = f"Unusual sensor pattern ({ml_explanation}) — verify readings and continue monitoring."
    return {**payload, "risk": risk, "confidence": confidence, "risk_explanation": risk_explanation,
            "predicted_water_level": forecast,
            "recommendation": action, "ml_status": ml_status,
            "anomaly_score": anomaly_score, "ml_explanation": ml_explanation}


def enrich_reading(reading):
    """Attach current data-quality and model-provenance details to API readings."""
    if not reading:
        return None
    values = {key: reading.get(key) for key in SENSOR_BOUNDS}
    issues = []
    has_missing_value = False
    has_out_of_range_value = False
    for key, (minimum, maximum) in SENSOR_BOUNDS.items():
        value = values[key]
        if value is None:
            issues.append(f"{key.replace('_', ' ')} is missing")
            has_missing_value = True
            continue
        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            issues.append(f"{key.replace('_', ' ')} is not numeric")
            has_missing_value = True
            continue
        if not isfinite(numeric_value) or not minimum <= numeric_value <= maximum:
            issues.append(f"{key.replace('_', ' ')} is outside configured range {minimum}–{maximum}")
            has_out_of_range_value = True
    try:
        stamp = datetime.fromisoformat(reading["timestamp"].replace("Z", "+00:00"))
        age_seconds = (datetime.now(timezone.utc) - stamp).total_seconds()
    except (KeyError, TypeError, ValueError):
        age_seconds = None
    if age_seconds is not None and age_seconds < -5:
        issues.append("reading timestamp is in the future")
        age_seconds = None
    elif age_seconds is not None:
        age_seconds = max(0, age_seconds)
    if has_out_of_range_value:
        quality = "out_of_range"
    elif has_missing_value or any("timestamp" in issue for issue in issues):
        quality = "missing"
    elif age_seconds is None:
        quality = "missing"
    elif age_seconds > SENSOR_STALE_SECONDS:
        quality = "stale"
        issues.append(f"no reading received within {SENSOR_STALE_SECONDS} seconds")
    else:
        quality = "valid"
    return {**reading, "risk_explanation": reading.get("risk_explanation") or explain_risk(
        reading["water_level"], reading["temperature"], reading["turbidity"]
    ), "data_quality": quality, "data_quality_issues": issues,
        "reading_age_seconds": round(age_seconds, 1) if age_seconds is not None else None,
        "prediction_basis": "Prototype prediction · trained on synthetic data; not field validated."}


def include_ml_result(reading):
    """Backfill ML results when reading rows were saved before the ML upgrade."""
    if not reading or reading.get("ml_status") not in (None, "Needs analysis"):
        return enrich_reading(reading)
    status, score, explanation = analyse_anomaly(
        reading["water_level"], reading["temperature"], reading["turbidity"]
    )
    return enrich_reading({**reading, "ml_status": status, "anomaly_score": score, "ml_explanation": explanation})


init_db()
if latest_reading() is None:
    # Seed one clearly synthetic baseline so the dashboard is populated on first open.
    save_reading(analyse({"water_level": 4.8, "temperature": 28.5, "turbidity": 5.2}))


@app.get("/")
def dashboard():
    return render_template("index.html")


@app.get("/api/latest")
def api_latest():
    reading = include_ml_result(latest_reading())
    return jsonify(reading or {"reading": None, "message": "No readings available.", "data_quality": "missing"})


@app.get("/api/history")
def api_history():
    return jsonify([include_ml_result(reading) for reading in recent_readings()])


@app.post("/api/sensor")
def api_sensor():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Send a JSON object with water_level, temperature and turbidity."), 400
    try:
        values = {key: float(payload[key]) for key in ("water_level", "temperature", "turbidity")}
    except (KeyError, TypeError, ValueError):
        return jsonify(error="All three sensor values must be numbers."), 400
    for key, (minimum, maximum) in SENSOR_BOUNDS.items():
        if not isfinite(values[key]) or not minimum <= values[key] <= maximum:
            return jsonify(error=f"{key.replace('_', ' ')} must be between {minimum} and {maximum}.",
                           data_quality="out_of_range", field=key), 422
    return jsonify(include_ml_result(save_reading(analyse(values)))), 201


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
