/**
 * cognitive_execute — Multi-phase cognitive execution action
 *
 * Provides the kernel-side brain for the cognitive architecture:
 *
 *   Phase: extract_objective
 *     LLM extracts { goal, title, constraints, required_deliverable } from a raw
 *     user message.  Returns a deliverable spec so the agent knows exactly what
 *     it is contracted to produce.
 *
 *   Phase: resolve_followup
 *     Determines whether a new user message continues an existing objective or
 *     starts a fresh one.  Uses fast heuristics first; falls back to LLM.
 *
 *   Phase: validate_deliverable
 *     Checks the assistant's output against the required_deliverable spec.
 *     Supports type "list" (count + item_format) and type "answer".
 *
 *   Phase: enforce_tool_truth
 *     Scans the output for false tool claims (e.g. "I searched the web") and
 *     sanitizes or flags them if no matching tool evidence exists.
 *
 *   Phase: repair_deliverable
 *     Re-prompts the LLM once with a strict constraint to fill missing items.
 *     Called by the bridge when validate_deliverable fails.
 *
 * All phases log a structured cognitive_trace for observability.
 */
import { getSecret } from "../connections.js";
import {
  getActiveObjective,
  getToolEvidence,
} from "../../objectives/service.js";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const XAI_MODEL       = "grok-3-mini";

// ── LLM helper ────────────────────────────────────────────────────────────────

async function callLLM(db, systemPrompt, userContent, maxTokens = 512) {
  const xai = getSecret(db, "xai");
  if (xai?.api_key) {
    try { return await callXai(xai.api_key, systemPrompt, userContent, maxTokens); } catch { /* fall through */ }
  }
  const anthropic = getSecret(db, "anthropic");
  if (anthropic?.api_key) {
    return callAnthropic(anthropic.api_key, systemPrompt, userContent, maxTokens);
  }
  throw new Error("No LLM API key configured (xai or anthropic)");
}

async function callAnthropic(apiKey, systemPrompt, userContent, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!r.ok) {throw new Error(`Anthropic HTTP ${r.status}`);}
  const d = await r.json();
  return (d.content?.[0]?.text ?? "").trim();
}

async function callXai(apiKey, systemPrompt, userContent, maxTokens) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
    }),
  });
  if (!r.ok) {throw new Error(`xAI HTTP ${r.status}`);}
  const d = await r.json();
  return (d.choices?.[0]?.message?.content ?? "").trim();
}

function parseJson(raw) {
  const cleaned = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  return JSON.parse(cleaned);
}

// ── Phase: extract_objective ──────────────────────────────────────────────────

const EXTRACT_SYSTEM = `You extract a structured objective from a user message for an AI assistant.

Return ONLY a JSON object (no markdown, no explanation):
{
  "title":                "<short title ≤50 chars>",
  "goal":                 "<concrete goal in 1-2 sentences>",
  "constraints":          { "<key>": "<value>" },
  "required_deliverable": {
    "type":        "list" | "answer" | "code" | "file" | "none",
    "count":       <integer, only for type=list>,
    "description": "<what is expected>",
    "item_format": { "<field>": "<type description>" }   // only for type=list
  }
}

Rules:
- If the user asks for a specific count (10 names, 5 ideas), type="list" with count=that number.
- If the user asks a factual question, type="answer".
- For naming / brainstorming tasks always include an "availability" field in item_format.
- evidence field in item_format should be "string (tool trace or 'Not verified')".
- constraints should capture things like "must have .ai domain", "no existing brands".`;

async function extractObjective(db, { text }) {
  try {
    const raw = await callLLM(db, EXTRACT_SYSTEM, text, 512);
    const parsed = parseJson(raw);
    return {
      title:                String(parsed.title ?? "").slice(0, 100),
      goal:                 String(parsed.goal ?? text).slice(0, 500),
      constraints:          parsed.constraints ?? {},
      required_deliverable: parsed.required_deliverable ?? null,
    };
  } catch {
    // Heuristic fallback: detect list request
    // Allow up to 3 modifier words between the count and the list noun:
    //   "5 ideas" | "5 Python code examples" | "10 great AI OS names"
    const countMatch = text.match(/\b(\d+)(?:\s+\w+){0,3}\s+(?:names?|ideas?|suggestions?|items?|results?|options?|examples?|steps?|ways?|tips?|points?|things?|reasons?|facts?)\b/i);
    const count = countMatch ? parseInt(countMatch[1], 10) : null;
    const isListRequest = count !== null || /\b(list|give me|come up with|suggest|find me)\b/i.test(text);
    return {
      title: text.slice(0, 60),
      goal:  text,
      constraints: {},
      required_deliverable: isListRequest
        ? { type: "list", count: count ?? 10, description: "list of results", item_format: { name: "string", availability: "Available|Taken|Unknown", evidence: "string" } }
        : { type: "answer", description: "direct answer" },
    };
  }
}

