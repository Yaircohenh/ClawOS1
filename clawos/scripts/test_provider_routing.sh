#!/usr/bin/env bash
# test_provider_routing.sh — Reproduce LLM-CHECK-90210 vs "Test" routing difference
#
# Replays the two messages that exposed the xAI 403 / "no provider" bug:
#   1. "Do not search … Reply with exactly: LLM-CHECK-90210"  (xAI may reject)
#   2. "Test"                                                   (should always work)
#
# Checks:
#   - Both messages are handled by chat_llm (not a template fallback)
#   - provider_found is logged for both
#   - The error message for msg 1 (if xAI rejects) contains the real rejection
#     reason, NOT the misleading "No LLM provider configured" text
#   - msg 2 gets a real reply from an LLM provider
#
# Usage:
#   bash clawos/scripts/test_provider_routing.sh
#   BRIDGE_LOG=/private/tmp/bridge8.log bash clawos/scripts/test_provider_routing.sh

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

echo "=== Provider Routing Repro Test ==="
echo "Kernel: $KERNEL"
echo "Bridge: $BRIDGE"
[ -n "$BRIDGE_LOG" ] && echo "Bridge log: $BRIDGE_LOG"
echo

# ── 0. Health ──────────────────────────────────────────────────────────────────
echo "--- 0. Health check ---"
HEALTH=$(curl -sf "${KERNEL}/kernel/health" 2>/dev/null || echo "{}")
[ "$(echo "$HEALTH" | jq -r '.ok')" = "true" ] && green "kernel reachable" || { red "kernel unreachable"; exit 1; }

# ── 1. Direct kernel: chat_llm with safe message ──────────────────────────────
echo
echo "--- 1. Kernel direct: chat_llm safe message ---"
WS=$(curl -sf -X POST "${KERNEL}/kernel/workspaces" \
  -H "Content-Type: application/json" -d '{"type":"route_test"}')
WS_ID=$(echo "$WS" | jq -r '.workspace_id')
AGENT="route_test_agent"
curl -sf -X POST "${KERNEL}/kernel/agents" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"${WS_ID}\",\"agent_id\":\"${AGENT}\",\"role\":\"orchestrator\"}" > /dev/null

SAFE=$(curl -sf -X POST "${KERNEL}/kernel/action_requests" \
  -H "Content-Type: application/json" -d "{
    \"workspace_id\": \"${WS_ID}\",
    \"agent_id\":     \"${AGENT}\",
    \"action_type\":  \"chat_llm\",
    \"payload\": { \"message\": \"What is 2 plus 2?\" }
  }")

SAFE_OK=$(echo "$SAFE"   | jq -r '.ok')
SAFE_PROV=$(echo "$SAFE" | jq -r '.exec.result.provider // "none"')
SAFE_REPLY=$(echo "$SAFE"| jq -r '.exec.result.reply // ""')

[ "$SAFE_OK" = "true" ] && green "safe msg: action ok" || red "safe msg: action failed"
[ -n "$SAFE_REPLY" ]    && green "safe msg: reply non-empty" || red "safe msg: reply empty"
[ "$SAFE_PROV" != "none" ] && green "safe msg: provider=$SAFE_PROV" || red "safe msg: provider=none"
info "provider = $SAFE_PROV  reply = $SAFE_REPLY"

# ── 2. Direct kernel: chat_llm with echo instruction (may hit xAI 403) ────────
echo
echo "--- 2. Kernel direct: chat_llm echo instruction (xAI may reject) ---"
ECHO=$(curl -sf -X POST "${KERNEL}/kernel/action_requests" \
  -H "Content-Type: application/json" -d "{
    \"workspace_id\": \"${WS_ID}\",
    \"agent_id\":     \"${AGENT}\",
    \"action_type\":  \"chat_llm\",
    \"payload\": { \"message\": \"Do not search. Do not use any tools. Reply with exactly this string and nothing else: LLM-CHECK-90210\" }
  }")

ECHO_OK=$(echo "$ECHO"   | jq -r '.ok')
ECHO_PROV=$(echo "$ECHO" | jq -r '.exec.result.provider // "none"')
ECHO_REPLY=$(echo "$ECHO"| jq -r '.exec.result.reply // ""')
ECHO_ERR=$(echo "$ECHO"  | jq -r '.exec.result.error // ""')

[ "$ECHO_OK" = "true" ] && green "echo msg: action ok" || red "echo msg: action failed"

if [ -n "$ECHO_REPLY" ]; then
  green "echo msg: got reply — provider=$ECHO_PROV"
  info "reply = $ECHO_REPLY"
