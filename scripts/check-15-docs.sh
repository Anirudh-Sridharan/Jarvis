#!/usr/bin/env bash
#
# check-15-docs.sh — documentation completeness gate for Phase 15 (Mac
# control tools — gated computer use). Greps the live-verification runbook
# for its eight required section headings and six live-verified failure
# signatures, and CLAUDE.md for the Mac-control tool surface/gating
# vocabulary — printing every missing string and exiting non-zero if any
# are absent. A doc task with no automated check is a doc task that
# silently rots (15-06-PLAN.md Task 3).
#
#   bash scripts/check-15-docs.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNBOOK="$ROOT/.planning/phases/15-mac-control-tools-gated-computer-use/15-LIVE-VERIFY-RUNBOOK.md"
CLAUDE_MD="$ROOT/CLAUDE.md"

MISSING=0

check_in_file() {
  local file="$1"
  local needle="$2"
  if [ ! -f "$file" ]; then
    echo "MISSING (file not found): $file"
    MISSING=1
    return
  fi
  if ! grep -qF -- "$needle" "$file"; then
    echo "MISSING: \"$needle\" not found in $file"
    MISSING=1
  fi
}

echo "Checking $RUNBOOK ..."
check_in_file "$RUNBOOK" "## Preconditions"
check_in_file "$RUNBOOK" "## Step 1"
check_in_file "$RUNBOOK" "## Step 2"
check_in_file "$RUNBOOK" "## Step 3"
check_in_file "$RUNBOOK" "## Step 4"
check_in_file "$RUNBOOK" "## Step 5"
check_in_file "$RUNBOOK" "## Evidence to record"
check_in_file "$RUNBOOK" "## Known live-verified failure signatures"
check_in_file "$RUNBOOK" "-25211"
check_in_file "$RUNBOOK" "-1712"
check_in_file "$RUNBOOK" "-1743"
# 15 IN-01: the two signatures this machine actually emits, which the original
# four-needle list did not cover.
check_in_file "$RUNBOOK" "-1719"
check_in_file "$RUNBOOK" "osascript is not allowed to send keystrokes."
check_in_file "$RUNBOOK" "could not create image from display"

echo "Checking $CLAUDE_MD ..."
check_in_file "$CLAUDE_MD" "mac_action"
check_in_file "$CLAUDE_MD" "mac_open"
check_in_file "$CLAUDE_MD" "mac_ui_snapshot"
check_in_file "$CLAUDE_MD" "computer_screenshot"
check_in_file "$CLAUDE_MD" "JARVIS_MAC_TOOLS"
check_in_file "$CLAUDE_MD" "mac-doctor"
check_in_file "$CLAUDE_MD" "AXSecureTextField"

if [ "$MISSING" -ne 0 ]; then
  echo ""
  echo "FAILED: one or more required strings are missing (see above)."
  exit 1
fi

echo ""
echo "OK: all required headings/signatures/vocabulary present."
exit 0
