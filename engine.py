"""INDRA background engine.

Independent always-on loops:
  precip loop     NASA GIBS GPM IMERG 30-min rain rate -> QC -> rain-cell detection -> tracking -> verification
  official loop   NDMA SACHET CAP alerts (OFFICIAL, kept separate from INDRA screening alerts)
  satellite loop  Meteosat IODC IR10.8 -> cold-cloud objects -> cooling / convective initiation
  model loop      Open-Meteo national grid (0-6 h) -> experimental hazard diagnostics
  lightning       Blitzortung websocket (continuous)
  fusion loop     radar + satellite + lightning + model -> storm objects, corridors, ETA, GIS impact,
                  district/state threat, alert lifecycle, event stream
"""
import io
import json
import logging
import math
import threading
import time
import traceback
from collections import deque

import numpy as np
from PIL import Image

from . import obs, config, geo, hazards as HZ, lightning, models, net, radar, sachet, satellite, store, tracking
from .grid_spec import LAT_N, LAT_S, LON_W, LON_E, RES, NROWS, NCOLS

log = logging.getLogger("indra.engine")
LEADS = list(range(7))  # 0..6 h

# ---- Mercator row resampling for overlays drawn by Leaflet (EPSG:3857)
def _merc(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


_MY = np.linspace(_merc(LAT_N), _merc(LAT_S), NROWS)
_MERC_ROWS = (((2 * np.degrees(np.arctan(np.exp(_MY))) - 90) * -1 + LAT_N) / RES).astype(int).clip(0, NROWS - 1)


def to_png(rgba):
    buf = io.BytesIO()
    Image.fromarray(rgba[_MERC_ROWS], "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


HAZ_COLORS = [(0, (0, 0, 0, 0)), (20, (46, 178, 160, 90)), (40, (240, 180, 40, 130)), (60, (240, 110, 40, 160)), (80, (214, 30, 90, 185))]


def colorize(score):
    rgba = np.zeros(score.shape + (4,), dtype=np.uint8)
    for thr, col in HAZ_COLORS:
        rgba[score >= thr] = col
    return rgba


class Engine:
    def __init__(self):
        self.lock = threading.RLock()
        self.cond = threading.Condition()
        self.events = deque(maxlen=800)
        self.ev_id = 0
        self.started = time.time()
        self.radar = {"status": "INITIALISING"}
        self.sat = {"status": "INITIALISING"}
        self.grid = {"status": "INITIALISING"}
        self.radar_dbz = None
        self.radar_objs = []
        self.radar_frame_t = None
        self.sat_objs = []
        self.sat_frame_t = None
        self.cells = []
        self.districts = {}
        self.states = {}
        self.national = {"status": "INITIALISING"}
        self.fusion_id = 0
        self.fusion_at = None
        self.radar_tracker = tracking.Tracker("R", max_speed_kmh=110, max_age_s=2700)
        self.sat_tracker = tracking.Tracker("S", max_speed_kmh=120, max_age_s=2700)
        self.done_radar = set()
        self.done_sat = set()
        self.overlay_cache = {}
        self.pending_strikes = []
        self._dirty = threading.Event()
        self.grid_points = None
        self.grid_scores = None  # np (npts, 7, 6)
        self.grid_inputs = None
        self.grid_times = []
        self.dist_w = None
        self.model_preds = {}  # valid_ts -> (point thunder>=40 bool array)
        self.loops = {}

    # ------------------------------------------------------------ events
    def emit(self, kind, data=None, level="info"):
        with self.cond:
            self.ev_id += 1
            self.events.append({"id": self.ev_id, "t": time.time(), "type": kind, "level": level, "data": data or {}})
            self.cond.notify_all()

    def log(self, msg, level="info", **kw):
        log.info(msg)
        self.emit("log", {"msg": msg, **kw}, level)

    def events_since(self, last_id):
        with self.cond:
            return [e for e in self.events if e["id"] > last_id]

    # ------------------------------------------------------------ start
    def start(self):
        store.init()
        obs.init()
        self.log("INDRA core online. Initialising data fusion engine.")
        if config.LIGHTNING_ENABLED:
            lightning.on_strike(self._on_strike)
            lightning.start()
            self.log("Lightning uplink: connecting to Blitzortung.org community network.")
        for name, fn, interval in (("radar", self.run_radar, config.RADAR_INTERVAL),
                                   ("satellite", self.run_sat, config.SATELLITE_INTERVAL),
                                   ("models", self.run_grid, config.MODEL_GRID_INTERVAL),
                                   ("official", self.run_official, config.SACHET_INTERVAL),
                                   ("stations", self.run_stations, config.STATIONS_INTERVAL)):
            th = threading.Thread(target=self._loop, args=(name, fn, interval), name=f"indra-{name}", daemon=True)
            th.start()
        threading.Thread(target=self._fusion_loop, name="indra-fusion", daemon=True).start()
        threading.Thread(target=self._strike_loop, name="indra-strikes", daemon=True).start()

    def _strike_loop(self):
        while True:
            time.sleep(3)
            try:
                self._flush_strikes()
            except Exception:  # noqa: BLE001
                pass

    def _loop(self, name, fn, interval):
        delay = {"radar": 1, "satellite": 4, "models": 2, "official": 3, "stations": 6}.get(name, 1)
        time.sleep(delay)
        while True:
            t0 = time.time()
            self.loops[name] = {"last_start": t0, "running": True}
            try:
                fn()
                self.loops[name].update(last_ok=time.time(), running=False, duration_s=round(time.time() - t0, 1))
            except Exception as exc:  # noqa: BLE001
                self.loops[name].update(running=False, last_error=str(exc)[:200])
                log.error("%s loop failed: %s", name, traceback.format_exc())
                self.log(f"{name} cycle failed: {str(exc)[:120]}", "warn")
            self._dirty.set()
            self.loops[name]["next_at"] = time.time() + interval
            time.sleep(max(20, interval - (time.time() - t0)))

    def _fusion_loop(self):
        last_prune = 0
        while True:
            fired = self._dirty.wait(timeout=60)
            self._flush_strikes()
            if fired:
                time.sleep(1.5)
                self._dirty.clear()
            try:
                self.fuse()
            except Exception:  # noqa: BLE001
                log.error("fusion failed: %s", traceback.format_exc())
            try:
                self.verify_model_lightning()
            except Exception:  # noqa: BLE001
                log.error("model verification failed: %s", traceback.format_exc())
            if time.time() - last_prune > 3600:
                store.prune()
                last_prune = time.time()

    def _on_strike(self, t, lat, lon):
        with self.lock:
            self.pending_strikes.append((round(t, 2), round(lat, 4), round(lon, 4)))
        if len(self.pending_strikes) >= 1:
            pass

    def _flush_strikes(self):
        with self.lock:
            batch, self.pending_strikes = self.pending_strikes, []
        if batch:
            self.emit("lightning", {"strikes": batch[-300:], "n": len(batch)})

    # ------------------------------------------------------------ radar
    def run_radar(self):
        info, meta = radar.frames()
        if not info or not info["frames"]:
            self.radar.update(status="UNAVAILABLE", error=meta.get("error"), checked_at=time.time())
            self.log("NASA GIBS IMERG time index unavailable — no precipitation objects this cycle.", "warn")
            return
        frames = sorted(info["frames"], key=lambda f: f["time"])
        last_t = self.radar_frame_t or 0
        todo = [f for f in frames if f["time"] not in self.done_radar and f["time"] > last_t][-4:]
        for f in todo:
            dbz, ok, total = radar.decode_frame(info["host"], f["path"])
            self.done_radar.add(f["time"])
            if dbz is None:
                self.log(f"IMERG frame {time.strftime('%H:%M', time.gmtime(f['time']))}Z could not be fetched from NASA GIBS.", "warn")
                continue
            dbz = radar.quality_control(dbz)
            objs, _ = radar.detect_cells(dbz)
            for o in objs:
                o["area_km2"] = geo.mask_area_km2(o["mask"], o["slice"][0])
                o["intensity"] = o["max_dbz"]
            objs = self.radar_tracker.update(f["time"], objs)
            tracking.infer_motion(objs)
            self.verify_radar(f["time"], dbz)
            self.issue_radar_forecasts(f["time"], objs)
            with self.lock:
                self.radar_dbz = dbz
                self.radar_objs = objs
                self.radar_frame_t = f["time"]
            echo_km2 = float((np.isfinite(dbz) * geo.ROW_AREA_KM2[:, None]).sum())
            self.radar.update(status="LIVE" if meta["status"] in ("LIVE", "CACHED") else meta["status"],
                              frame_time=f["time"], tiles_ok=ok, tiles_total=total, cells=len(objs),
                              echo_area_km2=round(echo_km2), checked_at=time.time())
            self.log(f"IMERG precipitation frame {time.strftime('%H:%M', time.gmtime(f['time']))}Z ingested · {len(objs)} heavy-rain cells ≥5.6 mm/h "
                     f"(observed {(time.time() - f['time']) / 3600:.1f} h ago).",
                     source="radar")
        self.radar.update(host=info["host"], provider=radar.PROVIDER, layer=radar.LAYER,
                          frames=[{"time": f["time"], "path": f["path"]} for f in frames],
                          age_s=round(time.time() - (self.radar.get("frame_time") or time.time())))
        self.done_radar = set(t for t in self.done_radar if t >= frames[0]["time"] - 600)
        with self.lock:
            snap = [{"id": o["track_id"], "lat": round(o["lat"], 3), "lon": round(o["lon"], 3), "dbz": round(o["max_dbz"]),
                     "area": round(o["area_km2"])} for o in self.radar_objs]
        if snap:
            with store.db() as con:
                con.execute("INSERT INTO cell_history(at,source,payload) VALUES(?,?,?)",
                            (self.radar_frame_t, "radar", json.dumps(snap)))

    # ------------------------------------------------------------ official (NDMA SACHET)
    def run_stations(self):
        st = obs.refresh()
        if st.get("status") == "UNAVAILABLE":
            self.log(f"METAR station feed unavailable: {str(st.get('error'))[:120]}", "warn", source="stations")
            return
        if time.time() - (obs.ACC.get("computed_at") or 0) >= config.VERIFY_INTERVAL or obs.ACC.get("status") != "LIVE":
            a = obs.verify()
            if a.get("status") == "LIVE":
                b = a.get("blend", {})
                self.log(f"Accuracy check vs {a['stations']} stations: temperature within 2 °C {b.get('temp', {}).get('within_2c_pct')}% · "
                         f"rain yes/no {b.get('rain', {}).get('accuracy_pct')}% (last {a['test_window_h']} h, out-of-sample).", source="stations")
                self.emit("accuracy", obs.summary())
        else:
            self.log(f"METAR: {st['stations']} stations reporting.", "debug", source="stations")

    def run_official(self):
        alerts, new = sachet.refresh()
        st = sachet.STATE
        if st["status"] in ("UNAVAILABLE",):
            self.log(f"NDMA SACHET official alert feed unavailable: {str(st.get('error'))[:120]}", "warn", source="official")
            return
        act = [a for a in alerts if a["status"] == "ACTIVE"]
        self.emit("official", {"active": len(act), "new": [{k: a[k] for k in ("id", "level", "event", "issuer", "area_description", "lat", "lon")}
                                                          for a in new[:10]]})
        if new or not self.loops.get("official", {}).get("last_ok"):
            self.log(f"NDMA SACHET: {len(act)} active official alerts" + (f" · {len(new)} new" if new else "") + ".", source="official")

    # ------------------------------------------------------------ satellite
    def _prewarm_sat(self, times):
        """Fetch the IR loop frames (newest first, 3 in parallel) so browsers get them instantly from cache."""
        from concurrent.futures import ThreadPoolExecutor

        def one(when):
            try:
                satellite.display_png("msg_iodc:ir108", when.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            except Exception:  # noqa: BLE001
                pass
        with ThreadPoolExecutor(max_workers=3) as ex:
            list(ex.map(one, list(reversed(times[-8:]))))

    def run_sat(self):
        all_times, meta = satellite.latest_times(8)
        times = all_times[-3:] if all_times else all_times
        if not times:
            self.sat.update(status="UNAVAILABLE", error=meta.get("error"), checked_at=time.time())
            self.log("Satellite capabilities unavailable.", "warn")
            return
        for when in times:
            t = when.timestamp()
            if t in self.done_sat or t <= (getattr(self, "sat_frame_t", None) or 0):
                continue
            arr = satellite.fetch_frame(when)
            if arr is None:
                self.log(f"Satellite frame {when.strftime('%H:%M')}Z not available yet.", "warn")
                continue
            self.done_sat.add(t)
            bt = satellite.count_to_bt(arr)
            objs = satellite.detect_cold_clouds(bt)
            for o in objs:
                o["area_km2"] = geo.mask_area_km2(o["mask"], o["slice"][0])
                o["intensity"] = -o["min_bt"]
            objs = self.sat_tracker.update(t, objs)
            tracking.infer_motion(objs)
            for o in objs:
                tr = self.sat_tracker.tracks.get(o["track_id"])
                o["cooling_k_15min"] = None
                if tr and len(tr["hist"]) >= 2:
                    a, b = tr["hist"][-2], tr["hist"][-1]
                    dtm = max(5, (b["t"] - a["t"]) / 60)
                    o["cooling_k_15min"] = round((-(b["intensity"]) - (-(a["intensity"]))) * 15 / dtm, 1)
                o["convective_initiation"] = bool(o["age_min"] <= 30 and (o["cooling_k_15min"] or 0) <= -4)
            with self.lock:
                self.sat_objs = objs
                self.sat_frame_t = t
            cold_km2 = float(((bt <= 235) * geo.ROW_AREA_KM2[:, None]).sum())
            ci = sum(1 for o in objs if o["convective_initiation"])
            self.sat.update(status="LIVE", frame_time=t, objects=len(objs), cold_cloud_area_km2=round(cold_km2),
                            convective_initiation=ci, checked_at=time.time())
            self.log(f"Meteosat IODC IR10.8 frame {when.strftime('%H:%M')}Z · {len(objs)} cold-cloud objects (≤235 K est.), {ci} initiation signals.",
                     source="satellite")
        self.sat.update(times=[w.strftime("%Y-%m-%dT%H:%M:%S.000Z") for w in all_times], layer=config.SAT_LAYER,
                        age_s=round(time.time() - (self.sat.get("frame_time") or time.time())))
        ft = self.sat.get("frame_time") or 0
        warm = [w for w in all_times if w.timestamp() <= ft + 1]
        threading.Thread(target=self._prewarm_sat, args=(warm,), daemon=True, name="sat-prewarm").start()
        self.done_sat = set(t for t in self.done_sat if t > time.time() - 6 * 3600)

    # ------------------------------------------------------------ model grid
    def run_grid(self):
        if self.grid_points is None:
            self.grid_points = models.grid_points()
            pts = np.array(self.grid_points)
            W = np.zeros((len(geo.DISTRICTS), len(pts)), dtype=np.float32)
            for i, d in enumerate(geo.DISTRICTS):
                dd = np.hypot(pts[:, 0] - d["lat"], (pts[:, 1] - d["lon"]) * math.cos(math.radians(d["lat"])))
                idx = np.argsort(dd)[:4]
                w = 1 / (dd[idx] + 0.15) ** 2
                W[i, idx] = w / w.sum()
            self.dist_w = W
        data, status = models.fetch_grid(self.grid_points)
        npts = len(self.grid_points)
        S = np.zeros((npts, 7, len(HZ.HAZARDS)), dtype=np.float32)
        inputs = [None] * npts
        times = []
        got = 0
        for i, h in enumerate(data):
            if not h:
                continue
            got += 1
            if not times:
                times = h.get("time", [])
            for lead in LEADS:
                sc = models.hazard_scores(h, lead)
                S[i, lead] = [sc[k] for k in HZ.HAZARDS]
                if lead == 0:
                    inputs[i] = sc["_inputs"]
        if got == 0:
            self.grid.update(status="UNAVAILABLE", checked_at=time.time())
            self.log("Model grid unavailable (Open-Meteo). Model-based screening paused; observations continue.", "warn")
            return
        with self.lock:
            self.grid_scores, self.grid_inputs, self.grid_times = S, inputs, times
        # archive model thunderstorm predictions for lightning-based verification
        for lead in range(1, 7):
            if lead < len(times):
                vt = models.iso_to_ts(times[lead])
                self.model_preds.setdefault(vt, (S[:, lead, 0] >= 40).copy())
        self.grid.update(status=status, points=npts, valid=got, fetched_at=time.time(), deg=config.MODEL_GRID_DEG,
                         times=times, runs=models.model_runs(), checked_at=time.time())
        self.log(f"Model grid refreshed · {got}/{npts} points · leads 0–6 h · best-match NWP (Open-Meteo).", source="models")

    def env_at(self, lat, lon):
        if self.grid_inputs is None:
            return None
        pts = np.array(self.grid_points)
        i = int(np.argmin(np.hypot(pts[:, 0] - lat, pts[:, 1] - lon)))
        return self.grid_inputs[i]

    # ------------------------------------------------------------ verification
    def issue_radar_forecasts(self, t, objs):
        rows = []
        for lead in (30, 60):
            for method in ("extrapolation", "persistence"):
                g = np.zeros((NROWS, NCOLS), bool)
                for o in objs:
                    if method == "extrapolation":
                        m, r0, c0 = tracking.advect_mask(o, lead)
                    else:
                        m, r0, c0 = o["mask"], o["slice"][0], o["slice"][2]
                    r1, c1 = r0 + m.shape[0], c0 + m.shape[1]
                    if r1 <= 0 or c1 <= 0 or r0 >= NROWS or c0 >= NCOLS:
                        continue
                    sr0, sc0 = max(0, r0), max(0, c0)
                    g[sr0:min(NROWS, r1), sc0:min(NCOLS, c1)] |= m[sr0 - r0:min(NROWS, r1) - r0, sc0 - c0:min(NCOLS, c1) - c0]
                cm = radar.coarse_mask(g)
                rows.append((t, t + lead * 60, lead, method, np.packbits(cm).tobytes()))
        with store.db() as con:
            con.executemany("INSERT INTO forecasts(issued_at,valid_at,lead_min,method,grid) VALUES(?,?,?,?,?)", rows)

    def verify_radar(self, t, dbz):
        obs = radar.coarse_mask(np.isfinite(dbz) & (dbz >= 35))
        from scipy import ndimage
        obs_tol = ndimage.binary_dilation(obs, iterations=1)
        shape = obs.shape
        with store.db() as con:
            rows = con.execute("SELECT id,lead_min,method,grid FROM forecasts WHERE verified=0 AND ABS(valid_at-?)<=150", (t,)).fetchall()
            for r in rows:
                fc = np.unpackbits(np.frombuffer(r["grid"], dtype=np.uint8))[:shape[0] * shape[1]].reshape(shape).astype(bool)
                fc_tol = ndimage.binary_dilation(fc, iterations=1)
                hits = int((fc & obs_tol).sum())
                fa = int((fc & ~obs_tol).sum())
                misses = int((obs & ~fc_tol).sum())
                cn = int(obs.size - hits - fa - misses)
                con.execute("INSERT INTO verification(valid_at,lead_min,method,hits,misses,false_alarms,correct_negatives) VALUES(?,?,?,?,?,?,?)",
                            (t, r["lead_min"], r["method"], hits, misses, fa, cn))
                con.execute("UPDATE forecasts SET verified=1 WHERE id=?", (r["id"],))
        if rows:
            self.emit("verification", {"valid_at": t, "n": len(rows)})

    def verify_model_lightning(self):
        if not lightning.STATE.get("since") or not self.grid_points:
            return
        now = time.time()
        pts = np.array(self.grid_points)
        for vt in sorted(list(self.model_preds)):
            if now < vt + 40 * 60:
                continue
            pred = self.model_preds.pop(vt)
            if lightning.STATE["since"] > vt - 30 * 60:
                continue  # feed was not up for the full window
            strikes = lightning.recent(int((now - (vt - 30 * 60)) / 60) + 1)
            strikes = [s for s in strikes if vt - 1800 <= s[0] <= vt + 1800]
            obs = np.zeros(len(pts), bool)
            if strikes:
                sa = np.array([[s[1], s[2]] for s in strikes])
                for i, (la, lo) in enumerate(pts):
                    d = np.hypot(sa[:, 0] - la, (sa[:, 1] - lo) * math.cos(math.radians(la)))
                    obs[i] = (d <= 0.4).any()
            hits = int((pred & obs).sum())
            fa = int((pred & ~obs).sum())
            misses = int((~pred & obs).sum())
            cn = int((~pred & ~obs).sum())
            with store.db() as con:
                con.execute("INSERT INTO verification(valid_at,lead_min,method,hits,misses,false_alarms,correct_negatives) VALUES(?,?,?,?,?,?,?)",
                            (vt, 60, "model_thunder_vs_lightning", hits, misses, fa, cn))

    # ------------------------------------------------------------ fusion
    def _strikes_in(self, lat0, lat1, lon0, lon1, minutes=15):
        return len(lightning.recent(minutes, (lat0, lon0, lat1, lon1)))

    def _cell_public(self, o, source, sat_match=None):
        r0, r1, c0, c1 = o["slice"]
        lat_top, lat_bot = LAT_N - r0 * RES, LAT_N - r1 * RES
        lon_l, lon_r = LON_W + c0 * RES, LON_W + c1 * RES
        pad = 0.1
        strikes = self._strikes_in(lat_bot - pad, lat_top + pad, lon_l - pad, lon_r + pad)
        env = self.env_at(o["lat"], o["lon"])
        sources = [source]
        latent = False
        obs_age_s = None
        if source == "radar":
            scores, extra = HZ.score_radar_cell(o, env, strikes)
            intensity = {"max_dbz": round(o["max_dbz"]), "p90_dbz": round(o["p90_dbz"]), **extra,
                         "max_rain_mmh": round(o.get("max_mmh", 0), 1), "p90_rain_mmh": round(o.get("p90_mmh", 0), 1)}
            if sat_match is not None:
                intensity["min_bt_est_k"] = round(sat_match["min_bt"])
                sources.append("satellite")
            obs_age_s = time.time() - (self.radar_frame_t or time.time())
            latent = obs_age_s > config.PRECIP_LIVE_AGE_S
            # IMERG arrives hours late: extrapolating that far would be fiction, so latent cells get no corridor/ETA
            path = tracking.forecast_path(o, 0, 10) if latent else tracking.forecast_path(o, 120, 10)
        else:
            scores = HZ.score_sat_cell(o, env, strikes)
            intensity = {"min_bt_est_k": round(o["min_bt"]), "core_fraction": round(o["frac_core"], 2),
                         "cooling_k_15min": o.get("cooling_k_15min")}
            path = tracking.forecast_path(o, 180, 15)
        if strikes:
            sources.append("lightning")
        if env and models.hazard_scores is not None and (env.get("cape") or 0) >= 500:
            sources.append("model")
        n_obs = len({x for x in sources if x in ("radar", "satellite", "lightning")})
        corroboration = "MULTI-SOURCE" if n_obs >= 2 else "SINGLE-SOURCE"
        cap = 100 if n_obs >= 2 else (HZ.SAT_ONLY_CAP if source == "satellite" else HZ.SINGLE_SOURCE_CAP)
        scores = {k: min(v, cap) for k, v in scores.items()}
        top = max(scores, key=scores.get)
        sev_score = max(scores.values())
        state = o["trend"]["state"]
        if (state == "RAPIDLY INTENSIFYING" or o.get("convective_initiation")) and sev_score >= 40:
            sev_score = min(cap, sev_score + 6)
        sev = HZ.level(sev_score)
        imp = tracking.impact(o, path)
        return {
            "id": o["track_id"], "source": source, "sources": sorted(set(sources)), "lat": round(o["lat"], 4), "lon": round(o["lon"], 4),
            "area_km2": round(o["area_km2"]), "intensity": intensity, "motion": o["motion"], "trend": o["trend"],
            "age_min": o["age_min"], "history": o["history"], "lightning_15min": strikes,
            "convective_initiation": bool(o.get("convective_initiation")),
            "hazards": scores, "primary_hazard": top, "severity": sev, "severity_score": round(sev_score), "corroboration": corroboration,
            "footprint": tracking.footprint_polygon(o), "forecast_path": path, "corridor": imp.pop("corridor"),
            "impact": imp, "environment": env,
            "confidence": HZ.confidence(sources, lead_h=0),
            "status_label": (f"OBSERVED {obs_age_s / 3600:.1f} h AGO · IMERG latency" if latent else "OBSERVED (IMERG precipitation)")
            if source == "radar" else "OBSERVED (satellite)",
            "latent": latent, "obs_time": self.radar_frame_t if source == "radar" else self.sat_frame_t,
            "forecast_label": "EXPERIMENTAL — linear extrapolation, not validated",
            "precautions": HZ.precautions(scores),
        }

    def fuse(self):
        t0 = time.time()
        with self.lock:
            robjs = list(self.radar_objs)
            sobjs = list(self.sat_objs)
            S = self.grid_scores
        # radar <-> satellite association
        sat_used = set()
        rcells = []
        for o in sorted(robjs, key=lambda x: -x["max_dbz"])[:80]:
            match = None
            r0, r1, c0, c1 = o["slice"]
            for k, s in enumerate(sobjs):
                a0, a1, b0, b1 = s["slice"]
                if a0 < r1 and r0 < a1 and b0 < c1 and c0 < b1:
                    match = s
                    sat_used.add(k)
                    break
            rcells.append(self._cell_public(o, "radar", match))
        scells = []
        for k, s in enumerate(sorted(sobjs, key=lambda x: x["min_bt"])):
            if k in sat_used:
                continue
            env = self.env_at(s["lat"], s["lon"]) or {}
            convective = s["min_bt"] <= 225 or (s.get("cooling_k_15min") or 0) <= -4 or (env.get("cape") or 0) >= 800
            if not convective:
                continue
            scells.append(self._cell_public(s, "satellite"))
            if len(scells) >= 40:
                break
        cells = sorted(rcells + scells, key=lambda c: -c["severity_score"])

        # district fusion
        nD = len(geo.DISTRICTS)
        nH = len(HZ.HAZARDS)
        F = np.zeros((nD, 7, nH), dtype=np.float32)
        srcs = [set() for _ in range(nD)]
        if S is not None and self.dist_w is not None:
            M = np.tensordot(self.dist_w, S, axes=(1, 0))  # (nD, 7, nH)
            F = np.minimum(M, HZ.MODEL_ONLY_CAP)
            for i in np.nonzero(M.max(axis=(1, 2)) >= 20)[0]:
                srcs[i].add("model")
        idx_of = {d["id"]: i for i, d in enumerate(geo.DISTRICTS)}
        eta = {}
        for c in cells:
            if c.get("latent"):
                continue  # hours-old IMERG rain cell: shown as history, not counted as a current threat
            hv = np.array([c["hazards"][k] for k in HZ.HAZARDS], dtype=np.float32)
            for d in c["impact"]["now"]["districts"]:
                i = idx_of[d["id"]]
                F[i, 0] = np.maximum(F[i, 0], hv)
                F[i, 1] = np.maximum(F[i, 1], hv * 0.8)
                srcs[i].update(c["sources"])
            for d in c["impact"]["forecast"]["districts"]:
                if "first_min" not in d:
                    continue
                i = idx_of[d["id"]]
                lead = min(6, int(d["first_min"] // 60))
                F[i, lead] = np.maximum(F[i, lead], hv * (1 - 0.12 * lead) * 0.92)
                srcs[i].update(c["sources"])
                e = eta.get(d["id"])
                if e is None or d["first_min"] < e["first_min"]:
                    eta[d["id"]] = {"cell": c["id"], "first_min": d["first_min"], "last_min": d.get("last_min"),
                                    "hazard": c["primary_hazard"], "severity": c["severity"]}
        # lightning counts per district (last 30 min)
        strikes = lightning.recent(30)
        lcount = np.zeros(nD, dtype=np.int32)
        for _, la, lo in strikes:
            r, cc = int((LAT_N - la) / RES), int((lo - LON_W) / RES)
            if 0 <= r < NROWS and 0 <= cc < NCOLS:
                did = int(geo.RASTER[r, cc])
                if did:
                    lcount[idx_of[did]] += 1
        li = HZ.HAZARDS.index("lightning")
        ti = HZ.HAZARDS.index("thunderstorm")
        for i in np.nonzero(lcount)[0]:
            n = lcount[i]
            sc = 50 if n < 5 else 70 if n < 15 else 85 if n < 40 else 96
            F[i, 0, li] = max(F[i, 0, li], sc)
            F[i, 0, ti] = max(F[i, 0, ti], sc * 0.85)
            srcs[i].add("lightning")
        districts = {}
        for i, d in enumerate(geo.DISTRICTS):
            peak = F[i].max(axis=1)  # per lead
            score = float(F[i].max())
            lead = int(peak.argmax())
            hz = HZ.HAZARDS[int(F[i, lead].argmax())]
            districts[d["id"]] = {
                "id": d["id"], "name": d["name"], "state": d["state"], "lat": d["lat"], "lon": d["lon"],
                "score": round(score), "level": HZ.level(score) if (S is not None or srcs[i]) else "UNKNOWN",
                "now_score": round(float(F[i, :2].max())), "peak_lead_h": lead, "primary_hazard": hz,
                "hazards": {k: int(round(float(F[i, :, j].max()))) for j, k in enumerate(HZ.HAZARDS)},
                "timeline": [int(round(float(v))) for v in peak], "sources": sorted(srcs[i]),
                "lightning_30min": int(lcount[i]), "eta": eta.get(d["id"]),
            }
        states = {}
        for sname, s in geo.STATES.items():
            ds = [districts[i] for i in s["district_ids"]]
            top = max(ds, key=lambda x: x["score"])
            counts = {lv: sum(1 for x in ds if x["level"] == lv) for lv in HZ.LEVELS}
            states[s["slug"]] = {"name": sname, "slug": s["slug"], "score": top["score"], "level": top["level"],
                                 "primary_hazard": top["primary_hazard"], "districts": len(ds), "counts": counts,
                                 "top_districts": [{"id": x["id"], "name": x["name"], "score": x["score"], "level": x["level"],
                                                    "hazard": x["primary_hazard"]} for x in sorted(ds, key=lambda x: -x["score"])[:5]],
                                 "lightning_30min": sum(x["lightning_30min"] for x in ds),
                                 "cells": sum(1 for c in cells if any(dd["state"] == sname for dd in c["impact"]["now"]["districts"]))}
        lvl_counts = {lv: sum(1 for x in districts.values() if x["level"] == lv) for lv in HZ.LEVELS}
        top_score = max((x["score"] for x in districts.values()), default=0)
        with self.lock:
            prev_d = self.districts
            self.cells = cells
            self.districts = districts
            self.states = states
            self.fusion_id += 1
            self.fusion_at = time.time()
            self.overlay_cache = {k: v for k, v in self.overlay_cache.items() if k[0] == "radar"}
            self.F = F
        self.national = {
            "status": "OK", "generated_at": self.fusion_at, "level": HZ.level(top_score), "score": round(top_score),
            "district_levels": lvl_counts, "states_at_high_or_above": sum(1 for s in states.values() if s["level"] in ("HIGH", "CRITICAL")),
            "cells": {"total": len(cells), "radar": len(rcells), "satellite": len(scells),
                      "severe": sum(1 for c in cells if c["severity"] in ("HIGH", "CRITICAL")),
                      "intensifying": sum(1 for c in cells if "INTENSIFYING" in c["trend"]["state"]),
                      "initiation": sum(1 for c in cells if c["convective_initiation"])},
            "lightning": {"last_15min": len(lightning.recent(15)), "last_60min": len(lightning.recent(60)),
                          "connected": lightning.STATE["connected"]},
            "priority_districts": sorted(({"id": x["id"], "name": x["name"], "state": x["state"], "score": x["score"], "level": x["level"],
                                           "hazard": x["primary_hazard"], "peak_lead_h": x["peak_lead_h"], "eta": x["eta"],
                                           "sources": x["sources"]} for x in districts.values()), key=lambda x: -x["score"])[:25],
            "fusion_ms": round((time.time() - t0) * 1000),
            "timeline": [int(round(float(v))) for v in F.max(axis=(0, 2))],
            "timeline_by_hazard": {k: [int(round(float(v))) for v in F[:, :, j].max(axis=0)] for j, k in enumerate(HZ.HAZARDS)},
            "districts_at_level_by_lead": [{lv: int(((F[:, L, :].max(axis=1) >= th) ).sum()) for lv, th in (("MEDIUM", 40), ("HIGH", 60), ("CRITICAL", 80))} for L in range(7)],
        }
        self.update_alerts(cells, districts)
        # escalation events for districts
        if prev_d:
            for did, x in districts.items():
                p = prev_d.get(did)
                if p and HZ.level_rank(x["level"]) > HZ.level_rank(p["level"]) and x["level"] in ("HIGH", "CRITICAL"):
                    self.emit("district_escalation", {"id": did, "name": x["name"], "state": x["state"], "from": p["level"], "to": x["level"],
                                                      "hazard": x["primary_hazard"]}, "warn")
        self.emit("fusion", {"id": self.fusion_id, "level": self.national["level"], "cells": self.national["cells"],
                             "district_levels": lvl_counts, "lightning": self.national["lightning"], "ms": self.national["fusion_ms"]})
        with store.db() as con:
            last = con.execute("SELECT MAX(at) FROM threat_history").fetchone()[0] or 0
            if time.time() - last >= 300:
                con.execute("INSERT INTO threat_history(at,payload) VALUES(?,?)", (time.time(), json.dumps({
                    "level": self.national["level"], "score": self.national["score"], "district_levels": lvl_counts,
                    "cells": self.national["cells"], "lightning_60": self.national["lightning"]["last_60min"],
                    "states": {k: v["score"] for k, v in states.items()}})))

    # ------------------------------------------------------------ alerts
    def update_alerts(self, cells, districts):
        now = time.time()
        cand = {}
        for c in cells:
            if c.get("latent") or HZ.level_rank(c["severity"]) < HZ.level_rank("MEDIUM"):
                continue
            nd = c["impact"]["now"]["districts"] or c["impact"]["forecast"]["districts"]
            if not nd:
                continue  # cell over sea / neighbouring country with no Indian district in its 0-2 h path: track, don't alert
            dname = nd[0]["name"]
            st = nd[0]["state"] if nd else ""
            cand[f"CELL-{c['id']}"] = {
                "kind": "storm_cell", "hazard": c["primary_hazard"], "level": c["severity"], "district_id": nd[0]["id"] if nd else None,
                "district": dname, "state": st, "lat": c["lat"], "lon": c["lon"],
                "title": (f"{HZ.HAZARD_LABEL.get(c['primary_hazard'], c['primary_hazard'])} cell near {dname}" if nd else f"{HZ.HAZARD_LABEL.get(c['primary_hazard'], c['primary_hazard'])} cell · offshore / border area"),
                "payload": {"cell_id": c["id"], "hazards": c["hazards"], "motion": c["motion"], "trend": c["trend"]["state"],
                            "intensity": c["intensity"], "sources": c["sources"], "confidence": c["confidence"],
                            "window": {"from_min": 0, "to_min": c["forecast_path"][-1]["lead_min"]},
                            "affected_now": {"area_km2": c["impact"]["now"]["area_km2"], "districts": [d["name"] for d in c["impact"]["now"]["districts"][:8]],
                                             "villages": c["impact"]["now"]["villages"], "towns": c["impact"]["now"]["towns"]},
                            "affected_forecast": {"area_km2": c["impact"]["forecast"]["area_km2"],
                                                  "districts": [{"name": d["name"], "state": d["state"], "eta_min": d.get("first_min")} for d in c["impact"]["forecast"]["districts"][:10]],
                                                  "villages": c["impact"]["forecast"]["villages"], "towns": c["impact"]["forecast"]["towns"],
                                                  "town_population": c["impact"]["forecast"]["town_population"],
                                                  "top_settlements": c["impact"]["forecast"]["top_settlements"][:8]},
                            "precautions": c["precautions"]}}
        for did, x in districts.items():
            if HZ.level_rank(x["level"]) < HZ.level_rank("MEDIUM"):
                continue
            cand[f"D{did}"] = {
                "kind": "district", "hazard": x["primary_hazard"], "level": x["level"], "district_id": did, "district": x["name"],
                "state": x["state"], "lat": x["lat"], "lon": x["lon"],
                "title": f"{HZ.HAZARD_LABEL.get(x['primary_hazard'])} threat · {x['name']}, {x['state']}",
                "payload": {"hazards": x["hazards"], "timeline": x["timeline"], "peak_lead_h": x["peak_lead_h"], "sources": x["sources"],
                            "eta": x["eta"], "confidence": HZ.confidence(x["sources"], lead_h=x["peak_lead_h"]),
                            "window": {"from_min": 0, "to_min": 360},
                            "affected_now": {"area_km2": geo.DISTRICT_BY_ID[did]["area_km2"], "districts": [x["name"]]},
                            "precautions": HZ.precautions(x["hazards"])}}
        with store.db() as con:
            active = {r["id"]: dict(r) for r in con.execute("SELECT * FROM alerts WHERE status IN ('ACTIVE','ENDING')")}
            for aid, a in cand.items():
                old = active.pop(aid, None)
                if old is None:
                    prev = con.execute("SELECT status FROM alerts WHERE id=?", (aid,)).fetchone()
                    con.execute("INSERT OR REPLACE INTO alerts(id,kind,source_type,hazard,level,peak_level,title,district_id,district,state,lat,lon,status,created_at,updated_at,expires_at,payload) "
                                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (aid, a["kind"], "INDRA_EXPERIMENTAL", a["hazard"], a["level"], a["level"], a["title"], a["district_id"], a["district"], a["state"],
                                 a["lat"], a["lon"], "ACTIVE", now, now, now + 3600, json.dumps(a["payload"])))
                    con.execute("INSERT INTO alert_events(alert_id,at,event,level,note) VALUES(?,?,?,?,?)", (aid, now, "ISSUED", a["level"], a["title"]))
                    if HZ.level_rank(a["level"]) >= HZ.level_rank("MEDIUM") or a["kind"] == "storm_cell":
                        self.emit("alert", {"id": aid, "event": "ISSUED", "level": a["level"], "title": a["title"], "hazard": a["hazard"],
                                            "district": a["district"], "state": a["state"], "lat": a["lat"], "lon": a["lon"]},
                                  "alert" if a["level"] in ("HIGH", "CRITICAL") else "info")
                else:
                    ev = None
                    if HZ.level_rank(a["level"]) > HZ.level_rank(old["level"]):
                        ev = "ESCALATED"
                    elif HZ.level_rank(a["level"]) < HZ.level_rank(old["level"]):
                        ev = "DOWNGRADED"
                    peak = a["level"] if HZ.level_rank(a["level"]) > HZ.level_rank(old["peak_level"]) else old["peak_level"]
                    con.execute("UPDATE alerts SET level=?,peak_level=?,title=?,lat=?,lon=?,status='ACTIVE',updated_at=?,expires_at=?,payload=?,"
                                "acknowledged_at=CASE WHEN ?='ESCALATED' THEN NULL ELSE acknowledged_at END WHERE id=?",
                                (a["level"], peak, a["title"], a["lat"], a["lon"], now, now + 3600, json.dumps(a["payload"]), ev or "", aid))
                    if ev:
                        con.execute("INSERT INTO alert_events(alert_id,at,event,level,note) VALUES(?,?,?,?,?)", (aid, now, ev, a["level"], f"{old['level']} → {a['level']}"))
                        self.emit("alert", {"id": aid, "event": ev, "level": a["level"], "from": old["level"], "title": a["title"], "hazard": a["hazard"],
                                            "district": a["district"], "state": a["state"], "lat": a["lat"], "lon": a["lon"]},
                                  "alert" if ev == "ESCALATED" and a["level"] in ("HIGH", "CRITICAL") else "info")
            # alerts no longer supported by evidence: ENDING (grace) then EXPIRED
            for aid, old in active.items():
                if old["status"] == "ACTIVE":
                    con.execute("UPDATE alerts SET status='ENDING', updated_at=? WHERE id=?", (now, aid))
                    con.execute("INSERT INTO alert_events(alert_id,at,event,level,note) VALUES(?,?,?,?,?)", (aid, now, "WEAKENING", old["level"], "Signal no longer detected"))
                elif now - old["updated_at"] > 900:
                    con.execute("UPDATE alerts SET status='EXPIRED', ended_at=? WHERE id=?", (now, aid))
                    con.execute("INSERT INTO alert_events(alert_id,at,event,level,note) VALUES(?,?,?,?,?)", (aid, now, "EXPIRED", old["level"], "Threat ended"))
                    self.emit("alert", {"id": aid, "event": "EXPIRED", "level": old["level"], "title": old["title"]})

    # ------------------------------------------------------------ overlays
    def overlay_radar(self):
        with self.lock:
            key = ("radar", self.radar_frame_t)
            if key in self.overlay_cache:
                return self.overlay_cache[key]
            dbz = self.radar_dbz
        if dbz is None:
            return None
        png = to_png(radar.render_rgba(dbz, 235))
        with self.lock:
            self.overlay_cache = {k: v for k, v in self.overlay_cache.items() if k[0] != "radar"}
            self.overlay_cache[key] = png
        return png

    def overlay_hazard(self, hazard="all", lead=0):
        key = ("hz", self.fusion_id, hazard, lead)
        with self.lock:
            if key in self.overlay_cache:
                return self.overlay_cache[key]
            F = getattr(self, "F", None)
        if F is None:
            return None
        if hazard == "all":
            vals = F[:, lead, :].max(axis=1)
        else:
            vals = F[:, lead, HZ.HAZARDS.index(hazard)]
        lut = np.zeros(geo.RASTER.max() + 1, dtype=np.float32)
        for i, d in enumerate(geo.DISTRICTS):
            lut[d["id"]] = vals[i]
        png = to_png(colorize(lut[geo.RASTER]))
        with self.lock:
            self.overlay_cache[key] = png
        return png


ENGINE = Engine()
