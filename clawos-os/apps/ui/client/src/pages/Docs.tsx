const SECTIONS = [
  {
    title: "Architecture",
    icon: "🏗️",
    content: `ClawOS is a layered AI operating system with strict trust boundaries.

Kernel (port 18888) — Core logic, SQLite DB, action orchestration, approval gates.
Bridge (port 18790) — WhatsApp ↔ Kernel connector, message routing.
Gateway (port 18889) — OpenClaw WebSocket gateway for the control UI.
UI (port 18887) — This dashboard.`,
  },
  {
    title: "Agent Architecture",
    icon: "🤖",
    content: `Every user-triggered action flows through a strict AGENT → TASK → SUBAGENT → DCT pipeline.

AGENT: Durable identity (your WhatsApp number). Creates tasks, requests tokens.
TASK: Contract-first work unit with objective, scope, deliverables.
SUBAGENT: Ephemeral worker bound to a single task. Acts only via DCT.
DCT (Delegation Capability Token): HMAC-signed, scoped, time-limited token.

Risk levels:
  LOW / MEDIUM → auto-executed (no approval needed)
  HIGH → approval required via WhatsApp yes/no or this dashboard`,
  },
  {
    title: "Kernel API",
    icon: "🔌",
    content: `Base URL: http://localhost:18888 (or /api/* from this UI)

Key endpoints:
  GET  /kernel/health           — Health check
  GET  /kernel/tasks            — List all tasks
  GET  /kernel/tasks/:id        — Task detail with subagents + artifacts
  GET  /kernel/tasks/:id/events — Task event stream
  GET  /kernel/events           — Global event stream
  GET  /kernel/approvals        — List pending approvals
  POST /kernel/approvals/:id/approve — Approve action
  POST /kernel/approvals/:id/reject  — Reject action
  GET  /kernel/connections      — List API connections
  PUT  /kernel/connections/:p   — Save connection credentials
  GET  /kernel/risk_policies    — List risk policies
  PUT  /kernel/risk_policies/:a — Update policy mode`,
  },
  {
    title: "Risk Policies",
    icon: "🛡️",
    content: `Each action type has a configurable policy mode:

  auto  — Execute immediately without human approval
  ask   — Request approval before executing (WhatsApp yes/no)
  block — Always deny this action type

Default policies:
  web_search, read_file, summarize_document → auto
  write_file → ask
  run_shell, send_email → ask (high risk)`,
  },
  {
    title: "WhatsApp Commands",
    icon: "📱",
    content: `Send messages to your WhatsApp number to interact with ClawOS:

Natural language — "search for X", "run df -h", "read /etc/hosts"
Approval flow    — "yes" to approve, "no" to reject, "edit" to modify
PDF processing   — Send a PDF document to summarize it
Help             — Ask "what can you do?"`,
  },
];

export function Docs() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Documentation</h1>
        <p className="page-subtitle">ClawOS architecture, API reference, and usage guide</p>
      </div>

      <div className="stack" style={{ gap: 20 }}>
        {SECTIONS.map((s) => (
          <div key={s.title} className="card">
            <div className="row" style={{ marginBottom: 12, gap: 10 }}>
              <span style={{ fontSize: 20 }}>{s.icon}</span>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)" }}>{s.title}</h2>
            </div>
            <pre style={{
              fontFamily: "var(--mono)", fontSize: 12.5,
              color: "var(--text)", lineHeight: 1.7,
              whiteSpace: "pre-wrap", wordBreak: "break-word"
            }}>
              {s.content}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
