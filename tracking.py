"""Storm-object tracking, motion estimation, extrapolation corridors, ETA and GIS impact."""
import math
import itertools

import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import ConvexHull

from . import geo
from .grid_spec import LAT_N, LON_W, RES, NROWS, NCOLS

_ids = itertools.count(1)


def km_between(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1, a)))


def offset(lat, lon, dist_km, bearing_deg):
    b = math.radians(bearing_deg)
    dlat = dist_km * math.cos(b) / 111.32
    dlon = dist_km * math.sin(b) / (111.32 * max(0.15, math.cos(math.radians(lat))))
    return lat + dlat, lon + dlon


class Tracker:
    """Nearest-neighbour object tracker with overlap preference and speed limit."""

    def __init__(self, prefix, max_speed_kmh=110, max_age_s=3600):
        self.prefix = prefix
        self.tracks = {}  # id -> dict
        self.max_speed = max_speed_kmh
        self.max_age = max_age_s
        self.last_t = None

    def update(self, t, objs):
        prev = {k: v for k, v in self.tracks.items() if t - v["last_t"] <= self.max_age}
        dt_h = (t - self.last_t) / 3600 if self.last_t else None
        used = set()
        pairs = []
        for oi, o in enumerate(objs):
            for tid, tr in prev.items():
                if tr["last_t"] >= t:
                    continue
                last = tr["hist"][-1]
                dth = (t - tr["last_t"]) / 3600
                d = km_between(last["lat"], last["lon"], o["lat"], o["lon"])
                limit = self.max_speed * max(dth, 1 / 6) + 0.5 * math.sqrt(o["area_km2"])
                if d <= limit:
                    pairs.append((d / limit - 0.3 * min(1, o["area_km2"] / max(1, last["area_km2"])), oi, tid))
        pairs.sort()
        assign = {}
        for _, oi, tid in pairs:
            if oi in assign or tid in used:
                continue
            assign[oi] = tid
            used.add(tid)
        for oi, o in enumerate(objs):
            tid = assign.get(oi)
            if tid is None:
                tid = f"{self.prefix}-{next(_ids):05d}"
                self.tracks[tid] = {"id": tid, "born": t, "hist": [], "last_t": t}
            tr = self.tracks[tid]
            rec = {"t": t, "lat": o["lat"], "lon": o["lon"], "area_km2": o["area_km2"], "intensity": o["intensity"]}
            tr["hist"] = (tr["hist"] + [rec])[-12:]
            tr["last_t"] = t
            o["track_id"] = tid
            o["age_min"] = round((t - tr["born"]) / 60)
            o["history"] = [{"t": h["t"], "lat": round(h["lat"], 3), "lon": round(h["lon"], 3), "v": round(float(h["intensity"]), 1),
                             "area": round(float(h["area_km2"]))} for h in tr["hist"]]
            o["motion"] = self.motion(tr)
            o["trend"] = self.trend(tr)
        # drop stale tracks
        for k in [k for k, v in self.tracks.items() if t - v["last_t"] > self.max_age]:
            self.tracks.pop(k, None)
        self.last_t = t
        return objs

    @staticmethod
    def motion(tr):
        h = tr["hist"]
        if len(h) < 2:
            return {"method": "unknown", "speed_kmh": None, "towards_deg": None}
        use = h[-4:]
        t0 = use[0]["t"]
        ts = np.array([(x["t"] - t0) / 3600 for x in use])
        lat0 = use[-1]["lat"]
        ys = np.array([(x["lat"] - use[0]["lat"]) * 111.32 for x in use])
        xs = np.array([(x["lon"] - use[0]["lon"]) * 111.32 * math.cos(math.radians(lat0)) for x in use])
        if ts[-1] <= 0:
            return {"method": "unknown", "speed_kmh": None, "towards_deg": None}
        vy = float(np.polyfit(ts, ys, 1)[0]) if len(use) > 2 else float(ys[-1] / ts[-1])
        vx = float(np.polyfit(ts, xs, 1)[0]) if len(use) > 2 else float(xs[-1] / ts[-1])
        sp = math.hypot(vx, vy)
        if sp > 130:  # implausible jump (merger/split) -> not trusted
            return {"method": "unreliable", "speed_kmh": None, "towards_deg": None}
        return {"method": "tracked", "speed_kmh": round(sp, 1), "towards_deg": round((math.degrees(math.atan2(vx, vy)) + 360) % 360),
                "samples": len(use), "vx_kmh": round(vx, 1), "vy_kmh": round(vy, 1)}

    @staticmethod
    def trend(tr):
        h = tr["hist"]
        if len(h) < 2:
            return {"area_change_pct_h": None, "intensity_change_h": None, "state": "NEW"}
        a, b = h[-2], h[-1]
        dth = max(1 / 12, (b["t"] - a["t"]) / 3600)
        dA = (b["area_km2"] - a["area_km2"]) / max(1, a["area_km2"]) * 100 / dth
        dI = (b["intensity"] - a["intensity"]) / dth
        state = "STEADY"
        if dA > 60 or dI > 12:
            state = "INTENSIFYING"
        if dA > 150 or dI > 25:
            state = "RAPIDLY INTENSIFYING"
        if dA < -40 or dI < -12:
            state = "WEAKENING"
        return {"area_change_pct_h": round(dA), "intensity_change_h": round(dI, 1), "state": state}


