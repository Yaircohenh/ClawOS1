export function Nodes() {
  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Nodes</h1>
        <p className="page-subtitle">Paired devices and exposed capabilities</p>
      </div>
      <div className="coming-soon">
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Device node management</h2>
        <p className="coming-desc">
          Pair physical devices or remote machines. Expose their capabilities (shell, files, sensors) to ClawOS agents.
        </p>
        <div className="coming-features">
          {[
            "QR code pairing", "Capability registry",
            "Command exposure", "Trust levels",
            "Remote shell", "File sync"
          ].map(f => (
            <span key={f} className="coming-feature">{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
