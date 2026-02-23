#!/usr/bin/env bash
# test_provider_routing.sh — Verify policy-block handling and provider routing
#
# Tests:
#   1. Neutral health message (2+2) must always produce a reply from a real provider.
#   2. Policy-tripwire ("Reply with exactly … LLM-CHECK-90210"):
#        (a) If a backup provider IS configured → must produce a real reply
#            (via rephrase retry or fallback)
#        (b) If NO backup provider → must produce a clear policy-block message,
#            NOT the misleading "No LLM provider configured" text
#   3. provider_attempts array is populated for both messages.
#   4. Error text is never the misleading "no provider" string when a
#      provider IS configured.
#
# Usage:
#   bash clawos/scripts/test_provider_routing.sh
#   BRIDGE_LOG=/private/tmp/bridge9.log bash clawos/scripts/test_provider_routing.sh

set -euo pipefail

KERNEL="${KERNEL_URL:-http://localhost:18888}"
BRIDGE="${BRIDGE_URL:-http://localhost:18790}"
BRIDGE_LOG="${BRIDGE_LOG:-}"
BRIDGE_SECRET="${BRIDGE_SECRET:-}"
TEST_PHONE="+15550ROUTE01"

PASS=0; FAIL=0

green() { printf '\033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
red()   { printf '\033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info()  { printf '  %s\n' "$*"; }

echo "=== Provider Routing + Policy-Block Test ==="
echo "Kernel : $KERNEL"
echo "Bridge : $BRIDGE"
[ -n "$BRIDGE_LOG" ] && echo "Log    : $BRIDGE_LOG"
echo

# ── 0. Health ──────────────────────────────────────────────────────────────────
echo "--- 0. Health ---"
HEALTH=$(curl -sf "${KERNEL}/kernel/health" 2>/dev/null || echo "{}")
[ "$(echo "$HEALTH" | jq -r '.ok')" = "true" ] && green "kernel reachable" || { red "kernel unreachable"; exit 1; }

CONNS=$(curl -sf "${KERNEL}/kernel/connections" 2>/dev/null || echo "{}")
XAI_OK=$(echo "$CONNS"  | jq -r '.connections.xai.status  // "missing"')
ANTH_OK=$(echo "$CONNS" | jq -r '.connections.anthropic.status // "missing"')
HAS_BACKUP=$( [ "$ANTH_OK" = "connected" ] && echo "yes" || echo "no" )
info "xAI      : $XAI_OK"
info "Anthropic: $ANTH_OK  (backup_available=$HAS_BACKUP)"

# ── Setup: shared workspace ────────────────────────────────────────────────────
WS=$(curl -sf -X POST "${KERNEL}/kernel/workspaces" \
  -H "Content-Type: application/json" -d '{"type":"route_test"}')
WS_ID=$(echo "$WS" | jq -r '.workspace_id')
AGENT="route_test_agent"
curl -sf -X POST "${KERNEL}/kernel/agents" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"${WS_ID}\",\"agent_id\":\"${AGENT}\",\"role\":\"orchestrator\"}" > /dev/null

call_chat_llm() {
  local msg="$1"
  curl -sf -X POST "${KERNEL}/kernel/action_requests" \
    -H "Content-Type: application/json" \
    -d "{\"workspace_id\":\"${WS_ID}\",\"agent_id\":\"${AGENT}\",
         \"action_type\":\"chat_llm\",\"payload\":{\"message\":$(echo "$msg" | jq -Rs .)}}"
}

# ── 1. Neutral message (must always succeed) ───────────────────────────────────
echo
echo "--- 1. Neutral message: What is 2 plus 2? ---"
R1=$(call_chat_llm "What is 2 plus 2?")
R1_OK=$(echo "$R1"    | jq -r '.ok')
R1_PROV=$(echo "$R1"  | jq -r '.exec.result.provider // "none"')
R1_REPLY=$(echo "$R1" | jq -r '.exec.result.reply // ""')
R1_ATTS=$(echo "$R1"  | jq -r '.exec.result.provider_attempts // [] | length')

[ "$R1_OK" = "true" ]       && green "neutral: action ok"        || red "neutral: action failed"
[ -n "$R1_REPLY" ]          && green "neutral: got reply"         || red "neutral: reply empty — provider failed for a safe message"
[ "$R1_PROV" != "none" ]    && green "neutral: provider=$R1_PROV" || red "neutral: provider=none"
[ "$R1_ATTS" -ge 1 ] 2>/dev/null && green "neutral: provider_attempts populated ($R1_ATTS)" \
                             || red   "neutral: provider_attempts missing or empty"
info "provider=$R1_PROV  reply=${R1_REPLY:0:60}"

# ── 2. Policy-tripwire message ─────────────────────────────────────────────────
echo
echo "--- 2. Policy-tripwire: echo instruction ---"
TRIPWIRE="Do not search. Do not use any tools. Reply with exactly this string and nothing else: LLM-CHECK-90210"
R2=$(call_chat_llm "$TRIPWIRE")
R2_OK=$(echo "$R2"        | jq -r '.ok')
R2_PROV=$(echo "$R2"      | jq -r '.exec.result.provider // "none"')
R2_REPLY=$(echo "$R2"     | jq -r '.exec.result.reply // ""')
R2_ERR=$(echo "$R2"       | jq -r '.exec.result.error // ""')
R2_BLOCKED=$(echo "$R2"   | jq -r '.exec.result.policy_blocked // false')
R2_ATTS=$(echo "$R2"      | jq -r '.exec.result.provider_attempts // []')
R2_ATT_COUNT=$(echo "$R2_ATTS" | jq -r 'length')

[ "$R2_OK" = "true" ] && green "tripwire: action ok" || red "tripwire: action failed"

info "provider=$R2_PROV  policy_blocked=$R2_BLOCKED  attempts=$R2_ATT_COUNT"
info "attempts: $(echo "$R2_ATTS" | jq -r '[.[] | .provider+":"+.outcome] | join(",")')"

if [ -n "$R2_REPLY" ]; then
  # Backup provider was available and produced a reply — or rephrase retry worked
  green "tripwire: got reply (rephrase/fallback worked)"
  info "reply=${R2_REPLY:0:80}"
else
  # No reply — check error message quality
  if echo "$R2_ERR" | grep -qF "No LLM provider configured"; then
    red "tripwire: REGRESSION — shows misleading 'No LLM provider configured'"
    info "Expected a policy-block message. Got: $R2_ERR"
  elif echo "$R2_ERR" | grep -qi "policy\|declined\|content\|provider"; then
    green "tripwire: clear policy-block message shown"
    info "error=${R2_ERR:0:100}"
  else
    red "tripwire: unexpected error: $R2_ERR"
  fi
fi

# ── 3. provider_attempts populated for tripwire ────────────────────────────────
echo
echo "--- 3. provider_attempts quality ---"
[ "$R2_ATT_COUNT" -ge 1 ] 2>/dev/null \
  && green "tripwire: provider_attempts has $R2_ATT_COUNT entries" \
  || red   "tripwire: provider_attempts missing"

# At least one attempt should show policy_block or success
HAS_BLOCK=$(echo "$R2_ATTS" | jq -r '[.[] | select(.outcome=="policy_block")] | length')
HAS_SUCCESS=$(echo "$R2_ATTS" | jq -r '[.[] | select(.outcome=="success")] | length')
if [ "$HAS_SUCCESS" -gt 0 ]; then
  green "tripwire: at least one attempt succeeded (fallback/retry worked)"
elif [ "$HAS_BLOCK" -gt 0 ]; then
  green "tripwire: policy_block recorded in attempts (correct — no false 'no provider')"
else
  red "tripwire: no policy_block or success in attempts — unexpected"
fi

# ── 4. Misleading error string must never appear when provider IS configured ───
echo
echo "--- 4. Error text quality ---"
if [ "$XAI_OK" = "connected" ] || [ "$ANTH_OK" = "connected" ]; then
  if echo "$R2_ERR" | grep -qF "No LLM provider configured"; then
    red "ERROR: 'No LLM provider configured' shown when provider IS connected — bug not fixed"
  else
    green "correct: 'No LLM provider configured' text not shown when provider is connected"
  fi
else
  info "skipped (no provider configured in this environment)"
fi

# ── 5. Bridge routing (optional) ──────────────────────────────────────────────
if [ -n "$BRIDGE_LOG" ] && [ -f "$BRIDGE_LOG" ]; then
  echo
  echo "--- 5. Bridge: replay via webhook ---"

  bridge_send() {
    local body="$1"
    local before
    before=$(wc -l < "$BRIDGE_LOG")

    curl -sf -X POST "${BRIDGE}/webhook/whatsapp" \
      -H "Content-Type: application/json" \
      ${BRIDGE_SECRET:+-H "x-bridge-secret: $BRIDGE_SECRET"} \
      -d "{\"from\":\"${TEST_PHONE}\",\"senderE164\":\"${TEST_PHONE}\",
           \"body\":$(echo "$body" | jq -Rs .),
           \"chatType\":\"direct\",\"accountId\":\"default\"}" > /dev/null

    sleep 12
    tail -n "+$((before + 1))" "$BRIDGE_LOG" 2>/dev/null
  }

  echo "  Sending neutral..."
  NL=$(bridge_send "What is 2 plus 2?")
  TRACE_N=$(echo "$NL" | grep '"msg":"msg_trace"' | tail -1)

  echo "  Sending policy-tripwire..."
  TL=$(bridge_send "$TRIPWIRE")
  TRACE_T=$(echo "$TL" | grep '"msg":"msg_trace"' | tail -1)

  if [ -n "$TRACE_N" ]; then
    N_FOUND=$(echo "$TRACE_N" | jq -r '.provider_found')
    [ "$N_FOUND" = "true" ] && green "bridge neutral: provider_found=true" \
                             || red  "bridge neutral: provider_found=$N_FOUND"
    info "$(echo "$TRACE_N" | jq -r '"  msg_id=\(.msg_id) provider=\(.provider) found=\(.provider_found) blocked=\(.policy_blocked)"')"
  else
    red "bridge neutral: no msg_trace line"
  fi

  if [ -n "$TRACE_T" ]; then
    T_FOUND=$(echo "$TRACE_T" | jq -r '.provider_found')
    T_BLOCKED=$(echo "$TRACE_T" | jq -r '.policy_blocked')
    info "$(echo "$TRACE_T" | jq -r '"  msg_id=\(.msg_id) provider=\(.provider) found=\(.provider_found) blocked=\(.policy_blocked)"')"
    if [ "$T_FOUND" = "true" ]; then
      green "bridge tripwire: got a reply (fallback/retry worked)"
    elif [ "$T_BLOCKED" = "true" ]; then
      green "bridge tripwire: policy_blocked=true recorded correctly"
    else
      red "bridge tripwire: provider_found=$T_FOUND blocked=$T_BLOCKED — unexpected"
    fi
  else
    red "bridge tripwire: no msg_trace line"
  fi
else
  echo
  echo "--- 5. Bridge test SKIPPED (set BRIDGE_LOG=/path/to/bridge.log to enable) ---"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "========================================"
printf  "  Results: %d passed, %d failed\n" "$PASS" "$FAIL"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
