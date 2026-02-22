export function Sessions() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Sessions</h1>
        <p className="page-subtitle">Active user sessions and conversation history</p>
      </div>
      <div className="coming-soon">
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Session management</h2>
        <p className="coming-desc">
          Track and manage all active sessions across channels. View conversation history, terminate sessions, and replay events.
        </p>
        <div className="coming-features">
          {["Per-sender sessions", "Message history", "Session replay", "Manual override", "Timeout config"].map(f => (
            <span key={f} className="coming-feature">{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
