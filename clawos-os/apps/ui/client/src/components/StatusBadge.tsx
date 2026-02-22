interface Props {
  status: string;
  size?: "sm" | "md";
}

const LABELS: Record<string, string> = {
  queued: "queued", running: "running", succeeded: "done", failed: "failed",
  finished: "done", active: "active", idle: "idle",
  auto: "auto", ask: "ask", block: "block",
  connected: "connected", error: "error", unknown: "unknown", missing: "missing",
  low: "low", medium: "medium", high: "high",
};

export function StatusBadge({ status, size = "md" }: Props) {
  const label = LABELS[status] ?? status;
  const cls = `badge status-${status}${size === "sm" ? " badge-sm" : ""}`;
  return <span className={cls}>{label}</span>;
}
