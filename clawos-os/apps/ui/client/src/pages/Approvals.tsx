import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

function fmt(ts: string) { return new Date(ts).toLocaleString(); }

const RISK_BADGE: Record<string, string> = {
  low: "badge-ok", medium: "badge-warn", high: "badge-danger",
};

export function Approvals() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["approvals"],
    queryFn: kernelApi.listApprovals,
    refetchInterval: 5_000,
  });

  const approveMut = useMutation({
    mutationFn: kernelApi.approve,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const rejectMut = useMutation({
    mutationFn: kernelApi.reject,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const approvals = data?.approvals ?? [];

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Approvals</h1>
        <p className="page-subtitle">
          {approvals.length > 0
            ? `${approvals.length} pending — review and approve or reject`
            : "Nothing to approve right now"}
        </p>
      </div>

      {isLoading ? (
        <div>{[1,2].map(i => <div key={i} className="skeleton" style={{ height: 100, marginBottom: 12 }} />)}</div>
      ) : approvals.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔔</div>
          <div className="empty-title">Nothing to approve</div>
          <div className="empty-desc">
            The system is running autonomously. High-risk actions will appear here for your review.
          </div>
        </div>
      ) : (
        <div className="stack">
          {approvals.map((a) => (
            <div key={a.approval_id} className="card">
              <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text-strong)" }}>
                  {a.action_type}
                </span>
                <span className={`badge ${RISK_BADGE[a.risk_level] ?? "badge-neutral"}`}>
                  {a.risk_level} risk
                </span>
                {!a.reversible && (
                  <span className="badge badge-danger">irreversible</span>
                )}
                <span style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: 12 }}>{fmt(a.created_at)}</span>
              </div>

              {a.description && (
                <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 10, lineHeight: 1.5 }}>
                  {a.description}
                </div>
              )}

              {a.payload && Object.keys(a.payload).length > 0 && (
                <pre style={{
                  background: "var(--bg)", border: "1px solid var(--border)",
                  borderRadius: "var(--r-md)", padding: "10px 12px",
                  fontSize: 12, fontFamily: "var(--mono)", marginBottom: 14,
                  overflowX: "auto", maxHeight: 120, overflowY: "auto"
                }}>
                  {JSON.stringify(a.payload, null, 2)}
                </pre>
              )}

              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => approveMut.mutate(a.approval_id)}
                  disabled={approveMut.isPending}
                >
                  ✅ Approve
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => rejectMut.mutate(a.approval_id)}
                  disabled={rejectMut.isPending}
                >
                  ✕ Reject
                </button>
                <span className="mono muted" style={{ fontSize: 11, marginLeft: 8 }}>
                  {a.approval_id}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
