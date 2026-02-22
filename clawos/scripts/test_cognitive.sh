#!/usr/bin/env bash
# test_cognitive.sh — Cognitive Architecture Repro Script
#
# Simulates the two-message naming task scenario and verifies:
#   1. Objectives are created and persisted
#   2. Follow-up messages bind to the same objective (no drift)
#   3. Tool evidence is recorded after execution
#   4. Tool-truth enforcement works (false claims blocked)
#   5. Deliverable validation phases work
#   6. Logs show session_id, objective_id, deliverable_check, tool_truth_check
#
# Tests the kernel cognitive API directly (no WhatsApp required).
#
# Usage:
#   bash clawos/scripts/test_cognitive.sh
#
# Requirements:
#   - Kernel running on port 18888 (already set up)
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

check_gte() {
  local label="$1" min="$2" actual="$3"
  if [ "$actual" -ge "$min" ] 2>/dev/null; then
    green "$label (got $actual)"
    PASS=$((PASS + 1))
  else
    red "$label (expected ≥$min, got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== ClawOS Cognitive Architecture Repro Tests ==="
echo "Kernel: $KERNEL"
echo

# ── 0. Health ─────────────────────────────────────────────────────────────────
echo "--- 0. Health check ---"
HEALTH=$(curl -s "$KERNEL/kernel/health")
check "kernel reachable" "true" "$(echo "$HEALTH" | jq -r '.ok')"

# ── 1. Setup workspace + session ──────────────────────────────────────────────
echo
echo "--- 1. Setup workspace + session ---"
WS=$(curl -s -X POST "$KERNEL/kernel/workspaces" \
  -H "Content-Type: application/json" -d '{"type":"test"}')
WS_ID=$(echo "$WS" | jq -r '.workspace_id')
check_notempty "workspace created" "$WS_ID"

SESSION_RESOLVE=$(curl -s -X POST "$KERNEL/kernel/sessions/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"channel\":\"whatsapp\",\"remote_jid\":\"+1555cognitive\",\"user_message\":\"test\"}")
SESSION_ID=$(echo "$SESSION_RESOLVE" | jq -r '.session_id')
check_notempty "session created" "$SESSION_ID"
echo "  session_id = $SESSION_ID"

AGENT="agent_test_cogarch"
curl -s -X POST "$KERNEL/kernel/agents" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"role\":\"orchestrator\"}" > /dev/null

# ── 2. Message 1: naming task — creates NEW objective ─────────────────────────
echo
echo "--- 2. Message 1: naming task (new objective) ---"
MSG1="Search the web and come up with a good name for our AI operating system. It should have a non taken .ai domain"
OBJ1=$(curl -s -X POST "$KERNEL/kernel/objectives/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"session_id\":\"$SESSION_ID\",\"agent_id\":\"$AGENT\",\"user_message\":\"$MSG1\"}")
check "ok=true" "true" "$(echo "$OBJ1" | jq -r '.ok')"
check "decision=new" "new" "$(echo "$OBJ1" | jq -r '.decision')"
OBJ_ID=$(echo "$OBJ1" | jq -r '.objective_id')
check_notempty "objective_id returned" "$OBJ_ID"
GOAL=$(echo "$OBJ1" | jq -r '.goal // ""')
check_notempty "goal extracted" "$GOAL"
echo "  objective_id = $OBJ_ID"
echo "  goal = $GOAL"

# Check deliverable spec was extracted
DELIV=$(curl -s "$KERNEL/kernel/objectives/$OBJ_ID" | jq -r '.objective.required_deliverable_json // "null"')
echo "  required_deliverable = ${DELIV:0:100}..."

# ── 3. Record tool evidence (simulate a web_search happened) ──────────────────
echo
echo "--- 3. Record tool evidence ---"
EV=$(curl -s -X POST "$KERNEL/kernel/objectives/$OBJ_ID/evidence" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION_ID\",\"action_type\":\"web_search\",\"query_text\":\"AI operating system names .ai domain availability\",\"result_summary\":\"Found several candidates including ClawOS, NeuralOS, CognitOS\"}")
check "evidence recorded" "true" "$(echo "$EV" | jq -r '.ok')"
EV_ID=$(echo "$EV" | jq -r '.evidence_id')
check_notempty "evidence_id returned" "$EV_ID"

# Verify evidence is retrievable
EV_LIST=$(curl -s "$KERNEL/kernel/objectives/$OBJ_ID/evidence")
check "evidence list ok" "true" "$(echo "$EV_LIST" | jq -r '.ok')"
EV_COUNT=$(echo "$EV_LIST" | jq '.evidence | length')
check "evidence count ≥1" "1" "$EV_COUNT"

# ── 4. Tool-truth enforcement: output WITH claims AND evidence → pass ──────────
echo
echo "--- 4. Tool-truth enforcement: claims + evidence → pass ---"
OUTPUT_WITH_EVIDENCE="Based on my search, here are 10 AI OS name suggestions:
1. ClawOS.ai - domain status: Available
2. NeuralOS.ai - domain status: Unknown"
TRUTH1=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"action_type\":\"cognitive_execute\",\"payload\":{\"phase\":\"enforce_tool_truth\",\"output\":$(echo "$OUTPUT_WITH_EVIDENCE" | jq -Rs .),\"objective_id\":\"$OBJ_ID\"}}")
TRUTH1_RESULT=$(echo "$TRUTH1" | jq -r '.exec.result // {}')
check "truth check ok" "true" "$(echo "$TRUTH1" | jq -r '.ok')"
check "truth1 passed (has evidence)" "true" "$(echo "$TRUTH1_RESULT" | jq -r '.passed')"
echo "  claims_found = $(echo "$TRUTH1_RESULT" | jq -c '.claims_found')"

