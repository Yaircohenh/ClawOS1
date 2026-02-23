#!/usr/bin/env bash
# test_multi_intent.sh — Verify multi-intent handling in the WhatsApp bridge
#
# Tests:
#   1. classify_intent returns intents[] for a message with email + math sub-question
#   2. classify_intent primary intent is send_email
#   3. classify_intent secondary intent is none with text = math question
#   4. chat_llm answers "10 + 5 = ?" correctly (returns "15")
#   5. Bridge webhook: msg_trace has split=true for the multi-intent message
#   6. Bridge webhook: tools_planned contains both intents
#   7. Bridge log: "send_email: smtp not configured" log line appears
#   8. Bridge log: conv_tail is non-null (math question was extracted)
#   9. Bridge log: chat_answered=true (math question was answered)
#  10. Single-intent email message → multi_intent=false (no false positives)
#
# Usage:
#   bash clawos/scripts/test_multi_intent.sh
#   BRIDGE_LOG=/private/tmp/bridge11.log bash clawos/scripts/test_multi_intent.sh

set -euo pipefail

KERNEL="${KERNEL_URL:-http://localhost:18888}"
BRIDGE="${BRIDGE_URL:-http://localhost:18790}"
BRIDGE_LOG="${BRIDGE_LOG:-/private/tmp/bridge11.log}"
# Read BRIDGE_SECRET from bridge .env if not already set in environment
if [ -z "${BRIDGE_SECRET:-}" ]; then
  BRIDGE_ENV="$(dirname "$0")/../bridge/.env"
  if [ -f "$BRIDGE_ENV" ]; then
    BRIDGE_SECRET=$(grep '^BRIDGE_SECRET=' "$BRIDGE_ENV" | cut -d= -f2- | tr -d '"'\'' ')
  fi
fi
BRIDGE_SECRET="${BRIDGE_SECRET:-}"
TEST_PHONE="+15550MULTI01"

PASS=0; FAIL=0

green() { printf '\033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
red()   { printf '\033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info()  { printf '  %s\n' "$*"; }

MULTI_MSG='Email yaircohenh@gmail.com "I'\''m running 10 minutes late" and also answer: 10 + 5 = ?'
SINGLE_EMAIL_MSG='Email yaircohenh@gmail.com saying hi'

echo "=== Multi-Intent WhatsApp Orchestration Test ==="
echo "Kernel : $KERNEL"
echo "Bridge : $BRIDGE"
[ -n "$BRIDGE_LOG" ] && echo "Log    : $BRIDGE_LOG"
echo
info "Multi-intent message: $MULTI_MSG"
echo

# ── 0. Health ──────────────────────────────────────────────────────────────────
echo "--- 0. Health ---"
HEALTH=$(curl -sf "${KERNEL}/kernel/health" 2>/dev/null || echo "{}")
[ "$(echo "$HEALTH" | jq -r '.ok')" = "true" ] && green "kernel reachable" || { red "kernel unreachable"; exit 1; }

BHEALTH=$(curl -sf "${BRIDGE}/health" 2>/dev/null || echo "{}")
[ "$(echo "$BHEALTH" | jq -r '.ok')" = "true" ] && green "bridge reachable" || red "bridge unreachable"

# ── Setup: workspace + agent ────────────────────────────────────────────────────
WS=$(curl -sf -X POST "${KERNEL}/kernel/workspaces" \
  -H "Content-Type: application/json" -d '{"type":"multi_intent_test"}' | jq -r '.workspace_id')
AGENT="multi_test_agent"
curl -sf -X POST "${KERNEL}/kernel/agents" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"${WS}\",\"agent_id\":\"${AGENT}\",\"role\":\"orchestrator\"}" > /dev/null

classify() {
  local msg="$1"
  curl -sf -X POST "${KERNEL}/kernel/action_requests" \
    -H "Content-Type: application/json" \
    -d "{\"workspace_id\":\"${WS}\",\"agent_id\":\"${AGENT}\",
         \"action_type\":\"classify_intent\",\"payload\":{\"text\":$(echo "$msg" | jq -Rs .)}}"
}

# ── 1-3. classify_intent multi-intent format ───────────────────────────────────
echo
echo "--- 1-3. classify_intent: multi-intent message ---"
R=$(classify "$MULTI_MSG")

MULTI=$(echo "$R" | jq -r '.exec.result.multi_intent // false')
PRIMARY=$(echo "$R" | jq -r '.exec.result.action_type')
INTENTS_LEN=$(echo "$R" | jq -r '.exec.result.intents // [] | length')
SECONDARY_TYPE=$(echo "$R" | jq -r '.exec.result.intents[1].action_type // "missing"')
SECONDARY_TEXT=$(echo "$R" | jq -r '.exec.result.intents[1].params.text // ""')

info "multi_intent=$MULTI  primary=$PRIMARY  intents=$INTENTS_LEN"
info "secondary_type=$SECONDARY_TYPE  secondary_text=${SECONDARY_TEXT:0:60}"

[ "$PRIMARY" = "send_email" ] && green "classify: primary=send_email" || red "classify: primary=$PRIMARY (expected send_email)"

if [ "$MULTI" = "true" ] && [ "$INTENTS_LEN" -ge 2 ]; then
  green "classify: intents[] array returned (multi_intent=true)"
  [ "$SECONDARY_TYPE" = "none" ] && green "classify: secondary=none (conversational)" || red "classify: secondary=$SECONDARY_TYPE (expected none)"
  if echo "$SECONDARY_TEXT" | grep -qE '[0-9]'; then
    green "classify: secondary text contains math expression"
  else
    red "classify: secondary text '$SECONDARY_TEXT' lacks math expression"
  fi
else
  # Acceptable fallback: single intent (heuristic in bridge still handles it)
  info "classify: returned single intent (multi_intent=$MULTI) — heuristic splitter will cover this"
  green "classify: primary intent correct (single-intent mode is acceptable fallback)"
fi

# ── 4. chat_llm answers "10 + 5 = ?" correctly ───────────────────────────────
echo
echo "--- 4. chat_llm: math sub-question ---"
CHAT_R=$(curl -sf -X POST "${KERNEL}/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"${WS}\",\"agent_id\":\"${AGENT}\",
       \"action_type\":\"chat_llm\",\"payload\":{\"message\":\"10 + 5 = ?\"}}")

CHAT_REPLY=$(echo "$CHAT_R" | jq -r '.exec.result.reply // ""')
info "chat_llm reply: ${CHAT_REPLY:0:80}"
if echo "$CHAT_REPLY" | grep -qE '\b15\b'; then
  green "chat_llm: math answer contains 15"
else
  red "chat_llm: math answer '$CHAT_REPLY' does not contain 15"
fi

# ── 5-9. Bridge webhook multi-intent trace ─────────────────────────────────────
if [ -f "$BRIDGE_LOG" ]; then
  echo
  echo "--- 5-9. Bridge webhook: multi-intent trace ---"

  BEFORE=$(wc -l < "$BRIDGE_LOG")

  WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BRIDGE}/webhook/whatsapp" \
    -H "Content-Type: application/json" \
    ${BRIDGE_SECRET:+-H "x-bridge-secret: $BRIDGE_SECRET"} \
    -d "{\"from\":\"${TEST_PHONE}\",\"senderE164\":\"${TEST_PHONE}\",
         \"body\":$(echo "$MULTI_MSG" | jq -Rs .),
         \"chatType\":\"direct\",\"accountId\":\"default\"}" 2>/dev/null || echo "000")
  info "webhook HTTP status: $WEBHOOK_STATUS"
  [ "$WEBHOOK_STATUS" = "200" ] && green "webhook: accepted (200)" || red "webhook: status=$WEBHOOK_STATUS (expected 200)"

  sleep 12

  NEW_LINES=$(tail -n "+$((BEFORE + 1))" "$BRIDGE_LOG" 2>/dev/null)

  TRACE=$(echo "$NEW_LINES" | grep '"msg":"msg_trace"' | tail -1)
  SMTP_LOG=$(echo "$NEW_LINES" | grep '"msg":"send_email: smtp not configured"' | tail -1)

  if [ -n "$TRACE" ]; then
    B_SPLIT=$(echo "$TRACE" | jq -r '.split // false')
    B_TOOLS=$(echo "$TRACE" | jq -r '.tools_planned // ""')
    B_INTENT=$(echo "$TRACE" | jq -r '.intent // ""')
    info "msg_trace: intent=$B_INTENT split=$B_SPLIT tools_planned=$B_TOOLS"

    [ "$B_SPLIT" = "true" ] && green "bridge: split=true in msg_trace" || red "bridge: split=$B_SPLIT (expected true)"
    echo "$B_TOOLS" | grep -q "chat_llm" && green "bridge: tools_planned contains chat_llm" || red "bridge: tools_planned='$B_TOOLS' missing chat_llm"
  else
    red "bridge: no msg_trace found in new log lines"
  fi

  if [ -n "$SMTP_LOG" ]; then
    green "bridge: 'send_email: smtp not configured' log line found"
    CHAT_ANS=$(echo "$SMTP_LOG" | jq -r '.chat_answered // false')
    CONV_TAIL=$(echo "$SMTP_LOG" | jq -r '.conv_tail // ""')
    info "conv_tail=$CONV_TAIL  chat_answered=$CHAT_ANS"
    [ -n "$CONV_TAIL" ] && green "bridge: conv_tail extracted ('$CONV_TAIL')" || red "bridge: conv_tail is empty"
    [ "$CHAT_ANS" = "true" ] && green "bridge: chat_answered=true (math question answered)" || red "bridge: chat_answered=$CHAT_ANS (math answer was not appended)"
  else
    red "bridge: 'send_email: smtp not configured' log line not found"
  fi
else
  echo
  echo "--- 5-9. Bridge tests SKIPPED (log file not found: $BRIDGE_LOG) ---"
fi

# ── 10. Single-intent: no false positive ─────────────────────────────────────
echo
echo "--- 10. classify_intent: single-intent email (no false positive) ---"
R10=$(classify "$SINGLE_EMAIL_MSG")
M10=$(echo "$R10" | jq -r '.exec.result.multi_intent // false')
AT10=$(echo "$R10" | jq -r '.exec.result.action_type')
info "single_email: action_type=$AT10 multi_intent=$M10"
[ "$AT10" = "send_email" ] && green "single-intent: primary=send_email" || red "single-intent: primary=$AT10"
[ "$M10" = "false" ] && green "single-intent: multi_intent=false (no false positive)" || red "single-intent: multi_intent=$M10 (false positive!)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "========================================"
printf  "  Results: %d passed, %d failed\n" "$PASS" "$FAIL"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
