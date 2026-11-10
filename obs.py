"""Ground-truth observations and live forecast accuracy.

Real surface observations come from airport METAR reports for ~95 Indian aerodromes
(NOAA Aviation Weather Center public API). They are used to:

1. show the nearest *measured* conditions next to every forecast (labelled OBSERVED);
2. score every NWP model hour-by-hour against what was actually measured
   (temperature, wind, rain yes/no) over the last ~24 h;
3. build INDRA's "best estimate": a skill-weighted multi-model blend (weights = 1/MAE²)
   with a local bias correction from nearby stations.

The blend is scored out-of-sample (weights and biases are learnt on the older part of
the window, accuracy is measured on the most recent hours) so the published accuracy
is not flattered by fitting to the data it is scored on.
"""
import logging
import math
import re
import threading
import time
from datetime import datetime, timezone

import numpy as np

from . import config, net
from .store import db

log = logging.getLogger("indra.obs")

# Indian aerodromes that publish METAR (ICAO). Unknown/closed ones are simply absent from replies.
STATIONS = (
    "VIDP,VABB,VOMM,VECC,VOBL,VOHS,VAAH,VOCI,VOTV,VOCB,VOMD,VOTR,VOML,VOBM,VOHB,VAGO,VAPO,VANP,VAID,VABP,"
    "VAJB,VARP,VAAU,VASU,VABO,VARK,VAJM,VAKP,VIJP,VIJO,VIUD,VILK,VIBN,VIAG,VIGR,VIKO,VIBK,VICG,VILH,VISR,"
    "VIJU,VIAR,VIDN,VIPT,VISM,VIDD,VEPT,VEGY,VEBS,VERC,VEGT,VEBD,VEAT,VEIM,VEDB,VEJT,VEMN,VEMR,VEPB,VELP,"
    "VEAN,VEKU,VERP,VOVZ,VORY,VOTP,VOPC,VOKN,VOGA,VOPB,VOSM,VOBZ,VOHY,VOCL,VOKU,VEDO,VIBR,VIGG,VIKG,VIPK,"
    "VIBY,VIBT,VAKS,VAUD,VAHB,VOMY,VOBG,VOAT,VOJV,VAOZ,VASD,VAJL,VEJS,VEJH,VECO,VIDX,VIHX,VEBN,VOPN"
).split(",")
METAR_URL = "https://aviationweather.gov/api/data/metar"
SCHEMA = """
CREATE TABLE IF NOT EXISTS obs (
  icao TEXT, t INTEGER, name TEXT, lat REAL, lon REAL, elev REAL, temp REAL, dewp REAL,
  wspd_kmh REAL, wgst_kmh REAL, wdir REAL, visib_km REAL, wx TEXT, rain INTEGER, ts INTEGER, raw TEXT,
  PRIMARY KEY (icao, t));
CREATE INDEX IF NOT EXISTS ix_obs_t ON obs(t);
"""
RAIN_RE = re.compile(r"(?:^|\s)[-+]?(?:VC)?(?:TS|SH)?(?:RA|DZ|GR|GS|PL|UP)|(?:^|\s)[-+]?(?:VC)?TS(?:\s|$)")
TS_RE = re.compile(r"TS")
KT = 1.852
MODEL_IDS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless", "ukmo_seamless", "ecmwf_aifs025_single"]
MODEL_NAMES = {"ecmwf_ifs025": "ECMWF IFS", "gfs_seamless": "NCEP GFS", "icon_seamless": "DWD ICON",
               "ukmo_seamless": "UKMO", "ecmwf_aifs025_single": "ECMWF AIFS (AI)"}

STATE = {"status": "INITIALISING", "stations": 0, "latest_obs": None, "fetched_at": None, "error": None}
ACC = {"status": "INITIALISING", "computed_at": None}
_lock = threading.Lock()
_latest = {}           # icao -> latest obs dict
_bias = {}             # icao -> {model_id: temp bias (model - obs)}, {"wind": {...}}
_weights = {}          # variable -> {model_id: weight}