def infer_motion(objs):
    """Cells without a track borrow the area-weighted mean motion of tracked neighbours within 400 km."""
    tracked = [o for o in objs if o["motion"]["method"] == "tracked"]
    for o in objs:
        if o["motion"]["method"] == "tracked" or not tracked:
            continue
        ws = vx = vy = 0.0
        for t in tracked:
            d = km_between(o["lat"], o["lon"], t["lat"], t["lon"])
            if d < 400:
                w = 1 / (50 + d)
                ws += w
                vx += w * t["motion"]["vx_kmh"]
                vy += w * t["motion"]["vy_kmh"]
        if ws:
            vx, vy = vx / ws, vy / ws
            o["motion"] = {"method": "inferred from neighbours", "speed_kmh": round(math.hypot(vx, vy), 1),
                           "towards_deg": round((math.degrees(math.atan2(vx, vy)) + 360) % 360), "vx_kmh": round(vx, 1), "vy_kmh": round(vy, 1)}


def forecast_path(o, horizon_min=120, step_min=10):
    """Extrapolated positions with growing uncertainty radius (km)."""
    r_eq = math.sqrt(o["area_km2"] / math.pi)
    m = o["motion"]
    out = []
    for lead in range(0, horizon_min + 1, step_min):
        th = lead / 60
        if m.get("speed_kmh") is not None:
            lat, lon = offset(o["lat"], o["lon"], m["speed_kmh"] * th, m["towards_deg"])
            unc = 6 + (10 if m["method"] == "tracked" else 22) * th + 0.15 * m["speed_kmh"] * th
        else:
            lat, lon = o["lat"], o["lon"]
            unc = 8 + 28 * th
        out.append({"lead_min": lead, "lat": round(lat, 4), "lon": round(lon, 4), "radius_km": round(r_eq + unc, 1)})
    return out


def _circle(lat, lon, rkm, n=24):
    return [offset(lat, lon, rkm, 360 * k / n) for k in range(n)]


def corridor_polygon(path):
    pts = []
    for p in path:
        pts += _circle(p["lat"], p["lon"], p["radius_km"])
    arr = np.array([[p[1], p[0]] for p in pts])
    try:
        hull = ConvexHull(arr)
        ring = arr[hull.vertices]
    except Exception:  # noqa: BLE001
        ring = arr
    return [[round(float(y), 4), round(float(x), 4)] for x, y in ring]  # [lat, lon]