// ── Phase: resolve_followup ───────────────────────────────────────────────────

// Fast heuristics — these patterns strongly indicate the user is continuing an
// existing objective rather than starting a new one.
const FOLLOWUP_PATTERNS = [
  /^(continue|try again|go ahead|proceed|yes|ok|okay|sure|next|more)$/i,
  /\b(10 more|give me more|do \d+ more|add more|\d+ new ones?|new suggestions?)\b/i,
  /\b(based on that|using that|with those|from there|head to (that|the) (website|site|url|link))\b/i,
  /\b(same (format|topic|task|request)|keep going|continue (with|from))\b/i,
  /\b(can'?t use (the )?taken|remove the taken|skip taken|only available)\b/i,
  /^(try|use|go|check|visit|open)\s+\S+$/i,  // short imperative ≤ 4 tokens
];

const NEWOBJ_PATTERNS = [
  /\b(forget (that|those|it)|start (over|fresh|new)|new (task|topic|project|conversation))\b/i,
  /\b(different topic|change subject|something else entirely)\b/i,
];

export function resolveFollowupHeuristic(text, activeObjective) {
  if (!activeObjective) {return { decision: "new", confidence: 1.0, reason: "no_active_objective" };}

  const norm = text.toLowerCase().trim();

  // Explicit new-topic signals override everything
  if (NEWOBJ_PATTERNS.some(re => re.test(norm))) {
    return { decision: "new", confidence: 0.95, reason: "explicit_new_topic" };
  }

  // Strong follow-up patterns
  if (FOLLOWUP_PATTERNS.some(re => re.test(norm))) {
    return { decision: "continue", confidence: 0.92, reason: "followup_pattern_match" };
  }

  // Short messages (≤ 35 chars) while objective is active → likely follow-up
  if (norm.length <= 35) {
    return { decision: "continue", confidence: 0.75, reason: "short_message_while_active" };
  }

  return null; // ambiguous — needs LLM
}

const FOLLOWUP_SYSTEM = `You decide if a user message continues an existing task or starts a new one.

Return ONLY JSON (no markdown):
{"decision":"continue"|"new","confidence":0.0-1.0,"reason":"one sentence"}

Rules:
- "continue" if the user references the active goal, wants more of the same output,
  or uses anaphoric references ("that", "those", "there", "it").
- "new" if the user changes topic, asks an unrelated question, or resets explicitly.
- When uncertain lean toward "continue" (false continuations are less harmful than drift).`;

async function resolveFollowup(db, { text, active_objective }) {
  // Fast path: heuristics
  const fast = resolveFollowupHeuristic(text, active_objective);
  if (fast && fast.confidence >= 0.85) {return fast;}

  // LLM path for ambiguous cases
  const userContent = `Active objective: "${active_objective?.goal ?? "(none)"}"

User message: "${text}"`;
  try {
    const raw = await callLLM(db, FOLLOWUP_SYSTEM, userContent, 128);
    const parsed = parseJson(raw);
    return {
      decision:   String(parsed.decision ?? "new"),
      confidence: Number(parsed.confidence ?? 0.5),
      reason:     String(parsed.reason ?? "llm"),
    };
  } catch {
    return fast ?? { decision: "new", confidence: 0.5, reason: "llm_unavailable" };
  }
}

// ── Phase: validate_deliverable ───────────────────────────────────────────────

/**
 * Parse a freetext response and attempt to extract list items.
 * Returns an array of extracted items (partial objects OK for counting).
 */
function extractListItems(output) {
  // Strategy 1: JSON array in the output
  const jsonMatch = output.match(/\[[\s\S]+?\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) {return arr;}
    } catch { /* fall through */ }
  }

  // Strategy 2: numbered list  "1. ...", "1) ..."
  const numbered = [...output.matchAll(/^\s*\d+[.)]\s+(.+)/gm)].map(m => m[1].trim());
  if (numbered.length > 0) {return numbered.map(line => ({ _text: line }));}

  // Strategy 3: bulleted list "- ..." / "• ..."
  const bulleted = [...output.matchAll(/^\s*[-•*]\s+(.+)/gm)].map(m => m[1].trim());
  if (bulleted.length > 0) {return bulleted.map(line => ({ _text: line }));}

  // Strategy 4: blank-line separated paragraphs (each ≥ 10 chars)
  const paras = output.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length >= 10);
  if (paras.length >= 2) {return paras.map(p => ({ _text: p }));}

  return [];
}

