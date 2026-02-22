import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "client", "dist");
const PORT = Number(process.env.UI_PORT || 18887);
const KERNEL_URL = process.env.KERNEL_URL || "http://localhost:18888";

const app = Fastify({ logger: false });

// ── Proxy: forward /api/* → kernel ───────────────────────────────────────────
app.all("/api/*", async (req, reply) => {
  const kernelPath = req.url.replace(/^\/api/, "/kernel");
  const url = `${KERNEL_URL}${kernelPath}`;

  const init = {
    method: req.method,
    headers: { "content-type": "application/json" },
  };
  if (req.method !== "GET" && req.method !== "DELETE") {
    init.body = JSON.stringify(req.body ?? {});
  }

  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    reply.code(res.status).send(body);
  } catch (e) {
    reply.code(502).send({ ok: false, error: "kernel_unreachable", message: e.message });
  }
});

// ── Serve SPA (if built) or fallback JSON ─────────────────────────────────────
if (existsSync(DIST)) {
  // Serve built React app from client/dist/
  await app.register(staticPlugin, {
    root: DIST,
    prefix: "/",
    wildcard: false,        // Don't register /* so we can add our own SPA fallback
  });

  // SPA fallback — all non-API routes → index.html (React Router handles client-side routing)
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.code(404).send({ ok: false, error: "not_found" });
      return;
    }
    return reply.sendFile("index.html");
  });
} else {
  // No build yet — return service info so health checks still pass
  app.get("/", async () => ({
    ok: true,
    service: "clawos-ui",
    note: "Run 'npm run build' to build the dashboard",
    kernel_proxy: "/api/*",
  }));

  app.setNotFoundHandler(async (_req, reply) => {
    if (!_req.url.startsWith("/api/")) {
      reply.code(404).send({ ok: false, error: "ui_not_built", note: "Run npm run build" });
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { process.stderr.write(err.message + "\n"); process.exit(1); }
  process.stdout.write(`[ui] listening on http://0.0.0.0:${PORT}\n`);
});
