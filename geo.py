"""Bundled administrative geography: states, districts (raster + index) and a
549k-place gazetteer (GeoNames, CC-BY 4.0) organised State -> District -> City/Town -> Village."""
import gzip
import json
import math
import shutil
import sqlite3
import threading

import numpy as np

from . import config
from .grid_spec import LAT_N, LON_W, RES, NROWS, NCOLS

_lock = threading.Lock()
DISTRICTS = json.load(open(config.DATA_DIR / "districts.json", encoding="utf-8"))
DISTRICT_BY_ID = {d["id"]: d for d in DISTRICTS}
RASTER = np.load(config.DATA_DIR / "district_raster.npz")["raster"]
STATES = {}
for d in DISTRICTS:
    s = STATES.setdefault(d["state"], {"name": d["state"], "slug": d["state_slug"], "district_ids": []})
    s["district_ids"].append(d["id"])
STATE_BY_SLUG = {s["slug"]: s for s in STATES.values()}
DISTRICT_STATE_IDX = np.zeros(RASTER.max() + 1, dtype=np.int16)
STATE_LIST = sorted(STATES)
for d in DISTRICTS:
    DISTRICT_STATE_IDX[d["id"]] = STATE_LIST.index(d["state"]) + 1
# grid cell area (km^2) by row (shrinks with latitude)
ROW_AREA_KM2 = np.array([(RES * 111.32) ** 2 * math.cos(math.radians(LAT_N - (r + 0.5) * RES)) for r in range(NROWS)])
CELLS_PER_DISTRICT = np.bincount(RASTER.ravel(), minlength=RASTER.max() + 1)

_XZ = config.DATA_DIR / "gazetteer.tsv.xz"   # compact (~6 MB) shipped form
_GZ = config.DATA_DIR / "gazetteer.sqlite.gz"  # legacy shipped form (still accepted)
_DB = config.RUNTIME_DIR / "gazetteer.sqlite"
_TIER = {"v": "village", "t": "town", "c": "city"}


