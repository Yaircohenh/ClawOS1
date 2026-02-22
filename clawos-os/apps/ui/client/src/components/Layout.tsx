import { useState, useEffect, useCallback } from "react";
import { Link, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("clawos-theme") as "dark" | "light") ?? "dark";
  });
  useEffect(() => {
    document.documentElement.className = theme;
    localStorage.setItem("clawos-theme", theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}

export function Layout() {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const { theme, toggle } = useTheme();

  // Global status bar
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: kernelApi.health,
    refetchInterval: 10_000,
    retry: false,
  });
  const { data: tasksData } = useQuery({
    queryKey: ["tasks-summary"],
    queryFn: () => kernelApi.listTasks({ limit: 100 }),
    refetchInterval: 10_000,
    retry: false,
  });
  const { data: approvalsData } = useQuery({
    queryKey: ["approvals"],
    queryFn: kernelApi.listApprovals,
    refetchInterval: 8_000,
    retry: false,
  });

  const activeTasks = (tasksData?.tasks ?? []).filter((t) => t.status === "running" || t.status === "queued").length;
  const pendingApprovals = approvalsData?.approvals?.length ?? 0;
  const kernelOk = health?.ok ?? false;

  // ⌘K handler
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setCmdOpen((o) => !o);
    }
    if (e.key === "Escape") { setCmdOpen(false); setNotifOpen(false); }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <div className="shell">
      {/* Topbar */}
      <header className="topbar">
        <Link to="/" className="topbar-logo">
          <div className="logo-claw">🐾</div>
          ClawOS
        </Link>

        <button
          className="btn btn-sm"
          style={{ marginLeft: 4, fontSize: 12, color: "var(--muted)", background: "transparent", border: "1px solid var(--border)" }}
          onClick={() => setCmdOpen(true)}
          title="Command palette (⌘K)"
        >
          ⌘K
        </button>

        <div className="topbar-spacer" />

        {/* Status indicators */}
        <div className="topbar-status">
          <span className={`dot${!kernelOk ? " danger" : ""}`} />
          <span>{kernelOk ? "Kernel OK" : "Kernel offline"}</span>
        </div>

        {activeTasks > 0 && (
          <Link to="/tasks" className="topbar-pill">
            ✅ {activeTasks} active
          </Link>
        )}

        {pendingApprovals > 0 && (
          <Link to="/approvals" className="topbar-pill warn">
            🔔 {pendingApprovals} approval{pendingApprovals > 1 ? "s" : ""}
          </Link>
        )}

        {/* Notification bell */}
        <button className="topbar-btn" onClick={() => setNotifOpen((o) => !o)} title="Notifications">
          🔔
          {pendingApprovals > 0 && (
            <span style={{
              position: "absolute", top: 4, right: 4,
              width: 8, height: 8, borderRadius: "50%",
              background: "var(--warn)", border: "2px solid var(--bg-1)",
            }} />
          )}
        </button>

        {/* Theme toggle */}
        <button className="topbar-btn" onClick={toggle} title="Toggle theme">
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>

      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="main">
        <Outlet />
      </main>

      {/* Command palette */}
      {cmdOpen && <CommandPalette onClose={() => setCmdOpen(false)} />}

      {/* Notification drawer */}
      {notifOpen && (
        <div className="notif-drawer">
          <div className="notif-header row">
            <span style={{ flex: 1 }}>Notifications</span>
            <button className="btn btn-sm" onClick={() => setNotifOpen(false)}>✕</button>
          </div>
          {pendingApprovals > 0 ? (
            <div className="notif-item">
              <div className="notif-title">🔔 {pendingApprovals} pending approval{pendingApprovals > 1 ? "s" : ""}</div>
              <div className="notif-body">Actions are waiting for your review.</div>
            </div>
          ) : (
            <div className="notif-item" style={{ color: "var(--muted)", textAlign: "center", padding: "24px" }}>
              All clear — nothing to review.
            </div>
          )}
          {!kernelOk && (
            <div className="notif-item">
              <div className="notif-title" style={{ color: "var(--danger)" }}>⚠️ Kernel unreachable</div>
              <div className="notif-body">Check that the kernel process is running on port 18888.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