def init():
    with db() as con:
        con.executescript(SCHEMA)


def _num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def _parse(rec):
    wx = (rec.get("wxString") or "").strip()
    wspd = _num(rec.get("wspd"))
    vis = rec.get("visib")
    vis_km = 10.0 if isinstance(vis, str) and "+" in vis else (_num(vis) * 1.609 if _num(vis) is not None else None)
    return {
        "icao": rec.get("icaoId"), "t": int(rec.get("obsTime") or 0), "name": (rec.get("name") or "").split(",")[0],
        "lat": _num(rec.get("lat")), "lon": _num(rec.get("lon")), "elev": _num(rec.get("elev")),
        "temp": _num(rec.get("temp")), "dewp": _num(rec.get("dewp")),
        "wspd_kmh": round(wspd * KT, 1) if wspd is not None else None,
        "wgst_kmh": round(_num(rec.get("wgst")) * KT, 1) if _num(rec.get("wgst")) is not None else None,
        "wdir": _num(rec.get("wdir")), "visib_km": round(vis_km, 1) if vis_km is not None else None,
        "wx": wx, "rain": int(bool(RAIN_RE.search(wx))), "ts": int(bool(TS_RE.search(wx))),
        "raw": rec.get("rawOb") or "",
    }


_backfilled = False


def refresh():
    """Fetch recent METARs for every station and store them (26 h backfill on first run)."""
    global _backfilled
    rows = []
    hours = 3 if _backfilled else 26
    for i in range(0, len(STATIONS), 25):
        chunk = ",".join(STATIONS[i:i + 25])
        data, meta = net.get(METAR_URL, params={"ids": chunk, "format": "json", "hours": hours}, ttl=240, feed="metar",
                             timeout=60)
        if data is None:
            STATE.update(status="UNAVAILABLE", error=meta.get("error"))
            continue
        rows += [_parse(r) for r in data if r.get("icaoId") and r.get("obsTime")]
    if rows:
        _backfilled = True
    if not rows:
        if STATE["status"] != "UNAVAILABLE":
            STATE.update(status="UNAVAILABLE", error="no METAR returned")
        return STATE
    with db() as con:
        con.executemany(
            "INSERT OR REPLACE INTO obs(icao,t,name,lat,lon,elev,temp,dewp,wspd_kmh,wgst_kmh,wdir,visib_km,wx,rain,ts,raw) "
            "VALUES(:icao,:t,:name,:lat,:lon,:elev,:temp,:dewp,:wspd_kmh,:wgst_kmh,:wdir,:visib_km,:wx,:rain,:ts,:raw)", rows)
        con.execute("DELETE FROM obs WHERE t < ?", (time.time() - 3 * 86400,))
    latest = {}
    for r in rows:
        if r["icao"] not in latest or r["t"] > latest[r["icao"]]["t"]:
            latest[r["icao"]] = r
    with _lock:
        _latest.update(latest)
    newest = max(r["t"] for r in rows)
    age = time.time() - newest
    STATE.update(status="LIVE" if age < 5400 else "STALE", stations=len(latest), latest_obs=newest,
                 fetched_at=time.time(), error=None)
    return STATE


def latest(max_age_s=10800):
    now = time.time()
    with _lock:
        return [dict(o) for o in _latest.values() if now - o["t"] <= max_age_s]