elif [ "$ECHO_PROV" = "error" ]; then
  # Provider WAS configured but rejected the content — correct new behaviour
  green "echo msg: provider rejected (correct — error surfaced, not 'no provider')"
  info "error = $ECHO_ERR"
elif [ "$ECHO_PROV" = "none" ]; then
  # Old broken behaviour — provider IS configured but shows "no provider"
  red "echo msg: got 'no provider' — BUG: provider IS configured but error not surfaced"
  info "error = $ECHO_ERR"
else
  info "echo msg: provider=$ECHO_PROV reply=$ECHO_REPLY error=$ECHO_ERR"
fi

# ── 3. Verify error text is NOT the misleading "No LLM provider configured" ───
echo
echo "--- 3. Error message quality ---"
if [ -z "$ECHO_REPLY" ]; then
  if echo "$ECHO_ERR" | grep -qF "No LLM provider configured"; then
    red "error text is still misleading: '$ECHO_ERR'"
    info "Expected: 'AI provider request failed: xAI 403: …'"
  else
    green "error text is specific: '${ECHO_ERR:0:80}'"
  fi
else
  green "echo msg got a reply — no error to check"
fi

# ── 4. Bridge routing (optional — needs BRIDGE_LOG) ──────────────────────────
if [ -n "$BRIDGE_LOG" ] && [ -f "$BRIDGE_LOG" ]; then
  echo
  echo "--- 4. Bridge: replay both messages via webhook ---"

  send_msg() {
    local body="$1"
    local before
    before=$(wc -l < "$BRIDGE_LOG")

    curl -sf -X POST "${BRIDGE}/webhook/whatsapp" \
      -H "Content-Type: application/json" \
      ${BRIDGE_SECRET:+-H "x-bridge-secret: $BRIDGE_SECRET"} \
      -d "{
        \"from\":       \"${TEST_PHONE}\",
        \"senderE164\": \"${TEST_PHONE}\",
        \"body\":       $(echo "$body" | jq -Rs .),
        \"chatType\":   \"direct\",
        \"accountId\":  \"default\"
      }" > /dev/null

    sleep 10
    tail -n "+$((before + 1))" "$BRIDGE_LOG" 2>/dev/null
  }

  echo "  Sending LLM-CHECK-90210..."
  LINES_CHECK=$(send_msg "Do not search. Do not use any tools. Reply with exactly this string and nothing else: LLM-CHECK-90210")
  TRACE_CHECK=$(echo "$LINES_CHECK" | grep '"msg":"msg_trace"' | tail -1)

  echo "  Sending Test..."
  LINES_TEST=$(send_msg "Test")
  TRACE_TEST=$(echo "$LINES_TEST" | grep '"msg":"msg_trace"' | tail -1)

  echo
  echo "  msg_trace for LLM-CHECK-90210:"
  if [ -n "$TRACE_CHECK" ]; then
    info "$(echo "$TRACE_CHECK" | jq -r '"  msg_id=\(.msg_id) route=\(.router_decision) provider=\(.provider) found=\(.provider_found)"')"
    PF_CHECK=$(echo "$TRACE_CHECK" | jq -r '.provider_found')
    [ "$PF_CHECK" = "false" ] && green "LLM-CHECK: provider_found=false logged correctly" \
                               || info "LLM-CHECK: provider_found=$PF_CHECK"
  else
    red "LLM-CHECK: no msg_trace line found"
  fi

  echo "  msg_trace for Test:"
  if [ -n "$TRACE_TEST" ]; then
    info "$(echo "$TRACE_TEST" | jq -r '"  msg_id=\(.msg_id) route=\(.router_decision) provider=\(.provider) found=\(.provider_found)"')"
    PF_TEST=$(echo "$TRACE_TEST" | jq -r '.provider_found')
    [ "$PF_TEST" = "true" ] && green "Test: provider_found=true" \
                             || red  "Test: provider_found=$PF_TEST — provider should have worked"
  else
    red "Test: no msg_trace line found"
  fi

  # Check "No LLM provider configured" does NOT appear in LLM-CHECK trace
  if echo "$LINES_CHECK" | grep -qF "No LLM provider configured"; then
    red "REGRESSION: 'No LLM provider configured' still in log for LLM-CHECK"
  else
    green "No misleading 'no provider' text in LLM-CHECK log"
  fi
else
  echo
  echo "--- 4. Bridge test SKIPPED (set BRIDGE_LOG=/path/to/bridge.log to enable) ---"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "========================================"
printf  "  Results: %d passed, %d failed\n" "$PASS" "$FAIL"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