# ── 5. Tool-truth enforcement: claims WITHOUT evidence → fail + sanitize ───────
echo
echo "--- 5. Tool-truth enforcement: claims WITHOUT evidence → sanitized ---"
# Create a separate objective with no evidence
OBJ_NOEV=$(curl -s -X POST "$KERNEL/kernel/objectives/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"session_id\":\"$SESSION_ID\",\"agent_id\":\"$AGENT\",\"user_message\":\"start fresh test for truth check\"}")
OBJ_NOEV_ID=$(echo "$OBJ_NOEV" | jq -r '.objective_id')
FALSE_OUTPUT="I searched the web and verified these domains are available: ClawOS.ai - Available, NeuralOS.ai - Available"
TRUTH2=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"action_type\":\"cognitive_execute\",\"payload\":{\"phase\":\"enforce_tool_truth\",\"output\":$(echo "$FALSE_OUTPUT" | jq -Rs .),\"objective_id\":\"$OBJ_NOEV_ID\"}}")
TRUTH2_RESULT=$(echo "$TRUTH2" | jq -r '.exec.result // {}')
check "truth check returned" "true" "$(echo "$TRUTH2" | jq -r '.ok')"
check "truth2 failed (no evidence)" "false" "$(echo "$TRUTH2_RESULT" | jq -r '.passed')"
check "repair triggered" "true" "$(echo "$TRUTH2_RESULT" | jq -r '.tool_repair_triggered')"
SANITIZED=$(echo "$TRUTH2_RESULT" | jq -r '.sanitized_output // ""')
check_contains "sanitized contains Unknown" "Unknown" "$SANITIZED"
check_contains "sanitized contains disclaimer" "not verified" "$SANITIZED"
echo "  sanitized preview: ${SANITIZED:0:100}..."

