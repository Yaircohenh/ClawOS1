import { Component, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: "monospace", color: "#ef4444", background: "#0f1117", minHeight: "100vh" }}>
          <h2 style={{ color: "#fafafa", marginBottom: 16 }}>ClawOS — Runtime Error</h2>
          <pre style={{ background: "#1a1d27", padding: 20, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>
            {(this.state.error as Error).message}
            {"\n\n"}
            {(this.state.error as Error).stack}
          </pre>
          <button
            style={{ marginTop: 16, padding: "8px 16px", background: "#5c7be0", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import { Overview }   from "./pages/Overview";
import { Chat }       from "./pages/Chat";
import { Channels }   from "./pages/Channels";
import { Instances }  from "./pages/Instances";
import { Sessions }   from "./pages/Sessions";
import { Usage }      from "./pages/Usage";
import { Cron }       from "./pages/Cron";
import { Tasks }      from "./pages/Tasks";
import { TaskDetail } from "./pages/TaskDetail";
import { Approvals }  from "./pages/Approvals";
import { Skills }     from "./pages/Skills";
import { Nodes }      from "./pages/Nodes";
import { Connections } from "./pages/Connections";
import { Risk }       from "./pages/Risk";
import { Config }     from "./pages/Config";
import { Debug }      from "./pages/Debug";
import { Logs }       from "./pages/Logs";
import { Health }     from "./pages/Health";
import { Docs }       from "./pages/Docs";

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1 },
  },
});

export default function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/"             element={<Overview />} />
            <Route path="/chat"         element={<Chat />} />
            <Route path="/channels"     element={<Channels />} />
            <Route path="/instances"    element={<Instances />} />
            <Route path="/sessions"     element={<Sessions />} />
            <Route path="/usage"        element={<Usage />} />
            <Route path="/cron"         element={<Cron />} />
            <Route path="/tasks"        element={<Tasks />} />
            <Route path="/tasks/:taskId" element={<TaskDetail />} />
            <Route path="/approvals"    element={<Approvals />} />
            <Route path="/skills"       element={<Skills />} />
            <Route path="/nodes"        element={<Nodes />} />
            <Route path="/connections"  element={<Connections />} />
            <Route path="/risk"         element={<Risk />} />
            <Route path="/config"       element={<Config />} />
            <Route path="/debug"        element={<Debug />} />
            <Route path="/logs"         element={<Logs />} />
            <Route path="/health"       element={<Health />} />
            <Route path="/docs"         element={<Docs />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
