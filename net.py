"""HTTP access with a small TTL cache and per-feed health accounting."""
import json
import logging
import threading
import time

import requests
from requests.adapters import HTTPAdapter

from . import config

log = logging.getLogger("indra.net")
_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT})
_session.mount("https://", HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=1))
_lock = threading.Lock()
_cache = {}
FEEDS = {}  # feed name -> health record


def utcnow_ts():
    return time.time()


def feed_mark(name, ok, latency_ms=None, error=None, detail=None):
    with _lock:
        rec = FEEDS.setdefault(name, {"name": name, "ok": 0, "fail": 0, "last_ok": None, "last_error": None,
                                      "last_error_at": None, "latency_ms": None})
        if ok:
            rec["ok"] += 1
            rec["last_ok"] = time.time()
            rec["latency_ms"] = latency_ms
        else:
            rec["fail"] += 1
            rec["last_error"] = (error or "error")[:240]
            rec["last_error_at"] = time.time()
        if detail is not None:
            rec["detail"] = detail


def _key(url, params):
    return url + "?" + json.dumps(params or {}, sort_keys=True)


def get(url, params=None, ttl=0, feed=None, as_json=True, timeout=None, headers=None):
    """Return (data, meta). Uses cached copy if fresh; returns a stale copy (flagged) on failure."""
    k = _key(url, params) + ("#j" if as_json else "#b")
    now = time.time()
    with _lock:
        hit = _cache.get(k)
    if hit and ttl and now - hit[0] < ttl:
        return hit[1], {"status": "CACHED", "fetched_at": hit[0]}
    t0 = time.time()
    try:
        r = _session.get(url, params=params, timeout=timeout or config.HTTP_TIMEOUT, headers=headers)
        r.raise_for_status()
        data = r.json() if as_json else r.content
        with _lock:
            _cache[k] = (time.time(), data)
            if len(_cache) > 4000:
                for old in sorted(_cache, key=lambda x: _cache[x][0])[:1000]:
                    _cache.pop(old, None)
        if feed:
            feed_mark(feed, True, round((time.time() - t0) * 1000))
        return data, {"status": "LIVE", "fetched_at": time.time()}
    except (requests.RequestException, ValueError) as exc:
        if feed:
            feed_mark(feed, False, error=str(exc))
        log.warning("fetch failed %s: %s", url[:120], str(exc)[:200])
        if hit:
            return hit[1], {"status": "STALE", "fetched_at": hit[0], "error": str(exc)[:200]}
        return None, {"status": "UNAVAILABLE", "fetched_at": None, "error": str(exc)[:200]}


def post(url, data=None, feed=None, timeout=None):
    t0 = time.time()
    try:
        r = _session.post(url, data=data, timeout=timeout or config.HTTP_TIMEOUT)
        r.raise_for_status()
        if feed:
            feed_mark(feed, True, round((time.time() - t0) * 1000))
        return r.json(), {"status": "LIVE", "fetched_at": time.time()}
    except (requests.RequestException, ValueError) as exc:
        if feed:
            feed_mark(feed, False, error=str(exc))
        return None, {"status": "UNAVAILABLE", "error": str(exc)[:200]}
