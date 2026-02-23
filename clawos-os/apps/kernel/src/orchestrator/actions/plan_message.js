/**
 * plan_message — Two-stage message planner
 *
 * Converts a natural-language user message into an ordered plan of steps,
 * without executing any of them.
 *
 * Stage A (deterministic, no LLM):
 *   - classify_intent result used as the basis
 *   - if multi_intent → multi-step plan
 *   - if single intent with high confidence → single-step plan
 *
 * Stage B (LLM, only when Stage A is uncertain):
 *   - Calls Claude Haiku / Grok with a strict planning prompt
 *   - Returns internal plan JSON (never shown verbatim to user)
 *
 * Plan step shape:
 *   { type: 'action'|'chat', name?: string, args?: object,
 *     priority: number, can_run_in_background: boolean }
 *
 * payload: { text, context_summary? }
 * returns: { steps: PlanStep[], mode: 'deterministic'|'llm'|'fallback' }
 */
import { getSecret } from "../connections.js";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const XAI_MODEL       = "grok-3-mini";

const PLAN_SYSTEM_PROMPT = `You are a task planner for a WhatsApp AI assistant.

Your ONLY job is to extract up to 3 distinct user tasks from a message and return a JSON plan.
Never execute tasks. Never explain. Output ONLY valid JSON.

Output format:
[
  {"type":"action","name":"web_search","args":{"q":"..."},"priority":1,"can_run_in_background":false},
  {"type":"chat","args":{"text":"..."},"priority":2,"can_run_in_background":false}
]

Available action names: web_search, send_email, run_shell, write_file, read_file

Rules:
1. For conversational questions (math, facts, chat) → type="chat", args.text = the sub-question
2. For tool actions → type="action", name = action name, args = action params
3. send_email args: { to, subject, body }
4. web_search args: { q }
5. run_shell args: { command }
6. write_file args: { path, content }
7. read_file args: { path }
8. Priority 1 = most important; if parallel, use same priority
9. Output [] if the message has no clear tasks (empty plan = fall through to chat)
10. Output ONLY the JSON array, no markdown, no explanation`;

// ── LLM plan call ─────────────────────────────────────────────────────────────

async function planWithXai(text, apiKey) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: XAI_MODEL,
      max_tokens: 512,
      temperature: 0,
      messages: [
        { role: "system",  content: PLAN_SYSTEM_PROMPT },
        { role: "user",    content: text },
      ],
    }),
  });
  if (!r.ok) {throw new Error(`xAI plan HTTP ${r.status}`);}
  const data = await r.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? "[]");
}

async function planWithAnthropic(text, apiKey) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      system: PLAN_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!r.ok) {throw new Error(`Anthropic plan HTTP ${r.status}`);}
  const data = await r.json();
  return JSON.parse(data.content?.[0]?.text ?? "[]");
}

// ── Plan normalizer (validates and normalizes LLM output) ─────────────────────

function normalizePlan(raw) {
  if (!Array.isArray(raw)) {return [];}
  return raw
    .filter(s => s && typeof s === "object")
    .map((s, i) => ({
      type:                 s.type === "chat" ? "chat" : "action",
      name:                 s.name ?? null,
      args:                 s.args ?? {},
      priority:             Number(s.priority ?? i + 1),
      can_run_in_background: Boolean(s.can_run_in_background ?? false),
    }))
    .slice(0, 3); // max 3 steps
}

// ── Action definition ─────────────────────────────────────────────────────────
export const action = {
  name:        "plan_message",
  writes:      false,
  risk_level:  "low",
  reversible:  true,
  description: "Convert a user message into an ordered execution plan",

  async run(req, ctx) {
    const text = req.payload?.text;
    if (!text || typeof text !== "string") {
      throw new Error("payload.text (string) is required");
    }
    const contextSummary = req.payload?.context_summary ?? null;
    const fullText = contextSummary
      ? `Session context:\n${contextSummary}\n\nUser message: ${text}`
      : text;

    // Stage B: LLM plan extraction
    if (ctx?.db) {
      const xai = getSecret(ctx.db, "xai");
      if (xai?.api_key) {
        try {
          const raw   = await planWithXai(fullText, xai.api_key);
          const steps = normalizePlan(raw);
          if (steps.length > 0) {
            return { steps, mode: "llm", provider: "xai" };
          }
        } catch { /* fall through */ }
      }

      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        try {
          const raw   = await planWithAnthropic(fullText, anthropic.api_key);
          const steps = normalizePlan(raw);
          if (steps.length > 0) {
            return { steps, mode: "llm", provider: "anthropic" };
          }
        } catch { /* fall through */ }
      }
    }

    // Fallback: single chat step
    return {
      steps: [{ type: "chat", name: null, args: { text }, priority: 1, can_run_in_background: false }],
      mode:  "fallback",
    };
  },
};