function validateListDeliverable(output, spec) {
  const items = extractListItems(output);
  const required = spec.count ?? 10;
  const missing  = [];
  const failures = [];

  if (items.length < required) {
    failures.push(`Expected ${required} items, found ${items.length}`);
  }

  // Check required fields exist on items that look like objects
  const fieldSpec = spec.item_format ?? {};
  const requiredFields = Object.keys(fieldSpec);
  if (requiredFields.length > 0 && items.length > 0) {
    const sampleItem = items[0];
    if (typeof sampleItem === "object" && !sampleItem._text) {
      for (const field of requiredFields) {
        if (!(field in sampleItem)) {missing.push(field);}
      }
      if (missing.length > 0) {failures.push(`Items missing fields: ${missing.join(", ")}`);}
    }
  }

  return {
    passed:        failures.length === 0,
    item_count:    items.length,
    required_count: required,
    missing_fields: missing,
    failures,
  };
}

function validateDeliverable(output, required_deliverable) {
  if (!required_deliverable) {return { passed: true, reason: "no_spec" };}

  const type = required_deliverable.type ?? "none";

  if (type === "none") {return { passed: true, reason: "type_none" };}

  if (type === "answer") {
    const passed = output.trim().length >= 10;
    return { passed, reason: passed ? "answer_present" : "empty_answer", item_count: null };
  }

  if (type === "list") {
    return validateListDeliverable(output, required_deliverable);
  }

  // Generic: just check output is non-empty
  const passed = output.trim().length >= 20;
  return { passed, reason: passed ? "output_present" : "empty_output" };
}

// ── Phase: enforce_tool_truth ─────────────────────────────────────────────────

const FALSE_CLAIM_PATTERNS = [
  { re: /\b(I searched|I searched the web|my (?:web )?search)\b/i,       claim: "web_search_claim"   },
  { re: /\b(I (?:checked|verified|looked up|confirmed|queried))\b.*\b(domain|availability|DNS|WHOIS)\b/i, claim: "domain_check_claim" },
  { re: /\b(I (?:visited|browsed|went to|accessed|navigated to))\b.*\b(website|site|URL|page|link)\b/i,   claim: "website_visit_claim" },
  { re: /\b(according to (?:my |the )?search|based on (?:my |the )?search|search results? (?:show|indicate|reveal))\b/i, claim: "search_result_claim" },
  { re: /\b(I (?:found|discovered|saw) (?:on the web|online|in search))\b/i, claim: "found_online_claim" },
];

/** Determine which tool claim types the text makes. */
function detectToolClaims(text) {
  return FALSE_CLAIM_PATTERNS.filter(({ re }) => re.test(text)).map(({ claim }) => claim);
}

/** Return true if any real tool evidence matches the claim type. */
function evidenceCoversClaimType(evidence, claimType) {
  if (evidence.length === 0) {return false;}
  const ACTION_FOR_CLAIM = {
    web_search_claim:    ["web_search"],
    domain_check_claim:  ["web_search", "run_shell"],
    website_visit_claim: ["web_search", "run_shell"],
    search_result_claim: ["web_search"],
    found_online_claim:  ["web_search"],
  };
  const validActions = ACTION_FOR_CLAIM[claimType] ?? ["web_search"];
  return evidence.some(ev => validActions.includes(ev.action_type));
}

/**
 * Sanitize an output string by replacing unsupported tool claims with an honest disclaimer.
 * Option B — strip-and-note (always available, no LLM required).
 */
function sanitizeToolClaims(output, unsupportedClaims) {
  let sanitized = output;
  for (const claim of unsupportedClaims) {
    if (claim === "domain_check_claim") {
      // Replace availability statements with Unknown
      sanitized = sanitized.replace(
        /\b(Available|Taken|Registered|Free|Unregistered)\b/gi,
        "Unknown",
      );
    }
    // Remove parenthetical evidence that implies tool use
    sanitized = sanitized.replace(/\((?:verified|checked|confirmed|found online)[^)]*\)/gi, "");
  }
  const disclaimer = `\n\n_(Domain availability not verified — no lookup tool available. Marked as Unknown.)_`;
  if (!sanitized.includes("not verified")) {sanitized += disclaimer;}
  return sanitized.trim();
}

function enforceToolTruth(output, evidence) {
  const claims = detectToolClaims(output);
  if (claims.length === 0) {
    return { passed: true, claims_found: [], sanitized_output: output, tool_repair_triggered: false };
  }

  const unsupported = claims.filter(c => !evidenceCoversClaimType(evidence, c));
  if (unsupported.length === 0) {
    // Claims exist and evidence backs them up ✓
    return { passed: true, claims_found: claims, sanitized_output: output, tool_repair_triggered: false };
  }

  // Unsupported claims found — sanitize
  const sanitized_output = sanitizeToolClaims(output, unsupported);
  return {
    passed: false,
    claims_found: claims,
    unsupported_claims: unsupported,
    sanitized_output,
    tool_repair_triggered: true,
  };
}

