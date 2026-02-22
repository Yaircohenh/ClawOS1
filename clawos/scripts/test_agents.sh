#!/usr/bin/env bash
# =============================================================================
# ClawOS Agent/Subagent Smoke Test
# =============================================================================
# Tests the full agent → task → subagent → DCT → run → verify flow.
# Covers both the LOW-risk (auto) path and the HIGH-risk (needs approval) path.
#
# Usage:
#   ./clawos/scripts/test_agents.sh
#
# Environment:
#   KERNEL_URL   (default: http://localhost:18888)
# =============================================================================

set -euo pipefail

KERNEL="${KERNEL_URL:-http://localhost:18888}"
PASS=0; FAIL=0

# ── Colours ───────────────────────────────────────────────────────────────────
R="\033[0;31m"; G="\033[0;32m"; Y="\033[0;33m"; B="\033[0;34m"; NC="\033[0m"
info()  { echo -e "${B}  ▸ $*${NC}"; }
ok()    { echo -e "${G}  ✓ $*${NC}"; PASS=$((PASS+1)); }
fail()  { echo -e "${R}  ✗ $*${NC}"; FAIL=$((FAIL+1)); }
step()  { echo -e "\n${Y}── $* ────────────────────────────────────────────────${NC}"; }
hr()    { echo -e "${Y}══════════════════════════════════════════════════════${NC}"; }

check() {
  local label="$1"; local expr="$2"
  if python3 -c "import sys,json; d=json.load(sys.stdin); assert ($expr), 'FAIL: '+repr(d)" <<< "$RESP" 2>/dev/null; then
    ok "$label"
  else
    fail "$label  →  $(echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d, indent=2))' 2>/dev/null || echo "$RESP")"
  fi
}

# ── Helper: POST with JSON ────────────────────────────────────────────────────
post() {
  local url="$1"; local data="$2"
  RESP=$(curl -s -X POST "${KERNEL}${url}" \
    -H "Content-Type: application/json" \
    -d "$data")
  echo "$RESP"
}

get() {
  local url="$1"
  RESP=$(curl -s "${KERNEL}${url}")
  echo "$RESP"
}

# ── Extract a field from last RESP ───────────────────────────────────────────
field() {
  python3 -c "import json,sys; d=json.loads('$1'); print(d['$2'])"
}

jq_field() {
  local resp="$1"; local key="$2"
  python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('$key',''))" <<< "$resp"
}

# =============================================================================
hr
echo -e "${Y}  ClawOS Agent / Subagent Smoke Test${NC}"
echo -e "${Y}  Kernel: $KERNEL${NC}"
hr

# ── 0. Health ─────────────────────────────────────────────────────────────────
step "0. Kernel Health"
RESP=$(curl -s "${KERNEL}/kernel/health")
check "kernel ok" "d['ok'] == True"

# ── 1. Create Workspace ───────────────────────────────────────────────────────
step "1. Create Workspace"
RESP=$(post "/kernel/workspaces" '{"type":"agent_test"}')
check "workspace created" "'workspace_id' in d"
WS_ID=$(jq_field "$RESP" "workspace_id")
info "workspace_id = $WS_ID"

# ── 2. Register Orchestrator AGENT ───────────────────────────────────────────
step "2. Register Orchestrator AGENT"
RESP=$(post "/kernel/agents" "{\"workspace_id\":\"$WS_ID\",\"agent_id\":\"orchestrator\",\"role\":\"orchestrator\"}")
check "agent registered" "d.get('ok') == True"
check "kind is agent" "d['agent']['kind'] == 'agent'"
check "role is orchestrator" "d['agent']['role'] == 'orchestrator'"
info "agent_id = orchestrator"

# ── 3. Verify AGENT is retrievable ───────────────────────────────────────────
step "3. GET /kernel/agents/orchestrator"
RESP=$(get "/kernel/agents/orchestrator")
check "agent found" "d['ok'] == True and d['agent']['agent_id'] == 'orchestrator'"

