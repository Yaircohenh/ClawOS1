#!/usr/bin/env bash
# test_chat_route.sh — Chat LLM Default Route Repro Script
#
# Verifies that:
#   1. The kernel's chat_llm action is registered and callable
#   2. chat_llm returns a real reply from xAI/Anthropic (not help fallback)
#   3. The bridge routes non-tool messages to chat_llm (not help fallback)
#   4. The bridge still routes explicit search to web_search
#   5. "LLM-CHECK-90210" goes to chat_llm
#
# Usage:
#   bash clawos/scripts/test_chat_route.sh
#   BRIDGE_LOG=/private/tmp/bridge6.log bash clawos/scripts/test_chat_route.sh
#
# Requirements:
#   - Kernel running on port 18888 (already set up with xAI or Anthropic key)
#   - Bridge running on port 18790 with DEBUG=true
#   - jq installed

set -euo pipefail

KERNEL="${KERNEL_URL:-http://localhost:18888}"
BRIDGE="${BRIDGE_URL:-http://localhost:18790}"
BRIDGE_LOG="${BRIDGE_LOG:-}"
BRIDGE_SECRET="${BRIDGE_SECRET:-}"
TEST_PHONE="+15550CHAT01"

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

check_notcontains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    red "$label (unexpected '$needle' found in output)"
    FAIL=$((FAIL + 1))
  else
    green "$label"
    PASS=$((PASS + 1))
  fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label (expected '$needle' not found)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== ClawOS Chat LLM Default Route Repro Tests ==="
echo "Kernel: $KERNEL"
echo "Bridge: $BRIDGE"
[ -n "$BRIDGE_LOG" ] && echo "Bridge log: $BRIDGE_LOG"
echo

# ── 0. Health ──────────────────────────────────────────────────────────────────
echo "--- 0. Health check ---"
HEALTH=$(curl -s "$KERNEL/kernel/health")
check "kernel reachable" "true" "$(echo "$HEALTH" | jq -r '.ok')"

# ── 1. Kernel: chat_llm action registered ─────────────────────────────────────
echo
echo "--- 1. Kernel: chat_llm action direct call ---"
WS=$(curl -s -X POST "$KERNEL/kernel/workspaces" \
  -H "Content-Type: application/json" -d '{"type":"test"}')
WS_ID=$(echo "$WS" | jq -r '.workspace_id')
check_notempty "workspace created" "$WS_ID"

AGENT="chat_route_test_agent"
curl -s -X POST "$KERNEL/kernel/agents" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"role\":\"orchestrator\"}" > /dev/null

# Call chat_llm directly on the kernel
CHAT_RES=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"$WS_ID\",
    \"agent_id\":     \"$AGENT\",
    \"action_type\":  \"chat_llm\",
    \"payload\": {
      \"message\": \"Reply with exactly this string and nothing else: LLM-CHECK-90210\"
    }
  }")

CHAT_OK=$(echo "$CHAT_RES"      | jq -r '.ok')
CHAT_PROVIDER=$(echo "$CHAT_RES" | jq -r '.exec.result.provider // "none"')
CHAT_REPLY=$(echo "$CHAT_RES"   | jq -r '.exec.result.reply // ""')

check "chat_llm: action ok"           "true"    "$CHAT_OK"
check_notempty "chat_llm: provider populated" "$CHAT_PROVIDER"
check_notcontains "chat_llm: provider != none"  "none" "$CHAT_PROVIDER"
check_notempty "chat_llm: reply non-empty"    "$CHAT_REPLY"
check_contains "chat_llm: follows instruction (LLM-CHECK-90210 in reply)" \
  "LLM-CHECK-90210" "$CHAT_REPLY"

echo "  provider = $CHAT_PROVIDER"
echo "  reply    = $CHAT_REPLY"

