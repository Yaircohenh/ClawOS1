import { getSecret } from "../connections.js";

const MAX_EXCERPT = 3000; // chars to return when no LLM is configured
const MAX_LLM_INPUT = 30000; // chars fed to Anthropic to keep costs reasonable

export const action = {
  name: "summarize_document",
  writes: false,
  risk_level: "low",
  reversible: true,
  description: "Summarize the contents of a document",
  async run(req, ctx) {
    const text = req.payload?.text;
    const pageCount = req.payload?.page_count ?? 0;
    const filename = req.payload?.filename ?? "document";

    if (!text || typeof text !== "string") {
      throw new Error("payload.text (string) is required");
    }

    // Use Anthropic API when credentials are configured
    if (ctx?.db) {
      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        try {
          const prompt = `You are a helpful assistant. Summarize the following document concisely (3-5 bullet points) then give a one-paragraph overview.\n\nFilename: ${filename}\nPages: ${pageCount}\n\n---\n${text.slice(0, MAX_LLM_INPUT)}`;
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": anthropic.api_key,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            }),
          });
          if (r.ok) {
            const data = await r.json();
            const summary = data.content?.[0]?.text ?? "";
            return { ok: true, mode: "anthropic", filename, page_count: pageCount, summary };
          }
          // Non-2xx — fall through to excerpt mode
        } catch {
          // Network or parse error — fall through
        }
      }
    }

    // Fallback: return a raw text excerpt
    const excerpt = text.slice(0, MAX_EXCERPT);
    return {
      ok: true,
      mode: "excerpt",
      filename,
      page_count: pageCount,
      excerpt,
      note: "Add an Anthropic API key in Settings → Connections for AI summaries.",
    };
  },
};