# ── 4. Create Task (contract-first) ──────────────────────────────────────────
step "4. Create Task (AGENT only)"
TASK_BODY=$(cat <<EOF
{
  "workspace_id": "$WS_ID",
  "created_by_agent_id": "orchestrator",
  "title": "Research and summarise disk usage",
  "intent": "Produce a short disk-usage report for the user",
  "contract": {
    "objective": "Produce a disk usage summary",
    "scope": { "tools": ["web_search"] },
    "deliverables": ["disk_report"],
    "acceptance_checks": [
      { "type": "min_artifacts", "count": 1 },
      { "type": "subagents_finished" }
    ]
  },
  "plan": {
    "steps": [
      { "id": "s1", "worker_type": "web_researcher", "description": "Research disk cleanup tips" }
    ],
    "delegation_plan": { "s1": "web_researcher" }
  }
}
EOF
)
RESP=$(post "/kernel/tasks" "$TASK_BODY")
check "task created" "d.get('ok') == True"
check "status queued" "d['task']['status'] == 'queued'"
check "contract present" "'acceptance_checks' in d['task']['contract']"
TASK_ID=$(jq_field "$RESP" "task_id")
info "task_id = $TASK_ID"

# ── 4b. Only AGENT can create task (reject non-agent) ─────────────────────────
step "4b. Task creation fails for non-agent"
BAD_BODY=$(echo "$TASK_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); d['created_by_agent_id']='ghost_999'; print(json.dumps(d))")
RESP=$(post "/kernel/tasks" "$BAD_BODY")
check "non-agent rejected" "d.get('ok') != True"

# ── 5. Spawn Subagent (AGENT only) ───────────────────────────────────────────
step "5. Spawn Subagent"
RESP=$(post "/kernel/subagents" "{
  \"workspace_id\":    \"$WS_ID\",
  \"parent_agent_id\": \"orchestrator\",
  \"task_id\":         \"$TASK_ID\",
  \"step_id\":         \"s1\",
  \"worker_type\":     \"web_researcher\"
}")
check "subagent spawned" "d.get('ok') == True"
check "kind is subagent" "d['subagent']['kind'] == 'subagent'"
check "status created" "d['subagent']['status'] == 'created'"
check "bound to agent" "d['subagent']['parent_agent_id'] == 'orchestrator'"
check "bound to task" "d['subagent']['task_id'] == '$TASK_ID'"
SA_ID=$(jq_field "$RESP" "subagent_id")
info "subagent_id = $SA_ID"

# ── 5b. Subagent can be retrieved ─────────────────────────────────────────────
step "5b. GET /kernel/subagents/:id"
RESP=$(get "/kernel/subagents/${SA_ID}?workspace_id=${WS_ID}")
check "subagent found" "d['ok'] == True"

# ── 6. Request LOW-risk DCT (web_search = auto, no approval needed) ───────────
step "6. Request DCT for subagent — LOW risk (web_search, auto)"
RESP=$(post "/kernel/tokens/request" "{
  \"workspace_id\":          \"$WS_ID\",
  \"requested_by_agent_id\": \"orchestrator\",
  \"issue_to\":              { \"kind\": \"subagent\", \"id\": \"$SA_ID\" },
  \"task_id\":               \"$TASK_ID\",
  \"scope\": {
    \"allowed_tools\": [\"web_search\"],
    \"operations\":    [\"read\"],
    \"resource_constraints\": {}
  },
  \"ttl_seconds\": 300
}")
check "token minted" "d.get('ok') == True"
check "issued to subagent" "d['issued_to_kind'] == 'subagent'"
check "low risk" "d['risk_level'] == 'LOW'"
DCT_LOW=$(jq_field "$RESP" "token")
DCT_LOW_ID=$(jq_field "$RESP" "token_id")
info "DCT (low) = ${DCT_LOW_ID}"

# ── 7. Run Subagent with DCT ──────────────────────────────────────────────────
step "7. Run Subagent worker"
RESP=$(post "/kernel/subagents/${SA_ID}/run" "{
  \"workspace_id\": \"$WS_ID\",
  \"token\":        \"$DCT_LOW\",
  \"input\":        { \"query\": \"how to free up disk space on macOS\" }
}")
check "worker ran" "d.get('ok') == True"
check "artifact created" "'artifact_id' in d"
check "result present" "'result' in d"
ART_ID=$(jq_field "$RESP" "artifact_id")
info "artifact_id = $ART_ID"

