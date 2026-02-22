import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

const ACTION_META: Record<string, { icon: string; desc: string; risk: string; reversible: boolean }> = {
  web_search:         { icon: "🔍", desc: "Search the web for information",        risk: "low",    reversible: true },
  read_file:          { icon: "📄", desc: "Read a file from the workspace",         risk: "low",    reversible: true },
  summarize_document: { icon: "📝", desc: "Summarize a document or PDF",            risk: "low",    reversible: true },
  write_file:         { icon: "✏️",  desc: "Write or overwrite a file",             risk: "medium", reversible: false },
  run_shell:          { icon: "💻", desc: "Execute a shell command",                risk: "high",   reversible: false },
  send_email:         { icon: "📧", desc: "Send an email via SMTP",                 risk: "medium", reversible: false },
  classify_intent:    { icon: "🧠", desc: "Classify the intent of a message",       risk: "low",    reversible: true },
  interpret_result:   { icon: "🔎", desc: "Interpret and format an agent result",   risk: "low",    reversible: true },
};

const MODES = ["auto", "ask", "block"] as const;

export function Risk() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["risk_policies"],
    queryFn: kernelApi.listPolicies,
  });

  const setMut = useMutation({
    mutationFn: ({ actionType, mode }: { actionType: string; mode: "auto" | "ask" | "block" }) =>
      kernelApi.setPolicy(actionType, mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["risk_policies"] }),
  });

  const policies = data?.policies ?? [];

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Risk Policies</h1>
        <p className="page-subtitle">Control how actions behave when triggered from WhatsApp or other channels</p>
      </div>

      {/* Legend */}
      <div className="card card-sm" style={{ marginBottom: 20 }}>
        <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge badge-ok">auto</span>
            <span className="muted" style={{ fontSize: 12 }}>Execute immediately without asking</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge badge-warn">ask</span>
            <span className="muted" style={{ fontSize: 12 }}>Request approval before executing</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge badge-danger">block</span>
            <span className="muted" style={{ fontSize: 12 }}>Always deny this action</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {isLoading ? (
          <div style={{ padding: 20 }}>
            {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 56, marginBottom: 8 }} />)}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Risk</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const meta = ACTION_META[p.action_type] ?? { icon: "⚙️", desc: p.action_type };
                return (
                  <tr key={p.action_type}>
                    <td>
                      <div className="row" style={{ gap: 10 }}>
                        <span style={{ fontSize: 18 }}>{meta.icon}</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-strong)" }}>
                            {p.action_type}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>{meta.desc}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-${meta.risk === "high" ? "danger" : meta.risk === "medium" ? "warn" : "ok"}`}>
                        {meta.risk}
                      </span>
                      {!meta.reversible && (
                        <span className="badge badge-neutral" style={{ marginLeft: 6 }}>permanent</span>
                      )}
                    </td>
                    <td>
                      <div className="segment">
                        {MODES.map((m) => (
                          <button
                            key={m}
                            className={`seg-btn${p.mode === m ? ` active-${m}` : ""}`}
                            onClick={() => setMut.mutate({ actionType: p.action_type, mode: m })}
                            disabled={setMut.isPending}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
