import { getSecret } from "../connections.js";

export const action = {
  name: "web_search",
  writes: false,
  async run(req, ctx) {
    const q = req.payload?.q || req.payload?.query || "";
    if (!q) {throw new Error("payload.q (or payload.query) is required");}

    // Use Brave Search API when credentials are configured
    if (ctx?.db) {
      const brave = getSecret(ctx.db, "brave");
      if (brave?.api_key) {
        try {
          const r = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
            {
              headers: {
                Accept: "application/json",
                "X-Subscription-Token": brave.api_key,
              },
            },
          );
          if (r.ok) {
            const data = await r.json();
            const results = (data.web?.results ?? []).slice(0, 5).map((x) => ({
              title: x.title,
              url: x.url,
              snippet: x.description ?? "",
            }));
            return { ok: true, mode: "brave", query: q, results };
          }
          // Non-2xx from Brave — fall through to manual mode (don't throw)
        } catch {
          // Network error or bad JSON — fall through to manual mode
        }
      }
    }

    return {
      ok: true,
      mode: "manual_research",
      query: q,
      note: "No web search provider configured. Add a Brave API key in Settings → Connections.",
    };
  },
};