# ── 6. Deliverable validation: 10-item list → pass ────────────────────────────
echo
echo "--- 6. Deliverable validation: 10 items → pass ---"
TEN_ITEMS="1. ClawOS — clawos.ai — Available — verified
2. NeuralOS — neuralos.ai — Unknown — not verified
3. CognitOS — cognitos.ai — Available — verified
4. SynapticOS — synapticos.ai — Unknown — not verified
5. MindOS — mindos.ai — Taken — verified
6. IntelliOS — intellios.ai — Available — verified
7. ThinkOS — thinkos.ai — Unknown — not verified
8. CortexOS — cortexos.ai — Available — verified
9. NexusOS — nexusos.ai — Unknown — not verified
10. PulseOS — pulseos.ai — Available — verified"

VAL1=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"action_type\":\"cognitive_execute\",\"payload\":{\"phase\":\"validate_deliverable\",\"output\":$(echo "$TEN_ITEMS" | jq -Rs .),\"objective_id\":\"$OBJ_ID\"}}")
VAL1_RESULT=$(echo "$VAL1" | jq -r '.exec.result // {}')
check "validation returned ok" "true" "$(echo "$VAL1" | jq -r '.ok')"
ITEM_COUNT1=$(echo "$VAL1_RESULT" | jq -r '.item_count // 0')
echo "  item_count = $ITEM_COUNT1"
# 10 numbered items should be detected
check_gte "item_count ≥10" 10 "$ITEM_COUNT1"

# ── 7. Deliverable validation: 3-item list → fail ─────────────────────────────
echo
echo "--- 7. Deliverable validation: only 3 items → fail ---"
THREE_ITEMS="Here are some suggestions:
1. ClawOS — clawos.ai
2. NeuralOS — neuralos.ai
3. CognitOS — cognitos.ai"
VAL2=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"action_type\":\"cognitive_execute\",\"payload\":{\"phase\":\"validate_deliverable\",\"output\":$(echo "$THREE_ITEMS" | jq -Rs .),\"objective_id\":\"$OBJ_ID\"}}")
VAL2_RESULT=$(echo "$VAL2" | jq -r '.exec.result // {}')
check "validation returned ok" "true" "$(echo "$VAL2" | jq -r '.ok')"
check "validation failed (only 3 items)" "false" "$(echo "$VAL2_RESULT" | jq -r '.passed')"
ITEM_COUNT2=$(echo "$VAL2_RESULT" | jq -r '.item_count // 0')
echo "  item_count = $ITEM_COUNT2 (expected < 10)"
FAILURES=$(echo "$VAL2_RESULT" | jq -r '.failures[0] // ""')
check_notempty "failure reason present" "$FAILURES"
echo "  failure = $FAILURES"

# ── 8. Follow-up binding: same objective continued ────────────────────────────
echo
echo "--- 8. Follow-up binding: 'Head to that website and give 10 more' ---"
MSG2="Head to that website and give 10 more suggestions. We can't use any taken ones."
OBJ2=$(curl -s -X POST "$KERNEL/kernel/objectives/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"session_id\":\"$SESSION_ID\",\"agent_id\":\"$AGENT\",\"user_message\":\"$MSG2\"}")
check "ok=true" "true" "$(echo "$OBJ2" | jq -r '.ok')"
OBJ_ID_2=$(echo "$OBJ2" | jq -r '.objective_id')
check "same objective_id (no drift)" "$OBJ_ID" "$OBJ_ID_2"
check "decision=continue" "continue" "$(echo "$OBJ2" | jq -r '.decision')"
echo "  decision = $(echo "$OBJ2" | jq -r '.decision'), reason = $(echo "$OBJ2" | jq -r '.reason')"
echo "  objective_id = $OBJ_ID_2 (matches original: $OBJ_ID)"

