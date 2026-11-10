"""Numerical weather prediction inputs via Open-Meteo.

Each model is fetched and timestamped independently (ECMWF IFS, NCEP GFS, DWD ICON,
UKMO, GraphCast) so they can be compared. IMD/NCMRWF NCUM/NEPS products have no public
API and are reported as unavailable."""
import logging
import math
import time
from datetime import datetime, timezone

import numpy as np

from . import config, net, geo
from .grid_spec import LAT_N, LON_W, RES

log = logging.getLogger("indra.models")

MODELS = [
    {"id": "ecmwf_ifs025", "name": "ECMWF IFS", "centre": "ECMWF", "res_km": 25, "meta": "ecmwf_ifs025"},
    {"id": "gfs_seamless", "name": "NCEP GFS", "centre": "NOAA/NCEP", "res_km": 13, "meta": "ncep_gfs013"},
    {"id": "icon_seamless", "name": "DWD ICON", "centre": "DWD", "res_km": 13, "meta": "dwd_icon"},
    {"id": "ukmo_seamless", "name": "UKMO Unified Model", "centre": "Met Office", "res_km": 10, "meta": "ukmo_global_deterministic_10km"},
    {"id": "ecmwf_aifs025_single", "name": "ECMWF AIFS (AI)", "centre": "ECMWF", "res_km": 25, "meta": "ecmwf_aifs025_single"},
]
UNAVAILABLE_MODELS = [
    {"id": "ncmrwf_ncum", "name": "NCMRWF NCUM-G / NEPS", "centre": "NCMRWF (MoES)", "status": "UNAVAILABLE",
     "reason": "No public machine-readable API; requires MoES/NCMRWF data-sharing agreement."},
    {"id": "imd_wrf", "name": "IMD WRF 3 km", "centre": "IMD", "status": "UNAVAILABLE",
     "reason": "Graphical products only on mausam.imd.gov.in; no public gridded feed."},
]
POINT_HOURLY = ["temperature_2m", "relative_humidity_2m", "dew_point_2m", "precipitation", "precipitation_probability",
                "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "cape", "lifted_index",
                "freezing_level_height", "cloud_cover"]
GRID_HOURLY = ["precipitation", "precipitation_probability", "cape", "lifted_index", "convective_inhibition",
               "wind_gusts_10m", "freezing_level_height", "dew_point_2m", "temperature_2m", "cloud_cover"]


def _params(extra):
    p = dict(extra)
    if config.OPEN_METEO_KEY:
        p["apikey"] = config.OPEN_METEO_KEY
    return p


def model_runs():
    out = []
    for m in MODELS:
        data, meta = net.get(f"https://api.open-meteo.com/data/{m['meta']}/static/meta.json", ttl=900, feed=None)
        rec = {k: m[k] for k in ("id", "name", "centre", "res_km")}
        if data:
            rec.update(status="AVAILABLE", run_init=data.get("last_run_initialisation_time"),
                       available_at=data.get("last_run_availability_time"),
                       update_interval_h=round((data.get("update_interval_seconds") or 0) / 3600, 1))
        else:
            rec.update(status="UNAVAILABLE", error=meta.get("error"))
        out.append(rec)
    return out + UNAVAILABLE_MODELS


def point_multi(lat, lon, hours=13):
    """Independent per-model hourly series for one location (0..hours-1)."""
    params = _params({"latitude": round(lat, 3), "longitude": round(lon, 3), "hourly": ",".join(POINT_HOURLY),
                      "models": ",".join(m["id"] for m in MODELS), "forecast_hours": hours,
                      "timezone": "UTC", "wind_speed_unit": "kmh"})
    data, meta = net.get(config.OPEN_METEO_URL, params=params, ttl=600, feed="open_meteo_models")
    if not data or "hourly" not in data:
        return {"status": "UNAVAILABLE", "error": meta.get("error"), "models": []}
    h = data["hourly"]
    times = h.get("time", [])
    models = []
    for m in MODELS:
        series = {}
        have = 0
        for v in POINT_HOURLY:
            vals = h.get(f"{v}_{m['id']}")
            series[v] = vals
            if vals and any(x is not None for x in vals):
                have += 1
        models.append({"id": m["id"], "name": m["name"], "centre": m["centre"], "res_km": m["res_km"],
                       "status": "AVAILABLE" if have >= 4 else "PARTIAL" if have else "NO_DATA",
                       "variables_available": have, "hourly": series})
    return {"status": meta["status"], "fetched_at": meta.get("fetched_at"), "times": times,
            "grid_lat": data.get("latitude"), "grid_lon": data.get("longitude"), "elevation": data.get("elevation"),
            "models": models}