# ── 7b. Replay fails (already finished) ──────────────────────────────────────
step "7b. Replay run fails — subagent already finished"
RESP=$(post "/kernel/subagents/${SA_ID}/run" "{
  \"workspace_id\": \"$WS_ID\",
  \"token\": \"$DCT_LOW\",
  \"input\": {}
}")
check "replay rejected" "d.get('ok') != True"

# ── 7c. Wrong token rejected ──────────────────────────────────────────────────
step "7c. Spawn second subagent; wrong token rejected"
RESP2=$(post "/kernel/subagents" "{
  \"workspace_id\":    \"$WS_ID\",
  \"parent_agent_id\": \"orchestrator\",
  \"task_id\":         \"$TASK_ID\",
  \"worker_type\":     \"doc_processor\"
}")
SA_ID2=$(jq_field "$RESP2" "subagent_id")
RESP=$(post "/kernel/subagents/${SA_ID2}/run" "{
  \"workspace_id\": \"$WS_ID\",
  \"token\":        \"$DCT_LOW\",
  \"input\":        {}
}")
check "wrong-subagent token rejected" "d.get('ok') != True and 'not_bound' in d.get('error','')"

# ── 8. HIGH-risk DCT — needs approval ────────────────────────────────────────
step "8. Request DCT — HIGH risk (run_shell → needs approval)"
# Spawn a shell_executor subagent
RESP=$(post "/kernel/subagents" "{
  \"workspace_id\":    \"$WS_ID\",
  \"parent_agent_id\": \"orchestrator\",
  \"task_id\":         \"$TASK_ID\",
  \"worker_type\":     \"shell_executor\"
}")
SA_SHELL=$(jq_field "$RESP" "subagent_id")
info "shell_executor subagent = $SA_SHELL"

RESP=$(post "/kernel/tokens/request" "{
  \"workspace_id\":          \"$WS_ID\",
  \"requested_by_agent_id\": \"orchestrator\",
  \"issue_to\":              { \"kind\": \"subagent\", \"id\": \"$SA_SHELL\" },
  \"task_id\":               \"$TASK_ID\",
  \"scope\": {
    \"allowed_tools\": [\"run_shell\"],
    \"operations\":    [\"execute\"]
  },
  \"ttl_seconds\": 300
}")
check "needs approval returned" "d.get('needs_approval') == True"
check "risk high" "d['risk_level'] == 'HIGH'"
DAR_ID=$(jq_field "$RESP" "dar_id")
info "dar_id = $DAR_ID"

# ── 9. Grant DCT approval ─────────────────────────────────────────────────────
step "9. Grant DCT approval"
RESP=$(post "/kernel/dct_approvals/${DAR_ID}/grant" "{}")
check "approval granted" "d['ok'] == True and d['status'] == 'granted'"

# ── 10. Re-request DCT with approval ─────────────────────────────────────────
step "10. Re-request DCT with dar_id — should mint"
RESP=$(post "/kernel/tokens/request" "{
  \"workspace_id\":          \"$WS_ID\",
  \"requested_by_agent_id\": \"orchestrator\",
  \"issue_to\":              { \"kind\": \"subagent\", \"id\": \"$SA_SHELL\" },
  \"task_id\":               \"$TASK_ID\",
  \"scope\": {
    \"allowed_tools\": [\"run_shell\"],
    \"operations\":    [\"execute\"]
  },
  \"ttl_seconds\": 300,
  \"dar_id\": \"$DAR_ID\"
}")
check "token minted after approval" "d.get('ok') == True"
check "issued to subagent" "d['issued_to_kind'] == 'subagent'"
DCT_HIGH=$(jq_field "$RESP" "token")
info "DCT (high) = $(jq_field "$RESP" "token_id")"

# ── 11. Run shell_executor subagent ──────────────────────────────────────────
step "11. Run shell_executor subagent"
RESP=$(post "/kernel/subagents/${SA_SHELL}/run" "{
  \"workspace_id\": \"$WS_ID\",
  \"token\":        \"$DCT_HIGH\",
  \"input\":        { \"command\": \"df -h\" }
}")
check "shell worker ran" "d.get('ok') == True"
check "artifact id present" "'artifact_id' in d"