# ── 2. Kernel: chat_llm for ZEBRA-77419 (opaque / unknown token) ──────────────
echo
echo "--- 2. Kernel: chat_llm for opaque message ---"
ZEBRA_RES=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{
    \"workspace_id\": \"$WS_ID\",
    \"agent_id\":     \"$AGENT\",
    \"action_type\":  \"chat_llm\",
    \"payload\": { \"message\": \"ZEBRA-77419\" }
  }")

ZEBRA_OK=$(echo "$ZEBRA_RES"    | jq -r '.ok')
ZEBRA_REPLY=$(echo "$ZEBRA_RES" | jq -r '.exec.result.reply // ""')

check "zebra: chat_llm ok"           "true"     "$ZEBRA_OK"
check_notempty "zebra: reply non-empty"        "$ZEBRA_REPLY"
check_notcontains "zebra: no help fallback text" \
  "I'm not sure what you'd like me to do" "$ZEBRA_REPLY"
check_notcontains "zebra: no 'ask me to search' text" \
  "Try asking me to search" "$ZEBRA_REPLY"

echo "  reply = $ZEBRA_REPLY"

# ── 3. Kernel: risk policy for chat_llm is auto (no approval required) ────────
echo
echo "--- 3. Kernel: chat_llm policy is auto ---"
POLICIES=$(curl -s "$KERNEL/kernel/risk_policies")
CHAT_POLICY=$(echo "$POLICIES" | jq -r '[.[] | select(.action_type=="chat_llm")] | .[0].mode // "missing"')
check "chat_llm risk policy = auto" "auto" "$CHAT_POLICY"

