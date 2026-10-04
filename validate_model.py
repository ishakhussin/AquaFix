"""Evaluate prototype model alerts against independently labelled field readings."""
import argparse
import csv
import sys
from pathlib import Path

from sklearn.metrics import accuracy_score, classification_report, confusion_matrix

from ml_model import analyse_anomaly, classify

RISK_LABELS = ("Normal", "Medium Risk", "High Risk")
ANOMALY_LABELS = ("Normal", "Anomaly")
BOUNDS = {"water_level": (0, 20), "temperature": (-5, 60), "turbidity": (0, 1000)}


def load_rows(path):
    required = set(BOUNDS) | {"actual_risk", "actual_anomaly"}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = required - set(reader.fieldnames or ())
        if missing:
            raise ValueError(f"CSV is missing columns: {', '.join(sorted(missing))}")
        rows = []
        for line, row in enumerate(reader, start=2):
            try:
                values = {key: float(row[key]) for key in BOUNDS}
            except (TypeError, ValueError):
                raise ValueError(f"Line {line}: sensor values must be numbers.") from None
            for key, value in values.items():
                minimum, maximum = BOUNDS[key]
                if not minimum <= value <= maximum:
                    raise ValueError(f"Line {line}: {key} is outside configured range {minimum}–{maximum}.")
            risk = row["actual_risk"].strip().title()
            anomaly = row["actual_anomaly"].strip().title()
            if risk not in RISK_LABELS:
                raise ValueError(f"Line {line}: actual_risk must be one of {', '.join(RISK_LABELS)}.")
            if anomaly not in ANOMALY_LABELS:
                raise ValueError(f"Line {line}: actual_anomaly must be Normal or Anomaly.")
            rows.append((values, risk, anomaly))
    if not rows:
        raise ValueError("CSV has a header but no labelled field readings.")
    return rows


def print_report(title, expected, predicted, labels):
    print(f"\n{title} (n={len(expected)})")
    print(f"Accuracy: {accuracy_score(expected, predicted):.3f}")
    print(classification_report(expected, predicted, labels=list(labels), zero_division=0, digits=3))
    print("Confusion matrix (rows=actual, columns=predicted):")
    print("Labels: " + " | ".join(labels))
    for row in confusion_matrix(expected, predicted, labels=list(labels)):
        print("  " + " | ".join(str(int(value)) for value in row))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path, help="CSV containing real sensor readings and independent field labels")
    args = parser.parse_args()
    try:
        rows = load_rows(args.csv_path)
    except (OSError, ValueError) as error:
        print(f"Validation could not run: {error}", file=sys.stderr)
        return 2

    actual_risk, predicted_risk, actual_anomaly, predicted_anomaly = [], [], [], []
    for values, risk_label, anomaly_label in rows:
        risk, _confidence = classify(values["water_level"], values["temperature"], values["turbidity"])
        anomaly, _score, _explanation = analyse_anomaly(values["water_level"], values["temperature"], values["turbidity"])
        actual_risk.append(risk_label)
        predicted_risk.append(risk)
        actual_anomaly.append(anomaly_label)
        predicted_anomaly.append("Normal" if anomaly == "Normal" else "Anomaly")

    print(f"AquaFix prototype validation · {len(rows)} labelled field readings")
    print("Use independent field assessments as labels; synthetic simulator readings are not valid field validation.")
    print_report("Risk classifier", actual_risk, predicted_risk, RISK_LABELS)
    print_report("Anomaly alert", actual_anomaly, predicted_anomaly, ANOMALY_LABELS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
