"""INDRA — India's real-time severe-weather intelligence & 0–6 h convective nowcasting platform.

Run locally:  pip install -r requirements.txt  then  python app.py   (http://127.0.0.1:5000)
Windows:      double-click run_windows.bat (creates a virtual env, installs packages, opens the browser)
Production:   gunicorn -c gunicorn.conf.py app:app
"""
import importlib.util
import sys

# Friendly check: running app.py without the dependencies installed (e.g. from IDLE) gives a clear fix.
_MISSING = [m for m in ("flask", "requests", "numpy", "PIL", "scipy", "websockets") if importlib.util.find_spec(m) is None]
if _MISSING:
    sys.stderr.write(
        "\nINDRA cannot start - missing Python packages: " + ", ".join(_MISSING) + "\n\n"
        "Fix (run once in a terminal / Command Prompt inside this folder):\n"
        f"    \"{sys.executable}\" -m pip install -r requirements.txt\n\n"
        "Windows: or just double-click run_windows.bat\n\n")
    raise SystemExit(1)

import csv
import io
import mimetypes
import re
import json
import logging
import math
import os
import time

import numpy as np
from flask import Flask, Response, g, jsonify, request, send_from_directory, stream_with_context
from flask.json.provider import DefaultJSONProvider

from indra import auth, config, geo, mailer, hazards as HZ, imd, lightning, models, net, obs, radar, sachet, store, tracking
from indra.engine import ENGINE

# Windows registries sometimes map .js to text/plain, which makes browsers refuse ES modules.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/geo+json", ".geojson")

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("indra")


class NumpyJSON(DefaultJSONProvider):
    sort_keys = False

    def default(self, o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, set):
            return sorted(o)
        return super().default(o)


app = Flask(__name__, static_folder="static", static_url_path="/static")
app.json = NumpyJSON(app)


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = config.CORS_ORIGINS
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    if request.path.startswith("/api/") and "Cache-Control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"
    return resp


_started = False


def ensure_engine():
    global _started
    if not _started and config.ENGINE_ENABLED:
        _started = True
        ENGINE.start()


store.init()
auth.init()
obs.init()


@app.before_request
def _before():
    ensure_engine()
    auth.resolve()


