import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

export function Config() {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: kernelApi.health,
    refetchInterval: 30_000,
  });

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Config</h1>
        <p className="page-subtitle">System configuration and kernel settings</p>
      </div>

      {/* Current kernel info */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Kernel</div>
        <div className="grid-2" style={{ gap: 16 }}>
          <div>
            <div className="card-label">Version</div>
            <div className="mono" style={{ fontSize: 14 }}>v{health?.version ?? "–"}</div>
          </div>
          <div>
            <div className="card-label">Database</div>
            <div className="mono" style={{ fontSize: 14 }}>{health?.db ?? "–"}</div>
          </div>
          <div>
            <div className="card-label">Port</div>
            <div className="mono" style={{ fontSize: 14 }}>18888</div>
          </div>
          <div>
            <div className="card-label">UI Port</div>
            <div className="mono" style={{ fontSize: 14 }}>18887</div>
          </div>
          <div>
            <div className="card-label">Bridge Port</div>
            <div className="mono" style={{ fontSize: 14 }}>18790</div>
          </div>
          <div>
            <div className="card-label">Gateway Port</div>
            <div className="mono" style={{ fontSize: 14 }}>18889</div>
          </div>
        </div>
      </div>

      <div className="coming-soon" style={{ paddingTop: 40 }}>
        <span className="coming-tag">v2</span>
        <h2 className="coming-title">Advanced configuration</h2>
        <p className="coming-desc">
          Edit kernel settings, environment variables, model selection, timeout values, and more — all from the UI.
        </p>
        <div className="coming-features">
          {["Model selection", "Timeout config", "Rate limits", "Workspace settings", "Export config"].map(f => (
            <span key={f} className="coming-feature">{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