def _build_from_tsv(dst):
    import lzma
    con = sqlite3.connect(dst)
    con.execute("CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, name_lc TEXT, district_id INTEGER, lat REAL, lon REAL, tier TEXT, pop INTEGER, code TEXT, town_id INTEGER)")
    batch = []
    with lzma.open(_XZ, "rt", encoding="utf-8") as f:
        for line in f:
            i, n, lc, d, la, lo, t, p, code, tw = line.rstrip("\n").split("\t")
            batch.append((int(i), n, lc or n.lower(), int(d), float(la), float(lo), _TIER[t], int(p) if p else 0,
                          code or "PPL", int(tw) if tw else None))
            if len(batch) >= 50000:
                con.executemany("INSERT INTO places VALUES (?,?,?,?,?,?,?,?,?,?)", batch); batch = []
    if batch:
        con.executemany("INSERT INTO places VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
    con.execute("CREATE INDEX ix_name ON places(name_lc)")
    con.execute("CREATE INDEX ix_dist ON places(district_id, tier)")
    con.execute("CREATE INDEX ix_town ON places(town_id)")
    con.commit()
    con.close()


def _ensure_db():
    with _lock:
        if not _DB.exists() or _DB.stat().st_size < 1000:
            tmp = _DB.with_suffix(".tmp")
            if tmp.exists():
                tmp.unlink()
            if _XZ.exists():
                _build_from_tsv(tmp)
            else:
                with gzip.open(_GZ, "rb") as src, open(tmp, "wb") as dst:
                    shutil.copyfileobj(src, dst)
            tmp.replace(_DB)


_local = threading.local()


def _con():
    con = getattr(_local, "con", None)
    if con is None:
        _ensure_db()
        con = sqlite3.connect(_DB.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)  # as_uri: safe on Windows paths
        con.row_factory = sqlite3.Row
        _local.con = con
    return con


def district_at(lat, lon):
    r, c = int((LAT_N - lat) / RES), int((lon - LON_W) / RES)
    if 0 <= r < NROWS and 0 <= c < NCOLS:
        did = int(RASTER[r, c])
        if did:
            return DISTRICT_BY_ID[did]
        win = RASTER[max(0, r - 3):r + 4, max(0, c - 3):c + 4]
        nz = win[win > 0]
        if nz.size:
            return DISTRICT_BY_ID[int(np.bincount(nz).argmax())]
    return None


def _place(row, with_district=True):
    p = {"id": row["id"], "name": row["name"], "lat": row["lat"], "lon": row["lon"], "tier": row["tier"],
         "population": row["pop"] or None, "district_id": row["district_id"]}
    if with_district:
        d = DISTRICT_BY_ID.get(row["district_id"])
        if d:
            p["district"] = d["name"]
            p["state"] = d["state"]
    return p


def towns_in_district(did, limit=400):
    rows = _con().execute(
        "SELECT p.*, (SELECT COUNT(*) FROM places v WHERE v.town_id=p.id) AS villages FROM places p "
        "WHERE district_id=? AND tier!='village' ORDER BY pop DESC, name LIMIT ?", (did, limit)).fetchall()
    out = []
    for r in rows:
        p = _place(r)
        p["villages"] = r["villages"]
        out.append(p)
    return out


def villages_of_town(town_id, limit=1500):
    rows = _con().execute("SELECT * FROM places WHERE town_id=? ORDER BY name LIMIT ?", (town_id, limit)).fetchall()
    return [_place(r) for r in rows]


def place(pid):
    r = _con().execute("SELECT * FROM places WHERE id=?", (pid,)).fetchone()
    return _place(r) if r else None


def village_count(did):
    return _con().execute("SELECT COUNT(*) FROM places WHERE district_id=? AND tier='village'", (did,)).fetchone()[0]


def search(q, limit=12):
    q = (q or "").strip().lower()
    if len(q) < 2:
        return []
    out = []
    # states and districts first
    for s in STATES.values():
        if s["name"].lower().startswith(q) or (len(q) > 3 and q in s["name"].lower()):
            ds = [DISTRICT_BY_ID[i] for i in s["district_ids"]]
            lat = sum(d["lat"] for d in ds) / len(ds)
            lon = sum(d["lon"] for d in ds) / len(ds)
            out.append({"type": "state", "name": s["name"], "slug": s["slug"], "lat": lat, "lon": lon,
                        "label": f"{s['name']} · State/UT"})
    for d in DISTRICTS:
        if d["name"].lower().startswith(q):
            out.append({"type": "district", "id": d["id"], "name": d["name"], "state": d["state"],
                        "lat": d["lat"], "lon": d["lon"], "label": f"{d['name']} district · {d['state']}"})
    rows = _con().execute(
        "SELECT * FROM places WHERE name_lc >= ? AND name_lc < ? ORDER BY CASE tier WHEN 'city' THEN 0 WHEN 'town' THEN 1 ELSE 2 END, pop DESC LIMIT ?",
        (q, q + "\uffff", limit * 2)).fetchall()
    for r in rows:
        p = _place(r)
        p["type"] = r["tier"]
        p["label"] = f"{p['name']} · {r['tier']} · {p.get('district', '')}, {p.get('state', '')}"
        out.append(p)
    return out[:limit]


def places_in_mask(mask, r0, c0, limit_towns=12):
    """Settlements whose grid cell is inside `mask` (bool array whose [0,0] is grid (r0,c0))."""
    h, w = mask.shape
    lat_top, lat_bot = LAT_N - r0 * RES, LAT_N - (r0 + h) * RES
    lon_l, lon_r = LON_W + c0 * RES, LON_W + (c0 + w) * RES
    rows = _con().execute("SELECT id,name,lat,lon,tier,pop,district_id FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                          (lat_bot, lat_top, lon_l, lon_r)).fetchall()
    villages = towns = pop = 0
    top = []
    for r in rows:
        rr = int((LAT_N - r["lat"]) / RES) - r0
        cc = int((r["lon"] - LON_W) / RES) - c0
        if 0 <= rr < h and 0 <= cc < w and mask[rr, cc]:
            if r["tier"] == "village":
                villages += 1
            else:
                towns += 1
                pop += r["pop"] or 0
                top.append({"id": r["id"], "name": r["name"], "tier": r["tier"], "population": r["pop"] or None,
                            "lat": r["lat"], "lon": r["lon"], "district": DISTRICT_BY_ID.get(r["district_id"], {}).get("name")})
    top.sort(key=lambda x: -(x["population"] or 0))
    return {"villages": villages, "towns": towns, "town_population": pop, "top_settlements": top[:limit_towns]}


def districts_in_mask(mask, r0, c0):
    """Districts intersecting a footprint mask (bool array whose [0,0] is grid cell (r0,c0))."""
    r0, c0 = max(0, r0), max(0, c0)
    sub = RASTER[r0:r0 + mask.shape[0], c0:c0 + mask.shape[1]]
    m = mask[:sub.shape[0], :sub.shape[1]]
    area_w = ROW_AREA_KM2[r0:r0 + sub.shape[0]][:, None]
    vals = sub[m]
    out = []
    if vals.size == 0:
        return out
    ids, counts = np.unique(vals[vals > 0], return_counts=True)
    for did, cnt in sorted(zip(ids, counts), key=lambda x: -x[1]):
        d = DISTRICT_BY_ID[int(did)]
        area = float((area_w * ((sub == did) & m)).sum())
        out.append({"id": d["id"], "name": d["name"], "state": d["state"], "area_km2": round(area),
                    "fraction_of_district": round(int(cnt) / max(1, int(CELLS_PER_DISTRICT[did])), 3)})
    return out


def mask_area_km2(mask, r0):
    h = mask.shape[0]
    return float((ROW_AREA_KM2[r0:r0 + h][:, None] * mask).sum())