// ── Phase: repair_deliverable ─────────────────────────────────────────────────

const REPAIR_SYSTEM = `You are a precise list generator. Follow the schema EXACTLY.
Do NOT add preamble, advice, or explanation.
Return ONLY the list in the requested format.
If domain availability is unknown, write "Unknown" — never guess.`;

async function repairDeliverable(db, { original_output, required_deliverable, working_memory, tool_capabilities }) {
  const spec = required_deliverable;
  const toolsAvailable = tool_capabilities?.web_search
    ? "Web search IS available. You may use it."
    : "Web search is NOT available. Mark domain availability as Unknown.";

  const userContent =
    `REQUIRED: Produce exactly ${spec.count ?? 10} items.\n\n` +
    `SCHEMA for each item:\n${JSON.stringify(spec.item_format ?? {}, null, 2)}\n\n` +
    `CONTEXT:\n${working_memory?.context_summary ?? ""}\n\n` +
    `TOOLS: ${toolsAvailable}\n\n` +
    `PREVIOUS ATTEMPT (insufficient):\n${original_output.slice(0, 800)}\n\n` +
    `Return the ${spec.count ?? 10} items now. No preamble. No advice.`;

  try {
    const repaired = await callLLM(db, REPAIR_SYSTEM, userContent, 1024);
    return { ok: true, repaired_output: repaired };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Action definition ──────────────────────────────────────────────────────────
export const action = {
  name:        "cognitive_execute",
  writes:      false,
  risk_level:  "low",
  reversible:  true,
  description: "Cognitive pipeline phases: objective extraction, follow-up resolution, deliverable validation, tool-truth enforcement, deliverable repair",

  async run(req, ctx) {
    const phase = req.payload?.phase;
    if (!phase) {throw new Error("payload.phase is required");}

    const db = ctx?.db ?? null;

    // ── extract_objective ──────────────────────────────────────────────────────
    if (phase === "extract_objective") {
      const { text } = req.payload;
      if (!text) {throw new Error("payload.text required for extract_objective");}
      const result = await extractObjective(db, { text });
      return { phase, ...result };
    }

    // ── resolve_followup ───────────────────────────────────────────────────────
    if (phase === "resolve_followup") {
      const { text, session_id } = req.payload;
      if (!text) {throw new Error("payload.text required for resolve_followup");}
      const active = session_id ? getActiveObjective(db, session_id) : null;
      const result = await resolveFollowup(db, { text, active_objective: active });
      return {
        phase,
        ...result,
        active_objective_id: active?.objective_id ?? null,
        active_objective_goal: active?.goal ?? null,
      };
    }

    // ── validate_deliverable ───────────────────────────────────────────────────
    if (phase === "validate_deliverable") {
      const { output, objective_id, required_deliverable } = req.payload;
      if (!output) {throw new Error("payload.output required for validate_deliverable");}
      // Prefer fetched spec if objective_id given
      let spec = required_deliverable;
      if (!spec && objective_id && db) {
        const { getObjective } = await import("../../objectives/service.js");
        const obj = getObjective(db, objective_id);
        spec = obj?.required_deliverable ?? null;
      }
      const result = validateDeliverable(output, spec);
      return { phase, ...result };
    }

    // ── enforce_tool_truth ─────────────────────────────────────────────────────
    if (phase === "enforce_tool_truth") {
      const { output, objective_id } = req.payload;
      if (!output) {throw new Error("payload.output required for enforce_tool_truth");}
      const evidence = objective_id && db ? getToolEvidence(db, objective_id) : [];
      const result = enforceToolTruth(output, evidence);
      return { phase, ...result };
    }

    // ── repair_deliverable ─────────────────────────────────────────────────────
    if (phase === "repair_deliverable") {
      const { original_output, objective_id, required_deliverable, working_memory, tool_capabilities } = req.payload;
      if (!original_output) {throw new Error("payload.original_output required for repair_deliverable");}
      let spec = required_deliverable;
      if (!spec && objective_id && db) {
        const { getObjective } = await import("../../objectives/service.js");
        const obj = getObjective(db, objective_id);
        spec = obj?.required_deliverable ?? null;
      }
      if (!spec) {throw new Error("No deliverable spec found for repair");}
      const result = await repairDeliverable(db, { original_output, required_deliverable: spec, working_memory, tool_capabilities });
      return { phase, ...result };
    }

    throw new Error(`Unknown cognitive_execute phase: ${phase}`);
  },
};

// Export helpers for use by objectives/routes.js
export { extractObjective, resolveFollowup, validateDeliverable, enforceToolTruth, repairDeliverable };