def fnum(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def age(ts):
    return None if not ts else round(time.time() - ts)


# ------------------------------------------------------------------ pages
@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api")
@app.get("/api/docs")
@auth.require("api_docs")
def docs():
    return jsonify({"name": "INDRA public API", "version": config.VERSION, "endpoints": {
        "GET /api/status": "Feed health, freshness and engine loops",
        "GET /api/stream": "Server-sent events: live log, lightning, alerts, fusion cycles",
        "GET /api/national": "National threat summary and priority districts",
        "GET /api/states": "Threat for all 36 states/UTs",
        "GET /api/states/<slug>/districts": "District threat for one state",
        "GET /api/district/<id>": "District report: threat timeline, cities/towns, cells, alerts",
        "GET /api/place/<id>/villages": "Villages grouped under a city/town",
        "GET /api/search?q=": "State / district / city / town / village search (offline gazetteer)",
        "GET /api/location?lat=&lon=": "Full hazard report for any point: multi-model, nowcast 0–6 h, nearby cells, ETA",
        "GET /api/models?lat=&lon=": "Independent model comparison (ECMWF, GFS, ICON, UKMO, AIFS)",
        "GET /api/cells": "Detected storm cells with motion, corridor, ETA, impact",
        "GET /api/radar": "Precipitation frames (NASA GIBS GPM IMERG 30-min) and processing status",
        "GET /api/official": "OFFICIAL alerts from NDMA SACHET (CAP) — never mixed with INDRA screening alerts",
        "GET /api/satellite": "Satellite frames and processing status",
        "GET /api/lightning?minutes=": "Lightning strikes, density and trend",
        "GET /api/alerts?status=": "Alerts (ACTIVE / ENDING / EXPIRED / all)",
        "POST /api/alerts/<id>/ack": "Acknowledge alert",
        "GET /api/verification": "Forecast verification scores (POD, FAR, CSI)",
        "GET /api/history": "National threat history and observed cell replay",
        "GET /api/overlay/hazard.png?hazard=&lead=": "Hazard overlay (Web-Mercator image, bounds in /api/status)",
        "GET /api/overlay/sat.png?layer=&time=": "EUMETSAT Meteosat IODC layer, Web-Mercator, proxied + cached",
        "GET /api/overlay/radar.png": "QC'd IMERG rain-rate analysis overlay (INDRA grid)",
        "GET /api/imd": "Official IMD feed status/records",
    }})


# ------------------------------------------------------------------ status
@app.get("/api/health")
def health():
    return jsonify({"system": "INDRA", "status": "OK", "version": config.VERSION, "time": time.time(),
                    "engine_started": _started, "uptime_s": round(time.time() - ENGINE.started)})


def feed_state(name, live_age_limit):
    f = net.FEEDS.get(name)
    if not f:
        return "CONNECTING"
    if f["last_ok"] and time.time() - f["last_ok"] < live_age_limit:
        return "LIVE"
    if f["last_ok"]:
        return "STALE"
    return "UNAVAILABLE"


def precip_state(r):
    st = r.get("status")
    if st == "LIVE" and r.get("frame_time") and time.time() - r["frame_time"] > config.PRECIP_LIVE_AGE_S:
        return "DELAYED"
    return st


@app.get("/api/status")
@auth.require("home")
def status():
    r, s, g = ENGINE.radar, ENGINE.sat, ENGINE.grid
    ls = lightning.STATE
    feeds = [
        {"id": "radar", "name": "Satellite precipitation (IMERG 30-min)", "provider": "NASA GIBS · GPM IMERG Early", "state": precip_state(r),
         "data_time": r.get("frame_time"), "age_s": age(r.get("frame_time")), "detail": f"{r.get('cells', 0)} rain cells ≥5.6 mm/h",
         "authoritative": False, "note": "Multi-satellite rain-rate estimate, 0.1° (~11 km), typical latency 4–6 h. Not ground radar, not IMD DWR."},
        {"id": "official", "name": "Official alerts (CAP)", "provider": "NDMA SACHET — IMD, SDMAs, CWC, INCOIS…", "state": sachet.STATE.get("status"),
         "data_time": sachet.STATE.get("fetched_at"), "age_s": age(sachet.STATE.get("fetched_at")),
         "detail": f"{len(sachet.active())} active official alerts", "authoritative": True,
         "note": "Shown separately from INDRA screening alerts. Public feed has no polygons — footprints approximate."},
        {"id": "satellite", "name": "Geostationary IR satellite", "provider": "EUMETSAT Meteosat IODC (45.5°E) SEVIRI 10.8 µm", "state": s.get("status"),
         "data_time": s.get("frame_time"), "age_s": age(s.get("frame_time")), "detail": f"{s.get('objects', 0)} cold-cloud objects · {s.get('convective_initiation', 0)} CI",
         "authoritative": False, "note": "Brightness temperature estimated from rendered imagery."},
        {"id": "lightning", "name": "Lightning detection", "provider": "Blitzortung.org community network", "state": "LIVE" if ls["connected"] else ("CONNECTING" if not ls["error"] else "UNAVAILABLE"),
         "data_time": ls.get("last_strike"), "age_s": age(ls.get("last_message")), "detail": f"{len(lightning.recent(15))} India strikes / 15 min",
         "authoritative": False, "note": "Volunteer network; detection efficiency over India varies. Not IMD/IITM."},
        {"id": "models", "name": "NWP model grid", "provider": "Open-Meteo (ECMWF/GFS/ICON best-match)", "state": g.get("status"),
         "data_time": g.get("fetched_at"), "age_s": age(g.get("fetched_at")), "detail": f"{g.get('valid', 0)} pts @ {config.MODEL_GRID_DEG}° · 0–6 h",
         "authoritative": False},
        {"id": "stations", "name": "Ground weather stations (METAR)", "provider": "NOAA AviationWeather.gov — Indian airports",
         "state": feed_state("metar", 5400) if net.FEEDS.get("metar") else obs.STATE.get("status", "CONNECTING"),
         "data_time": obs.STATE.get("fetched_at"), "age_s": age(obs.STATE.get("fetched_at")),
         "detail": f"{obs.STATE.get('stations', 0)} stations · accuracy {obs.ACC.get('status')}", "authoritative": False,
         "note": "Real observed temperature, wind and weather at airports. Used to score models and correct INDRA's best estimate."},
        {"id": "imd", "name": "IMD official warnings / nowcast", "provider": "India Meteorological Department", "state": feed_state("imd_official", 900) if net.FEEDS.get("imd_official") else "NOT CHECKED",
         "authoritative": True, "note": "Requires IMD IP whitelisting or token."},
        {"id": "dwr", "name": "IMD Doppler Weather Radar (reflectivity/velocity)", "provider": "IMD", "state": "NOT CONNECTED", "authoritative": True,
         "note": "No public machine-readable feed. Requires IMD data agreement."},
        {"id": "insat", "name": "INSAT-3D/3DR/3DS imagery", "provider": "ISRO / MOSDAC / IMD", "state": "NOT CONNECTED", "authoritative": True,
         "note": "MOSDAC requires registered access; adapter slot available."},
        {"id": "ilds", "name": "IMD / IITM lightning network", "provider": "IITM (Damini)", "state": "NOT CONNECTED", "authoritative": True,
         "note": "No public API."},
    ]
    return jsonify({"version": config.VERSION, "time": time.time(), "uptime_s": round(time.time() - ENGINE.started),
                    "national_level": ENGINE.national.get("level"), "fusion_id": ENGINE.fusion_id, "fusion_at": ENGINE.fusion_at,
                    "feeds": feeds, "loops": ENGINE.loops, "http": net.FEEDS,
                    "grid": {"bounds": [[5.0, 66.0], [38.0, 99.0]], "res_deg": 0.025, "model_grid_deg": config.MODEL_GRID_DEG},
                    "radar": {k: v for k, v in r.items() if k != "frames"}, "satellite": s,
                    "model_runs": g.get("runs"), "lightning": ls, "accuracy": obs.summary(), "tier": auth.tier()})


@app.get("/api/stream")
@auth.require("home")
def stream():
    last = int(request.args.get("since") or request.headers.get("Last-Event-ID") or 0)

    @stream_with_context
    def gen():
        nonlocal last
        yield "retry: 4000\n\n"
        if last == 0:
            for e in list(ENGINE.events)[-40:]:
                last = e["id"]
                yield f"id: {e['id']}\ndata: {json.dumps(e, default=float)}\n\n"
        t_end = time.time() + 600
        while time.time() < t_end:
            with ENGINE.cond:
                ENGINE.cond.wait(timeout=15)
            evs = ENGINE.events_since(last)
            if not evs:
                yield ": heartbeat\n\n"
                continue
            for e in evs:
                last = e["id"]
                yield f"id: {e['id']}\ndata: {json.dumps(e, default=float)}\n\n"
    return Response(gen(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/events")
@auth.require("home")
def events_poll():
    since = int(request.args.get("since", 0))
    return jsonify({"events": ENGINE.events_since(since)[-200:], "last_id": ENGINE.ev_id})


# ------------------------------------------------------------------ atlas
@app.get("/api/national")
@auth.require("atlas")
def national():
    return jsonify({**ENGINE.national, "states": list(ENGINE.states.values())})


@app.get("/api/states")
@auth.require("atlas")
def states():
    return jsonify({"generated_at": ENGINE.fusion_at, "states": list(ENGINE.states.values())})


@app.get("/api/states/<slug>/districts")
@auth.require("atlas")
def state_districts(slug):
    st = geo.STATE_BY_SLUG.get(slug)
    if not st:
        return jsonify({"error": "unknown state"}), 404
    ds = [ENGINE.districts.get(i) or {"id": i, "name": geo.DISTRICT_BY_ID[i]["name"], "level": "UNKNOWN", "score": None}
          for i in st["district_ids"]]
    return jsonify({"state": st["name"], "slug": slug, "generated_at": ENGINE.fusion_at, "state_threat": ENGINE.states.get(slug),
                    "districts": sorted(ds, key=lambda x: -(x.get("score") or -1))})


def _cell_brief(c):
    out = {k: c[k] for k in ("id", "source", "lat", "lon", "severity", "primary_hazard", "area_km2", "motion", "trend", "intensity", "lightning_15min")}
    out.update(latent=bool(c.get("latent")), status_label=c.get("status_label"), obs_time=c.get("obs_time"))
    return out


def _official_brief(a):
    return {k: a[k] for k in ("id", "classification", "issuer", "event", "level", "certainty", "message", "area_description",
                              "effective_from", "effective_until", "lat", "lon", "radius_km", "districts", "url")}


@app.get("/api/district/<int:did>")
@auth.require("district_report")
def district(did):
    d = geo.DISTRICT_BY_ID.get(did)
    if not d:
        return jsonify({"error": "unknown district"}), 404
    threat = ENGINE.districts.get(did)
    towns = geo.towns_in_district(did)
    cells = [c for c in ENGINE.cells if any(x["id"] == did for x in c["impact"]["now"]["districts"] + c["impact"]["forecast"]["districts"])]
    with store.db() as con:
        alerts = [dict(r) for r in con.execute("SELECT id,title,level,peak_level,status,hazard,created_at,updated_at FROM alerts WHERE district_id=? ORDER BY updated_at DESC LIMIT 20", (did,))]
    return jsonify({"district": d, "threat": threat, "towns": towns, "village_count": geo.village_count(did),
                    "cells": [{**_cell_brief(c), "eta": next((x for x in c["impact"]["forecast"]["districts"] if x["id"] == did), None)} for c in cells],
                    "alerts": alerts, "precautions": HZ.precautions((threat or {}).get("hazards", {})),
                    "official_alerts": [_official_brief(a) for a in sachet.near(d["lat"], d["lon"], 0, did)
                                        if any(x["id"] == did for x in a["districts"])],
                    "hierarchy_note": "Cities/towns and villages from GeoNames (CC-BY 4.0). Villages are grouped under their nearest town within the district."})


@app.get("/api/place/<int:pid>/villages")
@auth.require("atlas")
def villages(pid):
    p = geo.place(pid)
    if not p:
        return jsonify({"error": "unknown place"}), 404
    return jsonify({"place": p, "villages": geo.villages_of_town(pid)})


@app.get("/api/search")
@auth.require("search")
def search():
    q = request.args.get("q", "")
    res = geo.search(q, limit=14)
    source = "INDRA gazetteer (offline)"
    if not res and len(q.strip()) >= 3:
        data, meta = net.get(config.GEOCODER_URL, params={"q": q + ", India", "format": "jsonv2", "limit": 6, "countrycodes": "in"},
                             ttl=86400, feed="nominatim")
        for item in data or []:
            la, lo = fnum(item.get("lat")), fnum(item.get("lon"))
            if la is None:
                continue
            dd = geo.district_at(la, lo)
            res.append({"type": "place", "name": item.get("name") or item.get("display_name", "").split(",")[0], "lat": la, "lon": lo,
                        "district": dd and dd["name"], "state": dd and dd["state"], "district_id": dd and dd["id"],
                        "label": item.get("display_name", "")[:120]})
        source = "OpenStreetMap Nominatim (fallback)"
    return jsonify({"query": q, "source": source, "results": res})


# ------------------------------------------------------------------ location report
def _point_hazard_models(multi):
    """Hazard diagnostics per model per lead hour; mean and spread (model agreement)."""
    leads = min(7, len(multi.get("times") or []))
    per = {}
    for m in multi.get("models", []):
        if m["status"] == "NO_DATA":
            continue
        h = m["hourly"]
        per[m["id"]] = [models.hazard_scores(h, i) for i in range(leads)]
    out = []
    for i in range(leads):
        row = {"lead_h": i, "valid_time": multi["times"][i]}
        for k in HZ.HAZARDS:
            vals = [per[mid][i][k] for mid in per]
            if vals:
                row[k] = {"mean": round(float(np.mean(vals))), "max": max(vals), "min": min(vals), "spread": max(vals) - min(vals)}
        out.append(row)
    return out, list(per)


@app.get("/api/location")
@auth.require("weather")
def location():
    lat, lon = fnum(request.args.get("lat")), fnum(request.args.get("lon"))
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return jsonify({"error": "valid lat/lon required"}), 400
    name = (request.args.get("name") or "").strip()[:120]
    d = geo.district_at(lat, lon)
    multi = models.point_multi(lat, lon, hours=13)
    haz_models, used = _point_hazard_models(multi) if multi.get("models") else ([], [])
    dthreat = ENGINE.districts.get(d["id"]) if d else None
    # nearby cells and ETA to this exact point
    near = []
    for c in ENGINE.cells:
        dist = tracking.km_between(lat, lon, c["lat"], c["lon"])
        if dist > 250:
            continue
        eta = None
        for p in ([] if c.get("latent") else c["forecast_path"]):
            if tracking.km_between(lat, lon, p["lat"], p["lon"]) <= p["radius_km"]:
                eta = p["lead_min"]
                break
        near.append({**_cell_brief(c), "distance_km": round(dist, 1), "eta_min": eta})
    near.sort(key=lambda x: (x["eta_min"] if x["eta_min"] is not None else 999, x["distance_km"]))
    strikes15 = lightning.count_near(lat, lon, 25, 15)
    strikes60 = lightning.count_near(lat, lon, 25, 60)
    # fused 0-6 h nowcast at this point
    timeline = []
    for i in range(7):
        row = {"lead_h": i}
        for k in HZ.HAZARDS:
            mv = haz_models[i][k]["mean"] if i < len(haz_models) and k in haz_models[i] else 0
            mv = min(mv, HZ.MODEL_ONLY_CAP)
            ov = 0
            for c in near:
                if c["eta_min"] is not None and c["eta_min"] // 60 <= i <= c["eta_min"] // 60 + (1 if c["eta_min"] < 60 else 0):
                    full = next((x for x in ENGINE.cells if x["id"] == c["id"]), None)
                    if full:
                        ov = max(ov, full["hazards"][k] * (1 - 0.12 * i))
            if k == "lightning" and i == 0 and strikes15:
                ov = max(ov, 50 if strikes15 < 5 else 70 if strikes15 < 15 else 88)
            row[k] = round(max(mv, ov))
            row[k + "_src"] = "observed+extrapolated" if ov > mv else "model"
        row["score"] = max(row[k] for k in HZ.HAZARDS)
        row["level"] = HZ.level(row["score"])
        timeline.append(row)
    sources = ["model"] + (["radar"] if any(c["source"] == "radar" for c in near if c["eta_min"] is not None) else []) + \
              (["satellite"] if any(c["source"] == "satellite" for c in near if c["eta_min"] is not None) else []) + (["lightning"] if strikes15 else [])
    peak = max(timeline, key=lambda r: r["score"]) if timeline else None
    spread = None
    if haz_models:
        spread = max(haz_models[0].get(k, {}).get("spread", 0) for k in HZ.HAZARDS) / 100
    cur = {}
    for m in multi.get("models", []):
        if m["status"] != "NO_DATA":
            cur[m["id"]] = {v: (m["hourly"].get(v) or [None])[0] for v in models.POINT_HOURLY}
    pro = auth.allowed(auth.tier(), "model_raw")
    best = obs.best_estimate(multi, lat, lon) if multi.get("models") else None
    near_obs = obs.nearest(lat, lon)
    ens = models.ensemble_stats(multi) if multi.get("models") else []
    out = {
        "location": {"name": name or (d["name"] if d else "Selected point"), "lat": lat, "lon": lon,
                     "district": d and {"id": d["id"], "name": d["name"], "state": d["state"]}},
        "generated_at": time.time(),
        "threat": {"level": peak["level"] if peak else "UNKNOWN", "score": peak["score"] if peak else None,
                   "peak_lead_h": peak["lead_h"] if peak else None,
                   "primary_hazard": max(HZ.HAZARDS, key=lambda k: peak[k]) if peak else None},
        "nowcast": timeline, "model_hazards": haz_models, "models_used": used,
        "current": cur, "models": multi,
        "district_threat": dthreat, "nearby_cells": near[:10], "lightning": {"within_25km_15min": strikes15, "within_25km_60min": strikes60},
        "confidence": HZ.confidence(sources, spread, lead_h=peak["lead_h"] if peak else 0),
        "precautions": HZ.precautions({k: peak[k] for k in HZ.HAZARDS} if peak else {}),
        "labels": {"nowcast": "EXPERIMENTAL", "models": "LIVE model output (Open-Meteo)", "observations": "LIVE where available",
                   "official": "Not an IMD warning"},
        "official_warning": {"status": "SEE IMD", "url": "https://mausam.imd.gov.in/responsive/districtWiseNowcast.php"},
        "official_alerts": {"classification": "OFFICIAL", "provider": "NDMA SACHET", "feed_status": sachet.STATE.get("status"),
                            "alerts": [_official_brief(a) for a in sachet.near(lat, lon, 25, d["id"] if d else None)]},
        "best_estimate": best, "nearest_obs": near_obs, "accuracy": obs.summary(), "tier": auth.tier(),
    }
    if not pro:
        out["models"] = {"times": multi.get("times"), "models": [{"id": m["id"], "name": m.get("name"), "status": m.get("status"),
                                                                  "run": m.get("run")} for m in multi.get("models", [])],
                         "locked": "Per-model hourly series need a professional account."}
        out["current"] = {}
        out["model_hazards"] = []
    out["ensemble"] = ens
    return jsonify(out)


@app.get("/api/nowcast")
@auth.require("nowcast")
def nowcast():
    hz = request.args.get("hazard", "all")
    lead = int(min(6, max(0, fnum(request.args.get("lead")) or 0)))
    F = getattr(ENGINE, "F", None)
    if F is None:
        return jsonify({"status": "INITIALISING", "districts": []})
    if hz in HZ.HAZARDS:
        v = F[:, lead, HZ.HAZARDS.index(hz)]
    else:
        hz, v = "all", F[:, lead, :].max(axis=1)
    order = np.argsort(-v)[:40]
    out = []
    for i in order:
        if v[i] < 20:
            break
        d = geo.DISTRICTS[int(i)]
        x = ENGINE.districts.get(d["id"], {})
        out.append({"id": d["id"], "name": d["name"], "state": d["state"], "lat": d["lat"], "lon": d["lon"], "score": int(round(float(v[i]))),
                    "level": HZ.level(float(v[i])), "sources": x.get("sources", []), "eta": x.get("eta")})
    return jsonify({"status": "OK", "hazard": hz, "lead_h": lead, "generated_at": ENGINE.fusion_at, "label": "EXPERIMENTAL",
                    "counts": {lv: int((v >= th).sum()) for lv, th in (("LOW", 20), ("MEDIUM", 40), ("HIGH", 60), ("CRITICAL", 80))},
                    "national_timeline": ENGINE.national.get("timeline"), "by_hazard": ENGINE.national.get("timeline_by_hazard"),
                    "method": {"0-2 h": "Observed radar/satellite cells advected along tracked motion; lightning nowcast from last 30 min",
                               "2-6 h": "Blend toward NWP convective diagnostics (CAPE, lifted index, CIN, precipitation, gusts, freezing level); model-only signals capped at HIGH",
                               "uncertainty": "Grows with lead time and model spread; see confidence fields"},
                    "districts": out})


@app.get("/api/models")
@auth.require("weather")
def models_cmp():
    lat, lon = fnum(request.args.get("lat")), fnum(request.args.get("lon"))
    if lat is None or lon is None:
        return jsonify({"error": "valid lat/lon required"}), 400
    multi = models.point_multi(lat, lon, hours=int(min(48, fnum(request.args.get("hours")) or 13)))
    return jsonify({"lat": lat, "lon": lon, "runs": ENGINE.grid.get("runs") or models.model_runs(), "data": multi,
                    "ensemble": models.ensemble_stats(multi) if multi.get("models") else []})


# ------------------------------------------------------------------ observations
@app.get("/api/cells")
@auth.require("storms_map")
def cells():
    src = request.args.get("source")
    cs = ENGINE.cells
    if src:
        cs = [c for c in cs if c["source"] == src]
    return jsonify({"generated_at": ENGINE.fusion_at, "radar_frame": ENGINE.radar_frame_t, "satellite_frame": ENGINE.sat_frame_t,
                    "count": len(cs), "cells": cs,
                    "method": "Radar cells: connected regions ≥35 dBZ after QC on 0.025° grid. Satellite cells: IR10.8 ≤235 K (estimated) "
                              "objects with convective signals, not overlapping radar cells. Tracking: overlap-weighted nearest neighbour across frames. "
                              "Forecast: linear extrapolation with growing uncertainty (EXPERIMENTAL)."})


@app.get("/api/cells/<cid>")
@auth.require("storms")
def cell(cid):
    c = next((x for x in ENGINE.cells if x["id"] == cid), None)
    if not c:
        return jsonify({"error": "cell not active"}), 404
    return jsonify(c)


@app.get("/api/radar")
@auth.require("rain_map")
def radar_info():
    r = ENGINE.radar
    frames = [{"time": f["time"], "tiles": radar.tile_template(f["path"])} for f in r.get("frames", [])]
    return jsonify({"status": precip_state(r), "frame_time": r.get("frame_time"), "frames": frames, "cells": r.get("cells"),
                    "provider": radar.PROVIDER, "layer": radar.LAYER, "max_zoom": 6, "units": "mm/h",
                    "attribution": "Precipitation: NASA GIBS / GPM IMERG (NASA, JAXA)",
                    "himawari": radar.himawari_frames(),
                    "notice": "IMERG is a satellite precipitation estimate (0.1°, half-hourly) with ~4–6 h latency. Not ground radar, "
                              "not IMD DWR. Cells older than 90 min are shown as recent history only — no ETA, no screening alert."})


@app.get("/api/satellite")
@auth.require("satellite_ir")
def sat_info():
    s = ENGINE.sat
    return jsonify({**s, "wms": config.EUMETSAT_WMS, "layers": {
        "ir108": "msg_iodc:ir108", "convection": "msg_iodc:rgb_convection", "airmass": "msg_iodc:rgb_airmass",
        "cloud_top_height": "msg_iodc:cth", "water_vapour": "msg_iodc:wv062", "visible": "msg_iodc:vis006",
        "lifted_index": "msg_iodc:gii_liftedindex", "precip_rate": "msg_iodc:h63"},
        "attribution": "Satellite © EUMETSAT (Meteosat IODC)",
        "insat": {"status": "NOT CONNECTED", "note": "INSAT-3DR/3DS via MOSDAC requires registration."}})


@app.get("/api/lightning")
@auth.require("lightning")
def lightning_api():
    minutes = int(min(180, fnum(request.args.get("minutes")) or 30))
    rows = lightning.recent(minutes)
    dens = lightning.density(minutes)
    for c in dens["cells"][:25]:
        d = geo.district_at(c["lat"], c["lon"])
        c["district"], c["state"] = (d["name"], d["state"]) if d else (None, None)
    return jsonify({"state": lightning.STATE, "minutes": minutes, "count": len(rows),
                    "strikes": [[round(t, 1), la, lo] for t, la, lo in rows[-5000:]],
                    "density": dens, "trend": lightning.trend(120, 5),
                    "attribution": "Lightning data © Blitzortung.org contributors (community network, non-authoritative)"})


# ------------------------------------------------------------------ alerts
@app.get("/api/alerts")
@auth.require("screening_alerts")
def alerts():
    st = request.args.get("status", "active").lower()
    q = "SELECT * FROM alerts"
    args = ()
    if st == "active":
        q += " WHERE status IN ('ACTIVE','ENDING')"
    elif st != "all":
        q += " WHERE status=?"
        args = (st.upper(),)
    q += " ORDER BY updated_at DESC LIMIT 400"
    rank = {lv: i for i, lv in enumerate(HZ.LEVELS)}
    with store.db() as con:
        rows = [dict(r) for r in con.execute(q, args)]
    for r in rows:
        r["payload"] = json.loads(r["payload"] or "{}")
        r["source_label"] = "INDRA EXPERIMENTAL SCREENING ALERT — not an official IMD warning"
    rows.sort(key=lambda r: (r["status"] != "ACTIVE", -rank.get(r["level"], 0), -r["updated_at"]))
    counts = {lv: sum(1 for r in rows if r["level"] == lv and r["status"] == "ACTIVE") for lv in HZ.LEVELS}
    return jsonify({"generated_at": time.time(), "count": len(rows), "counts": counts, "alerts": rows,
                    "official": {"status": "SEPARATE", "endpoint": "/api/official", "active": len(sachet.active())}})


@app.get("/api/alerts/<aid>/history")
@auth.require("screening_alerts")
def alert_history(aid):
    with store.db() as con:
        evs = [dict(r) for r in con.execute("SELECT * FROM alert_events WHERE alert_id=? ORDER BY at", (aid,))]
    return jsonify({"alert_id": aid, "events": evs})


@app.get("/api/alerts/log")
@auth.require("command")
def alert_log():
    with store.db() as con:
        evs = [dict(r) for r in con.execute("SELECT e.*, a.title, a.hazard FROM alert_events e LEFT JOIN alerts a ON a.id=e.alert_id ORDER BY e.at DESC LIMIT 300")]
    return jsonify({"events": evs})


@app.post("/api/alerts/<aid>/ack")
@auth.require("ack")
def ack(aid):
    body = request.get_json(silent=True) or {}
    op = str(body.get("operator", "operator"))[:60] or "operator"
    with store.db() as con:
        n = con.execute("UPDATE alerts SET acknowledged_at=?, acknowledged_by=? WHERE id=?", (time.time(), op, aid)).rowcount
        con.execute("INSERT INTO alert_events(alert_id,at,event,level,note) VALUES(?,?,?,?,?)", (aid, time.time(), "ACKNOWLEDGED", None, op))
    store.audit(op, "ACK_ALERT", aid)
    ENGINE.emit("ack", {"id": aid, "operator": op})
    return jsonify({"ok": bool(n), "alert_id": aid})


@app.get("/api/imd")
@auth.require("official_alerts")
def imd_api():
    return jsonify({**imd.summary(), "sachet": sachet.public_state()})


@app.get("/api/official")
@auth.require("official_alerts")
def official_api():
    if sachet.STATE.get("fetched_at") is None or time.time() - (sachet.STATE.get("checked_at") or 0) > 600:
        sachet.refresh()
    out = sachet.public_state()
    if request.args.get("status", "active") == "active":
        out["alerts"] = [a for a in out["alerts"] if a["status"] == "ACTIVE"]
    out["notice"] = ("OFFICIAL alerts as published on NDMA SACHET by the issuing agency. Map footprints are approximate "
                     "(centroid + equivalent-area circle). Always follow the issuing authority.")
    return jsonify(out)


# ------------------------------------------------------------------ verification / history
@app.get("/api/verification")
@auth.require("verify")
def verification():
    hours = int(min(72, fnum(request.args.get("hours")) or 24))
    cutoff = time.time() - hours * 3600
    with store.db() as con:
        rows = con.execute("SELECT method, lead_min, SUM(hits) h, SUM(misses) m, SUM(false_alarms) f, SUM(correct_negatives) c, COUNT(*) n "
                           "FROM verification WHERE valid_at>=? GROUP BY method, lead_min", (cutoff,)).fetchall()
        series = [dict(r) for r in con.execute("SELECT valid_at, lead_min, method, hits, misses, false_alarms FROM verification WHERE valid_at>=? ORDER BY valid_at", (cutoff,))]
        pending = con.execute("SELECT COUNT(*) FROM forecasts WHERE verified=0").fetchone()[0]
        labels = con.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
    out = []
    for r in rows:
        h, m, f = r["h"] or 0, r["m"] or 0, r["f"] or 0
        out.append({"method": r["method"], "lead_min": r["lead_min"], "samples": r["n"], "hits": h, "misses": m, "false_alarms": f,
                    "pod": round(h / (h + m), 3) if h + m else None, "far": round(f / (h + f), 3) if h + f else None,
                    "csi": round(h / (h + m + f), 3) if h + m + f else None,
                    "bias": round((h + f) / (h + m), 3) if h + m else None})
    best = max((x for x in out if x["method"] == "extrapolation" and x["csi"] is not None), key=lambda x: x["samples"], default=None)
    return jsonify({"window_hours": hours, "scores": sorted(out, key=lambda x: (x["method"], x["lead_min"])), "series": series[-600:],
                    "pending_forecasts": pending, "event_labels": labels,
                    "target": {"metric": "POD ≥ 0.80 with CSI reported", "status": ("MET on this window" if best and best["pod"] and best["pod"] >= 0.8 else "NOT DEMONSTRATED"),
                               "note": "Automatic self-verification measures extrapolation skill against later NASA GIBS IMERG precipitation observations "
                                       "(10 km tolerance). It is not independent ground truth. An 80% accuracy claim needs a verified historical event archive."},
                    "methods": {"extrapolation": "INDRA cell advection forecast vs observed IMERG ≥5.6 mm/h (≈35 dBZe, 0.1° boxes)",
                                "persistence": "No-motion baseline", "model_thunder_vs_lightning": "Model thunderstorm screening (≥40) vs community lightning within 40 km ±30 min"}})


@app.get("/api/history")
@auth.require("storms")
def history():
    hours = int(min(72, fnum(request.args.get("hours")) or 24))
    cutoff = time.time() - hours * 3600
    with store.db() as con:
        th = [{"at": r["at"], **json.loads(r["payload"])} for r in con.execute("SELECT at,payload FROM threat_history WHERE at>=? ORDER BY at", (cutoff,))]
        ch = [{"at": r["at"], "source": r["source"], "cells": json.loads(r["payload"])} for r in
              con.execute("SELECT at,source,payload FROM cell_history WHERE at>=? ORDER BY at", (cutoff,))]
    return jsonify({"threat": th, "cells": ch, "label": "OBSERVED HISTORY (archived by this INDRA instance)"})


@app.get("/api/replay/demo")
@auth.require("replay")
def replay_demo():
    o_lat, o_lon = 20.30, 85.82
    track = [{"lead_min": k * 20, "lat": round(o_lat + k * 0.09, 3), "lon": round(o_lon + k * 0.05, 3),
              "max_dbz": min(63, 44 + k * 1.6), "radius_km": round(12 + k * 1.5, 1)} for k in range(19)]
    return jsonify({"mode": "SIMULATION", "is_live": False, "scenario": "Synthetic convective cell, coastal Odisha", "track": track,
                    "notice": "Fictional scenario for operator training. Not observed data and not a forecast."})


@app.get("/api/audit")
@auth.require("audit")
def audit():
    with store.db() as con:
        rows = [dict(r) for r in con.execute("SELECT * FROM audit ORDER BY at DESC LIMIT 200")]
    return jsonify({"events": rows})


@app.post("/api/feedback")
@auth.require("feedback")
def feedback():
    b = request.get_json(silent=True) or {}
    et = str(b.get("event_type", "")).upper()[:40]
    oc = str(b.get("outcome", "")).upper()[:20]
    if et not in {"THUNDERSTORM", "HAIL", "CLOUDBURST", "HEAVY_RAIN", "LIGHTNING", "DOWNBURST", "FLASH_FLOOD", "OTHER"} or oc not in {"OBSERVED", "NOT_OBSERVED", "UNKNOWN"}:
        return jsonify({"error": "invalid event_type/outcome"}), 400
    with store.db() as con:
        con.execute("INSERT INTO feedback(created_at,location,event_type,outcome,notes) VALUES(?,?,?,?,?)",
                    (time.time(), str(b.get("location", ""))[:160], et, oc, str(b.get("notes", ""))[:1000]))
    store.audit(str(b.get("operator", "operator"))[:60], "EVENT_LABEL", str(b.get("location", ""))[:160], {"event": et, "outcome": oc})
    return jsonify({"ok": True}), 201


@app.get("/api/feedback")
@auth.require("verify")
def feedback_list():
    with store.db() as con:
        rows = [dict(r) for r in con.execute("SELECT * FROM feedback ORDER BY id DESC LIMIT 100")]
    return jsonify({"events": rows})


@app.get("/api/export/<name>.csv")
@auth.require("exports")
def export(name):
    q = {"alerts": "SELECT id,kind,hazard,level,peak_level,title,district,state,lat,lon,status,created_at,updated_at,acknowledged_at,acknowledged_by FROM alerts ORDER BY created_at DESC",
         "feedback": "SELECT * FROM feedback ORDER BY id DESC", "verification": "SELECT * FROM verification ORDER BY valid_at DESC",
         "audit": "SELECT * FROM audit ORDER BY at DESC"}.get(name)
    if not q:
        return jsonify({"error": "unknown export"}), 404
    with store.db() as con:
        cur = con.execute(q)
        cols = [c[0] for c in cur.description]
        rows = cur.fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    w.writerows([tuple(r) for r in rows])
    return Response(out.getvalue(), mimetype="text/csv", headers={"Content-Disposition": f"attachment; filename=indra_{name}.csv"})


# ------------------------------------------------------------------ overlays
@app.get("/api/overlay/hazard.png")
@auth.require("hazard_overlay")
def overlay_hazard():
    hz = request.args.get("hazard", "all")
    if hz != "all" and hz not in HZ.HAZARDS:
        hz = "all"
    lead = int(min(6, max(0, fnum(request.args.get("lead")) or 0)))
    png = ENGINE.overlay_hazard(hz, lead)
    if png is None:
        return Response(status=204)
    return Response(png, mimetype="image/png", headers={"Cache-Control": "max-age=60"})


@app.get("/api/overlay/sat.png")
@auth.require("satellite_ir")
def overlay_sat():
    from indra import satellite as SAT
    layer = request.args.get("layer", "msg_iodc:ir108")
    if layer != "msg_iodc:ir108" and not auth.allowed(auth.tier(), "sat_products"):
        return jsonify({"error": "Advanced satellite products need a professional account.", "code": "tier_required",
                        "feature": "sat_products", "required_tier": "professional"}), 403
    t = request.args.get("time", "")
    if t and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z", t):
        return jsonify({"error": "bad time"}), 400
    data, meta = SAT.display_png(layer, t)
    if not data:
        return jsonify({"error": meta.get("error") or "satellite image unavailable", "status": "UNAVAILABLE"}), 502
    return Response(data, mimetype="image/png", headers={"Cache-Control": "public, max-age=3600", "X-INDRA-Feed": meta.get("status", "")})


@app.get("/api/overlay/radar.png")
@auth.require("qc_layers")
def overlay_radar():
    png = ENGINE.overlay_radar()
    if png is None:
        return Response(status=204)
    return Response(png, mimetype="image/png", headers={"Cache-Control": "max-age=60"})


# ------------------------------------------------------------------ accounts
def _ip():
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "?").split(",")[0].strip()


def _auth_reply(res, err, code=400):
    if err:
        return jsonify({"error": err}), code
    return jsonify({**res, "features": auth.feature_map(res["user"]["tier"])})


@app.post("/api/auth/register")
def auth_register():
    res, err = auth.register(request.get_json(silent=True) or {}, _ip())
    if not err:
        store.audit(res["user"]["email"], "REGISTER", res["user"]["tier"])
    return _auth_reply(res, err)


@app.post("/api/auth/login")
def auth_login():
    res, err = auth.login(request.get_json(silent=True) or {}, _ip())
    return _auth_reply(res, err, 401 if err and "incorrect" in err else 400)


@app.post("/api/auth/guest")
def auth_guest():
    res, err = auth.guest(_ip())
    return _auth_reply(res, err, 429)


@app.post("/api/auth/logout")
def auth_logout():
    auth.logout()
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def auth_me():
    u = auth.me()
    if not u:
        return jsonify({"error": "Sign in required", "code": "auth_required"}), 401
    out = {"user": u, "features": auth.feature_map(u["tier"]), "tiers": auth.FEATURES}
    if u.get("id"):
        out["pro_request"] = auth.my_request(u["id"])
    return jsonify(out)


def _body():
    return request.get_json(silent=True) or {}


@app.post("/api/auth/verify")
@auth.require_user
def auth_verify():
    res, err = auth.verify_email(g.session["user_id"], _body().get("code"))
    if err:
        return jsonify({"error": err}), 400
    store.audit(res["user"]["email"], "EMAIL_VERIFIED", res["user"]["email"])
    return jsonify(res)


@app.post("/api/auth/resend")
@auth.require_user
def auth_resend():
    res, err = auth.resend_verification(g.session["user_id"], _ip())
    return (jsonify({"error": err}), 429 if "Too many" in err or "wait" in err else 400) if err else jsonify(res)


@app.post("/api/auth/forgot")
def auth_forgot():
    res, err = auth.forgot_password(_body().get("email"), _ip())
    return (jsonify({"error": err}), 429) if err else jsonify(res)


@app.post("/api/auth/reset")
def auth_reset():
    b = _body()
    res, err = auth.reset_password(b.get("email"), b.get("code"), b.get("password"), _ip())
    if err:
        return jsonify({"error": err}), 400
    store.audit(res["user"]["email"], "PASSWORD_RESET", res["user"]["email"])
    return _auth_reply(res, None)


@app.post("/api/auth/password")
@auth.require_user
def auth_password():
    b = _body()
    res, err = auth.change_password(g.session["user_id"], b.get("old_password"), b.get("new_password"))
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "", "PASSWORD_CHANGED", "")
    return jsonify(res)


@app.post("/api/auth/request-pro")
@auth.require("saved_places")
def auth_request_pro():
    b = _body()
    res, err = auth.request_pro(g.session["user_id"], b.get("org"), b.get("role"), b.get("note"))
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "", "PRO_REQUESTED", b.get("org") or "")
    return jsonify(res)


