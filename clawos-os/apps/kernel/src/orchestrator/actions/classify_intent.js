/**
 * classify_intent — Natural language → action router
 *
 * Uses Claude Haiku / Grok to classify free-form text into a kernel action type
 * and extract (or generate) the correct parameters for that action.
 *
 * Falls back to lightweight keyword heuristics when no LLM key is configured.
 *
 * Return shape (single intent):
 *   { action_type, params, confidence, reasoning, mode, multi_intent: false }
 *
 * Return shape (multi-intent — primary action + conversational sub-question):
 *   { action_type, params, confidence, reasoning, mode, multi_intent: true,
 *     intents: [{ action_type, params, confidence }, ...] }
 *   intents[0] = primary (actionable), intents[1+] = secondary (conversational)
 */
import { getSecret } from "../connections.js";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const XAI_MODEL = "grok-3-mini";

const SYSTEM_PROMPT = `You are a command router for a personal AI assistant.
Classify the user message into the correct action(s) and produce parameters.

ACTIONS
- web_search   : Look up information, answer questions, research topics, check prices, news.
                 params: { "q": "<search query>" }
- run_shell    : Execute system commands, manage files, run programs.
                 params: { "command": "<valid bash command>" }
- write_file   : Create or overwrite a file. Use for "write", "create", "draft", "save to file".
                 params: { "path": "<relative filepath>", "content": "<file content>" }
- read_file    : Read or display a file.
                 params: { "path": "<relative filepath>" }
- send_email   : Send an email. Use when user says "email", "send", "write to", "message" with an email address.
                 params: { "to": "<recipient email>", "subject": "<subject line>", "body": "<full email body>" }
- none         : Casual chat, math, factual question, general conversation, or non-actionable message.
                 Single intent: params: {}
                 Multi-intent (conversational slot): params: { "text": "<exact sub-question text>" }

MULTI-INTENT
When the message combines a PRIMARY actionable intent (send_email, run_shell, etc.) WITH a
DISTINCT conversational sub-question (math, factual, casual — signaled by "and also",
"also answer", "also:", "and what is", "and how much", trailing math expression, etc.),
return intents[] instead of action_type:
{"intents":[
  {"action_type":"send_email","params":{"to":"...","subject":"...","body":"..."},"confidence":0.95},
  {"action_type":"none","params":{"text":"10 + 5 = ?"},"confidence":0.99}
],"reasoning":"email request plus math sub-question"}

For single-purpose messages, return the standard format:
{"action_type":"...","params":{...},"confidence":0.9,"reasoning":"one sentence"}

RULES
1. For run_shell — generate a real, runnable bash command. Never echo words as a command.
2. For web_search — sharpen and clean the query; remove filler words.
3. Prefer web_search over run_shell for informational questions.
4. Only choose run_shell when the user clearly wants system-level execution.
5. For send_email — extract recipient email, infer subject, draft a polite body from intent.
6. For write_file — infer a sensible filename when not explicitly given.
7. confidence: float 0.0–1.0 reflecting certainty.
8. Multi-intent: put the ACTIONABLE intent FIRST in intents[]; conversational (none) last.
9. Only use intents[] when there are genuinely 2 distinct purposes. When in doubt → standard format.

Respond with ONLY a JSON object — no markdown, no explanation.`;

// ── Shared JSON parser (handles accidental markdown fences) ───────────────────
function parseClassifyResponse(raw) {
  const jsonStr = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const parsed = JSON.parse(jsonStr);

  // ── Multi-intent format: { intents: [{action_type, params, confidence}, …], reasoning }
  if (Array.isArray(parsed.intents) && parsed.intents.length > 0) {
    const intents = parsed.intents.map((i) => ({
      action_type: String(i.action_type ?? "none"),
      params:      i.params ?? {},
      confidence:  Number(i.confidence ?? 0.5),
    }));
    return {
      // Primary intent exposed at top level for backward compatibility
      action_type:  intents[0].action_type,
      params:       intents[0].params,
      confidence:   intents[0].confidence,
      reasoning:    String(parsed.reasoning ?? ""),
      intents,
      multi_intent: true,
    };
  }

  // ── Single-intent format (standard) ──────────────────────────────────────────
  return {
    action_type:  String(parsed.action_type ?? "web_search"),
    params:       parsed.params ?? {},
    confidence:   Number(parsed.confidence ?? 0.5),
    reasoning:    String(parsed.reasoning ?? ""),
    multi_intent: false,
  };
}

