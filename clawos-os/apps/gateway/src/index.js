import Fastify from "fastify";

const app = Fastify({ logger: true });
const PORT = Number(process.env.GATEWAY_PORT || 18889);

app.get("/health", async () => ({ ok: true, service: "gateway" }));

app.post("/llm/complete", async (_req) => {
  return {
    content: "Gateway stub response",
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    provider: "stub"
  };
});

app.listen({ port: PORT, host: "0.0.0.0" });
