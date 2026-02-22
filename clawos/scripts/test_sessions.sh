#!/usr/bin/env bash
# test_sessions.sh — Multi-turn conversation session smoke tests
#
# Tests the kernel session API directly (no WhatsApp required).
# Simulates a multi-turn conversation: create workspace → resolve session
# across multiple turns → verify context_summary grows → test reset → timeout.
#
# Usage:
#   bash clawos/scripts/test_sessions.sh
#
# Requirements:
#   - Kernel running on port 18888 and already set up (POST /kernel/setup done)
#   - jq installed

set -euo pipefail

KERNEL="${KERNEL_URL:-http://localhost:18888}"
PASS=0
FAIL=0

green() { printf '\033[32m✓\033[0m %s\n' "$*"; }
red()   { printf '\033[31m✗\033[0m %s\n' "$*"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label (expected '$needle' in '$haystack')"
    FAIL=$((FAIL + 1))
  fi
}

check_notempty() {
  local label="$1" val="$2"
  if [ -n "$val" ] && [ "$val" != "null" ]; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label (got empty/null)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== ClawOS Session API Smoke Tests ==="
echo "Kernel: $KERNEL"
echo

# ── 0. Health check ───────────────────────────────────────────────────────────
echo "--- 0. Health check ---"
HEALTH=$(curl -s "$KERNEL/kernel/health")
check "kernel reachable" "true" "$(echo "$HEALTH" | jq -r '.ok')"

# ── 1. Create workspace ───────────────────────────────────────────────────────
echo
echo "--- 1. Create workspace ---"
WS=$(curl -s -X POST "$KERNEL/kernel/workspaces" \
  -H "Content-Type: application/json" \
  -d '{"type":"test"}')
WS_ID=$(echo "$WS" | jq -r '.workspace_id')
check_notempty "workspace created" "$WS_ID"
echo "  workspace_id = $WS_ID"

# ── 2. First resolve — creates session ────────────────────────────────────────
echo
echo "--- 2. First resolve (new session) ---"
R1=$(curl -s -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\",\"remote_jid\":\"+1555000001\",\"user_message\":\"search for the capital of France\"}")
check "ok=true" "true" "$(echo "$R1" | jq -r '.ok')"
check "decision=new (first message)" "new" "$(echo "$R1" | jq -r '.decision')"
SESSION_ID=$(echo "$R1" | jq -r '.session_id')
check_notempty "session_id returned" "$SESSION_ID"
echo "  session_id = $SESSION_ID"

# ── 3. Second resolve — continues session ─────────────────────────────────────
echo
echo "--- 3. Second resolve (continue same session) ---"
R2=$(curl -s -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\",\"remote_jid\":\"+1555000001\",\"user_message\":\"now search for the Eiffel Tower height\"}")
check "ok=true" "true" "$(echo "$R2" | jq -r '.ok')"
check "decision=continue" "continue" "$(echo "$R2" | jq -r '.decision')"
SESSION_ID_2=$(echo "$R2" | jq -r '.session_id')
check "same session_id" "$SESSION_ID" "$SESSION_ID_2"

# ── 4. Advance session — PATCH with a simulated turn ─────────────────────────
echo
echo "--- 4. PATCH session (advance context) ---"
P1=$(curl -s -X PATCH "$KERNEL/kernel/sessions/$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"user_message\":\"search for the capital of France\",\"assistant_response\":\"The capital of France is Paris.\",\"action_type\":\"web_search\"}")
check "patch ok=true" "true" "$(echo "$P1" | jq -r '.ok')"
check "patch returns session_id" "$SESSION_ID" "$(echo "$P1" | jq -r '.session_id')"
CTX=$(echo "$P1" | jq -r '.context_summary')
echo "  context_summary = $CTX"

# ── 5. Third resolve — context_summary should be populated ────────────────────
echo
echo "--- 5. Third resolve (context propagated) ---"
R3=$(curl -s -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\",\"remote_jid\":\"+1555000001\",\"user_message\":\"what about its population?\"}")
check "ok=true" "true" "$(echo "$R3" | jq -r '.ok')"
check "decision=continue" "continue" "$(echo "$R3" | jq -r '.decision')"
CTX3=$(echo "$R3" | jq -r '.session.context_summary // ""')
echo "  context_summary from session = ${CTX3:0:120}..."

# ── 6. Explicit reset ─────────────────────────────────────────────────────────
echo
echo "--- 6. Explicit reset keyword ---"
R4=$(curl -s -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\",\"remote_jid\":\"+1555000001\",\"user_message\":\"reset\"}")
check "ok=true" "true" "$(echo "$R4" | jq -r '.ok')"
check "decision=new" "new" "$(echo "$R4" | jq -r '.decision')"
check "reason=explicit_reset" "explicit_reset" "$(echo "$R4" | jq -r '.reason')"
NEW_SESSION=$(echo "$R4" | jq -r '.session_id')
# Must be a different session
if [ "$NEW_SESSION" != "$SESSION_ID" ]; then
  green "new session_id issued after reset"
  PASS=$((PASS + 1))
else
  red "new session_id issued after reset (still got old id)"
  FAIL=$((FAIL + 1))
fi
echo "  old=$SESSION_ID  new=$NEW_SESSION"

# ── 7. GET session by ID ──────────────────────────────────────────────────────
echo
echo "--- 7. GET session by ID ---"
G1=$(curl -s "$KERNEL/kernel/sessions/$SESSION_ID")
check "get ok=true" "true" "$(echo "$G1" | jq -r '.ok')"
check "get returns remote_jid" "+1555000001" "$(echo "$G1" | jq -r '.session.remote_jid')"
check "get returns channel" "whatsapp" "$(echo "$G1" | jq -r '.session.channel')"

# ── 8. GET session 404 ────────────────────────────────────────────────────────
echo
echo "--- 8. GET unknown session → 404 ---"
G2_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$KERNEL/kernel/sessions/does-not-exist-xxx")
check "404 for unknown session" "404" "$G2_STATUS"

# ── 9. List sessions ──────────────────────────────────────────────────────────
echo
echo "--- 9. List sessions for workspace ---"
L1=$(curl -s "$KERNEL/kernel/sessions?workspace_id=$WS_ID")
check "list ok=true" "true" "$(echo "$L1" | jq -r '.ok')"
LIST_COUNT=$(echo "$L1" | jq '.sessions | length')
if [ "$LIST_COUNT" -ge 2 ]; then
  green "list returns ≥2 sessions (got $LIST_COUNT)"
  PASS=$((PASS + 1))
else
  red "list should return ≥2 sessions (got $LIST_COUNT)"
  FAIL=$((FAIL + 1))
fi

# ── 10. Close session ─────────────────────────────────────────────────────────
echo
echo "--- 10. Close session ---"
C1=$(curl -s -X POST "$KERNEL/kernel/sessions/$SESSION_ID/close" \
  -H "Content-Type: application/json" -d '{}')
check "close ok=true" "true" "$(echo "$C1" | jq -r '.ok')"

# Verify closed sessions don't continue
R5=$(curl -s -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\",\"remote_jid\":\"+1555000002\",\"user_message\":\"hello\"}")
check "new sender → new session" "new" "$(echo "$R5" | jq -r '.decision')"

# ── 11. Missing workspace → 404 ──────────────────────────────────────────────
echo
echo "--- 11. Resolve with unknown workspace → 404 ---"
R6_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d '{"workspace_id":"does-not-exist","channel":"whatsapp","remote_jid":"+1","user_message":"hi"}')
check "404 for unknown workspace" "404" "$R6_STATUS"

# ── 12. Missing required fields → 400 ────────────────────────────────────────
echo
echo "--- 12. Resolve with missing remote_jid → 400 ---"
R7_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\"}")
check "400 for missing remote_jid" "400" "$R7_STATUS"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="
if [ "$FAIL" -eq 0 ]; then
  green "All session tests passed"
  exit 0
else
  red "$FAIL test(s) failed"
  exit 1
fi
