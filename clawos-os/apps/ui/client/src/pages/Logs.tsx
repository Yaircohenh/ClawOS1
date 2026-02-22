import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";
import { EventFeed } from "../components/EventFeed";

const DOT_MAP: Record<string, string> = {
  "task.created": "task", "subagent.spawned": "agent",
  "token.issued": "token", "worker.started": "worker",
  "worker.completed": "worker", "worker.failed": "danger",
  "verify.passed": "token", "verify.failed": "verify",
};

export function Logs() {
  const [limit, setLimit] = useState(50);

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["events", limit],
    queryFn: () => kernelApi.listEvents({ limit }),
    refetchInterval: 5_000,
  });

  const events = data?.events ?? [];

  const lastUpdate = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : "–";

  return (
    <div className="animate-rise">
      <div className="page-header row">
        <div>
          <h1 className="page-title">Logs</h1>
          <p className="page-subtitle">Global event stream · refreshes every 5s · last: {lastUpdate}</p>
        </div>
        <div style={{ flex: 1 }} />
        <select
          className="select"
          style={{ width: "auto" }}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          {[25, 50, 100, 250].map((n) => (
            <option key={n} value={n}>Last {n}</option>
          ))}
        </select>
      </div>

      <div className="card" style={{ padding: "16px 20px" }}>
        {isLoading ? (
          <div>{[1,2,3,4,5].map(i => <div key={i} className="skeleton" style={{ height: 36, marginBottom: 6 }} />)}</div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📜</div>
            <div className="empty-title">No events yet</div>
            <div className="empty-desc">Events will appear here as tasks run.</div>
          </div>
        ) : (
          <EventFeed events={events} limit={limit} />
        )}
      </div>

      {!isLoading && events.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
          <button className="btn btn-sm" onClick={() => setLimit((l) => l + 50)}>
            Load more
          </button>
        </div>
      )}

      {/* Event type legend */}
      <div className="card card-sm" style={{ marginTop: 20 }}>
        <div className="card-title">Event types</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          {Object.entries(DOT_MAP).map(([type, dot]) => (
            <div key={type} className="row" style={{ gap: 6 }}>
              <div className={`timeline-dot ${dot}`} style={{ width: 8, height: 8, flexShrink: 0 }} />
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{type}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
