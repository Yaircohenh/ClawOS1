# ClawOS Multi-Turn Conversation Sessions

Sessions give every WhatsApp sender a persistent conversation state so the AI can
maintain context across multiple messages — referring back to previous searches,
file operations, and decisions without the user having to repeat themselves.

---

## Architecture

```
WhatsApp sender
      │ message
      ▼
Bridge (port 18790)
  ├─ ensureWorkspace(sender)       — create/load workspace + agent
  ├─ kernelResolveSession(...)     — find or create session ──────────►  Kernel (port 18888)
  │    returns { session_id,                                              sessions table (SQLite)
  │              decision,                                                  session_id
  │              reason,                                                    workspace_id
  │              session.context_summary }                                  channel
  │                                                                         remote_jid
  ├─ routeMessage(..., sessionId, contextSummary)                           status  (active|closed)
  │    ├─ classify_intent payload includes context_summary                  turn_count
  │    └─ routeViaAgent task objective includes context_summary             context_summary
  │                                                                         last_message_at
  └─ kernelUpdateSession(...)      ◄───────────────────────────────────  After each reply
       advances turn_count, last_message_at, regenerates context_summary
```

The session lives entirely in the kernel. The bridge is stateless with respect to
sessions — it only holds the `session_id` for the duration of a single webhook call.

---

## Session Lifecycle

```
                  ┌──────────────────────────────────────────────┐
                  │  POST /kernel/sessions/resolve               │
                  │  (workspace_id, channel, remote_jid, msg)    │
                  └─────────────────┬────────────────────────────┘
                                    │
             ┌──────────────────────▼──────────────────────────────┐
             │                Decision Policy                        │
             │                                                       │
             │  1. explicit_reset   — "reset", "start over", …      │
             │     → close current session, create NEW              │
             │                                                       │
             │  2. no_session       — sender has never messaged      │
             │     → create NEW                                      │
             │                                                       │
             │  3. closed           — most recent session is closed  │
             │     → create NEW                                      │
             │                                                       │
             │  4. timeout          — last_message_at > 30 min ago   │
             │     → close old, create NEW                           │
             │                                                       │
             │  5. drift (optional) — topic changed (LLM gate)       │
             │     requires ENABLE_SESSION_DRIFT_CLASSIFIER=true     │
             │     confidence ≥ 0.80 to trigger                     │
             │     → close old, create NEW                           │
             │                                                       │
             │  6. continue         — same topic, within timeout     │
             │     → return existing session                         │
             └───────────────────────────────────────────────────────┘
```

The `decision` field in the response tells the bridge which policy fired.
The `reason` field is the kebab-case policy name (e.g. `"timeout"`, `"explicit_reset"`).

---

## Context Summary

After each assistant turn the bridge calls:

```
PATCH /kernel/sessions/:session_id
  { workspace_id, user_message, assistant_response, action_type }
```

The kernel regenerates `context_summary` using **Claude Haiku** (if an Anthropic API key
is configured in Connections) or a lightweight template fallback. The summary is always
≤ 1000 characters and uses this deterministic format:

```
GOAL: <current user objective>
ENTITIES: <key names, files, URLs — comma separated>
DECISIONS: <choices made this session — comma separated>
PENDING: <unanswered questions or pending items>
TURNS: <N>
```

On the _next_ inbound message the bridge passes `context_summary` to:

- `classify_intent` — so the LLM understands pronoun references ("it", "that", "there")
- task objective in `kernelCreateTask` — so the worker sees prior conversation context

---

## Database Schema

```sql
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  channel         TEXT NOT NULL DEFAULT 'whatsapp',
  remote_jid      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | closed
  turn_count      INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_lookup
  ON sessions (workspace_id, channel, remote_jid, status);
```

Stored in the kernel's SQLite database at `apps/kernel/data/kernel.db`.

---

## Kernel API

