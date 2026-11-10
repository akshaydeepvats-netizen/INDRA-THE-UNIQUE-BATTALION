"""SQLite persistence: alerts lifecycle, acknowledgements, audit log, forecast archive,
verification scores, cell history (for replay) and event-feedback labels."""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

from . import config

_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, kind TEXT, source_type TEXT, hazard TEXT, level TEXT, peak_level TEXT,
  title TEXT, district_id INTEGER, district TEXT, state TEXT, lat REAL, lon REAL,
  status TEXT, created_at REAL, updated_at REAL, expires_at REAL, ended_at REAL,
  acknowledged_at REAL, acknowledged_by TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS ix_alert_status ON alerts(status, updated_at);
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, at REAL, event TEXT, level TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS ix_ae ON alert_events(alert_id, at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, actor TEXT, action TEXT, target TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, issued_at REAL, valid_at REAL, lead_min INTEGER,
  method TEXT, grid BLOB, verified INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_fc ON forecasts(verified, valid_at);
CREATE TABLE IF NOT EXISTS verification (
  id INTEGER PRIMARY KEY AUTOINCREMENT, valid_at REAL, lead_min INTEGER, method TEXT,
  hits INTEGER, misses INTEGER, false_alarms INTEGER, correct_negatives INTEGER);
CREATE TABLE IF NOT EXISTS cell_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, source TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS ix_ch ON cell_history(at);
CREATE TABLE IF NOT EXISTS threat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, payload TEXT);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at REAL, location TEXT, event_type TEXT,
  outcome TEXT, notes TEXT);
"""


@contextmanager
def db():
    with _lock:
        con = sqlite3.connect(config.DB_PATH, timeout=10)
        con.row_factory = sqlite3.Row
        try:
            yield con
            con.commit()
        finally:
            con.close()


def init():
    with db() as con:
        con.executescript(SCHEMA)


def audit(actor, action, target="", detail=None):
    with db() as con:
        con.execute("INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)",
                    (time.time(), actor, action, target, json.dumps(detail or {})[:4000]))


def prune():
    """Keep the runtime DB bounded on small hosts."""
    cutoff = time.time() - 3 * 86400
    with db() as con:
        con.execute("DELETE FROM cell_history WHERE at < ?", (cutoff,))
        con.execute("DELETE FROM threat_history WHERE at < ?", (cutoff,))
        con.execute("DELETE FROM forecasts WHERE valid_at < ? AND verified=1", (time.time() - 6 * 3600,))
        con.execute("DELETE FROM forecasts WHERE valid_at < ?", (cutoff,))
        con.execute("DELETE FROM audit WHERE at < ?", (time.time() - 14 * 86400,))
