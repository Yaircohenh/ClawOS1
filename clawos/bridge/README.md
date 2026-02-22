# ClawOS WhatsApp → Kernel Bridge

Routes inbound WhatsApp messages from the existing OpenClaw Baileys session
to the ClawOS Kernel, and delivers Kernel results back to the sender.

## Architecture

```
WhatsApp user
     │  inbound message
     ▼
OpenClaw gateway (port 18789)       ← existing Baileys session, NOT touched
     │  messageSink tap (new, 2-line hook)
     │  POST /webhook/whatsapp
     ▼
clawos/bridge (port 18790)          ← this service
     │
     ├─ !approve ap_xxx  ──►  POST /kernel/approvals/:id/approve
     ├─ !deny ap_xxx     ──►  POST /kernel/approvals/:id/reject
     │
     └─ normal text      ──►  POST /kernel/action_requests
                                    { action_type: "web_search", payload: { q } }
                                         │
                                         ▼
                              ClawOS Kernel (port 18888)
                                         │
                              POST localhost:18791/send  ◄── bridge send server
                                         │                  (inside OpenClaw process)
                                         ▼
                              WhatsApp user  ← reply
```

## Prerequisites

- Node >= 20
- ClawOS Kernel running on port 18888 (set up and unlocked)
- OpenClaw gateway running on port 18789 with active Baileys session

## 1. Kernel setup (first time only)

```bash
# Initialise the kernel with a recovery phrase (do this once):
curl -s -X POST http://localhost:18888/kernel/setup \
  -H "Content-Type: application/json" \
  -d '{"recovery_phrase":"<your-secret-phrase>"}'
# → { "ok": true, "locked": false }

# Verify health:
curl -s http://localhost:18888/kernel/health
# → { "ok": true, ... }
```

If the kernel is restarted in locked mode:

```bash
curl -s -X POST http://localhost:18888/kernel/unlock \
  -H "Content-Type: application/json" \
  -d '{"recovery_phrase":"<your-secret-phrase>"}'
```

## 2. OpenClaw environment variables

Add these to the environment where OpenClaw runs (e.g. `.env` or shell):

```bash
# URL the WhatsApp plugin will POST inbound messages to:
BRIDGE_WEBHOOK_URL=http://localhost:18790/webhook/whatsapp

# Port for the bridge send server (started inside the OpenClaw process):
BRIDGE_SEND_PORT=18791

# Shared secret (must match BRIDGE_SECRET in the bridge .env):
BRIDGE_SECRET=change-me
```

## 3. Bridge setup

```bash
cd clawos/bridge

# Install dependencies:
npm install

# Create config:
cp .env.example .env
# Edit .env — set BRIDGE_SECRET to the same value as above.

# Start:
npm start
```

## 4. Verify the bridge

```bash
# Bridge health (includes kernel reachability):
curl -s http://localhost:18790/health

# Simulate an inbound WhatsApp message:
curl -s -X POST http://localhost:18790/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "x-bridge-secret: change-me" \
  -d '{"from":"+1234567890","body":"What is the capital of France?","chatType":"direct","senderE164":"+1234567890","accountId":"default"}'
```

## 5. Approval flow

When the Kernel requires approval for a dangerous action, the sender receives:

```
Blocked. Approval needed: ap_abc123def456
Reply: !approve ap_abc123def456
```

To approve:

```
!approve ap_abc123def456
```

To deny:

```
!deny ap_abc123def456
```

## Environment reference

| Variable          | Default                       | Description                    |
| ----------------- | ----------------------------- | ------------------------------ |
| `BRIDGE_PORT`     | `18790`                       | Port this service listens on   |
| `BRIDGE_SECRET`   | `""`                          | Shared secret for webhook auth |
| `BRIDGE_SEND_URL` | `http://localhost:18791/send` | Bridge send server URL         |
| `KERNEL_URL`      | `http://localhost:18888`      | ClawOS Kernel URL              |
| `BRIDGE_DATA_DIR` | `data/clawos/bridge/`         | State persistence directory    |
| `LOG_LEVEL`       | `info`                        | Fastify log level              |

## State files

Persisted under `BRIDGE_DATA_DIR` (gitignored):

- `workspaces.json` — maps sender E.164/JID → kernel `workspace_id`
- `approvals.json` — maps `approval_id` → pending approval metadata

## Security notes

- The bridge send server binds to `127.0.0.1` only — not accessible externally.
- All webhook endpoints require `x-bridge-secret` header when `BRIDGE_SECRET` is set.
- The bridge never executes tools directly; all actions go through the Kernel.
- Tool execution for `write_file`, `send_email`, `run_shell` requires explicit approval.
