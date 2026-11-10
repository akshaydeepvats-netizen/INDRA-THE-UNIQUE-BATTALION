"""Satellite ingestion: EUMETSAT Meteosat (Indian Ocean Data Coverage, 45.5E) SEVIRI IR10.8.

The WMS service returns an 8-bit rendered image, not calibrated radiances. INDRA converts
the grey level to an ESTIMATED brightness temperature with a documented linear stretch
(310 K at count 0 -> 200 K at count 255). Thresholds therefore carry uncertainty of a few K.
INSAT-3D/3DR (MOSDAC) requires registered access and is reported as such."""
import io
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image
from scipy import ndimage

from . import config, net
from .grid_spec import LAT_N, LAT_S, LON_W, LON_E, RES, NROWS, NCOLS

log = logging.getLogger("indra.sat")
BT_WARM, BT_COLD = 310.0, 200.0


def count_to_bt(count):
    return BT_WARM - count.astype(np.float32) * (BT_WARM - BT_COLD) / 255.0


def latest_times(n=3):
    """Read the time dimension of the IR10.8 layer from WMS capabilities."""
    url = config.EUMETSAT_WMS
    params = {"service": "WMS", "request": "GetCapabilities", "version": "1.3.0"}
    data, meta = net.get(url, params=params, ttl=240, as_json=False, feed="satellite_index", timeout=40)
    if not data:
        return None, meta
    txt = data.decode("utf8", "ignore")
    i = txt.find(f"<Name>{config.SAT_LAYER.split(':')[1]}</Name>", txt.find("msg_iodc"))
    # find the block for the configured layer
    j = txt.find(f"<Name>{config.SAT_LAYER}</Name>")
    seg = txt[j:j + 6000] if j >= 0 else txt[i:i + 6000]
    m = re.search(r'<Dimension name="time"[^>]*>([^<]*)</Dimension>', seg)
    if not m:
        return None, {"status": "UNAVAILABLE", "error": "time dimension not found"}
    spec = m.group(1).strip().split(",")[-1]
    parts = spec.split("/")
    end = datetime.strptime(parts[1] if len(parts) > 1 else parts[0], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    step = 15
    times = [end - timedelta(minutes=step * k) for k in range(n)][::-1]
    return times, meta


def fetch_frame(when, layer=None, width=NCOLS, height=NROWS):
    params = {"service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": layer or config.SAT_LAYER,
              "styles": "", "crs": "EPSG:4326", "bbox": f"{LAT_S},{LON_W},{LAT_N},{LON_E}",
              "width": width, "height": height, "format": "image/png",
              "time": when.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    data, meta = net.get(config.EUMETSAT_WMS, params=params, ttl=6 * 3600, as_json=False, feed="satellite_ir108", timeout=60)
    if not data:
        return None
    try:
        im = Image.open(io.BytesIO(data)).convert("L")
        if im.size != (NCOLS, NROWS):
            im = im.resize((NCOLS, NROWS))
        arr = np.array(im)
        if arr.max() == 0:
            return None
        return arr
    except Exception as exc:  # noqa: BLE001
        net.feed_mark("satellite_ir108", False, error=f"decode: {exc}")
        return None


def detect_cold_clouds(bt, threshold=235.0, core=221.0, min_cells=25):
    """Cold-cloud (deep convection candidate) objects. Returns objects with footprint masks."""
    cold = bt <= threshold
    cold = ndimage.binary_opening(cold, structure=np.ones((3, 3)))
    lab, n = ndimage.label(cold)
    objs = []
    if not n:
        return objs
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        m = lab[sl] == i
        cnt = int(m.sum())
        if cnt < min_cells:
            continue
        vals = bt[sl][m]
        rr, cc = np.nonzero(m)
        w = (threshold - vals) + 1
        r = sl[0].start + float((rr * w).sum() / w.sum())
        c = sl[1].start + float((cc * w).sum() / w.sum())
        objs.append({"slice": (sl[0].start, sl[0].stop, sl[1].start, sl[1].stop), "mask": m,
                     "r": r, "c": c, "lat": LAT_N - (r + 0.5) * RES, "lon": LON_W + (c + 0.5) * RES,
                     "cells": cnt, "min_bt": float(vals.min()), "mean_bt": float(vals.mean()),
                     "core_cells": int((vals <= core).sum()), "frac_core": float((vals <= core).mean())})
    return objs


def ts():
    return time.time()


# ---------------------------------------------------------------- display overlays (proxied + cached)
DISPLAY_LAYERS = {"msg_iodc:ir108", "msg_iodc:rgb_convection", "msg_iodc:rgb_airmass", "msg_iodc:cth",
                  "msg_iodc:wv062", "msg_iodc:vis006", "msg_iodc:gii_liftedindex", "msg_iodc:h63"}
_disp_locks = {}
_disp_guard = threading.Lock()
_disp_cache = {}


def _merc(lat, lon):
    import math
    R = 6378137.0
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def display_png(layer, time_iso, width=760, height=800):
    """Web-Mercator PNG of a EUMETSAT layer for the map. Cached for 6 h so loops are instant for every user."""
    if layer not in DISPLAY_LAYERS:
        return None, {"status": "UNAVAILABLE", "error": "unknown layer"}
    x0, y0 = _merc(LAT_S, LON_W)
    x1, y1 = _merc(LAT_N, LON_E)
    params = {"service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": layer, "styles": "",
              "crs": "EPSG:3857", "bbox": f"{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}", "width": width, "height": height,
              "format": "image/png", "transparent": "true"}
    if time_iso:
        params["time"] = time_iso
    key = layer + "|" + (time_iso or "")
    with _disp_guard:
        lk = _disp_locks.setdefault(key, threading.Lock())
        if len(_disp_locks) > 500:
            _disp_locks.clear()
    with lk:  # one upstream request per frame even if many browsers ask at once
        hit = _disp_cache.get(key)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1], {"status": "CACHED"}
        data, meta = net.get(config.EUMETSAT_WMS, params=params, ttl=0, as_json=False, feed="satellite_display", timeout=90)
        if not data:
            return (hit[1], {"status": "STALE"}) if hit else (None, meta)
        try:  # palette PNG: ~3x smaller, visually identical for these products
            im = Image.open(io.BytesIO(data)).convert("RGBA")
            out = io.BytesIO()
            im.quantize(colors=128, method=Image.Quantize.FASTOCTREE).save(out, format="PNG", optimize=True)
            data = out.getvalue()
        except Exception:  # noqa: BLE001
            pass
        _disp_cache[key] = (time.time(), data)
        for k in sorted(_disp_cache, key=lambda x: _disp_cache[x][0])[:-60]:
            _disp_cache.pop(k, None)
        return data, meta
