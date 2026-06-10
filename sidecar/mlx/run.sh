#!/usr/bin/env bash
#
# Jarvis MLX sidecar launcher.
#
# Creates a Python 3.11+ virtualenv (if missing), installs requirements, and
# execs uvicorn on 127.0.0.1:${MLX_SIDECAR_PORT:-8088}.
#
# WHY a venv: the system python3 on the target MacBook Air M3 is 3.9, which is
# TOO OLD for current mlx-lm (needs Python >= 3.11). This script refuses to run
# until it finds a 3.11+ interpreter.
#
# Install a suitable Python first, e.g.:
#     brew install python@3.12
#   or with uv:
#     curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="${SCRIPT_DIR}/.venv"
PORT="${MLX_SIDECAR_PORT:-8088}"

# --- locate a Python >= 3.11 -------------------------------------------------
# Probe common interpreter names, newest first, and verify the version.
find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
        command -v "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

# --- create venv if missing --------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
  PYTHON_BIN="$(find_python)" || {
    echo "ERROR: no Python >= 3.11 found on PATH." >&2
    echo "       Current mlx-lm requires Python 3.11+. The system python3 is too old." >&2
    echo "       Install one, e.g.:  brew install python@3.12   (or use uv)" >&2
    exit 1
  }
  echo "Creating venv at $VENV_DIR using: $PYTHON_BIN ($($PYTHON_BIN --version))"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Guard again in case an old venv was created with a now-too-old interpreter.
if ! python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "ERROR: venv Python is $(python --version) but >= 3.11 is required." >&2
  echo "       Delete $VENV_DIR and re-run with a 3.11+ interpreter on PATH." >&2
  exit 1
fi

# --- install deps ------------------------------------------------------------
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

# --- serve -------------------------------------------------------------------
echo "Starting Jarvis MLX sidecar on 127.0.0.1:${PORT}"
exec uvicorn mlx_server:app --host 127.0.0.1 --port "${PORT}"
