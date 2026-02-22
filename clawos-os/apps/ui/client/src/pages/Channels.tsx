const CHANNELS = [
  { icon: "📱", name: "WhatsApp",  status: "active",  desc: "Receive messages and run tasks via WhatsApp" },
  { icon: "✈️",  name: "Telegram", status: "planned", desc: "Connect via Telegram bot" },
  { icon: "💬", name: "Slack",     status: "planned", desc: "Slack app integration" },
  { icon: "🎮", name: "Discord",   status: "planned", desc: "Discord bot" },
  { icon: "📨", name: "Email",     status: "planned", desc: "Trigger tasks via email" },
  { icon: "🌐", name: "Web API",   status: "planned", desc: "REST webhook endpoint" },
];

export function Channels() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Channels</h1>
        <p className="page-subtitle">Configure communication channels</p>
      </div>
      <div className="coming-soon" style={{ paddingBottom: 40 }}>
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Manage your channels</h2>
        <p className="coming-desc">Configure every channel ClawOS can receive messages from.</p>
      </div>
      <div className="grid-2" style={{ marginTop: 0 }}>
        {CHANNELS.map((c) => (
          <div key={c.name} className="card" style={{ opacity: c.status === "active" ? 1 : 0.6 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 22 }}>{c.icon}</span>
              <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-strong)" }}>{c.name}</span>
              <span
                className={`badge ${c.status === "active" ? "badge-ok" : "badge-neutral"}`}
                style={{ marginLeft: "auto" }}
              >
                {c.status}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>{c.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