def rasterize(poly_latlon, pad=0):
    """Rasterise a [lat,lon] polygon onto the analysis grid. Returns (mask, r0, c0)."""
    lats = [p[0] for p in poly_latlon]
    lons = [p[1] for p in poly_latlon]
    r0 = max(0, int((LAT_N - max(lats)) / RES) - pad)
    r1 = min(NROWS, int((LAT_N - min(lats)) / RES) + 1 + pad)
    c0 = max(0, int((min(lons) - LON_W) / RES) - pad)
    c1 = min(NCOLS, int((max(lons) - LON_W) / RES) + 1 + pad)
    if r1 <= r0 or c1 <= c0:
        return np.zeros((1, 1), bool), r0, c0
    im = Image.new("1", (c1 - c0, r1 - r0), 0)
    ImageDraw.Draw(im).polygon([((lo - LON_W) / RES - c0, (LAT_N - la) / RES - r0) for la, lo in poly_latlon], fill=1)
    return np.array(im, dtype=bool), r0, c0


def footprint_polygon(o):
    r0, r1, c0, c1 = o["slice"]
    rr, cc = np.nonzero(o["mask"])
    pts = np.column_stack([LON_W + (cc + c0 + 0.5) * RES, LAT_N - (rr + r0 + 0.5) * RES])
    if len(pts) < 3:
        return [[round(float(p[1]), 4), round(float(p[0]), 4)] for p in pts]
    # pad hull by half a cell
    corners = np.concatenate([pts + [dx, dy] for dx in (-RES / 2, RES / 2) for dy in (-RES / 2, RES / 2)])
    try:
        hull = ConvexHull(corners)
        ring = corners[hull.vertices]
    except Exception:  # noqa: BLE001
        ring = corners[:4]
    return [[round(float(y), 4), round(float(x), 4)] for x, y in ring]


def impact(o, path):
    """GIS impact: districts/settlements under the observed footprint and under the forecast corridor, with ETA."""
    r0, r1, c0, c1 = o["slice"]
    now_d = geo.districts_in_mask(o["mask"], r0, c0)
    now_s = geo.places_in_mask(o["mask"], r0, c0)
    corridor = corridor_polygon(path)
    cmask, cr0, cc0 = rasterize(corridor)
    fc_d = geo.districts_in_mask(cmask, cr0, cc0)
    fc_s = geo.places_in_mask(cmask, cr0, cc0, limit_towns=20)
    # ETA per district: first/last lead at which the uncertainty circle touches the district
    eta = {}
    for p in path:
        circ = _circle(p["lat"], p["lon"], p["radius_km"], n=16)
        m, rr0, cc0_ = rasterize([[a, b] for a, b in circ])
        for d in geo.districts_in_mask(m, rr0, cc0_):
            e = eta.setdefault(d["id"], {"first_min": p["lead_min"], "last_min": p["lead_min"]})
            e["last_min"] = p["lead_min"]
    for d in fc_d:
        d.update(eta.get(d["id"], {}))
    fc_d.sort(key=lambda d: (d.get("first_min", 999), -d["area_km2"]))
    for s in fc_s["top_settlements"]:
        best = None
        for p in path:
            if km_between(s["lat"], s["lon"], p["lat"], p["lon"]) <= p["radius_km"]:
                best = p["lead_min"]
                break
        s["eta_min"] = best
    return {
        "now": {"area_km2": round(geo.mask_area_km2(o["mask"], r0)), "districts": now_d[:15], **now_s},
        "forecast": {"horizon_min": path[-1]["lead_min"], "area_km2": round(geo.mask_area_km2(cmask, cr0)),
                     "districts": fc_d[:25], **fc_s},
        "corridor": corridor,
        "method": "Observed footprint = radar/satellite object pixels on the 0.025° grid. Forecast area = union of "
                  "extrapolated positions with growing uncertainty radius, rasterised against district polygons and the "
                  "GeoNames settlement gazetteer. Population counts only settlements with census population in GeoNames "
                  "(towns/cities), so they are a lower bound.",
    }


def advect_mask(o, lead_min):
    """Shift an object footprint by its motion vector (for verification forecasts)."""
    m = o["motion"]
    r0, r1, c0, c1 = o["slice"]
    if m.get("speed_kmh") is None:
        return o["mask"], r0, c0
    th = lead_min / 60
    dr = -int(round(m["vy_kmh"] * th / (RES * 111.32)))
    dc = int(round(m["vx_kmh"] * th / (RES * 111.32 * math.cos(math.radians(o["lat"])))))
    return o["mask"], r0 + dr, c0 + dc
