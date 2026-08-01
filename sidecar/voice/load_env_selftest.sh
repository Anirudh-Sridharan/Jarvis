#!/usr/bin/env bash
#
# Hermetic selftest for load_env.sh (WR-04 / WR-05 regression guard).
#
# No network, no sidecar, no real .env: every scenario writes its own
# fixture file and sources load_env.sh inside a `bash -c 'set -euo pipefail'`
# child with a clean environment (env -i), exactly the way run.sh consumes it.
#
# Asserted:
#   1. Allowlisted keys load: DEEPGRAM_* (quotes stripped), TTS_ENGINE, and
#      JARVIS_ECHO_* (WR-04 — the echo-gate tunables must be loadable
#      through the phase's own loader).
#   2. Anchored strictness (WR-05): FIREWORKS_API_KEY / ANTHROPIC_API_KEY /
#      TTS_ENGINE_EXTRA / JARVIS_ECHO (no suffix) / DEEPGRAM_ (empty suffix)
#      never load.
#   3. Malformed-key hardening (WR-05): "DEEPGRAM_API KEY=…" and
#      "JARVIS_ECHO_BAD-KEY=…" must NOT abort the set -euo pipefail child
#      (exit 0), must not export anything, and must warn on stderr with the
#      KEY only — the value must never appear in output.
#   4. Non-override semantics: a pre-set variable wins over the .env value.
#   5. A missing env file is not an error.
#
# Prints LOAD_ENV_SELFTEST_OK and exits 0 on success; prints the failing
# assertion to stderr and exits non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "LOAD_ENV_SELFTEST FAILED: $*" >&2
  exit 1
}

ENV_FILE="$TMP_DIR/test.env"
cat > "$ENV_FILE" <<'EOF'
# comment line — ignored
DEEPGRAM_API_KEY=dg-selftest-value
DEEPGRAM_MODEL="nova-3"
TTS_ENGINE=aura
JARVIS_ECHO_SIM_THRESHOLD=0.65
JARVIS_ECHO_GATE=0
FIREWORKS_API_KEY=must-never-load
ANTHROPIC_API_KEY=must-never-load
TTS_ENGINE_EXTRA=must-never-load
JARVIS_ECHO=must-never-load
DEEPGRAM_=must-never-load
DEEPGRAM_API KEY=malformed-value-never-printed
JARVIS_ECHO_BAD-KEY=malformed-value-never-printed
EOF

# --- Scenarios 1-3: allowlist + strictness + no-crash, in one strict child ---
OUT_FILE="$TMP_DIR/out.txt"
ERR_FILE="$TMP_DIR/err.txt"
set +e
env -i PATH="$PATH" HOME="${HOME:-/tmp}" JARVIS_ENV_FILE="$ENV_FILE" bash -c '
  set -euo pipefail
  source "'"$SCRIPT_DIR"'/load_env.sh"
  printf "%s\n" \
    "DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}" \
    "DEEPGRAM_MODEL=${DEEPGRAM_MODEL:-}" \
    "TTS_ENGINE=${TTS_ENGINE:-}" \
    "JARVIS_ECHO_SIM_THRESHOLD=${JARVIS_ECHO_SIM_THRESHOLD:-}" \
    "JARVIS_ECHO_GATE=${JARVIS_ECHO_GATE:-}" \
    "FIREWORKS_API_KEY=${FIREWORKS_API_KEY:-}" \
    "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
    "TTS_ENGINE_EXTRA=${TTS_ENGINE_EXTRA:-}" \
    "JARVIS_ECHO=${JARVIS_ECHO:-}" \
    "DEEPGRAM_=${DEEPGRAM_:-}"
' >"$OUT_FILE" 2>"$ERR_FILE"
CHILD_EXIT=$?
set -e

[ "$CHILD_EXIT" -eq 0 ] || fail "strict child exited $CHILD_EXIT — malformed keys crashed the set -euo pipefail parent (WR-05). stderr: $(cat "$ERR_FILE")"

grep -qx 'DEEPGRAM_API_KEY=dg-selftest-value' "$OUT_FILE" || fail "DEEPGRAM_API_KEY did not load"
grep -qx 'DEEPGRAM_MODEL=nova-3' "$OUT_FILE" || fail "DEEPGRAM_MODEL did not load (quote stripping broken)"
grep -qx 'TTS_ENGINE=aura' "$OUT_FILE" || fail "TTS_ENGINE did not load"
grep -qx 'JARVIS_ECHO_SIM_THRESHOLD=0.65' "$OUT_FILE" || fail "JARVIS_ECHO_SIM_THRESHOLD did not load (WR-04)"
grep -qx 'JARVIS_ECHO_GATE=0' "$OUT_FILE" || fail "JARVIS_ECHO_GATE did not load (WR-04)"
grep -qx 'FIREWORKS_API_KEY=' "$OUT_FILE" || fail "FIREWORKS_API_KEY leaked through the allowlist"
grep -qx 'ANTHROPIC_API_KEY=' "$OUT_FILE" || fail "ANTHROPIC_API_KEY leaked through the allowlist"
grep -qx 'TTS_ENGINE_EXTRA=' "$OUT_FILE" || fail "TTS_ENGINE_EXTRA loaded — allowlist is not anchored (WR-05)"
grep -qx 'JARVIS_ECHO=' "$OUT_FILE" || fail "JARVIS_ECHO (no underscore suffix) loaded — allowlist too wide"
grep -qx 'DEEPGRAM_=' "$OUT_FILE" || fail "DEEPGRAM_ (empty suffix) loaded — allowlist too wide"

# Malformed matching keys warn on stderr with the KEY only — never the value.
grep -q 'skipping malformed .env key' "$ERR_FILE" || fail "no malformed-key warning emitted"
grep -q 'DEEPGRAM_API KEY' "$ERR_FILE" || fail "malformed-key warning does not name the key"
if grep -q 'malformed-value-never-printed' "$OUT_FILE" "$ERR_FILE"; then
  fail "a malformed key's VALUE leaked into output"
fi

# --- Scenario 4: non-override — a pre-set variable wins over .env ---
PRESET_OUT="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" JARVIS_ENV_FILE="$ENV_FILE" \
  DEEPGRAM_API_KEY=preset-wins bash -c '
    set -euo pipefail
    source "'"$SCRIPT_DIR"'/load_env.sh" 2>/dev/null
    printf "%s" "${DEEPGRAM_API_KEY:-}"
  ')"
[ "$PRESET_OUT" = "preset-wins" ] || fail "non-override broken: expected preset-wins, got ${PRESET_OUT}"

# --- Scenario 5: missing env file is not an error ---
env -i PATH="$PATH" HOME="${HOME:-/tmp}" JARVIS_ENV_FILE="$TMP_DIR/does-not-exist.env" bash -c '
  set -euo pipefail
  source "'"$SCRIPT_DIR"'/load_env.sh"
' || fail "missing env file aborted the strict child"

echo "LOAD_ENV_SELFTEST_OK"
