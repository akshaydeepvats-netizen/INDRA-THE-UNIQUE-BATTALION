"""Precipitation observations: NASA GIBS — GPM IMERG 30-minute precipitation rate (mm/h).

Replaces the earlier RainViewer radar tiles. IMERG is a multi-satellite (passive-microwave +
geostationary-IR) precipitation estimate at 0.1 deg (~11 km), half-hourly. It is NOT ground radar and
is not IMD DWR. NASA serves the Early run with a latency of roughly 4-6 hours, so INDRA treats IMERG
cells as recent observations (track history, climatology of the day, verification), never as "now".

For compatibility with the cell-scoring code the rain rate R is also expressed as an equivalent
reflectivity via Marshall-Palmer Z = 200 R^1.6 (dBZe). Every dBZe value is labelled ESTIMATED.
"""
import io
import logging
import math
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image
from scipy import ndimage

from . import config, net
from .grid_spec import LAT_N, LAT_S, LON_W, LON_E, RES, NROWS, NCOLS

log = logging.getLogger("indra.radar")
LAYER = config.GIBS_PRECIP_LAYER
PROVIDER = "NASA GIBS · GPM IMERG Early (30-min precipitation rate)"
FRAME_STEP_S = 1800


# ---------------------------------------------------------------- colour map (bundled copy of GIBS v1.3)
def _load_colormap():
    """rgb -> representative rain rate (mm/h, geometric mid of the class)."""
    root = ET.parse(config.DATA_DIR / "gibs_gpm_precipitation_rate_colormap.xml").getroot()
    rgb, val = [], []
    for e in root.iter("ColorMapEntry"):
        if e.get("transparent") == "true" or e.get("nodata") == "true":
            continue
        m = re.match(r"\[([-\d.]+|-INF),([-\d.]+|\+INF)\)", e.get("value", ""))
        if not m:
            continue
        lo = float(m.group(1)) if m.group(1) != "-INF" else 0.05
        hi = float(m.group(2)) if m.group(2) != "+INF" else lo * 1.15
        rgb.append([int(x) for x in e.get("rgb").split(",")])
        val.append(math.sqrt(max(lo, 0.01) * hi))
    order = np.argsort(val)
    return np.array(rgb, dtype=np.float32)[order], np.array(val, dtype=np.float32)[order]


_PAL_RGB, _PAL_MMH = _load_colormap()


def mmh_to_dbz(r):
    return 10 * np.log10(200 * np.power(np.maximum(r, 1e-3), 1.6))


def dbz_to_mmh(dbz):
    return np.power(np.power(10, dbz / 10) / 200, 1 / 1.6)


_PAL_DBZ = mmh_to_dbz(_PAL_MMH).astype(np.float32)  # legacy name kept for callers


# ---------------------------------------------------------------- time domain
def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(s):
    s = s.strip()
    fmt = "%Y-%m-%dT%H:%M:%SZ" if "T" in s else "%Y-%m-%d"
    return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp()


