import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { kernelApi } from "../api/kernel";
import { StatusBadge } from "../components/StatusBadge";
import { EventFeed } from "../components/EventFeed";

function fmt(ts: string) {
  return new Date(ts).toLocaleString();
}

export function Overview() {
  const { data: tasksData } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => kernelApi.listTasks({ limit: 50 }),
    refetchInterval: 10_000,
  });
  const { data: eventsData } = useQuery({
    queryKey: ["events-live"],
    queryFn: () => kernelApi.listEvents({ limit: 20 }),
    refetchInterval: 5_000,
  });
  const { data: approvalsData } = useQuery({
    queryKey: ["approvals"],
    queryFn: kernelApi.listApprovals,
    refetchInterval: 8_000,
  });
  const { data: connectionsData } = useQuery({
    queryKey: ["connections"],
    queryFn: kernelApi.listConnections,
  });
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: kernelApi.health,
    refetchInterval: 10_000,
  });

  const tasks = tasksData?.tasks ?? [];
  const active = tasks.filter((t) => t.status === "running").length;
  const total = tasks.length;
  const pending = approvalsData?.approvals?.length ?? 0;
  const connectedProviders = (connectionsData?.connections ?? []).filter(
    (c) => c.status === "connected"
  ).length;

  const noConnections =
    connectionsData?.connections &&
    connectionsData.connections.every((c) => c.status !== "connected");

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Overview</h1>
        <p className="page-subtitle">ClawOS control plane · {health?.ok ? "Kernel running" : "Kernel offline"}</p>
      </div>

      {/* Onboarding banner */}
      {noConnections && (
        <div className="callout callout-warn" style={{ marginBottom: 20 }}>
          <span>⚠️</span>
          <span>
            No API connections configured.{" "}
            <Link to="/connections" style={{ color: "inherit", fontWeight: 600 }}>
              Set up Connections →
            </Link>
          </span>
        </div>
      )}

      {/* Stats */}
      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Total tasks</div>
          <div className="stat-value">{total}</div>
          <div className="stat-sub">{active} running</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active tasks</div>
          <div className={`stat-value${active > 0 ? " ok" : ""}`}>{active}</div>
          <div className="stat-sub">queued or running</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pending approvals</div>
          <div className={`stat-value${pending > 0 ? " warn" : ""}`}>{pending}</div>
          <div className="stat-sub">{pending > 0 ? "action required" : "all clear"}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Connected providers</div>
          <div className={`stat-value${connectedProviders > 0 ? " ok" : ""}`}>{connectedProviders}</div>
          <div className="stat-sub">API keys active</div>
        </div>
      </div>

      <div className="grid-2" style={{ gap: 20 }}>
        {/* Recent tasks */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="row" style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
            <span className="card-title" style={{ marginBottom: 0 }}>Recent Tasks</span>
            <div style={{ flex: 1 }} />
            <Link to="/tasks" className="btn btn-sm">View all</Link>
          </div>
          {tasks.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">✅</div>
              <div className="empty-title">No tasks yet</div>
              <div className="empty-desc">Send a message via WhatsApp to create your first task.</div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.slice(0, 8).map((t) => (
                  <tr key={t.task_id} className="clickable" onClick={() => location.href = `/tasks/${t.task_id}`}>
                    <td className="truncate" style={{ maxWidth: 200 }}>{t.title}</td>
                    <td><StatusBadge status={t.status} size="sm" /></td>
                    <td className="muted mono" style={{ fontSize: 11 }}>
                      {fmt(t.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Live events */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="row" style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
            <span className="card-title" style={{ marginBottom: 0 }}>Live Events</span>
            <div style={{ flex: 1 }} />
            <Link to="/logs" className="btn btn-sm">View logs</Link>
          </div>
          <div style={{ padding: "12px 20px" }}>
            <EventFeed events={eventsData?.events ?? []} limit={15} />
          </div>
        </div>
      </div>
    </div>
  );
}