# ------------------------------------------------------------------ admin console
@app.get("/api/admin/overview")
@auth.require_admin
def admin_overview():
    return jsonify({"stats": auth.admin_stats(), "requests": auth.admin_requests("pending")})


@app.get("/api/admin/users")
@auth.require_admin
def admin_users():
    a = request.args
    return jsonify(auth.admin_users(a.get("q", "").strip()[:80], a.get("tier", ""), a.get("status", ""),
                                    int(fnum(a.get("limit")) or 100), int(fnum(a.get("offset")) or 0)))


@app.post("/api/admin/users/<int:uid>")
@auth.require_admin
def admin_user_action(uid):
    b = _body()
    res, err = auth.admin_action(g.session["user_id"], uid, b.get("action"), b.get("value"))
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "admin", "ADMIN_" + str(b.get("action")).upper(), str(uid), {"value": b.get("value")})
    return jsonify(res)


@app.post("/api/admin/users")
@auth.require_admin
def admin_create_user():
    b = request.get_json(silent=True) or {}
    res, err = auth.admin_create_user(g.session.get("email") or "admin", b)
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "admin", "ADMIN_CREATE_USER", res["user"]["email"],
                {"tier": res["user"]["tier"], "admin": res["user"]["is_admin"]})
    return jsonify(res)


