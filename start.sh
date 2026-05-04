#!/usr/bin/env bash
# Launch CRYTDL. Runs setup automatically the first time.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ] || [ ! -x .venv/bin/python ]; then
  echo "→ First run — running setup..."
  ./setup.sh
fi

exec .venv/bin/python app.py