def frames(n=8, layer=None, hours=12, step_s=FRAME_STEP_S, feed="gibs_domains"):
    """Available times for a GIBS layer over the last `hours` from the WMTS DescribeDomains endpoint."""
    layer = layer or LAYER
    now = datetime.now(timezone.utc)
    start = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end = (now + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"{config.GIBS_WMTS_4326}/1.0.0/{layer}/default/2km/all/{start}--{end}.xml"
    data, meta = net.get(url, ttl=240, feed=feed, as_json=False, timeout=25)
    if not data:
        return None, meta
    txt = data.decode("utf-8", "replace")
    m = re.search(r"<Domain>([^<]*)</Domain>", txt)
    times = []
    if m and m.group(1).strip():
        for part in m.group(1).split(","):
            bits = part.strip().split("/")
            try:
                if len(bits) == 3:
                    t0, t1 = _parse_ts(bits[0]), _parse_ts(bits[1])
                    t = t1
                    while t >= t0 and len(times) < 200:
                        times.append(t)
                        t -= step_s
                elif bits[0]:
                    times.append(_parse_ts(bits[0]))
            except ValueError:
                continue
    times = sorted(set(int(t) for t in times))[-n:]
    return {"host": "https://gibs.earthdata.nasa.gov", "layer": layer,
            "frames": [{"time": t, "iso": _iso(t), "path": _iso(t)} for t in times]}, meta


def tile_template(iso, layer=None):
    """EPSG:3857 WMTS tile URL (CORS-enabled) for browser display."""
    return f"{config.GIBS_WMTS_3857}/{layer or LAYER}/default/{iso}/GoogleMapsCompatible_Level6/{{z}}/{{y}}/{{x}}.png"


def himawari_frames(n=12):
    """Himawari-9 AHI band 13 (10.4 um) IR times from GIBS — display layer for the eastern half of India."""
    info, meta = frames(n, layer=config.GIBS_IR_LAYER, hours=4, step_s=600, feed="gibs_himawari")
    if not info:
        return {"status": "UNAVAILABLE", "error": meta.get("error"), "frames": []}
    return {"status": "LIVE" if meta["status"] in ("LIVE", "CACHED") else meta["status"], "layer": config.GIBS_IR_LAYER,
            "frames": [{"time": f["time"], "tiles": tile_template(f["iso"], config.GIBS_IR_LAYER)} for f in info["frames"]],
            "max_native_zoom": 6, "attribution": "Himawari-9 AHI via NASA GIBS (JMA)",
            "notice": "Himawari-9 sits at 140.7°E; India is near the edge of its disk, so the view is oblique west of ~80°E."}


# ---------------------------------------------------------------- decode
def decode_frame(host, iso):
    """Fetch one IMERG frame exactly on the INDRA grid via WMS GetMap and return dBZe (NaN = no rain).

    Returns (dbz, ok, total) with ok/total = 1/1 on success to match the old tile accounting."""
    params = {"SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1", "LAYERS": LAYER, "STYLES": "",
              "SRS": "EPSG:4326", "BBOX": f"{LON_W},{LAT_S},{LON_E},{LAT_N}", "WIDTH": NCOLS, "HEIGHT": NROWS,
              "FORMAT": "image/png", "TRANSPARENT": "TRUE", "TIME": iso}
    data, meta = net.get(config.GIBS_WMS_4326, params=params, ttl=24 * 3600, as_json=False, timeout=60, feed="gibs_imerg")
    if not data or not data[:8].startswith(b"\x89PNG"):
        net.feed_mark("gibs_imerg", False, error=meta.get("error") or "not a PNG (no data for this time)")
        return None, 0, 1
    im = np.array(Image.open(io.BytesIO(data)).convert("RGBA"))
    if im.shape[:2] != (NROWS, NCOLS):
        im = np.array(Image.fromarray(im).resize((NCOLS, NROWS), Image.NEAREST))
    mmh = rgba_to_mmh(im)
    dbz = np.where(np.isfinite(mmh), mmh_to_dbz(mmh), np.nan).astype(np.float32)
    return dbz, 1, 1


def rgba_to_mmh(im):
    out = np.full(im.shape[:2], np.nan, dtype=np.float32)
    m = im[..., 3] > 0
    if m.any():
        rgb = im[m][:, :3].astype(np.float32)
        uniq, inv = np.unique(rgb, axis=0, return_inverse=True)
        d2 = ((uniq[:, None, :] - _PAL_RGB[None, :, :]) ** 2).sum(-1)
        best = d2.argmin(1)
        vals = _PAL_MMH[best]
        vals[d2[np.arange(len(uniq)), best] > 900] = np.nan  # not a colormap colour (e.g. coastline artefact)
        out[m] = vals[inv.ravel()]
    return out


# ---------------------------------------------------------------- analysis
def quality_control(dbz):
    """IMERG has no ground clutter; drop isolated single 0.1-degree specks of light rain only."""
    valid = np.isfinite(dbz) & (dbz >= 20)  # ~0.65 mm/h
    lab, n = ndimage.label(valid)
    if n:
        sizes = ndimage.sum(valid, lab, range(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= 12
        valid = keep[lab]
    return np.where(valid, dbz, np.nan).astype(np.float32)


def detect_cells(dbz, threshold=35.0, min_cells=12):
    """Connected regions >= threshold dBZe (~5.6 mm/h). Returns objects with footprint masks."""
    core = np.isfinite(dbz) & (dbz >= threshold)
    lab, n = ndimage.label(core)
    objs = []
    if not n:
        return objs, lab
    slices = ndimage.find_objects(lab)
    for i, sl in enumerate(slices, start=1):
        m = lab[sl] == i
        cnt = int(m.sum())
        if cnt < min_cells:
            continue
        vals = dbz[sl][m]
        rr, cc = np.nonzero(m)
        w = np.clip(np.nan_to_num(vals - threshold + 1, nan=0), 0, None)
        if w.sum() <= 0:
            w = np.ones_like(w)
        r = sl[0].start + float((rr * w).sum() / w.sum())
        c = sl[1].start + float((cc * w).sum() / w.sum())
        rain = dbz_to_mmh(vals)
        objs.append({"label": i, "slice": (sl[0].start, sl[0].stop, sl[1].start, sl[1].stop), "mask": m,
                     "r": r, "c": c, "lat": LAT_N - (r + 0.5) * RES, "lon": LON_W + (c + 0.5) * RES,
                     "cells": cnt, "max_dbz": float(np.nanmax(vals)), "mean_dbz": float(np.nanmean(vals)),
                     "p90_dbz": float(np.nanpercentile(vals, 90)),
                     "max_mmh": float(np.nanmax(rain)), "p90_mmh": float(np.nanpercentile(rain, 90)),
                     "frac_ge50": float((vals >= 50).mean()), "frac_ge55": float((vals >= 55).mean())})
    return objs, lab


def coarse_mask(field_mask, factor=4):
    h, w = field_mask.shape
    h2, w2 = h // factor, w // factor
    return field_mask[:h2 * factor, :w2 * factor].reshape(h2, factor, w2, factor).any(axis=(1, 3))


def render_rgba(dbz, alpha=230):
    rgba = np.zeros(dbz.shape + (4,), dtype=np.uint8)
    m = np.isfinite(dbz)
    if m.any():
        idx = np.searchsorted(_PAL_MMH, dbz_to_mmh(dbz[m])).clip(0, len(_PAL_MMH) - 1)
        rgba[m, :3] = _PAL_RGB[idx].astype(np.uint8)
        rgba[m, 3] = alpha
    return rgba


def render_png(dbz):
    buf = io.BytesIO()
    Image.fromarray(render_rgba(dbz), "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def ts():
    return time.time()