@app.get("/api/admin/keys")
@auth.require_admin
def admin_keys():
    return jsonify({"keys": auth.admin_keys(), "shared_code": auth.pro_code()})


@app.post("/api/admin/keys")
@auth.require_admin
def admin_create_key():
    b = request.get_json(silent=True) or {}
    res, err = auth.admin_create_key(g.session.get("email") or "admin", b.get("label"), b.get("email"),
                                     b.get("max_uses", 1), b.get("days", 30), bool(b.get("send")))
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "admin", "ADMIN_CREATE_PRO_KEY", res["key"]["code"][:8] + "…",
                {"email": res["key"]["email"], "max_uses": res["key"]["max_uses"]})
    return jsonify(res)


@app.post("/api/admin/keys/<int:kid>/revoke")
@auth.require_admin
def admin_revoke_key(kid):
    res, err = auth.admin_revoke_key(kid)
    if err:
        return jsonify({"error": err}), 404
    store.audit(g.session.get("email") or "admin", "ADMIN_REVOKE_PRO_KEY", str(kid))
    return jsonify(res)


@app.get("/api/admin/requests")
@auth.require_admin
def admin_requests():
    return jsonify({"requests": auth.admin_requests(request.args.get("status", "pending"))})


@app.post("/api/admin/requests/<int:rid>")
@auth.require_admin
def admin_decide(rid):
    ok = _body().get("decision") == "approve"
    res, err = auth.admin_decide(rid, ok, g.session.get("email") or "admin")
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "admin", "ADMIN_PRO_" + ("APPROVE" if ok else "REJECT"), str(rid))
    return jsonify(res)


