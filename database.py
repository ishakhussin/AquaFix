"""Small SQLite storage layer for AquaFix sensor readings."""
import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("AQUIFIX_DB_PATH", BASE_DIR / "data" / "aquafix.db"))


def get_connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS sensor_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                water_level REAL NOT NULL,
                temperature REAL NOT NULL,
                turbidity REAL NOT NULL,
                risk TEXT NOT NULL,
                confidence REAL NOT NULL,
                predicted_water_level REAL NOT NULL,
                recommendation TEXT NOT NULL,
                ml_status TEXT NOT NULL DEFAULT 'Needs analysis',
                anomaly_score REAL NOT NULL DEFAULT 0,
                ml_explanation TEXT NOT NULL DEFAULT 'Awaiting sensor analysis.'
            )
        """)
        # Add ML fields to databases created by earlier AquaFix versions.
        columns = {row[1] for row in connection.execute("PRAGMA table_info(sensor_data)")}
        additions = {
            "ml_status": "TEXT NOT NULL DEFAULT 'Needs analysis'",
            "anomaly_score": "REAL NOT NULL DEFAULT 0",
            "ml_explanation": "TEXT NOT NULL DEFAULT 'Awaiting sensor analysis.'",
        }
        for name, declaration in additions.items():
            if name not in columns:
                connection.execute(f"ALTER TABLE sensor_data ADD COLUMN {name} {declaration}")


def save_reading(reading):
    with get_connection() as connection:
        cursor = connection.execute("""
            INSERT INTO sensor_data
            (water_level, temperature, turbidity, risk, confidence, predicted_water_level, recommendation,
             ml_status, anomaly_score, ml_explanation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (reading["water_level"], reading["temperature"], reading["turbidity"], reading["risk"],
              reading["confidence"], reading["predicted_water_level"], reading["recommendation"],
              reading["ml_status"], reading["anomaly_score"], reading["ml_explanation"]))
        # Keep this local prototype database bounded during unattended streaming.
        connection.execute("DELETE FROM sensor_data WHERE id NOT IN (SELECT id FROM sensor_data ORDER BY id DESC LIMIT 2000)")
        row = connection.execute("SELECT * FROM sensor_data WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return dict(row)


def latest_reading():
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1").fetchone()
        return dict(row) if row else None


def recent_readings(limit=60):
    with get_connection() as connection:
        rows = connection.execute("SELECT * FROM sensor_data ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in reversed(rows)]
