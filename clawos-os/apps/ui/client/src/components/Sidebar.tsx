import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { kernelApi } from "../api/kernel";

const NAV = [
  {
    group: "OVERVIEW",
    items: [
      { icon: "🏠", label: "Overview",  path: "/" },
      { icon: "💬", label: "Chat",      path: "/chat" },
    ],
  },
  {
    group: "CONTROL",
    items: [
      { icon: "📡", label: "Channels",  path: "/channels" },
      { icon: "🖥️",  label: "Instances", path: "/instances" },
      { icon: "📋", label: "Sessions",  path: "/sessions" },
      { icon: "📊", label: "Usage",     path: "/usage" },
      { icon: "⏰", label: "Cron",      path: "/cron" },
    ],
  },
  {
    group: "AGENTS",
    items: [
      { icon: "✅", label: "Tasks",     path: "/tasks",      live: true },
      { icon: "🔔", label: "Approvals", path: "/approvals",  live: true },
      { icon: "⚡", label: "Skills",    path: "/skills" },
    ],
  },
  {
    group: "NODES",
    items: [
      { icon: "🔌", label: "Nodes",     path: "/nodes" },
    ],
  },
  {
    group: "SYSTEM",
    items: [
      { icon: "🔑", label: "Connections", path: "/connections" },
      { icon: "🛡️",  label: "Risk",       path: "/risk" },
      { icon: "⚙️",  label: "Config",     path: "/config" },
      { icon: "🐛", label: "Debug",      path: "/debug" },
    ],
  },
  {
    group: "MORE",
    items: [
      { icon: "📜", label: "Logs",   path: "/logs" },
      { icon: "❤️",  label: "Health", path: "/health" },
      { icon: "📚", label: "Docs",   path: "/docs" },
    ],
  },
];

export function Sidebar() {
  const location = useLocation();

  // Pulse: check for active tasks
  const { data: tasksData } = useQuery({
    queryKey: ["tasks-active"],
    queryFn: () => kernelApi.listTasks({ limit: 5, status: "running" }),
    refetchInterval: 10_000,
    retry: false,
  });
  const hasActive = (tasksData?.tasks?.length ?? 0) > 0;

  return (
    <nav className="nav">
      {NAV.map((group) => (
        <div key={group.group} className="nav-group">
          <div className="nav-group-label">{group.group}</div>
          {group.items.map((item) => {
            const isActive =
              item.path === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(item.path);
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`nav-item${isActive ? " active" : ""}`}
                end={item.path === "/"}
              >
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.live && hasActive && item.path === "/tasks" && (
                  <span className="nav-pulse" title="Tasks running" />
                )}
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