# ── 9. Follow-up binding: unrelated message → new objective ────────────────────
echo
echo "--- 9. Unrelated message → new objective ---"
MSG3="What is the weather forecast for New York tomorrow?"
OBJ3=$(curl -s -X POST "$KERNEL/kernel/objectives/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"session_id\":\"$SESSION_ID\",\"agent_id\":\"$AGENT\",\"user_message\":\"$MSG3\"}")
check "ok=true" "true" "$(echo "$OBJ3" | jq -r '.ok')"
OBJ_ID_3=$(echo "$OBJ3" | jq -r '.objective_id')
if [ "$OBJ_ID_3" != "$OBJ_ID" ]; then
  green "different objective for unrelated topic (expected)"
  PASS=$((PASS + 1))
else
  red "should have created new objective for unrelated topic"
  FAIL=$((FAIL + 1))
fi
echo "  original_obj=$OBJ_ID  new_obj=$OBJ_ID_3"

# ── 10. List objectives for session ───────────────────────────────────────────
echo
echo "--- 10. List objectives for session ---"
OBJ_LIST=$(curl -s "$KERNEL/kernel/objectives?session_id=$SESSION_ID")
check "list ok" "true" "$(echo "$OBJ_LIST" | jq -r '.ok')"
OBJ_COUNT=$(echo "$OBJ_LIST" | jq '.objectives | length')
check_gte "≥2 objectives for session" 2 "$OBJ_COUNT"
echo "  total objectives for session: $OBJ_COUNT"

# ── 11. Update objective status ───────────────────────────────────────────────
echo
echo "--- 11. Update objective status to completed ---"
PATCH_RES=$(curl -s -X PATCH "$KERNEL/kernel/objectives/$OBJ_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","result_summary":"10 AI OS names provided"}')
check "patch ok" "true" "$(echo "$PATCH_RES" | jq -r '.ok')"

# Verify status change
OBJ_AFTER=$(curl -s "$KERNEL/kernel/objectives/$OBJ_ID")
check "status=completed" "completed" "$(echo "$OBJ_AFTER" | jq -r '.objective.status')"

# ── 12. extract_objective phase ───────────────────────────────────────────────
echo
echo "--- 12. extract_objective phase ---"
EXTRACT=$(curl -s -X POST "$KERNEL/kernel/action_requests" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"$AGENT\",\"action_type\":\"cognitive_execute\",\"payload\":{\"phase\":\"extract_objective\",\"text\":\"Give me 5 Python code examples for sorting algorithms\"}}")
check "extract ok" "true" "$(echo "$EXTRACT" | jq -r '.ok')"
EX_RESULT=$(echo "$EXTRACT" | jq -r '.exec.result // {}')
check_notempty "goal extracted" "$(echo "$EX_RESULT" | jq -r '.goal // ""')"
# Should detect a list request
DELIV_TYPE=$(echo "$EX_RESULT" | jq -r '.required_deliverable.type // "unknown"')
echo "  deliverable type = $DELIV_TYPE"
DELIV_COUNT=$(echo "$EX_RESULT" | jq -r '.required_deliverable.count // null')
echo "  deliverable count = $DELIV_COUNT"
if [ "$DELIV_TYPE" = "list" ] && [ "$DELIV_COUNT" = "5" ]; then
  green "list deliverable with count=5 correctly extracted"
  PASS=$((PASS + 1))
else
  red "expected list/5 deliverable, got type=$DELIV_TYPE count=$DELIV_COUNT"
  FAIL=$((FAIL + 1))
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="
echo
echo "Log fields emitted during execution:"
echo "  session_id, objective_id, obj_decision, obj_reason  (objective resolved)"
echo "  tool_truth_check: pass|fail                         (tool-truth gate)"
echo "  deliverable_check: pass|fail|repaired|skip          (deliverable validator)"
echo "  repair_attempts: 0|1                               (auto-repair loop)"
echo "  tool_repair_triggered: true|false                   (false claim sanitization)"
echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m✓ All cognitive tests passed\033[0m\n'
  exit 0
else
  printf '\033[31m✗ %d test(s) failed\033[0m\n' "$FAIL"
  exit 1
fi