@app.post("/api/admin/access-code")
@auth.require_admin
def admin_rotate_code():
    code, err = auth.rotate_code()
    if err:
        return jsonify({"error": err}), 400
    store.audit(g.session.get("email") or "admin", "ADMIN_ROTATE_ACCESS_CODE", "")
    return jsonify({"access_code": code})


@app.get("/api/admin/outbox")
@auth.require_admin
def admin_outbox():
    return jsonify({"mode": mailer.mode(), "messages": mailer.outbox()})


@app.get("/api/admin/audit")
@auth.require_admin
def admin_audit():
    with store.db() as con:
        rows = con.execute("SELECT at,actor,action,target,detail FROM audit WHERE action LIKE 'ADMIN_%' OR action IN "
                           "('REGISTER','UPGRADE','EMAIL_VERIFIED','PASSWORD_RESET','PASSWORD_CHANGED','PRO_REQUESTED') "
                           "ORDER BY at DESC LIMIT 200").fetchall()
    return jsonify({"events": [dict(r) for r in rows]})


@app.post("/api/auth/upgrade")
@auth.require("saved_places")
def auth_upgrade():
    b = request.get_json(silent=True) or {}
    from flask import g as _g
    res, err = auth.upgrade(_g.session["user_id"], b.get("access_code"), b.get("org"), b.get("role"))
    if err:
        return jsonify({"error": err}), 400
    store.audit(res["user"]["email"], "UPGRADE", "professional")
    return jsonify({**res, "features": auth.feature_map("professional")})


