"""Synthetic-data risk classifier and short-horizon water-level estimate."""
import numpy as np
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

RISK_LABELS = {0: "Normal", 1: "Medium Risk", 2: "High Risk"}


def build_model():
    """Train on a deliberately synthetic, rule-labelled dataset."""
    rng = np.random.default_rng(42)
    rows, labels = [], []
    for _ in range(2400):
        water = rng.uniform(1.2, 7.0)
        temp = rng.uniform(24, 36)
        turbidity = rng.uniform(1, 24)
        # Training labels combine low water with heat and changing water quality.
        stress = (4.2 - water) + max(0, temp - 29) * 0.11 + max(0, turbidity - 8) * 0.055
        label = 2 if stress >= 2.35 or water < 2.1 else 1 if stress >= 0.65 or water < 3.7 else 0
        rows.append([water, temp, turbidity])
        labels.append(label)
    model = RandomForestClassifier(n_estimators=120, max_depth=8, random_state=42, class_weight="balanced")
    model.fit(np.asarray(rows), np.asarray(labels))
    return model


MODEL = build_model()


def build_anomaly_model():
    """Fit an Isolation Forest to explicitly synthetic normal readings."""
    rng = np.random.default_rng(2026)
    count = 2400
    water = np.clip(rng.normal(5.1, 0.62, count), 3.7, 6.6)
    temperature = np.clip(rng.normal(28.5, 1.9, count), 24, 33)
    turbidity = np.clip(rng.normal(5.8, 2.0, count), 0.5, 12)
    normal_rows = np.column_stack([water, temperature, turbidity])
    pipeline = make_pipeline(
        StandardScaler(),
        IsolationForest(n_estimators=180, contamination=0.08, random_state=42),
    )
    pipeline.fit(normal_rows)
    baseline_scores = pipeline.decision_function(normal_rows)
    warning_threshold = float(np.percentile(baseline_scores, 25))
    return pipeline, warning_threshold


ANOMALY_MODEL, WARNING_THRESHOLD = build_anomaly_model()


def analyse_anomaly(water_level, temperature, turbidity):
    """Return an anomaly label, score, and plain-language explanation.

    Higher scores are more typical of the synthetic training baseline. The
    model is a software proof of concept, not a field-validated farm model.
    """
    features = np.asarray([[water_level, temperature, turbidity]], dtype=float)
    score = float(ANOMALY_MODEL.decision_function(features)[0])
    flagged = int(ANOMALY_MODEL.predict(features)[0]) == -1
    status = "Abnormal" if flagged else "Warning" if score < WARNING_THRESHOLD else "Normal"
    issues = []
    if water_level < 3.6:
        issues.append("low water level")
    if temperature > 31.5:
        issues.append("high temperature")
    if turbidity > 12:
        issues.append("elevated turbidity")
    if issues:
        explanation = "Possible factors: " + ", ".join(issues)
    elif status == "Normal":
        explanation = "Readings fit the synthetic training baseline."
    else:
        explanation = "The sensor combination differs from the synthetic demo baseline."
    return status, round(score, 4), explanation


def classify(water_level, temperature, turbidity):
    features = np.array([[water_level, temperature, turbidity]])
    prediction = int(MODEL.predict(features)[0])
    confidence = float(MODEL.predict_proba(features)[0][prediction])
    return RISK_LABELS[prediction], round(confidence, 3)


def explain_risk(water_level, temperature, turbidity):
    """Explain the synthetic rule pattern used to train the risk classifier."""
    factors = {
        "low water level": max(0.0, 4.2 - water_level),
        "elevated temperature": max(0.0, temperature - 29.0) * 0.11,
        "elevated turbidity": max(0.0, turbidity - 8.0) * 0.055,
    }
    score = sum(factors.values())
    contributors = [f"{name} (+{value:.2f})" for name, value in factors.items() if value > 0]
    if water_level < 2.1:
        contributors.append("very low water override (<2.1 cm)")
    if not contributors:
        return f"Training-rule stress score {score:.2f}; no individual factor contributed. Synthetic labels use Medium Risk at 0.65 and High Risk at 2.35, or water below 2.1 cm."
    return f"Training-rule stress score {score:.2f}; contributors: {', '.join(contributors)}. Synthetic labels use Medium Risk at 0.65 and High Risk at 2.35, or water below 2.1 cm."


def forecast_water_level(current, history):
    """Project the recent robust slope forward three hours (prototype heuristic)."""
    levels = [float(item["water_level"]) for item in history[-8:]]
    if len(levels) < 2:
        return round(max(0, current - 0.2), 1)
    differences = np.diff(levels)
    slope = float(np.median(differences[-5:]))
    # Simulation time is compressed, so extrapolate only a few
    # recent steps to keep the displayed three-hour estimate responsive but stable.
    projected = current + slope * 2
    # Bound the forecast so one noisy reading cannot create a wild estimate.
    return round(max(0, min(current + 1.5, projected)), 1)


def recommend(risk, predicted_water_level):
    if risk == "High Risk" or predicted_water_level < 2.5:
        return "Irrigation required — check the field water supply."
    if risk == "Medium Risk" or predicted_water_level < 3.6:
        return "Prepare irrigation and monitor the water level closely."
    return "Conditions stable — continue routine monitoring."
