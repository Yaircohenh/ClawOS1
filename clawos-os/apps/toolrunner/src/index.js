import Fastify from "fastify";

const app = Fastify({ logger: true });
const PORT = Number(process.env.TOOLRUNNER_PORT || 18890);
const KERNEL_URL = process.env.KERNEL_URL || "http://kernel:18888";

app.get("/health", async () => ({ ok: true, service: "toolrunner" }));

async function verifyWithKernel({ token, tool_name, workspace_id, action_request_id, destination }) {
  const res = await fetch(`${KERNEL_URL}/kernel/tokens/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, tool_name, workspace_id, action_request_id, destination })
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

app.post("/tools/execute", async (req, reply) => {
  const { capability_token, tool_name, params } = req.body ?? {};

  // Minimum envelope required for v0.1
  const workspace_id = params?.workspace_id;
  const action_request_id = params?.action_request_id;
  const destination = params?.destination ?? null;

  if (!capability_token || !tool_name || !workspace_id || !action_request_id) {
    reply.code(400);
    return { ok: false, error: "missing_fields", required: ["capability_token", "tool_name", "params.workspace_id", "params.action_request_id"] };
  }

  const v = await verifyWithKernel({
    token: capability_token,
    tool_name,
    workspace_id,
    action_request_id,
    destination
  });

  if (v.status !== 200 || !v.json?.ok) {
    reply.code(v.status);
    return { ok: false, error: "capability_token_rejected", details: v.json };
  }

  // v0.1: stub execution (next milestone: real tools)
  return {
    ok: true,
    result: { message: `Tool executed (stub): ${tool_name}` },
    logs: []
  };
});

app.listen({ port: PORT, host: "0.0.0.0" });
