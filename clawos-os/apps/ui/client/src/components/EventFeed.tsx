import type { TaskEvent } from "../api/kernel";

const DOT_CLASS: Record<string, string> = {
  "task.created":     "task",
  "subagent.spawned": "agent",
  "token.issued":     "token",
  "worker.started":   "worker",
  "worker.completed": "worker",
  "worker.failed":    "danger",
  "verify.passed":    "token",
  "verify.failed":    "verify",
  "agent.registered": "agent",
};

function relTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) {return `${Math.floor(diff / 1000)}s ago`;}
  if (diff < 3_600_000) {return `${Math.floor(diff / 60_000)}m ago`;}
  return new Date(ts).toLocaleTimeString();
}

interface Props {
  events: TaskEvent[];
  limit?: number;
}

export function EventFeed({ events, limit = 20 }: Props) {
  const shown = events.slice(0, limit);
  if (shown.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "30px 0" }}>
        <div className="empty-icon">⚡</div>
        <div className="empty-desc">No events yet</div>
      </div>
    );
  }
  return (
    <div className="timeline">
      {shown.map((e) => (
        <div key={e.event_id} className="timeline-item">
          <div className={`timeline-dot ${DOT_CLASS[e.type] ?? "system"}`} />
          <div>
            <div className="timeline-type">{e.type}</div>
            <div className="timeline-actor">
              {e.actor_kind} · {e.actor_id.slice(0, 20)}
              {e.task_id ? ` · ${e.task_id.slice(0, 16)}` : ""}
            </div>
          </div>
          <div className="timeline-time">{relTime(e.ts)}</div>
        </div>
      ))}
    </div>
  );
}