# ── 4. Bridge routing tests (optional — requires BRIDGE_LOG and running bridge) ──
if [ -n "$BRIDGE_LOG" ] && [ -f "$BRIDGE_LOG" ]; then
  echo
  echo "--- 4. Bridge routing: chat_llm default route ---"

  BRIDGE_SECRET_HEADER=""
  if [ -n "$BRIDGE_SECRET" ]; then
    BRIDGE_SECRET_HEADER="-H \"x-bridge-secret: $BRIDGE_SECRET\""
  fi

  # Record line count before sending
  BEFORE_LINES=$(wc -l < "$BRIDGE_LOG")

  # Send LLM-CHECK-90210 message
  curl -s -X POST "$BRIDGE/webhook/whatsapp" \
    -H "Content-Type: application/json" \
    ${BRIDGE_SECRET:+-H "x-bridge-secret: $BRIDGE_SECRET"} \
    -d "{
      \"from\":       \"$TEST_PHONE\",
      \"senderE164\": \"$TEST_PHONE\",
      \"body\":       \"Do not search. Do not use any tools. Reply with exactly this string and nothing else: LLM-CHECK-90210\",
      \"chatType\":   \"direct\",
      \"accountId\":  \"default\"
    }" > /dev/null

  echo "  Waiting 25s for async processing..."
  sleep 25

  # Check new log lines for chat_llm routing
  NEW_LINES=$(tail -n "+$((BEFORE_LINES + 1))" "$BRIDGE_LOG" 2>/dev/null || echo "")

  BRIDGE_CHAT_ROUTE=$(echo "$NEW_LINES" | \
    grep '"msg":"dbg_inbound"' | \
    grep '"router_decision":"chat_llm"' | \
    tail -1)

  if [ -n "$BRIDGE_CHAT_ROUTE" ]; then
    green "bridge: LLM-CHECK-90210 → router_decision=chat_llm"
    PASS=$((PASS + 1))
    PROVIDER_TARGET=$(echo "$BRIDGE_CHAT_ROUTE" | jq -r '.provider_target // "?"')
    MODEL_USED=$(echo "$BRIDGE_CHAT_ROUTE"      | jq -r '.model // "?"')
    echo "  provider_target = $PROVIDER_TARGET"
    echo "  model           = $MODEL_USED"
  else
    red "bridge: LLM-CHECK-90210 did not route to chat_llm"
    echo "  New log lines:"
    echo "$NEW_LINES" | grep '"msg":"dbg_inbound"' | tail -5 || echo "  (none)"
    FAIL=$((FAIL + 1))
  fi

  # Verify no help fallback text appeared
  HELP_FALLBACK=$(echo "$NEW_LINES" | grep -F "I'm not sure what you'd like me to do" || true)
  if [ -z "$HELP_FALLBACK" ]; then
    green "bridge: no help fallback text in log"
    PASS=$((PASS + 1))
  else
    red "bridge: help fallback text found — routing still broken"
    FAIL=$((FAIL + 1))
  fi

  # ── 4b. web_search still routes correctly ────────────────────────────────────
  echo
  echo "--- 4b. Bridge routing: web_search explicit intent ---"
  BEFORE_LINES=$(wc -l < "$BRIDGE_LOG")

  curl -s -X POST "$BRIDGE/webhook/whatsapp" \
    -H "Content-Type: application/json" \
    ${BRIDGE_SECRET:+-H "x-bridge-secret: $BRIDGE_SECRET"} \
    -d "{
      \"from\":       \"$TEST_PHONE\",
      \"senderE164\": \"$TEST_PHONE\",
      \"body\":       \"Search for the latest AI news\",
      \"chatType\":   \"direct\",
      \"accountId\":  \"default\"
    }" > /dev/null

  echo "  Waiting 25s for async processing..."
  sleep 25

  NEW_LINES=$(tail -n "+$((BEFORE_LINES + 1))" "$BRIDGE_LOG" 2>/dev/null || echo "")

  BRIDGE_SEARCH_ROUTE=$(echo "$NEW_LINES" | \
    grep '"msg":"dbg_inbound"' | \
    grep '"router_decision":"web_search"' | \
    tail -1)

  if [ -n "$BRIDGE_SEARCH_ROUTE" ]; then
    green "bridge: 'Search for latest AI news' → router_decision=web_search"
    PASS=$((PASS + 1))
  else
    red "bridge: explicit search did not route to web_search"
    echo "  New log lines:"
    echo "$NEW_LINES" | grep '"msg":"dbg_inbound"' | tail -5 || echo "  (none)"
    FAIL=$((FAIL + 1))
  fi

  # ── 4c. ZEBRA-77419 routes to chat_llm, not help fallback ────────────────────
  echo
  echo "--- 4c. Bridge routing: ZEBRA-77419 → chat_llm ---"
  BEFORE_LINES=$(wc -l < "$BRIDGE_LOG")

  curl -s -X POST "$BRIDGE/webhook/whatsapp" \
    -H "Content-Type: application/json" \
    ${BRIDGE_SECRET:+-H "x-bridge-secret: $BRIDGE_SECRET"} \
    -d "{
      \"from\":       \"$TEST_PHONE\",
      \"senderE164\": \"$TEST_PHONE\",
      \"body\":       \"ZEBRA-77419\",
      \"chatType\":   \"direct\",
      \"accountId\":  \"default\"
    }" > /dev/null

  echo "  Waiting 25s for async processing..."
  sleep 25

  NEW_LINES=$(tail -n "+$((BEFORE_LINES + 1))" "$BRIDGE_LOG" 2>/dev/null || echo "")

  ZEBRA_ROUTE=$(echo "$NEW_LINES" | \
    grep '"msg":"dbg_inbound"' | \
    grep '"router_decision":"chat_llm"' | \
    tail -1)

  if [ -n "$ZEBRA_ROUTE" ]; then
    green "bridge: ZEBRA-77419 → router_decision=chat_llm"
    PASS=$((PASS + 1))
  else
    red "bridge: ZEBRA-77419 did not route to chat_llm"
    echo "  New log lines:"
    echo "$NEW_LINES" | grep '"msg":"dbg_inbound"' | tail -5 || echo "  (none)"
    FAIL=$((FAIL + 1))
  fi
else
  echo
  echo "--- 4. Bridge routing tests SKIPPED (set BRIDGE_LOG=/path/to/bridge.log to enable) ---"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