@app.get("/api/places")
@auth.require("saved_places")
def places_list():
    from flask import g as _g
    return jsonify({"places": auth.places(_g.session["user_id"])})


@app.post("/api/places")
@auth.require("saved_places")
def places_add():
    from flask import g as _g
    b = request.get_json(silent=True) or {}
    lat, lon = fnum(b.get("lat")), fnum(b.get("lon"))
    if lat is None or lon is None:
        return jsonify({"error": "valid lat/lon required"}), 400
    d = geo.district_at(lat, lon)
    res, err = auth.add_place(_g.session["user_id"], str(b.get("name") or (d and d["name"]) or "Saved place"), lat, lon, d and d["id"])
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"places": res})


@app.delete("/api/places/<int:pid>")
@auth.require("saved_places")
def places_del(pid):
    from flask import g as _g
    return jsonify({"places": auth.remove_place(_g.session["user_id"], pid)})


# ------------------------------------------------------------------ ground truth
@app.get("/api/accuracy")
@auth.require("accuracy_summary")
def accuracy():
    out = {"summary": obs.summary(), "feed": obs.public_state()}
    if auth.allowed(auth.tier(), "station_table"):
        a = obs.ACC
        out["detail"] = {k: a.get(k) for k in ("models", "blend", "simple_mean", "selected_method", "method_scores", "weights",
                                               "station_table", "method", "limits", "train_window_h", "test_window_h")}
    return jsonify(out)


@app.get("/api/stations")
@auth.require("stations")
def stations():
    return jsonify({"label": "OBSERVED (METAR, aviationweather.gov)", "stations": obs.latest(), "feed": obs.public_state()})


@app.errorhandler(404)
def nf(_):
    if request.path.startswith("/api/"):
        return jsonify({"error": "not found"}), 404
    return send_from_directory("static", "index.html")


@app.errorhandler(500)
def ie(e):
    log.exception("server error")
    return jsonify({"error": "internal error"}), 500


if __name__ == "__main__":
    print(f"\n  INDRA {config.VERSION} starting on http://127.0.0.1:{os.getenv('PORT', '5000')}  (Ctrl+C to stop)\n", flush=True)
    ensure_engine()
    app.run(host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "5000")), threaded=True, debug=False)
