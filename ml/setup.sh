#!/usr/bin/env bash
# ML sidecar setup — creates ml/.venv, installs the FashionSigLIP stack, and
# downloads the model weights (one-time, ~860 MB to the HuggingFace cache).
#
#   npm run ml:setup
#
# The app is fully functional WITHOUT this — everything degrades to the
# attribute-vector similarity path (docs/ARCHITECTURE.md §7.5 style).
set -euo pipefail
cd "$(dirname "$0")"

# ── pick a python (>=3.10; torch publishes macOS arm64 wheels cp310–cp314) ──
PY="${HEMLINE_ML_PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in python3 python3.13 python3.12 python3.11; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
        PY="$candidate"
        break
      fi
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "error: no python >= 3.10 found (set HEMLINE_ML_PYTHON to override)" >&2
  exit 1
fi
echo "→ using $("$PY" --version 2>&1) at $(command -v "$PY")"

# ── venv + deps ──────────────────────────────────────────────────────────────
if [ ! -x .venv/bin/python ]; then
  echo "→ creating ml/.venv"
  "$PY" -m venv .venv
fi
echo "→ installing requirements (torch + open_clip; first run downloads ~500 MB of wheels)"
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt

# ── download weights + smoke-test the model (embeds one image + one text) ───
echo "→ warming up Marqo/marqo-fashionSigLIP (first run downloads the ~860 MB checkpoint)"
.venv/bin/python embed.py warmup

echo "✓ ml setup complete. Try:  npm run embed"
