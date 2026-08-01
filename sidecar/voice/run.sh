#!/usr/bin/env bash
#
# Jarvis Voice sidecar launcher.
#
# Creates a Python 3.11+ virtualenv (if missing), installs requirements, and
# execs uvicorn on 127.0.0.1:${VOICE_SIDECAR_PORT:-8089}.
#
# WHY a venv: the system python3 on the target MacBook Air M3 is 3.9.6, which
# is TOO OLD for faster-whisper, kokoro, openwakeword, and silero-vad (all need
# Python >= 3.11).  This script refuses to run until it finds a 3.11+
# interpreter.
#
# Install a suitable Python first, e.g.:
#     brew install python@3.12
#   or with uv:
#     curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12
#
# Also required BEFORE running (macOS):
#     brew install portaudio          # needed by pyaudio (wake word mic capture)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck disable=SC1091
# Allowlisted, non-overriding load of DEEPGRAM_*/TTS_ENGINE/JARVIS_ECHO_*
# from the repo-root .env (see load_env.sh for the allowlist/security
# rationale). Sourced before the venv probe so both the pip step and the
# exec'd uvicorn process see the loaded values.
source "${SCRIPT_DIR}/load_env.sh"

VENV_DIR="${SCRIPT_DIR}/.venv"
PORT="${VOICE_SIDECAR_PORT:-8089}"

# ---------------------------------------------------------------------------
# locate a Python >= 3.11 (probe newest-first)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# create venv if missing
# ---------------------------------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
  PYTHON_BIN="$(find_python)" || {
    echo "" >&2
    echo "ERROR: No Python >= 3.11 found on PATH." >&2
    echo "" >&2
    echo "  The voice sidecar requires Python 3.11+ (faster-whisper, kokoro," >&2
    echo "  openwakeword, silero-vad all need >= 3.11)." >&2
    echo "  The system python3 on this Mac is $(python3 --version 2>&1 || echo 'unknown') — TOO OLD." >&2
    echo "" >&2
    echo "  Install one:" >&2
    echo "    brew install python@3.12" >&2
    echo "    # or:" >&2
    echo "    curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12" >&2
    echo "" >&2
    exit 1
  }
  echo "Creating venv at $VENV_DIR using: $PYTHON_BIN ($("$PYTHON_BIN" --version))"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Guard: reject an old venv created with a now-too-old interpreter.
if ! python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "" >&2
  echo "ERROR: The venv Python is $(python --version) but >= 3.11 is required." >&2
  echo "       Delete $VENV_DIR and re-run with a 3.11+ interpreter on PATH." >&2
  echo "" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# install / upgrade deps
# ---------------------------------------------------------------------------
echo "Installing/verifying voice sidecar dependencies …"
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet

# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------

# Compute the STT engine line and the key-presence word WITHOUT ever naming
# the key's value in an echo/printf line (leak gate: grep for
# echo/printf...DEEPGRAM_API_KEY across this file and load_env.sh must be 0).
if [ -n "${DEEPGRAM_API_KEY:-}" ] && [ "${DEEPGRAM_STT_ENABLED:-}" != "0" ]; then
  STT_ENGINE_LINE="deepgram (${DEEPGRAM_MODEL:-nova-3})"
  DEEPGRAM_KEY_STATUS="set"
else
  STT_ENGINE_LINE="faster-whisper (${STT_MODEL_SIZE:-small})"
  DEEPGRAM_KEY_STATUS="unset"
fi

# TTS engine line mirrors voice_server._configured_tts_engine: aura only when
# TTS_ENGINE (default "aura" — user decision, phase 13.2) asks for it AND a
# key is present; otherwise the Kokoro fallback serves.
if [ "${TTS_ENGINE:-aura}" = "aura" ] && [ -n "${DEEPGRAM_API_KEY:-}" ]; then
  TTS_ENGINE_LINE="aura (${DEEPGRAM_TTS_MODEL:-aura-2-draco-en})"
else
  TTS_ENGINE_LINE="kokoro (${TTS_VOICE:-bm_george:0.7,bf_emma:0.3})"
fi

echo ""
echo "Starting Jarvis Voice sidecar on 127.0.0.1:${PORT}"
echo "  STT engine  : ${STT_ENGINE_LINE}"
echo "  Deepgram key: ${DEEPGRAM_KEY_STATUS}"
echo "  STT model   : ${STT_MODEL_SIZE:-small} (faster-whisper int8)"
echo "  TTS engine  : ${TTS_ENGINE_LINE}"
echo "  Kokoro voice: ${TTS_VOICE:-bm_george:0.7,bf_emma:0.3} (British blend — the automatic fallback voice)"
echo "  Wake model  : ${WAKE_WORD_MODEL:-hey_jarvis} (openWakeWord)"
echo "  Wake thresh : ${WAKE_THRESHOLD:-0.35} (lower = more sensitive)"
echo "  Orchestrator: ${VOICE_ORCHESTRATOR_URL:-http://127.0.0.1:8080/voice/wake}"
echo ""
exec uvicorn voice_server:app \
  --host 127.0.0.1 \
  --port "${PORT}" \
  --log-level info
