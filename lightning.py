"""Live lightning ingestion from the Blitzortung.org community network (websocket).

Blitzortung is a volunteer, non-authoritative network: detection efficiency over India is
lower than over Europe and varies by region. It is not the IMD/IITM lightning network.
Data are used for non-commercial research with attribution to Blitzortung.org contributors."""
import asyncio
import json
import logging
import random
import threading
import time
from collections import deque

import numpy as np

from . import net
from .grid_spec import LAT_N, LAT_S, LON_W, LON_E

log = logging.getLogger("indra.lightning")
STRIKES = deque(maxlen=200000)  # (t_epoch, lat, lon)
_lock = threading.Lock()
STATE = {"connected": False, "host": None, "since": None, "global_rx": 0, "india_rx": 0, "last_strike": None,
         "last_message": None, "error": None}
_listeners = []


def on_strike(cb):
    _listeners.append(cb)


def _decode(b):
    e = {}
    d = list(b)
    c = d[0]
    f = c
    g = [c]
    h = 256
    o = h
    for i in range(1, len(d)):
        a = ord(d[i])
        a = d[i] if h > a else (e[a] if a in e else f + c)
        g.append(a)
        c = a[0]
        e[o] = f + c
        o += 1
        f = a
    return "".join(g)


async def _run():
    import websockets
    hosts = ["ws1", "ws7", "ws8", "ws5", "ws6", "ws3", "ws2"]
    backoff = 3
    while True:
        host = random.choice(hosts[:3]) if STATE["global_rx"] == 0 else hosts[0]
        try:
            async with websockets.connect(f"wss://{host}.blitzortung.org/", open_timeout=15, ping_interval=30,
                                          additional_headers={"Origin": "https://map.blitzortung.org"},
                                          max_size=2 ** 20) as ws:
                await ws.send('{"a":111}')
                STATE.update(connected=True, host=host, since=time.time(), error=None)
                net.feed_mark("lightning", True, detail=f"{host}.blitzortung.org")
                backoff = 3
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=90)
                    try:
                        j = json.loads(_decode(msg))
                    except Exception:  # noqa: BLE001
                        continue
                    STATE["global_rx"] += 1
                    STATE["last_message"] = time.time()
                    lat, lon = j.get("lat"), j.get("lon")
                    if lat is None or lon is None:
                        continue
                    if LAT_S <= lat <= LAT_N and LON_W <= lon <= LON_E:
                        t = j.get("time", time.time() * 1e9) / 1e9
                        with _lock:
                            STRIKES.append((t, float(lat), float(lon)))
                        STATE["india_rx"] += 1
                        STATE["last_strike"] = t
                        for cb in _listeners:
                            try:
                                cb(t, lat, lon)
                            except Exception:  # noqa: BLE001
                                pass
                    if STATE["global_rx"] % 500 == 0:
                        net.feed_mark("lightning", True, detail=f"{host}.blitzortung.org")
        except Exception as exc:  # noqa: BLE001
            STATE.update(connected=False, error=str(exc)[:200])
            net.feed_mark("lightning", False, error=str(exc))
            await asyncio.sleep(backoff)
            backoff = min(120, backoff * 2)


def start():
    def runner():
        asyncio.run(_run())
    th = threading.Thread(target=runner, name="indra-lightning", daemon=True)
    th.start()
    return th


def recent(minutes=60, bbox=None):
    cutoff = time.time() - minutes * 60
    with _lock:
        rows = [s for s in STRIKES if s[0] >= cutoff]
    if bbox:
        s, w, n, e = bbox
        rows = [r for r in rows if s <= r[1] <= n and w <= r[2] <= e]
    return rows


def density(minutes=30, res=0.25):
    rows = recent(minutes)
    nr, nc = int((LAT_N - LAT_S) / res), int((LON_E - LON_W) / res)
    g = np.zeros((nr, nc), dtype=np.int32)
    for _, lat, lon in rows:
        r, c = int((LAT_N - lat) / res), int((lon - LON_W) / res)
        if 0 <= r < nr and 0 <= c < nc:
            g[r, c] += 1
    cells = [{"lat": round(LAT_N - (r + 0.5) * res, 3), "lon": round(LON_W + (c + 0.5) * res, 3), "count": int(g[r, c])}
             for r, c in zip(*np.nonzero(g))]
    cells.sort(key=lambda x: -x["count"])
    return {"res_deg": res, "minutes": minutes, "cells": cells[:400]}


def trend(minutes=120, bin_min=5):
    now = time.time()
    rows = recent(minutes)
    nb = minutes // bin_min
    bins = [0] * nb
    for t, _, _ in rows:
        k = int((now - t) // (bin_min * 60))
        if 0 <= k < nb:
            bins[nb - 1 - k] += 1
    return {"bin_minutes": bin_min, "counts": bins, "end": now}


def count_near(lat, lon, km=25, minutes=15):
    dlat = km / 111.0
    dlon = km / (111.0 * max(0.2, np.cos(np.radians(lat))))
    rows = recent(minutes, (lat - dlat, lon - dlon, lat + dlat, lon + dlon))
    return len(rows)
