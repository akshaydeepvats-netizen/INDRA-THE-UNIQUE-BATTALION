"""Gunicorn config for Render / any PaaS.

One worker process is required: the live engine (radar, satellite, lightning, models, alerts) runs as
background threads inside that process and serves every request from shared memory. Threads give concurrency
for Server-Sent Events and API calls.
"""
import os

bind = f"0.0.0.0:{os.getenv('PORT', '10000')}"
workers = 1
worker_class = "gthread"
threads = int(os.getenv("GUNICORN_THREADS", "24"))
timeout = 120
graceful_timeout = 20
keepalive = 5
accesslog = "-" if os.getenv("ACCESS_LOG", "0") == "1" else None
errorlog = "-"
loglevel = os.getenv("LOG_LEVEL", "info").lower()


def post_worker_init(worker):
    # Start the always-on engine as soon as the worker boots (not on first request).
    from app import ensure_engine
    ensure_engine()
