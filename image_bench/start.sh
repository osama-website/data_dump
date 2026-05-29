#!/usr/bin/env bash
# start the image_bench server in the foreground. PORT defaults to 8095.
# For a persistent run on login-4 (like tagger), use the setsid pattern from
# ~/Osama/HANDOFF.md §6.
set -euo pipefail
cd "$(dirname "$0")"
PY=/old_Users/sarmad/miniconda3/envs/gemma/bin/python3
export PORT="${PORT:-8095}"
exec "$PY" server.py
