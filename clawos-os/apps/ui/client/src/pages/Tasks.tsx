import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { kernelApi } from "../api/kernel";
import { StatusBadge } from "../components/StatusBadge";

const FILTERS = ["all", "queued", "running", "succeeded", "failed"] as const;

function relTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) {return `${Math.floor(diff / 1000)}s ago`;}
  if (diff < 3_600_000) {return `${Math.floor(diff / 60_000)}m ago`;}
  if (diff < 86_400_000) {return `${Math.floor(diff / 3_600_000)}h ago`;}
  return new Date(ts).toLocaleDateString();
}

export function Tasks() {
  const [filter, setFilter] = useState<string>("all");
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["tasks", filter],
    queryFn: () =>
      kernelApi.listTasks({ limit: 100, ...(filter !== "all" ? { status: filter } : {}) }),
    refetchInterval: 8_000,
  });

  const tasks = data?.tasks ?? [];

  return (
    <div className="animate-rise">
      <div className="page-header row">
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-subtitle">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="row" style={{ marginBottom: 16, gap: 6 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`btn btn-sm${filter === f ? " btn-primary" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {isLoading ? (
          <div style={{ padding: 24 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 40, marginBottom: 8 }} />
            ))}
          </div>
        ) : error ? (
          <div className="callout callout-danger" style={{ margin: 20 }}>
            Failed to load tasks: {(error).message}
          </div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">✅</div>
            <div className="empty-title">No tasks{filter !== "all" ? ` with status "${filter}"` : ""}</div>
            <div className="empty-desc">
              {filter === "all"
                ? "Send a message via WhatsApp to create your first task."
                : `Try a different filter or wait for tasks to change status.`}
            </div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Workspace</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr
                  key={t.task_id}
                  className="clickable"
                  onClick={() => navigate(`/tasks/${t.task_id}`)}
                >
                  <td>
                    <div style={{ fontWeight: 500, color: "var(--text-strong)" }}>{t.title}</div>
                    <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>{t.task_id}</div>
                  </td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="mono muted" style={{ fontSize: 11 }}>{t.workspace_id.slice(0, 16)}…</td>
                  <td className="muted" style={{ fontSize: 12 }}>{relTime(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
