import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

function fmt(ts: string) { return new Date(ts).toLocaleString(); }
function timeLeft(expires: string) {
  const ms = new Date(expires).getTime() - Date.now();
  if (ms < 0) {return "expired";}
  if (ms < 60_000) {return `${Math.floor(ms / 1000)}s left`;}
  return `${Math.floor(ms / 60_000)}m left`;
}

export function Approvals() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["approvals"],
    queryFn: kernelApi.listApprovals,
    refetchInterval: 5_000,
  });

  const approveMut = useMutation({
    mutationFn: kernelApi.approve,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const rejectMut = useMutation({
    mutationFn: kernelApi.reject,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["approvals"] }),
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
                  Action Request
                </span>
                <span className="badge badge-warn">pending</span>
                <span style={{ flex: 1 }} />
                <span className="badge badge-neutral" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                  {timeLeft(a.expires_at)}
                </span>
              </div>

              <div className="stack" style={{ gap: 6, marginBottom: 14, fontSize: 13 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted" style={{ width: 120, flexShrink: 0 }}>Request ID</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text)" }}>{a.action_request_id}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted" style={{ width: 120, flexShrink: 0 }}>Requested by</span>
                  <span style={{ color: "var(--text)" }}>{a.requested_by}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted" style={{ width: 120, flexShrink: 0 }}>Expires</span>
                  <span style={{ color: "var(--text)" }}>{fmt(a.expires_at)}</span>
                </div>
              </div>

              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => approveMut.mutate(a.approval_id)}
                  disabled={approveMut.isPending || rejectMut.isPending}
                >
                  ✅ Approve
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => rejectMut.mutate(a.approval_id)}
                  disabled={approveMut.isPending || rejectMut.isPending}
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
