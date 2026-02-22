import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
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
  );
}
