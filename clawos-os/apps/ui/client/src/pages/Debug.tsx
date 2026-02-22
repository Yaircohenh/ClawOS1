import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

export function Debug() {
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: kernelApi.health });
  const { data: tasks } = useQuery({ queryKey: ["tasks"], queryFn: () => kernelApi.listTasks({ limit: 100 }) });
  const { data: events } = useQuery({ queryKey: ["events", 100], queryFn: () => kernelApi.listEvents({ limit: 100 }) });

  const tasksByStatus = (tasks?.tasks ?? []).reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Debug</h1>
        <p className="page-subtitle">Kernel internals and diagnostic information</p>
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total tasks</div>
          <div className="stat-value mono">{tasks?.tasks?.length ?? "–"}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total events</div>
          <div className="stat-value mono">{events?.events?.length ?? "–"}</div>
          <div className="stat-sub">(last 100)</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Kernel uptime</div>
          <div className="stat-value mono" style={{ fontSize: 20 }}>
            {health?.uptime_ms ? `${Math.floor(health.uptime_ms / 1000)}s` : "–"}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-title">Tasks by status</div>
          {Object.entries(tasksByStatus).length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No tasks in DB.</div>
          ) : (
            Object.entries(tasksByStatus).map(([status, count]) => (
              <div key={status} className="row" style={{ marginBottom: 8 }}>
                <span className={`badge status-${status}`}>{status}</span>
                <span className="mono" style={{ fontSize: 14 }}>{count}</span>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <div className="card-title">Kernel health raw</div>
          <pre style={{
            fontFamily: "var(--mono)", fontSize: 12,
            color: "var(--text)", background: "var(--bg)",
            borderRadius: "var(--r-md)", padding: "10px 12px",
            overflowX: "auto"
          }}>
            {health ? JSON.stringify(health, null, 2) : "Loading…"}
          </pre>
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-title">Recent events (last 20)</div>
          {(events?.events ?? []).slice(0, 20).map((e) => (
            <div key={e.event_id} className="row" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)", gap: 12 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{e.ts.slice(11, 19)}</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--accent)" }}>{e.type}</span>
              <span className="mono muted" style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.actor_id}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
