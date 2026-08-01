# Jarvis Voice sidecar — allowlisted, non-overriding repo-root .env loader.
#
# Intended usage: `source`d by run.sh (or any other launcher) BEFORE the
# venv/pip steps, so the loaded values are visible to the exec'd uvicorn
# process. Safe to source from a `set -euo pipefail` parent — this file does
# NOT set its own `-e`/`-u` and never traces (`set -x` is never enabled here).
#
# Why this exists (and why it is NOT a general dotenv loader):
#   Nothing in the Python sidecar currently reads the repo-root .env (unlike
#   core, which imports loadEnv.js). Sourcing the *whole* .env file naively
#   would inject every secret it contains — FIREWORKS_API_KEY, ANTHROPIC_API_KEY,
#   BRAVE_API_KEY, SIMPLEFIN_ACCESS_URL, OAuth client secrets — into a
#   long-running Python process that only ever needs DEEPGRAM_*/TTS_ENGINE.
#   The allowlist regex below is the security control (T-13.2-02).
#
# Resolution:
#   - JARVIS_ENV_FILE, if set, names the .env file to load.
#   - Otherwise: <repo root>/.env, where repo root is two directories above
#     this script (sidecar/voice -> sidecar -> <root>), resolved the same way
#     run.sh resolves SCRIPT_DIR.
#   - A missing or unreadable file is NOT an error: this function returns 0
#     silently (env may be provided some other way — same "missing .env is
#     fine" rule as services/core/src/loadEnv.ts).
#
# Non-override semantics (mirrors loadEnv.ts): a variable already set and
# non-empty in the current environment is left untouched — explicit shell
# exports and test-injected vars always win over the .env value.
#
# Parsing rules (deliberately narrow):
#   - Line-by-line. Blank lines and lines whose first non-space char is `#`
#     are skipped.
#   - A line is only honoured when its KEY matches the allowlist regex
#     ^(DEEPGRAM_[A-Z0-9_]+|TTS_ENGINE)$ — everything else in .env is ignored.
#   - Split on the FIRST `=` only (values, e.g. API keys, may contain `=`).
#   - One layer of surrounding single or double quotes is stripped from the
#     value. No expansion, no command substitution, no `eval`, and the .env
#     file itself is never `source`d — a crafted .env line cannot execute
#     shell code via this loader (T-13.2-03).
#   - Values are never echoed, logged, or traced.

_jarvis_load_env() {
  local env_file="${JARVIS_ENV_FILE:-}"

  if [ -z "$env_file" ]; then
    local _load_env_script_dir
    _load_env_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # sidecar/voice -> sidecar -> <repo root>
    env_file="$(cd "${_load_env_script_dir}/../.." && pwd)/.env"
  fi

  if [ ! -f "$env_file" ] || [ ! -r "$env_file" ]; then
    return 0
  fi

  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines.
    case "$line" in
      '') continue ;;
    esac

    # Skip comment lines (first non-space char is '#').
    local trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      '#'*) continue ;;
    esac

    # Must contain an '='.
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"

    # Trim surrounding whitespace from the key only (values are taken as-is
    # apart from quote stripping below).
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"

    # Allowlist gate: only DEEPGRAM_* or TTS_ENGINE keys are honoured.
    case "$key" in
      DEEPGRAM_[A-Z0-9_]*|TTS_ENGINE) ;;
      *) continue ;;
    esac

    # Strip one layer of surrounding single or double quotes from the value.
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac

    # Non-override: leave a pre-set, non-empty value untouched.
    if [ -n "${!key:-}" ]; then
      continue
    fi

    export "$key=$value"
  done < "$env_file"

  return 0
}

_jarvis_load_env
unset -f _jarvis_load_env
