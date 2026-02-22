import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";

const ITEMS = [
  { icon: "🏠", label: "Overview",     path: "/",            group: "Overview" },
  { icon: "💬", label: "Chat",         path: "/chat",        group: "Overview" },
  { icon: "📡", label: "Channels",     path: "/channels",    group: "Control" },
  { icon: "🖥️", label: "Instances",    path: "/instances",   group: "Control" },
  { icon: "📋", label: "Sessions",     path: "/sessions",    group: "Control" },
  { icon: "📊", label: "Usage",        path: "/usage",       group: "Control" },
  { icon: "⏰", label: "Cron",         path: "/cron",        group: "Control" },
  { icon: "✅", label: "Tasks",        path: "/tasks",       group: "Agents" },
  { icon: "🔔", label: "Approvals",    path: "/approvals",   group: "Agents" },
  { icon: "⚡", label: "Skills",       path: "/skills",      group: "Agents" },
  { icon: "🔌", label: "Nodes",        path: "/nodes",       group: "Nodes" },
  { icon: "🔑", label: "Connections",  path: "/connections", group: "System" },
  { icon: "🛡️", label: "Risk",         path: "/risk",        group: "System" },
  { icon: "⚙️", label: "Config",       path: "/config",      group: "System" },
  { icon: "🐛", label: "Debug",        path: "/debug",       group: "System" },
  { icon: "📜", label: "Logs",         path: "/logs",        group: "More" },
  { icon: "❤️", label: "Health",       path: "/health",      group: "More" },
  { icon: "📚", label: "Docs",         path: "/docs",        group: "More" },
];

interface Props { onClose: () => void; }

export function CommandPalette({ onClose }: Props) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = ITEMS.filter(
    (i) => !query || i.label.toLowerCase().includes(query.toLowerCase())
  );

  const go = useCallback((path: string) => {
    navigate(path);
    onClose();
  }, [navigate, onClose]);

  useEffect(() => { setFocused(0); }, [query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setFocused(f => Math.min(f + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setFocused(f => Math.max(f - 1, 0)); }
    if (e.key === "Enter" && filtered[focused]) {go(filtered[focused].path);}
    if (e.key === "Escape") {onClose();}
  };

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd-box" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input">
          <span style={{ color: "var(--muted)", fontSize: 16 }}>⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Go to page…"
          />
          <kbd style={{ fontSize: 11, color: "var(--muted-2)", background: "var(--bg-2)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border)" }}>ESC</kbd>
        </div>
        <div className="cmd-results">
          {filtered.map((item, i) => (
            <div
              key={item.path}
              className={`cmd-item${i === focused ? " focused" : ""}`}
              onClick={() => go(item.path)}
              onMouseEnter={() => setFocused(i)}
            >
              <span className="cmd-item-icon">{item.icon}</span>
              <span className="cmd-item-label">{item.label}</span>
              <span className="cmd-item-group">{item.group}</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)" }}>No results</div>
          )}
        </div>
        <div className="cmd-hint">↑↓ navigate · Enter select · Esc close</div>
      </div>
    </div>
  );
}
