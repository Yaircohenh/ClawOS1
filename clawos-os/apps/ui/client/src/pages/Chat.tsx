export function Chat() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Chat</h1>
        <p className="page-subtitle">Direct chat interface — coming soon</p>
      </div>
      <div className="coming-soon">
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Chat directly with ClawOS</h2>
        <p className="coming-desc">
          Send messages, run tasks, and review results without leaving the dashboard.
          No WhatsApp required.
        </p>
        <div className="coming-features">
          {["Text & voice input", "File uploads", "Task history", "Real-time streaming", "Multi-modal"].map((f) => (
            <span key={f} className="coming-feature">{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
