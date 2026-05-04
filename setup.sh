#!/usr/bin/env bash
# One-time setup: builds a self-contained Python venv and grabs ffmpeg.
# Re-running is safe — it skips work that's already done.

set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "✖ Python 3 not found. Install Python 3.10+ first." >&2
  exit 1
fi

if [ ! -d .venv ]; then
  echo "→ Creating virtual environment in ./.venv"
  "$PY" -m venv .venv
fi

echo "→ Installing Python dependencies"
.venv/bin/python -m pip install --upgrade pip wheel >/dev/null
.venv/bin/python -m pip install -r requirements.txt

echo "→ Setting up ffmpeg"
.venv/bin/python setup_ffmpeg.py

echo ""
echo "  ✓ Setup complete. Run ./start.sh to launch CRYTDL."
