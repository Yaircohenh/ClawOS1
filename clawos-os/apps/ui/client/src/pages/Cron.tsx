const MOCK_CRONS = [
  { name: "Daily report",        schedule: "Every day at 9:00am",   status: "active",  last: "Yesterday 9:00" },
  { name: "Weekly backup",       schedule: "Every Monday at 8:00am", status: "active", last: "Mon 8:00" },
  { name: "Monthly billing run", schedule: "1st of month",          status: "paused",  last: "Feb 1st" },
];

export function Cron() {
  return (
    <div className="animate-rise">
      <div className="page-header row">
        <div>
          <h1 className="page-title">Cron Jobs</h1>
          <p className="page-subtitle">Recurring automated tasks</p>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" disabled title="Coming in v2">+ New Job</button>
      </div>

      <div className="callout callout-info" style={{ marginBottom: 20 }}>
        <span>ℹ️</span>
        <span>Cron job scheduling is coming in v2. The entries below are a preview of the planned UI.</span>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", opacity: 0.7 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {MOCK_CRONS.map((c) => (
              <tr key={c.name}>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td className="muted" style={{ fontSize: 12 }}>{c.schedule}</td>
                <td>
                  <span className={`badge ${c.status === "active" ? "badge-ok" : "badge-neutral"}`}>
                    {c.status}
                  </span>
                </td>
                <td className="muted mono" style={{ fontSize: 12 }}>{c.last}</td>
                <td>
                  <button className="btn btn-sm" disabled>Run now</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