def _km(la1, lo1, la2, lo2):
    p = math.pi / 180
    a = math.sin((la2 - la1) * p / 2) ** 2 + math.cos(la1 * p) * math.cos(la2 * p) * math.sin((lo2 - lo1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(min(1, a)))


def nearest(lat, lon, km=150, n=3):
    out = []
    for o in latest():
        if o["lat"] is None:
            continue
        d = _km(lat, lon, o["lat"], o["lon"])
        if d <= km:
            out.append({**o, "distance_km": round(d, 1), "age_min": round((time.time() - o["t"]) / 60)})
    out.sort(key=lambda x: x["distance_km"])
    return out[:n]


# ------------------------------------------------------------------ verification
def _hourly_obs(since):
    """{icao: {hour_ts: obs}} using the report closest to each top of hour (within 20 min)."""
    with db() as con:
        rows = con.execute("SELECT * FROM obs WHERE t >= ? ORDER BY t", (since,)).fetchall()
    out, meta = {}, {}
    for r in rows:
        h = int(round(r["t"] / 3600) * 3600)
        if abs(r["t"] - h) > 1200:
            continue
        cur = out.setdefault(r["icao"], {}).get(h)
        if cur is None or abs(r["t"] - h) < abs(cur["t"] - h):
            out[r["icao"]][h] = dict(r)
        meta[r["icao"]] = (r["lat"], r["lon"], r["name"])
    return out, meta


def _fetch_models(meta):
    """Per-model hourly values for the past day at each station (Open-Meteo, multi-location)."""
    icaos = [k for k, v in meta.items() if v[0] is not None]
    res = {}
    for i in range(0, len(icaos), 25):
        chunk = icaos[i:i + 25]
        params = {"latitude": ",".join(f"{meta[k][0]:.3f}" for k in chunk),
                  "longitude": ",".join(f"{meta[k][1]:.3f}" for k in chunk),
                  "hourly": "temperature_2m,wind_speed_10m,precipitation", "models": ",".join(MODEL_IDS),
                  "past_days": 1, "forecast_days": 1, "timezone": "UTC", "wind_speed_unit": "kmh"}
        if config.OPEN_METEO_KEY:
            params["apikey"] = config.OPEN_METEO_KEY
        data, m = net.get(config.OPEN_METEO_URL, params=params, ttl=1800, feed="open_meteo_verify", timeout=45)
        if not data:
            continue
        if isinstance(data, dict):
            data = [data]
        for k, d in zip(chunk, data):
            h = d.get("hourly") or {}
            ts = [int(datetime.fromisoformat(t).replace(tzinfo=timezone.utc).timestamp()) for t in h.get("time", [])]
            res[k] = {"t": ts, **{key: v for key, v in h.items() if key != "time"}}
    return res


def _at(f, key, i):
    v = f.get(key) or []
    return v[i] if i < len(v) else None


def _wavg(vals, w, bias=None, bkey=None):
    ws = {m: (w.get(m) if w else 1) or 0.02 for m in vals}
    tw = sum(ws.values()) or 1
    return sum(ws[m] * (vals[m] - ((bias or {}).get(m, {}).get(bkey, 0.0) if bkey else 0.0)) for m in vals) / tw


def _score(pairs_t, pairs_w, pairs_r):
    s = {}
    if pairs_t:
        e = np.array([f - o for f, o in pairs_t])
        s["temp"] = {"mae": round(float(np.abs(e).mean()), 2), "bias": round(float(e.mean()), 2),
                     "within_2c_pct": round(float((np.abs(e) <= 2).mean() * 100), 1), "n": len(e)}
    if pairs_w:
        e = np.array([f - o for f, o in pairs_w])
        s["wind"] = {"mae": round(float(np.abs(e).mean()), 1), "bias": round(float(e.mean()), 1),
                     "within_10kmh_pct": round(float((np.abs(e) <= 10).mean() * 100), 1), "n": len(e)}
    if pairs_r:
        f = np.array([a for a, _ in pairs_r], bool)
        o = np.array([b for _, b in pairs_r], bool)
        hits, miss, fa, cn = int((f & o).sum()), int((~f & o).sum()), int((f & ~o).sum()), int((~f & ~o).sum())
        s["rain"] = {"accuracy_pct": round((hits + cn) / len(f) * 100, 1), "hits": hits, "misses": miss,
                     "false_alarms": fa, "correct_negatives": cn,
                     "pod": round(hits / (hits + miss), 2) if hits + miss else None,
                     "far": round(fa / (hits + fa), 2) if hits + fa else None, "n": len(f)}
    return s


def verify():
    """Score each model and the INDRA blend against the last 24 h of station observations."""
    now = time.time()
    since = now - 26 * 3600
    obs, meta = _hourly_obs(since)
    if sum(len(v) for v in obs.values()) < 20:
        ACC.update(status="ACCUMULATING", computed_at=now, stations=len(obs),
                   note="Collecting observations — scores appear once enough hourly reports exist.")
        return ACC
    fc = _fetch_models(meta)
    if not fc:
        ACC.update(status="UNAVAILABLE", computed_at=now, note="Model hindcast fetch failed.")
        return ACC
    split = now - 8 * 3600  # train on older hours, score blend on the most recent 8 h
    per = {m: {"t": [], "w": [], "r": []} for m in MODEL_IDS}
    per_test = {m: {"t": [], "w": [], "r": []} for m in MODEL_IDS}
    raw_mean_test = {"t": [], "w": [], "r": []}
    st_bias = {}
    station_rows = []
    recent0 = split - 6 * 3600
    for icao, hours in obs.items():
        f = fc.get(icao)
        if not f:
            continue
        idx = {t: i for i, t in enumerate(f["t"])}
        sb = {m: {"t": [], "w": []} for m in MODEL_IDS}
        for h, o in hours.items():
            i = idx.get(h)
            if i is None:
                continue
            for m in MODEL_IDS:
                ft = _at(f, f"temperature_2m_{m}", i)
                fw = _at(f, f"wind_speed_10m_{m}", i)
                fp = _at(f, f"precipitation_{m}", i)
                tgt = per if h < split else per_test
                if ft is not None and o["temp"] is not None:
                    tgt[m]["t"].append((ft, o["temp"]))
                    if h < split:
                        sb[m]["t"].append((h, ft - o["temp"]))
                if fw is not None and o["wspd_kmh"] is not None:
                    tgt[m]["w"].append((fw, o["wspd_kmh"]))
                    if h < split:
                        sb[m]["w"].append((h, fw - o["wspd_kmh"]))
                if fp is not None:
                    tgt[m]["r"].append((fp >= 0.1, bool(o["rain"])))

        def _b(lst, recent=False):
            v = [e for h, e in lst if not recent or h >= recent0]
            return float(np.mean(v)) if len(v) >= (3 if recent else 4) else 0.0
        st_bias[icao] = {m: {"t": _b(v["t"]), "w": _b(v["w"]), "t6": _b(v["t"], True), "w6": _b(v["w"], True)}
                         for m, v in sb.items()}
    # skill weights from the training window
    weights, train_mae = {}, {}
    for var in ("t", "w"):
        mae = {m: float(np.mean([abs(a - b) for a, b in per[m][var]])) for m in MODEL_IDS if len(per[m][var]) >= 10}
        train_mae[var] = mae
        if mae:
            inv = {m: 1 / max(v, 0.3) ** 2 for m, v in mae.items()}
            tot = sum(inv.values())
            weights[var] = {m: round(float(v / tot), 3) for m, v in inv.items()}
    # out-of-sample: score candidate blending methods on the recent window, keep the best
    METHODS = ("mean", "weighted", "weighted_bias", "weighted_recent_bias", "best_model")
    cand = {k: {"t": [], "w": []} for k in METHODS}
    rain_c = {thr: [] for thr in (0.1, 0.2, 0.5)}
    raw_mean_test = {"t": [], "w": [], "r": []}
    for icao, hours in obs.items():
        f = fc.get(icao)
        if not f:
            continue
        idx = {t: i for i, t in enumerate(f["t"])}
        b = st_bias.get(icao, {})
        for h, o in hours.items():
            i = idx.get(h)
            if i is None or h < split:
                continue
            for var, key, okey in (("t", "temperature_2m", "temp"), ("w", "wind_speed_10m", "wspd_kmh")):
                if o[okey] is None:
                    continue
                vals = {m: _at(f, f"{key}_{m}", i) for m in MODEL_IDS}
                vals = {m: v for m, v in vals.items() if v is not None}
                if not vals:
                    continue
                w = weights.get(var) or {}
                best = min(train_mae.get(var) or {m: 0 for m in vals}, key=lambda m: (train_mae.get(var) or {}).get(m, 0))
                ests = {"mean": float(np.mean(list(vals.values()))),
                        "weighted": _wavg(vals, w),
                        "weighted_bias": _wavg(vals, w, b, var),
                        "weighted_recent_bias": _wavg(vals, w, b, var + "6"),
                        "best_model": vals.get(best, float(np.mean(list(vals.values()))))}
                for k, e in ests.items():
                    cand[k][var].append((max(0.0, e) if var == "w" else e, o[okey]))
            pv = {m: _at(f, f"precipitation_{m}", i) for m in MODEL_IDS}
            pv = {m: p for m, p in pv.items() if p is not None}
            if pv:
                wr = weights.get("t") or {}
                for thr in rain_c:
                    share = sum(wr.get(m, 0.2) * (1 if p >= thr else 0) for m, p in pv.items()) / (sum(wr.get(m, 0.2) for m in pv) or 1)
                    rain_c[thr].append((share >= 0.5, bool(o["rain"])))
                raw_mean_test["r"].append((float(np.mean(list(pv.values()))) >= 0.1, bool(o["rain"])))
    raw_mean_test["t"], raw_mean_test["w"] = cand["mean"]["t"], cand["mean"]["w"]
    method_scores = {}
    for k in METHODS:
        method_scores[k] = {var: round(float(np.mean([abs(a - c) for a, c in cand[k][var]])), 2) if cand[k][var] else None
                            for var in ("t", "w")}
    sel = {}
    for var in ("t", "w"):
        ok = {k: v[var] for k, v in method_scores.items() if v[var] is not None}
        sel[var] = min(ok, key=ok.get) if ok else "mean"
    rain_acc = {thr: (sum(1 for a, c in v if a == c) / len(v)) if v else 0 for thr, v in rain_c.items()}
    sel["rain_threshold_mm"] = max(rain_acc, key=rain_acc.get) if rain_c[0.1] else 0.1
    blend = {"t": cand[sel["t"]]["t"], "w": cand[sel["w"]]["w"], "r": rain_c.get(sel["rain_threshold_mm"], [])}
    for icao, hours in obs.items():
        m = meta.get(icao)
        last = hours[max(hours)] if hours else None
        bt = st_bias.get(icao, {})
        station_rows.append({"icao": icao, "name": m[2] if m else icao, "lat": m[0] if m else None, "lon": m[1] if m else None,
                             "hours": len(hours), "last_temp": last and last["temp"],
                             "temp_bias_by_model": {k: round(v["t"], 2) for k, v in bt.items()}})
    models_scores = []
    for m in MODEL_IDS:
        allp = {k: per[m][k] + per_test[m][k] for k in ("t", "w", "r")}
        sc = _score(allp["t"], allp["w"], allp["r"])
        if sc:
            models_scores.append({"id": m, "name": MODEL_NAMES[m], **sc,
                                  "weight_temp": (weights.get("t") or {}).get(m), "weight_wind": (weights.get("w") or {}).get(m)})
    with _lock:
        _bias.clear()
        _bias.update(st_bias)
        _weights.clear()
        _weights.update(weights)
        _weights["selected"] = sel
    blend_s = _score(blend["t"], blend["w"], blend["r"])
    raw_s = _score(raw_mean_test["t"], raw_mean_test["w"], raw_mean_test["r"])
    ACC.clear()
    ACC.update({
        "status": "LIVE", "computed_at": now, "window_h": 26, "test_window_h": 8,
        "stations": len([s for s in station_rows if s["hours"]]),
        "observations": sum(len(v) for v in obs.values()),
        "models": sorted(models_scores, key=lambda x: x.get("temp", {}).get("mae", 99)),
        "blend": blend_s, "simple_mean": raw_s, "selected_method": sel, "method_scores": method_scores,
        "weights": weights, "station_table": sorted(station_rows, key=lambda x: x["icao"]),
        "method": ("Each model is compared with hourly METAR observations at Indian airports. Five ways of combining the "
                   "models (equal mean, skill-weighted 1/MAE², weighted + station bias, weighted + recent bias, best single "
                   "model) are fitted on the older 18 h and scored only on the most recent 8 h they were not fitted to. "
                   f"The winner is used live: temperature = {sel['t'].replace('_', ' ')}, wind = {sel['w'].replace('_', ' ')}, "
                   f"rain yes/no threshold = {sel['rain_threshold_mm']} mm/h."),
        "limits": ("Airport stations only (~60–90 sites), mostly urban/plains. Rain is scored as yes/no from the METAR "
                   "present-weather group, not rain amount. Hindcast values are Open-Meteo's latest-run hours, which "
                   "are short-lead forecasts. Severe-event (hail, cloudburst) accuracy cannot be measured this way."),
        "source": "NOAA Aviation Weather Center METAR · Open-Meteo model hindcast",
    })
    return ACC


def weights(var="t"):
    with _lock:
        return dict(_weights.get(var) or {})


def selected():
    with _lock:
        return dict(_weights.get("selected") or {})


def local_bias(lat, lon, km=200):
    """Inverse-distance weighted per-model bias from stations within km (empty if none)."""
    with _lock:
        items = list(_bias.items())
    near = []
    for icao, b in items:
        o = _latest.get(icao)
        if not o or o.get("lat") is None:
            continue
        d = _km(lat, lon, o["lat"], o["lon"])
        if d <= km:
            near.append((d, b, icao))
    if not near:
        return {}, []
    near.sort(key=lambda x: x[0])
    near = near[:4]
    out = {}
    for m in MODEL_IDS:
        for var in ("t", "w", "t6", "w6"):
            num = den = 0.0
            for d, b, _ in near:
                w = 1 / max(d, 10) ** 1.5 * max(0, 1 - d / km)  # decays to 0 at km
                num += w * b.get(m, {}).get(var, 0.0)
                den += w
            out.setdefault(m, {})[var] = num / den * min(1.0, 60 / max(near[0][0], 1)) ** 0.5 if den else 0.0
    return out, [x[2] for x in near]


def best_estimate(multi, lat, lon):
    """INDRA blended hourly forecast for a point from the per-model series (Open-Meteo)."""
    times = multi.get("times") or []
    mods = {m["id"]: m for m in multi.get("models", []) if m.get("status") != "NO_DATA"}
    if not times or not mods:
        return None
    wt, ww = weights("t"), weights("w")
    sel = selected()
    bias, used_st = local_bias(lat, lon)
    labels = {"mean": "equal-weight multi-model mean", "weighted": "skill-weighted model blend",
              "weighted_bias": "skill-weighted blend + station bias correction",
              "weighted_recent_bias": "skill-weighted blend + recent (6 h) station bias correction",
              "best_model": "best-scoring single model"}
    mt, mw = sel.get("t", "mean" if not wt else "weighted"), sel.get("w", "mean" if not ww else "weighted")
    if not used_st and "bias" in mt:
        mt = "weighted"
    if not used_st and "bias" in mw:
        mw = "weighted"
    out = {"times": times, "temp": [], "wind": [], "gust": [], "rain_mm": [], "rain_prob": [], "cloud": [], "rh": [],
           "spread_temp": [], "models_used": list(mods), "bias_stations": used_st if "bias" in mt + mw else [],
           "weights_from_live_skill": bool(wt), "method_temp": labels.get(mt, mt), "method_wind": labels.get(mw, mw),
           "rain_threshold_mm": sel.get("rain_threshold_mm", 0.1),
           "method": labels.get(mt, mt)}

    def pick(vals, wts, method, var):
        if not vals:
            return None
        if method == "mean" or not wts:
            return float(np.mean(list(vals.values())))
        if method == "best_model":
            best = max(wts, key=wts.get)
            if best in vals:
                return vals[best]
        bkey = var + "6" if method == "weighted_recent_bias" else var if method == "weighted_bias" else None
        return _wavg(vals, wts, bias if bkey else None, bkey)

    def col(var, i):
        return {m: (s["hourly"].get(var) or [None] * (i + 1))[i] if i < len(s["hourly"].get(var) or []) else None
                for m, s in mods.items()}

    for i in range(len(times)):
        t = {m: v for m, v in col("temperature_2m", i).items() if v is not None}
        w = {m: v for m, v in col("wind_speed_10m", i).items() if v is not None}

        bt = pick(t, wt, mt, "t")
        bw = pick(w, ww, mw, "w")
        out["temp"].append(round(bt, 1) if bt is not None else None)
        out["spread_temp"].append(round(max(t.values()) - min(t.values()), 1) if len(t) > 1 else None)
        out["wind"].append(round(max(0, bw)) if bw is not None else None)
        g = [v for v in col("wind_gusts_10m", i).values() if v is not None]
        out["gust"].append(round(float(np.median(g))) if g else None)
        p = [v for v in col("precipitation", i).values() if v is not None]
        out["rain_mm"].append(round(float(np.median(p)), 1) if p else None)
        pop = [v for v in col("precipitation_probability", i).values() if v is not None]
        thr = out["rain_threshold_mm"]
        wet_share = (sum(1 for v in p if v >= thr) / len(p) * 100) if p else None
        # probability: average of models' own PoP (where provided) and the share of models producing rain
        parts = [x for x in (float(np.mean(pop)) if pop else None, wet_share) if x is not None]
        out["rain_prob"].append(round(sum(parts) / len(parts)) if parts else None)
        c = [v for v in col("cloud_cover", i).values() if v is not None]
        out["cloud"].append(round(float(np.mean(c))) if c else None)
        rh = [v for v in col("relative_humidity_2m", i).values() if v is not None]
        out["rh"].append(round(float(np.mean(rh))) if rh else None)
    return out


def public_state():
    return {**STATE, "accuracy_status": ACC.get("status"), "accuracy_at": ACC.get("computed_at")}


def summary():
    """Short accuracy summary safe for every tier."""
    if ACC.get("status") != "LIVE":
        return {k: ACC.get(k) for k in ("status", "computed_at", "note", "stations")}
    b = ACC.get("blend", {})
    return {"status": "LIVE", "computed_at": ACC["computed_at"], "stations": ACC["stations"],
            "observations": ACC["observations"], "test_window_h": ACC["test_window_h"],
            "temp_within_2c_pct": b.get("temp", {}).get("within_2c_pct"), "temp_mae": b.get("temp", {}).get("mae"),
            "wind_within_10kmh_pct": b.get("wind", {}).get("within_10kmh_pct"), "wind_mae": b.get("wind", {}).get("mae"),
            "rain_yes_no_pct": b.get("rain", {}).get("accuracy_pct"), "rain_pod": b.get("rain", {}).get("pod"),
            "rain_far": b.get("rain", {}).get("far"),
            "best_single_model": (ACC.get("models") or [{}])[0].get("name"),
            "selected_method": ACC.get("selected_method"), "limits": ACC.get("limits")}
