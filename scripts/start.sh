#!/usr/bin/env bash
#
# Jarvis — start EVERYTHING with one command:
#
#   npm start                  # all services + voice push-to-talk in this terminal
#   npm start -- --no-voice    # all services only (logs hint printed)
#   npm start -- --no-dashboard
#
# Services (skipped automatically if already healthy on their port):
#   MLX sidecar    127.0.0.1:8088   local Qwen chat + embeddings
#   Voice sidecar  127.0.0.1:8089   STT / VAD / TTS (Kokoro bm_fable, British)
#   Core           127.0.0.1:8080   gateway, chat, memory, agent
#   Dashboard      127.0.0.1:3000   Next.js life-metrics UI
#
# Logs: ~/.jarvis/logs/<service>.log  (only services started by this script)
# Ctrl+C stops every service this script started (pre-existing ones are left alone).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/.jarvis/logs"
mkdir -p "$LOG_DIR"

MLX_URL="http://127.0.0.1:${MLX_SIDECAR_PORT:-8088}"
VOICE_URL="http://127.0.0.1:${VOICE_SIDECAR_PORT:-8089}"
CORE_URL="http://127.0.0.1:${CORE_PORT:-8080}"
DASH_URL="http://127.0.0.1:3000"

WITH_VOICE=1
WITH_DASHBOARD=1
for arg in "$@"; do
  case "$arg" in
    --no-voice) WITH_VOICE=0 ;;
    --no-dashboard) WITH_DASHBOARD=0 ;;
  esac
done

PIDS=()

cleanup() {
  echo ""
  echo "Stopping Jarvis services started by this session…"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  # Give them a moment, then force.
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done
  exit 0
}
trap cleanup INT TERM

healthy() { # healthy <url-path>
  curl -s -m 2 "$1" >/dev/null 2>&1
}

start_service() { # start_service <name> <health-url> <logfile> <cmd...>
  local name="$1" health="$2" logfile="$3"
  shift 3
  if healthy "$health"; then
    echo "  ✓ ${name} already running"
    return 0
  fi
  echo "  ▸ starting ${name}  (log: ${logfile})"
  "$@" >>"$logfile" 2>&1 &
  PIDS+=("$!")
}

wait_healthy() { # wait_healthy <name> <health-url> <timeout-secs>
  local name="$1" health="$2" timeout="$3" waited=0
  printf "  … waiting for %s" "$name"
  until healthy "$health"; do
    sleep 2
    waited=$((waited + 2))
    printf "."
    if [ "$waited" -ge "$timeout" ]; then
      echo ""
      echo "  ✗ ${name} did not become healthy in ${timeout}s — check its log."
      return 1
    fi
  done
  echo " ready"
}

echo "Jarvis — starting all services"
echo ""

start_service "MLX sidecar (local model)" "$MLX_URL/health" "$LOG_DIR/mlx.log" \
  bash "$ROOT/sidecar/mlx/run.sh"
start_service "voice sidecar (STT/TTS)" "$VOICE_URL/health" "$LOG_DIR/voice-sidecar.log" \
  env VOICE_ORCHESTRATOR_URL="${VOICE_ORCHESTRATOR_URL:-$CORE_URL/voice/wake}" \
  bash "$ROOT/sidecar/voice/run.sh"
start_service "core (chat/memory/agent)" "$CORE_URL/healthz" "$LOG_DIR/core.log" \
  npm --prefix "$ROOT" --workspace @jarvis/core run dev
if [ "$WITH_DASHBOARD" -eq 1 ]; then
  start_service "dashboard" "$DASH_URL" "$LOG_DIR/dashboard.log" \
    npm --prefix "$ROOT" --workspace @jarvis/dashboard run dev
fi

echo ""
# Sidecars install deps on first run — allow generous startup windows.
wait_healthy "MLX sidecar" "$MLX_URL/health" 300 || true
wait_healthy "voice sidecar" "$VOICE_URL/health" 600 || true
wait_healthy "core" "$CORE_URL/healthz" 120 || cleanup
if [ "$WITH_DASHBOARD" -eq 1 ]; then
  wait_healthy "dashboard" "$DASH_URL" 120 || true
fi

echo ""
echo "Jarvis is up:"
echo "  chat (text):  npm run chat        dashboard: $DASH_URL"
echo "  logs:         tail -f $LOG_DIR/<service>.log"
echo ""

if [ "$WITH_VOICE" -eq 1 ]; then
  # Voice CLI takes the foreground; Ctrl+C lands in the trap and stops the stack.
  npm --prefix "$ROOT" --workspace @jarvis/core run voice
  cleanup
else
  echo "Running. Ctrl+C stops every service started by this session."
  wait
fi
