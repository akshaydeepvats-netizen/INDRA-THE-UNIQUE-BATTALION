#!/usr/bin/env bash
# INDRA - local start for macOS / Linux: creates .venv, installs requirements, runs the app.
set -e
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
PORT="${PORT:-5000}" exec .venv/bin/python app.py
