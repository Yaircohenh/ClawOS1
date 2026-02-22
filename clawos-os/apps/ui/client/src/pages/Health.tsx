import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

function uptime(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) {return `${s}s`;}
  if (s < 3600) {return `${Math.floor(s / 60)}m ${s % 60}s`;}
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function Health() {
  const { data: kernel, isLoading: kernelLoading, error: kernelErr } = useQuery({
    queryKey: ["health"],
    queryFn: kernelApi.health,
    refetchInterval: 10_000,
    retry: false,
  });

  const SERVICES = [
    {
      name: "Kernel",
      port: 18888,
      description: "Core logic, DB, action orchestration",
      data: kernel,
      loading: kernelLoading,
      error: kernelErr,
    },
    {
      name: "Bridge",
      port: 18790,
      description: "WhatsApp ↔ Kernel connector",
      data: null,
      loading: false,
      error: null,
      externalUrl: "http://localhost:18790/health",
    },
    {
      name: "UI Server",
      port: 18887,
      description: "This dashboard",
      data: { ok: true },
      loading: false,
      error: null,
    },
    {
      name: "Gateway",
      port: 18889,
      description: "OpenClaw WebSocket gateway",
      data: null,
      loading: false,
      error: null,
      placeholder: true,
    },
    {
      name: "Tool Runner",
      port: 18890,
      description: "Tool execution service",
      data: null,
      loading: false,
      error: null,
      placeholder: true,
    },
  ];

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Health</h1>
        <p className="page-subtitle">System component status · auto-refreshes every 10s</p>
      </div>

      <div className="grid-2">
        {SERVICES.map((svc) => {
          const ok = svc.error ? false : svc.data?.ok ?? null;
          const isPlaceholder = svc.placeholder;

          return (
            <div key={svc.name} className="card">
              <div className="row" style={{ marginBottom: 14 }}>
                <div
                  style={{
                    width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                    background: isPlaceholder
                      ? "var(--muted-2)"
                      : ok === null
                      ? "var(--muted)"
                      : ok
                      ? "var(--ok)"
                      : "var(--danger)",
                    boxShadow: ok && !isPlaceholder ? "0 0 6px var(--ok)" : "none",
                  }}
                />
                <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text-strong)" }}>
                  {svc.name}
                </span>
                <span
                  className={`badge ${
                    isPlaceholder
                      ? "badge-neutral"
                      : svc.loading
                      ? "badge-neutral"
                      : ok
                      ? "badge-ok"
                      : "badge-danger"
                  }`}
                  style={{ marginLeft: "auto" }}
                >
                  {isPlaceholder ? "unknown" : svc.loading ? "checking…" : ok ? "healthy" : "unreachable"}
                </span>
              </div>

              <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>{svc.description}</div>

              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <div>
                  <div className="card-label">Port</div>
                  <div className="mono" style={{ fontSize: 13 }}>{svc.port}</div>
                </div>
                {"uptime_ms" in (svc.data ?? {}) && (
                  <div>
                    <div className="card-label">Uptime</div>
                    <div className="mono" style={{ fontSize: 13 }}>{uptime((svc.data as { uptime_ms: number }).uptime_ms)}</div>
                  </div>
                )}
                {"version" in (svc.data ?? {}) && (
                  <div>
                    <div className="card-label">Version</div>
                    <div className="mono" style={{ fontSize: 13 }}>v{(svc.data as { version: string }).version}</div>
                  </div>
                )}
                {"db" in (svc.data ?? {}) && (
                  <div>
                    <div className="card-label">Database</div>
                    <div className="mono" style={{ fontSize: 13 }}>{(svc.data as { db: string }).db}</div>
                  </div>
                )}
                {isPlaceholder && (
                  <div className="muted" style={{ fontSize: 12 }}>Health check coming in v2</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