def ensemble_stats(multi):
    """Model agreement for key fields at each lead hour."""
    out = []
    times = multi.get("times") or []
    for i, t in enumerate(times):
        row = {"time": t}
        for v in ("precipitation", "wind_gusts_10m", "cape", "temperature_2m", "precipitation_probability"):
            vals = []
            for m in multi.get("models", []):
                s = m["hourly"].get(v) or []
                if i < len(s) and s[i] is not None:
                    vals.append(float(s[i]))
            if vals:
                row[v] = {"mean": round(float(np.mean(vals)), 2), "min": round(min(vals), 2), "max": round(max(vals), 2),
                          "spread": round(max(vals) - min(vals), 2), "n": len(vals)}
        out.append(row)
    return out


# ----------------------------------------------------------------- national grid
def grid_points(deg=None):
    deg = deg or config.MODEL_GRID_DEG
    pts = []
    lat = 6.5
    while lat <= 37.0:
        lon = 68.0
        while lon <= 97.5:
            r, c = int((LAT_N - lat) / RES), int((lon - LON_W) / RES)
            half = int(deg / 2 / RES)
            win = geo.RASTER[max(0, r - half):r + half + 1, max(0, c - half):c + half + 1]
            if (win > 0).mean() > 0.08:
                pts.append((round(lat, 3), round(lon, 3)))
            lon += deg
        lat += deg
    return pts


def fetch_grid(points):
    """Best-match model hourly fields (0..6 h) at every grid point, chunked."""
    out = [None] * len(points)
    status = "LIVE"
    chunk = 90
    for k in range(0, len(points), chunk):
        part = points[k:k + chunk]
        params = _params({"latitude": ",".join(str(p[0]) for p in part), "longitude": ",".join(str(p[1]) for p in part),
                          "hourly": ",".join(GRID_HOURLY), "forecast_hours": 7, "timezone": "UTC", "wind_speed_unit": "kmh"})
        data, meta = net.get(config.OPEN_METEO_URL, params=params, ttl=1800, feed="open_meteo_grid", timeout=45)
        if data is None:
            status = "PARTIAL" if any(out) else "UNAVAILABLE"
            continue
        if meta["status"] == "STALE":
            status = "STALE"
        if isinstance(data, dict):
            data = [data]
        for j, item in enumerate(data):
            out[k + j] = item.get("hourly")
        time.sleep(0.3)
    return out, status


def _c(x):
    return max(0.0, min(1.0, x))


def hazard_scores(h, i):
    """Physically-motivated EXPERIMENTAL diagnostics (0-100) from model fields at hour index i."""
    def g(v, default=None):
        s = h.get(v) or []
        return s[i] if i < len(s) and s[i] is not None else default
    cape = g("cape", 0.0) or 0.0
    li = g("lifted_index", 0.0)
    li = 0.0 if li is None else li
    cin = abs(g("convective_inhibition", 0.0) or 0.0)
    pr = g("precipitation", 0.0) or 0.0
    pp = g("precipitation_probability", None)
    gust = g("wind_gusts_10m", 0.0) or 0.0
    fzl = g("freezing_level_height", 4800.0) or 4800.0
    t = g("temperature_2m", 25.0) or 25.0
    td = g("dew_point_2m", 20.0) or 20.0
    cloud = g("cloud_cover", 0.0) or 0.0
    acc3 = sum((h.get("precipitation") or [0] * 7)[i:i + 3][k] or 0 for k in range(len((h.get("precipitation") or [0] * 7)[i:i + 3])))
    acc6 = sum(x or 0 for x in (h.get("precipitation") or [])[:7])
    trig = max(_c(pr / 6), _c((pp or 0) / 100) if pp is not None else _c(pr / 2))
    inst = 0.55 * _c(cape / 2500) + 0.45 * _c(-li / 6)
    cinpen = 1 - 0.6 * _c(cin / 150)
    thunder = 100 * _c(inst * (0.35 + 0.65 * trig) * cinpen * (0.7 + 0.3 * _c(cloud / 80)) * 1.4)
    lightning = 100 * _c(thunder / 100 * (0.5 + 0.5 * _c(cape / 1200)))
    hail = 100 * _c(_c((cape - 800) / 2500) * _c((4600 - fzl) / 1800 + 0.2) * (0.4 + 0.6 * trig) * _c(-li / 4 + 0.2) * 1.6)
    cloudburst = 100 * _c(0.6 * _c((pr - 8) / 40) + 0.4 * _c((acc3 - 25) / 75))
    downburst = 100 * _c(_c((gust - 35) / 55) * (0.45 + 0.55 * _c(cape / 1500)) * (0.6 + 0.4 * _c((t - td) / 15)) * 1.3)
    heavy = 100 * _c(acc6 / 65) if i == 0 else 100 * _c(acc3 / 40)
    return {"thunderstorm": round(thunder), "lightning": round(lightning), "hail": round(hail),
            "cloudburst": round(cloudburst), "downburst": round(downburst), "heavy_rain": round(heavy),
            "_inputs": {"cape": cape, "li": li, "cin": cin, "precip_mm": pr, "pp": pp, "gust_kmh": gust,
                        "freezing_level_m": fzl, "t_td": round(t - td, 1)}}


def iso_to_ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp()
