import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";
import { StatusBadge } from "../components/StatusBadge";
import { EventFeed } from "../components/EventFeed";

function fmt(ts: string) { return new Date(ts).toLocaleString(); }

export function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const [artifactOpen, setArtifactOpen] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => kernelApi.getTask(taskId!),
    refetchInterval: 5_000,
    enabled: !!taskId,
  });

  const { data: eventsData } = useQuery({
    queryKey: ["task-events", taskId],
    queryFn: () => kernelApi.getTaskEvents(taskId!),
    refetchInterval: 5_000,
    enabled: !!taskId,
  });

  if (isLoading) {return (
    <div style={{ padding: 24 }}>
      {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 60, marginBottom: 12 }} />)}
    </div>
  );}

  if (error || !data?.task) {return (
    <div>
      <Link to="/tasks" className="btn btn-sm" style={{ marginBottom: 16 }}>← Tasks</Link>
      <div className="callout callout-danger">Task not found or could not be loaded.</div>
    </div>
  );}

  const { task, artifacts = [], subagents = [] } = data;
  let contract: Record<string, unknown> | null = null;
  try { contract = JSON.parse(task.contract_json); } catch {}

  return (
    <div className="animate-rise">
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <Link to="/tasks" className="btn btn-sm" style={{ marginBottom: 12 }}>← Tasks</Link>
        <div className="row">
          <h1 className="page-title" style={{ flex: 1 }}>{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>
        <div className="row muted" style={{ fontSize: 12, marginTop: 6, gap: 16 }}>
          <span className="mono">{task.task_id}</span>
          <span>Created {fmt(task.created_at)}</span>
          <span>{task.workspace_id}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Contract */}
        {contract && (
          <div className="card">
            <div className="card-title">📄 Contract</div>
            {!!contract.objective && (
              <div style={{ marginBottom: 12 }}>
                <div className="card-label">Objective</div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>{typeof contract.objective === "string" ? contract.objective : JSON.stringify(contract.objective)}</div>
              </div>
            )}
            {(contract.scope as { tools?: string[] })?.tools && (
              <div style={{ marginBottom: 12 }}>
                <div className="card-label">Tools</div>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {((contract.scope as { tools: string[] }).tools ?? []).map((t) => (
                    <span key={t} className="badge badge-accent">{t}</span>
                  ))}
                </div>
              </div>
            )}
            {Array.isArray(contract.deliverables) && contract.deliverables.length > 0 && (
              <div>
                <div className="card-label">Deliverables</div>
                <ul style={{ paddingLeft: 16, fontSize: 13, color: "var(--muted)" }}>
                  {(contract.deliverables as string[]).map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Subagents */}
        <div className="card">
          <div className="card-title">🤖 Subagents ({subagents.length})</div>
          {subagents.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No subagents spawned yet.</div>
          ) : (
            <div className="stack">
              {subagents.map((sa) => (
                <div key={sa.subagent_id} style={{
                  background: "var(--bg)", border: "1px solid var(--border)",
                  borderRadius: "var(--r-md)", padding: "12px"
                }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{sa.worker_type}</span>
                    <StatusBadge status={sa.status} size="sm" />
                  </div>
                  <div className="mono muted" style={{ fontSize: 11 }}>{sa.subagent_id}</div>
                  {sa.finished_at && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      Finished {fmt(sa.finished_at)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Events */}
        <div className="card">
          <div className="card-title">⚡ Events ({eventsData?.events?.length ?? 0})</div>
          <EventFeed events={eventsData?.events ?? []} limit={30} />
        </div>

        {/* Artifacts */}
        <div className="card">
          <div className="card-title">📦 Artifacts ({artifacts.length})</div>
          {artifacts.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No artifacts yet.</div>
          ) : (
            <div className="stack">
              {artifacts.map((a) => {
                const isOpen = artifactOpen === a.artifact_id;
                let preview = a.content ?? "";
                try { preview = JSON.stringify(JSON.parse(preview), null, 2); } catch {}
                return (
                  <div key={a.artifact_id} style={{
                    background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: "var(--r-md)", overflow: "hidden"
                  }}>
                    <div
                      className="row"
                      style={{ padding: "10px 12px", cursor: "pointer" }}
                      onClick={() => setArtifactOpen(isOpen ? null : a.artifact_id)}
                    >
                      <span className="badge badge-neutral">{a.type}</span>
                      <span className="mono muted" style={{ fontSize: 11, flex: 1 }}>{a.artifact_id.slice(0, 20)}</span>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
                    </div>
                    {isOpen && preview && (
                      <pre style={{
                        padding: "10px 12px", fontSize: 11,
                        color: "var(--text)", fontFamily: "var(--mono)",
                        overflowX: "auto", background: "var(--bg-1)",
                        borderTop: "1px solid var(--border)", maxHeight: 300,
                        overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all"
                      }}>
                        {preview.slice(0, 2000)}{preview.length > 2000 ? "\n…" : ""}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