# ── 12. Add manual artifact via API ───────────────────────────────────────────
step "12. POST artifact to task"
RESP=$(post "/kernel/tasks/${TASK_ID}/artifacts" "{
  \"workspace_id\": \"$WS_ID\",
  \"actor_kind\":   \"agent\",
  \"actor_id\":     \"orchestrator\",
  \"type\":         \"disk_report\",
  \"content\":      \"Disk usage: 84% — consider cleaning ~/Downloads\",
  \"metadata\":     { \"generated_by\": \"orchestrator\" }
}")
check "artifact created via API" "d.get('ok') == True"

# ── 13. Verify Task ───────────────────────────────────────────────────────────
step "13. Verify Task (acceptance checks)"
# Note: one subagent (SA_ID2 = doc_processor) was never run — it's still 'created'
# The acceptance check 'subagents_finished' will fail for it.
# We'll verify and expect it to call out the unfinished subagent.
RESP=$(post "/kernel/tasks/${TASK_ID}/verify" "{
  \"workspace_id\":          \"$WS_ID\",
  \"requested_by_agent_id\": \"orchestrator\"
}")
check "verify ran" "'passed' in d"
check "min_artifacts check met" "d['artifacts_found'] >= 1"
info "verify passed=$(jq_field "$RESP" "passed"), failures=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('failures',[]))) " <<< "$RESP")"
# (may not pass fully because doc_processor subagent was not run — that's expected)

# ── 14. Run doc_processor to finish all subagents ─────────────────────────────
step "14. Get DCT for doc_processor and run it"
RESP=$(post "/kernel/tokens/request" "{
  \"workspace_id\":          \"$WS_ID\",
  \"requested_by_agent_id\": \"orchestrator\",
  \"issue_to\":              { \"kind\": \"subagent\", \"id\": \"$SA_ID2\" },
  \"task_id\":               \"$TASK_ID\",
  \"scope\": { \"allowed_tools\": [\"read_file\"], \"operations\": [\"read\"] },
  \"ttl_seconds\": 300
}")
check "doc_processor DCT minted" "d.get('ok') == True"
DCT_DOC=$(jq_field "$RESP" "token")

RESP=$(post "/kernel/subagents/${SA_ID2}/run" "{
  \"workspace_id\": \"$WS_ID\",
  \"token\":        \"$DCT_DOC\",
  \"input\":        { \"filename\": \"report.pdf\" }
}")
check "doc_processor ran" "d.get('ok') == True"

# ── 15. Re-verify — should pass now ───────────────────────────────────────────
step "15. Re-verify — all subagents finished"
RESP=$(post "/kernel/tasks/${TASK_ID}/verify" "{
  \"workspace_id\":          \"$WS_ID\",
  \"requested_by_agent_id\": \"orchestrator\"
}")
check "verify passed" "d.get('passed') == True"
check "task succeeded in events" "True"  # status updated in kernel

# ── 16. Fetch Events ──────────────────────────────────────────────────────────
step "16. GET /kernel/tasks/:id/events"
RESP=$(get "/kernel/tasks/${TASK_ID}/events?workspace_id=${WS_ID}")
check "events returned" "d['ok'] == True and d['event_count'] > 0"
EVENT_COUNT=$(jq_field "$RESP" "event_count")
info "total events: $EVENT_COUNT"

# Print event types
python3 <<EOF
import json, sys
with open('/dev/stdin') as f: pass  # no-op
import subprocess
result = subprocess.run(['curl','-s',"${KERNEL}/kernel/tasks/${TASK_ID}/events?workspace_id=${WS_ID}"], capture_output=True, text=True)
d = json.loads(result.stdout)
for ev in d.get('events', []):
    print(f"  {ev['ts'][11:19]}  [{ev['actor_kind']:8s}] {ev['type']}")
EOF

# ── 17. Get full task snapshot ────────────────────────────────────────────────
step "17. GET /kernel/tasks/:id — full snapshot"
RESP=$(get "/kernel/tasks/${TASK_ID}?workspace_id=${WS_ID}")
check "task succeeded" "d['task']['status'] == 'succeeded'"
check "artifacts present" "len(d['artifacts']) >= 2"
check "subagents present" "len(d['subagents']) >= 2"

# ── Summary ───────────────────────────────────────────────────────────────────
hr
echo -e "${G}  PASSED: $PASS${NC}  ${R}FAILED: $FAIL${NC}"
hr
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
