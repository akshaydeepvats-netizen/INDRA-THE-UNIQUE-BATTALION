"""Official alerts from NDMA SACHET — India's Common Alerting Protocol (CAP) Integrated Alert System.

SACHET aggregates alerts issued by authorised agencies (IMD regional centres, State/UT Disaster
Management Authorities, CWC, INCOIS, FSI ...). INDRA shows them as OFFICIAL and never mixes them with
its own model-generated screening alerts. The public feed gives a centroid and covered area (km^2)
but no polygon, so the map footprint is an equivalent-area circle and is labelled APPROXIMATE;
district names in the area description are matched to INDRA's district boundaries where possible.
"""
import logging
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from . import config, geo, net

log = logging.getLogger("indra.sachet")
IST = timezone(timedelta(hours=5, minutes=30))
_lock = threading.Lock()
STATE = {"status": "NOT CHECKED", "alerts": [], "fetched_at": None, "error": None, "seen": set()}

SEVERITY_RANK = {"WARNING": 3, "ALERT": 2, "WATCH": 1}
COLOUR_LEVEL = {"red": "WARNING", "orange": "ALERT", "yellow": "WATCH", "green": "ADVISORY"}
_MET_WORDS = re.compile(r"rain|thunder|lightning|hail|storm|squall|wind|cyclone|cloud|flood|heat|cold|fog|snow|dust", re.I)


def _parse_time(s):
    if not s:
        return None
    s = re.sub(r"\s+", " ", str(s).strip())
    for fmt in ("%a %b %d %H:%M:%S IST %Y", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S"):
        try:
            d = datetime.strptime(s, fmt)
            if d.tzinfo is None:
                d = d.replace(tzinfo=IST)
            return d.timestamp()
        except ValueError:
            continue
    return None


_NAME_INDEX = None


def _norm(s):
    return re.sub(r"[^a-z]", "", s.lower())


def _districts_named(text, state_hint=None):
    """Match district names that appear in a SACHET area description."""
    global _NAME_INDEX
    if _NAME_INDEX is None:
        _NAME_INDEX = [(_norm(d["name"]), d) for d in geo.DISTRICTS if len(_norm(d["name"])) >= 4]
    tokens = [_norm(t) for t in re.split(r",|&|\band\b|;|\(|\)", text or "") if t.strip()]
    tokens = [re.sub(r"(districts?of.*|district|dist)$", "", t) for t in tokens]
    out = []
    for key, d in _NAME_INDEX:
        if state_hint and d["state"] != state_hint:
            continue
        if any(t == key or (len(t) >= 5 and (t.startswith(key) or key.startswith(t))) for t in tokens):
            out.append(d)
    return out


def _normalise(rec, now):
    try:
        lon, lat = [float(x) for x in str(rec.get("centroid", "")).split(",")[:2]]
    except ValueError:
        lat = lon = None
    start, end = _parse_time(rec.get("effective_start_time")), _parse_time(rec.get("effective_end_time"))
    area = None
    try:
        area = float(rec.get("area_covered") or 0) or None
    except ValueError:
        pass
    level = (rec.get("severity") or COLOUR_LEVEL.get((rec.get("severity_color") or "").lower(), "ADVISORY")).upper()
    centre = geo.district_at(lat, lon) if lat is not None else None
    state = centre["state"] if centre else None
    named = _districts_named(rec.get("area_description", ""), state) or _districts_named(rec.get("area_description", ""))
    if centre and not any(d["id"] == centre["id"] for d in named) and not named:
        named = [centre]
    radius = math.sqrt(area / math.pi) if area else None
    return {
        "id": f"SACHET-{rec.get('identifier')}",
        "identifier": rec.get("identifier"),
        "classification": "OFFICIAL",
        "issuer": rec.get("alert_source") or "Authorised agency",
        "feed": "NDMA SACHET (CAP Integrated Alert System)",
        "event": rec.get("disaster_type") or "Alert",
        "meteorological": bool(_MET_WORDS.search(rec.get("disaster_type") or "")),
        "level": level,
        "level_rank": SEVERITY_RANK.get(level, 0),
        "colour": (rec.get("severity_color") or "").lower() or None,
        "certainty": rec.get("severity_level"),
        "message": (rec.get("warning_message") or "").strip(),
        "area_description": (rec.get("area_description") or "").strip(),
        "area_km2": area,
        "lat": lat, "lon": lon,
        "radius_km": round(radius, 1) if radius else None,
        "footprint": "APPROXIMATE (centroid + equivalent-area circle; SACHET public feed has no polygon)",
        "state": state,
        "districts": [{"id": d["id"], "name": d["name"], "state": d["state"]} for d in named[:40]],
        "effective_from": start, "effective_until": end,
        "status": "ACTIVE" if (end is None or end > now) and (start is None or start <= now + 3600) else "EXPIRED",
        "language": rec.get("actual_lang"),
        "url": "https://sachet.ndma.gov.in/",
    }


def refresh():
    """Fetch the current SACHET alert list. Returns (alerts, new_alerts)."""
    data, meta = net.get(config.SACHET_ALERTS_URL, ttl=60, feed="sachet", timeout=30,
                         headers={"Accept": "application/json", "Referer": "https://sachet.ndma.gov.in/"})
    now = time.time()
    if not isinstance(data, list):
        with _lock:
            STATE.update(status="UNAVAILABLE" if not STATE["alerts"] else "STALE", error=meta.get("error") or "unexpected response",
                         checked_at=now)
        return STATE["alerts"], []
    alerts = []
    for rec in data:
        try:
            alerts.append(_normalise(rec, now))
        except Exception as exc:  # noqa: BLE001
            log.warning("sachet record skipped: %s", exc)
    alerts.sort(key=lambda a: (a["status"] != "ACTIVE", -a["level_rank"], -(a["effective_from"] or 0)))
    with _lock:
        first = not STATE["seen"]
        new = [a for a in alerts if a["status"] == "ACTIVE" and a["id"] not in STATE["seen"]]
        STATE["seen"].update(a["id"] for a in alerts)
        STATE.update(status="LIVE" if meta["status"] in ("LIVE", "CACHED") else meta["status"], alerts=alerts,
                     fetched_at=meta.get("fetched_at") or now, checked_at=now, error=None)
    return alerts, ([] if first else new)


def active(meteorological_only=False):
    with _lock:
        al = [a for a in STATE["alerts"] if a["status"] == "ACTIVE"]
    return [a for a in al if a["meteorological"]] if meteorological_only else al


def near(lat, lon, km=60, district_id=None):
    """Active official alerts covering a point (district match or within centroid radius + km)."""
    out = []
    for a in active():
        hit = district_id is not None and any(d["id"] == district_id for d in a["districts"])
        if not hit and a["lat"] is not None:
            d = geo_km(lat, lon, a["lat"], a["lon"])
            hit = d <= (a["radius_km"] or 0) + km
        if hit:
            out.append(a)
    return out


def geo_km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


def public_state():
    with _lock:
        al = list(STATE["alerts"])
        st = {k: v for k, v in STATE.items() if k not in ("alerts", "seen")}
    act = [a for a in al if a["status"] == "ACTIVE"]
    return {**st, "provider": "NDMA SACHET — CAP Integrated Alert System", "url": "https://sachet.ndma.gov.in/",
            "classification": "OFFICIAL", "total": len(al), "active": len(act),
            "by_level": {lv: sum(1 for a in act if a["level"] == lv) for lv in ("WARNING", "ALERT", "WATCH", "ADVISORY")},
            "alerts": al}
