const MOCK_SKILLS = [
  { name: "web_search",         type: "tool",   desc: "Search the web via Brave API",          enabled: true  },
  { name: "read_file",          type: "tool",   desc: "Read files from the workspace",          enabled: true  },
  { name: "write_file",         type: "tool",   desc: "Write files to the workspace",           enabled: true  },
  { name: "run_shell",          type: "tool",   desc: "Execute shell commands",                 enabled: true  },
  { name: "send_email",         type: "tool",   desc: "Send emails via SMTP",                   enabled: false },
  { name: "summarize_document", type: "action", desc: "Summarize PDFs and documents",           enabled: true  },
  { name: "interpret_result",   type: "action", desc: "Format results into friendly messages",  enabled: true  },
  { name: "classify_intent",    type: "action", desc: "Classify user message intent via LLM",   enabled: true  },
  { name: "web_researcher",     type: "agent",  desc: "Ephemeral agent for web research tasks", enabled: true  },
  { name: "shell_executor",     type: "agent",  desc: "Ephemeral agent for shell commands",     enabled: true  },
  { name: "doc_processor",      type: "agent",  desc: "Ephemeral agent for document tasks",     enabled: true  },
  { name: "file_reader",        type: "agent",  desc: "Ephemeral agent for file reading",       enabled: true  },
];

const TYPE_BADGE: Record<string, string> = {
  tool:   "badge-accent",
  action: "badge-info",
  agent:  "badge-ok",
};

export function Skills() {
  return (
    <div className="animate-rise">
      <div className="page-header row">
        <div>
          <h1 className="page-title">Skills</h1>
          <p className="page-subtitle">Registered tools, actions, and agent workers</p>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" disabled title="Coming in v2">+ Add Skill</button>
      </div>

      <div className="callout callout-info" style={{ marginBottom: 20 }}>
        <span>ℹ️</span>
        <span>Skills are auto-registered from the kernel. Full management (enable/disable, configure, custom skills) coming in v2.</span>
      </div>

      <div className="grid-2">
        {MOCK_SKILLS.map((s) => (
          <div key={s.name} className="card card-sm">
            <div className="row" style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-strong)", flex: 1, fontFamily: "var(--mono)" }}>
                {s.name}
              </span>
              <span className={`badge ${TYPE_BADGE[s.type]}`}>{s.type}</span>
              <span className={`badge ${s.enabled ? "badge-ok" : "badge-neutral"}`} style={{ marginLeft: 6 }}>
                {s.enabled ? "on" : "off"}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