// ── xAI (Grok) classifier — OpenAI-compatible API ────────────────────────────
async function classifyWithXai(text, apiKey) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      max_tokens: 512,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!r.ok) {
    throw new Error(`xAI returned HTTP ${r.status}`);
  }

  const data = await r.json();
  const raw = data.choices?.[0]?.message?.content ?? "";
  return { ...parseClassifyResponse(raw), mode: "llm", provider: "xai" };
}

// ── Anthropic (Claude Haiku) classifier ───────────────────────────────────────
async function classifyWithAnthropic(text, apiKey) {
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
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!r.ok) {
    throw new Error(`Anthropic returned HTTP ${r.status}`);
  }

  const data = await r.json();
  const raw = data.content?.[0]?.text ?? "";
  return { ...parseClassifyResponse(raw), mode: "llm", provider: "anthropic" };
}

// ── Keyword heuristic fallback ─────────────────────────────────────────────────
const SHELL_VERBS = new Set([
  "ls", "ll", "la", "pwd", "ps", "top", "df", "du", "cat", "head", "tail",
  "grep", "find", "mkdir", "rmdir", "rm", "mv", "cp", "touch", "chmod",
  "chown", "echo", "curl", "wget", "git", "npm", "node", "python", "python3",
  "pip", "pip3", "brew", "apt", "apt-get", "sudo", "kill", "killall", "which",
  "env", "export", "source", "bash", "sh", "zsh", "ssh", "scp", "tar", "zip",
  "unzip", "open", "code",
]);

const SHELL_PATTERNS = [
  /\|\s*\w/,          // pipe
  /&&|\|\|/,          // logical operators
  /^\.\//,            // ./script
  /^\/[a-z]/i,        // absolute path
  /\s-{1,2}[a-z]/i,  // flags like -la or --verbose
  />\s*\w/,           // redirect
  /`[^`]+`/,          // backtick subshell
  /\$\(/,             // $() subshell
];

function classifyWithHeuristics(text) {
  const trimmed = text.trim();
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();

  // Looks like a literal shell command
  if (
    SHELL_VERBS.has(firstWord) ||
    SHELL_PATTERNS.some((re) => re.test(trimmed))
  ) {
    return {
      action_type: "run_shell",
      params: { command: trimmed },
      confidence: 0.82,
      reasoning: "Message matches known shell command pattern",
      mode: "heuristic",
    };
  }

  // Default → web_search
  return {
    action_type: "web_search",
    params: { q: trimmed },
    confidence: 0.55,
    reasoning: "No shell pattern detected — defaulting to web search",
    mode: "heuristic",
  };
}

// ── Action definition ──────────────────────────────────────────────────────────
export const action = {
  name: "classify_intent",
  writes: false,
  risk_level: "low",
  reversible: true,
  description: "Classify a natural language message into a kernel action",

  async run(req, ctx) {
    const text = req.payload?.text;
    if (!text || typeof text !== "string") {
      throw new Error("payload.text (string) is required");
    }

    // Optional session context — passed by bridge when a session is active.
    // Prepended to the user message so the LLM can disambiguate pronouns and
    // references that only make sense with prior context.
    const contextSummary = req.payload?.context_summary;
    const fullText = contextSummary
      ? `Session context:\n${contextSummary}\n\nUser message: ${text}`
      : text;

    if (ctx?.db) {
      // Try xAI (Grok) first — OpenAI-compatible, preferred when configured
      const xai = getSecret(ctx.db, "xai");
      if (xai?.api_key) {
        try {
          return await classifyWithXai(fullText, xai.api_key);
        } catch {
          // Fall through to Anthropic
        }
      }

      // Try Anthropic (Claude Haiku) second
      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        try {
          return await classifyWithAnthropic(fullText, anthropic.api_key);
        } catch {
          // Fall through to heuristics
        }
      }
    }

    return classifyWithHeuristics(text); // heuristics always use raw text (no context)
  },
};
