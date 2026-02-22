export const action = {
  name: "web_search",
  writes: false,
  async run(req, _ctx) {
    const q = req.payload?.q || req.payload?.query || "";
    if (!q) {throw new Error("payload.q (or payload.query) is required");}

    // Stub: no Brave key yet, so return instruction for manual research mode
    return {
      ok: true,
      mode: "manual_research",
      query: q,
      note:
        "No web search provider configured. Provide results manually or add BRAVE_API_KEY in next slice.",
    };
  },
};
