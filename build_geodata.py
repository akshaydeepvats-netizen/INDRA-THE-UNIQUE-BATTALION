"""Offline build of INDRA's geographic database.

Inputs (download once):
  - udit-001/india-maps-data  geojson/india.geojson  (760 district polygons, 36 states/UTs)
  - GeoNames IN.txt (CC-BY 4.0) populated places

Outputs:
  static/geo/states.geojson                simplified state/UT polygons (dissolved from districts)
  static/geo/districts/<state_slug>.geojson simplified district polygons per state
  data/districts.json                      district index (id, name, state, centroid, bbox, area)
  data/district_raster.npz                 uint16 district-id raster on the INDRA analysis grid
  data/gazetteer.tsv.xz                    cities / towns / villages assigned to districts

Usage: python scripts/build_geodata.py <india-maps-data/geojson/states dir> <IN.txt>
"""
import gzip, json, math, os, re, shutil, sqlite3, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from indra.grid_spec import LAT_N, LAT_S, LON_W, LON_E, RES, NROWS, NCOLS  # noqa: E402


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def rnd(geom, nd=4):
    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    m = mapping(geom)
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def area_km2(geom):
    lat = geom.centroid.y
    return geom.area * (111.32 ** 2) * math.cos(math.radians(lat))


def main(india_path, geonames_path):
    import glob
    feats = []
    for fp in sorted(glob.glob(os.path.join(india_path, "*.geojson"))):
        feats += json.load(open(fp))["features"]
    districts = []
    for f in feats:
        p = f["properties"]
        geom = shape(f["geometry"]).buffer(0)
        if geom.is_empty:
            continue
        districts.append({"name": p["district"].strip(), "state": p["st_nm"].strip(), "geom": geom,
                          "code": p.get("dt_code")})
    # merge duplicate district names within a state (multi-part records)
    merged = {}
    for d in districts:
        k = (d["state"], d["name"])
        if k in merged:
            merged[k]["geom"] = unary_union([merged[k]["geom"], d["geom"]])
        else:
            merged[k] = d
    districts = sorted(merged.values(), key=lambda d: (d["state"], d["name"]))
    for i, d in enumerate(districts, start=1):
        d["id"] = i
    print("districts", len(districts))

    os.makedirs(os.path.join(ROOT, "static/geo/districts"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)

    # states
    states = {}
    for d in districts:
        states.setdefault(d["state"], []).append(d)
    st_feats = []
    for sname, ds in sorted(states.items()):
        geom = unary_union([d["geom"] for d in ds]).buffer(0)
        simp = geom.simplify(0.012, preserve_topology=True)
        st_feats.append({"type": "Feature", "properties": {
            "name": sname, "slug": slug(sname), "districts": len(ds),
            "area_km2": round(area_km2(geom)), "centroid": [round(geom.representative_point().y, 4), round(geom.representative_point().x, 4)],
            "bbox": [round(x, 3) for x in geom.bounds]}, "geometry": rnd(simp, 3)})
        dfeats = []
        for d in ds:
            ds_simp = d["geom"].simplify(0.004, preserve_topology=True)
            rp = d["geom"].representative_point()
            dfeats.append({"type": "Feature", "properties": {"id": d["id"], "name": d["name"], "state": sname},
                           "geometry": rnd(ds_simp, 4)})
        json.dump({"type": "FeatureCollection", "features": dfeats},
                  open(os.path.join(ROOT, f"static/geo/districts/{slug(sname)}.geojson"), "w"), separators=(",", ":"))
    json.dump({"type": "FeatureCollection", "features": st_feats},
              open(os.path.join(ROOT, "static/geo/states.geojson"), "w"), separators=(",", ":"))
    print("states", len(st_feats))

    # district raster on analysis grid
    img = Image.new("I", (NCOLS, NROWS), 0)
    dr = ImageDraw.Draw(img)

    def to_px(lon, lat):
        return ((lon - LON_W) / RES, (LAT_N - lat) / RES)

    for d in districts:
        geoms = getattr(d["geom"], "geoms", [d["geom"]])
        for poly in geoms:
            dr.polygon([to_px(x, y) for x, y in poly.exterior.coords], fill=d["id"])
            for hole in poly.interiors:
                dr.polygon([to_px(x, y) for x, y in hole.coords], fill=0)
    raster = np.array(img, dtype=np.int32).astype(np.uint16)
    # tiny districts (e.g. island or city districts) must own at least their representative pixel
    for d in districts:
        rp = d["geom"].representative_point()
        r, c = int((LAT_N - rp.y) / RES), int((rp.x - LON_W) / RES)
        if 0 <= r < NROWS and 0 <= c < NCOLS and not (raster == d["id"]).any():
            raster[r, c] = d["id"]
    np.savez_compressed(os.path.join(ROOT, "data/district_raster.npz"), raster=raster)
    px_area = {}
    ids, counts = np.unique(raster, return_counts=True)
    for i, c in zip(ids, counts):
        px_area[int(i)] = int(c)

    index = []
    for d in districts:
        rp = d["geom"].representative_point()
        index.append({"id": d["id"], "name": d["name"], "state": d["state"], "state_slug": slug(d["state"]),
                      "lat": round(rp.y, 4), "lon": round(rp.x, 4), "bbox": [round(x, 3) for x in d["geom"].bounds],
                      "area_km2": round(area_km2(d["geom"])), "grid_cells": px_area.get(d["id"], 0)})
    json.dump(index, open(os.path.join(ROOT, "data/districts.json"), "w"), separators=(",", ":"))

    # gazetteer
    rows = []
    skip = {"PPLQ", "PPLH", "PPLW", "PPLCH"}
    for line in open(geonames_path, encoding="utf8"):
        f = line.rstrip("\n").split("\t")
        if len(f) < 15 or f[6] != "P" or f[7] in skip:
            continue
        lat, lon = float(f[4]), float(f[5])
        r, c = int((LAT_N - lat) / RES), int((lon - LON_W) / RES)
        if not (0 <= r < NROWS and 0 <= c < NCOLS):
            continue
        did = int(raster[r, c])
        if did == 0:
            win = raster[max(0, r - 2):r + 3, max(0, c - 2):c + 3]
            nz = win[win > 0]
            if nz.size == 0:
                continue
            did = int(np.bincount(nz).argmax())
        pop = int(f[14] or 0)
        code = f[7]
        if code in ("PPLC", "PPLA") or pop >= 100000:
            tier = "city"
        elif pop > 0 or code in ("PPLA2", "PPLA3", "PPLA4"):
            tier = "town"
        else:
            tier = "village"
        rows.append([int(f[0]), f[1], f[2], did, lat, lon, tier, pop, code])
    print("places", len(rows))
    # assign every village to its nearest city/town in the same district
    by_d = {}
    for row in rows:
        by_d.setdefault(row[3], []).append(row)
    town_of = {}
    for did, rs in by_d.items():
        towns = [r for r in rs if r[6] != "village"]
        if not towns:
            continue
        tree = cKDTree(np.array([[t[4], t[5] * math.cos(math.radians(t[4]))] for t in towns]))
        vills = [r for r in rs if r[6] == "village"]
        if vills:
            _, idx = tree.query(np.array([[v[4], v[5] * math.cos(math.radians(v[4]))] for v in vills]))
            for v, k in zip(vills, idx):
                town_of[v[0]] = towns[int(k)][0]

    # compact shipped form: xz-compressed TSV (rebuilt into SQLite with indexes on first run by indra/geo.py)
    import lzma
    T = {"village": "v", "town": "t", "city": "c"}
    out = sorted(rows, key=lambda r: (r[3], r[6], r[0]))
    with lzma.open(os.path.join(ROOT, "data/gazetteer.tsv.xz"), "wt", encoding="utf-8", preset=9 | lzma.PRESET_EXTREME) as f:
        for r in out:
            lc = r[2].lower() if r[2] else r[1].lower()
            f.write("\t".join([str(r[0]), r[1], "" if lc == r[1].lower() else lc, str(r[3]),
                               f"{r[4]:.5f}".rstrip("0").rstrip("."), f"{r[5]:.5f}".rstrip("0").rstrip("."), T[r[6]],
                               str(r[7] or ""), "" if r[8] == "PPL" else (r[8] or ""), str(town_of.get(r[0]) or "")]) + "\n")
    print("done")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
