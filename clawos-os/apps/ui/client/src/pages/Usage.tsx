export function Usage() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Usage</h1>
        <p className="page-subtitle">Model usage, token spend, and budget tracking</p>
      </div>
      <div className="coming-soon">
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Usage analytics</h2>
        <p className="coming-desc">
          Track exactly which models are used, how many tokens are consumed, and how much it costs. Set budgets and get alerts.
        </p>
        <div className="coming-features">
          {[
            "Per-model breakdown", "Token counters", "Cost estimates",
            "Daily/weekly/monthly", "Budget alerts", "Export CSV"
          ].map(f => (
            <span key={f} className="coming-feature">{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
