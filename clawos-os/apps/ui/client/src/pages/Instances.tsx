export function Instances() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Instances</h1>
        <p className="page-subtitle">Manage ClawOS instances and deployments</p>
      </div>
      <div className="coming-soon">
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Multi-instance support</h2>
        <p className="coming-desc">
          Manage multiple ClawOS instances across environments — local, cloud, and edge.
        </p>
        <div className="coming-features">
          {["One-click deploy", "Health monitoring", "Resource usage", "Remote config", "Scaling controls"].map(f => (
            <span key={f} className="coming-feature">{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
