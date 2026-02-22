/**
 * classify_intent — Natural language → action router
 *
 * Uses Claude Haiku to classify free-form text into a kernel action type
 * and extract (or generate) the correct parameters for that action.
 *
 * Falls back to lightweight keyword heuristics when no Anthropic key is
 * configured so the bridge degrades gracefully to web_search.
 *
 * Return shape:
 *   { action_type, params, confidence, reasoning, mode }
 *   mode: "llm" | "heuristic"
 */
import { getSecret } from "../connections.js";

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a command router for a personal AI assistant.
Classify the user message into one of these actions and produce the right parameters.

ACTIONS
- web_search   : Look up information, answer questions, research topics.
                 params: { "q": "<search query>" }
- run_shell    : Execute system commands, manage files, run programs.
                 params: { "command": "<valid bash command>" }
- write_file   : Create or overwrite a file in the workspace.
                 params: { "path": "<relative filepath>", "content": "<file content>" }
- read_file    : Read / display a file in the workspace.
                 params: { "path": "<relative filepath>" }
- none         : Greeting, casual chat, or non-actionable message.
                 params: {}

RULES
1. For run_shell — generate a real, runnable bash command.  Never echo the user's
   words literally as a command. Translate intent to shell syntax.
2. For web_search — sharpen and clean the query; remove filler words.
3. Prefer web_search over run_shell for informational questions.
4. Only choose run_shell when the user clearly wants system-level execution.
5. confidence: float 0.0–1.0 reflecting how certain you are.

Respond with ONLY a JSON object — no markdown, no explanation:
{"action_type":"...","params":{...},"confidence":0.9,"reasoning":"one sentence"}`;

// ── Anthropic-powered classifier ───────────────────────────────────────────────
async function classifyWithLLM(text, apiKey) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!r.ok) {
    throw new Error(`Anthropic returned HTTP ${r.status}`);
  }

  const data = await r.json();
  const raw = data.content?.[0]?.text ?? "";

  // Strip accidental markdown fences
  const jsonStr = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const parsed = JSON.parse(jsonStr);

  return {
    action_type: String(parsed.action_type ?? "web_search"),
    params: parsed.params ?? {},
    confidence: Number(parsed.confidence ?? 0.5),
    reasoning: String(parsed.reasoning ?? ""),
    mode: "llm",
  };
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

    // Try Anthropic LLM first
    if (ctx?.db) {
      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        try {
          return await classifyWithLLM(text, anthropic.api_key);
        } catch {
          // Fall through to heuristics on any error
        }
      }
    }

    return classifyWithHeuristics(text);
  },
};