| Method  | Path                             | Description                                     |
| ------- | -------------------------------- | ----------------------------------------------- |
| `POST`  | `/kernel/sessions/resolve`       | Find or create a session for an inbound message |
| `GET`   | `/kernel/sessions/:id`           | Fetch a session by ID                           |
| `PATCH` | `/kernel/sessions/:id`           | Advance turn count + regenerate context summary |
| `POST`  | `/kernel/sessions/:id/close`     | Forcefully close a session                      |
| `GET`   | `/kernel/sessions?workspace_id=` | List sessions for a workspace                   |

### POST /kernel/sessions/resolve

Request:

```json
{
  "workspace_id": "ws_abc",
  "channel": "whatsapp",
  "remote_jid": "+15550001234",
  "user_message": "what's the weather like?"
}
```

Response:

```json
{
  "ok": true,
  "session_id": "sess_xyz",
  "decision": "continue",
  "reason": "within_timeout",
  "session": {
    "session_id": "sess_xyz",
    "workspace_id": "ws_abc",
    "channel": "whatsapp",
    "remote_jid": "+15550001234",
    "status": "active",
    "turn_count": 3,
    "context_summary": "GOAL: Check weather...\nENTITIES: ...\nTURNS: 3",
    "created_at": "2026-02-23T10:00:00.000Z",
    "last_message_at": "2026-02-23T10:05:00.000Z"
  }
}
```

Possible `decision` values: `new` | `continue`
Possible `reason` values: `first_message` | `within_timeout` | `no_session` | `session_closed` | `timeout` | `explicit_reset` | `topic_drift`

---

## Configuration

| Environment Variable              | Default | Description                                                    |
| --------------------------------- | ------- | -------------------------------------------------------------- |
| `SESSION_TIMEOUT_MINUTES`         | `30`    | Minutes of inactivity before a new session is created          |
| `ENABLE_SESSION_DRIFT_CLASSIFIER` | `false` | Enable the LLM-based topic-drift gate (requires Anthropic key) |

Set in `apps/kernel/.env` or as process environment variables.

---

## Reset Keywords

Sending any of these phrases (case-insensitive) triggers an immediate session reset:

`new task` · `start over` · `reset` · `forget that` · `new project` · `clear history` · `start fresh` · `new conversation`

The bridge replies "Starting fresh. How can I help you?" and skips normal intent routing.

---

## How to Test

### Quick API test (no WhatsApp needed)

```bash
# Make sure the kernel is running
curl http://localhost:18888/kernel/health

# Run the full session smoke test suite
bash clawos/scripts/test_sessions.sh
```

### End-to-end via bridge webhook (simulates WhatsApp)

```bash
SECRET="your-bridge-secret"
URL="http://localhost:18790/webhook/whatsapp"

# Turn 1 — creates a new session
curl -s -X POST "$URL" \
  -H "x-bridge-secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"from":"+1555","body":"what is the capital of France?","chatType":"direct","senderE164":"+1555","accountId":"default"}'

# Turn 2 — context flows (bridge passes context_summary to classify_intent)
curl -s -X POST "$URL" \
  -H "x-bridge-secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"from":"+1555","body":"and what is its population?","chatType":"direct","senderE164":"+1555","accountId":"default"}'

# Reset the session
curl -s -X POST "$URL" \
  -H "x-bridge-secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"from":"+1555","body":"reset","chatType":"direct","senderE164":"+1555","accountId":"default"}'
```

Watch the bridge logs to see `session resolved` entries with `decision` and `reason` fields.

---

## File Map

| File                                           | Role                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `apps/kernel/src/sessions/service.js`          | CRUD helpers for the `sessions` table                       |
| `apps/kernel/src/sessions/resolver.js`         | 5-policy decision chain                                     |
| `apps/kernel/src/sessions/summarizer.js`       | LLM/template context summary generator                      |
| `apps/kernel/src/sessions/drift_classifier.js` | Optional LLM topic-drift gate                               |
| `apps/kernel/src/sessions/routes.js`           | Fastify route handlers                                      |
| `clawos/bridge/src/kernel.js`                  | `kernelResolveSession` + `kernelUpdateSession` HTTP helpers |
| `clawos/bridge/src/index.js`                   | Session wiring in webhook handler, `routeMessage`, handlers |
| `clawos/scripts/test_sessions.sh`              | Smoke test suite (12 checks)                                |
