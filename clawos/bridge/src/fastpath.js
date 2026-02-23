/**
 * Fast-path handlers — deterministic, zero-LLM, sub-millisecond.
 *
 * Exported:
 *   evalArithmetic(text)   → { matched, value } — safe expression evaluator
 *   normalizeApproval(text) → 'yes'|'no'|'more'|'edit'|'go_ahead'|'cancel'|null
 *   planStageA(text)        → Plan[] | null       — entity/verb lexicon planner
 *
 * Never calls eval() or Function().  All regexes are linear-time.
 */

// ── Arithmetic parser ─────────────────────────────────────────────────────────
// Grammar (left-recursive eliminated):
//   expr   → add
//   add    → mul  ( ('+' | '-')  mul  )*
//   mul    → unary( ('*' | '/')  unary)*
//   unary  → '-' primary | '+' primary | primary
//   primary→ NUMBER | '(' expr ')'
//
// Only chars allowed: digits, '.', +, -, *, /, (, ), whitespace.

function _tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(str[i + 1] ?? ""))) {
      let num = "";
      while (i < str.length && (/\d/.test(str[i]) || str[i] === ".")) {
        num += str[i++];
      }
      const n = parseFloat(num);
      if (!Number.isFinite(n)) {
        throw new Error("bad number");
      }
      tokens.push({ t: "n", v: n });
    } else if ("+-*/()".includes(ch)) {
      tokens.push({ t: "o", v: ch });
      i++;
    } else {
      throw new Error(`bad char: ${ch}`);
    }
  }
  return tokens;
}

class _ArithParser {
  constructor(tokens) {
    this._t = tokens;
    this._i = 0;
  }
  _peek() {
    return this._t[this._i] ?? null;
  }
  _next() {
    return this._t[this._i++];
  }
  _done() {
    return this._i >= this._t.length;
  }
  _expect(v) {
    const t = this._next();
    if (t?.v !== v) {
      throw new Error(`expected ${v}`);
    }
  }

  parse() {
    const v = this._expr();
    if (!this._done()) {
      throw new Error("trailing");
    }
    return v;
  }
  _expr() {
    return this._add();
  }

  _add() {
    let v = this._mul();
    while (this._peek()?.t === "o" && (this._peek().v === "+" || this._peek().v === "-")) {
      const op = this._next().v;
      const r = this._mul();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  _mul() {
    let v = this._unary();
    while (this._peek()?.t === "o" && (this._peek().v === "*" || this._peek().v === "/")) {
      const op = this._next().v;
      const r = this._unary();
      if (op === "/" && r === 0) {
        throw new Error("div/0");
      }
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }

  _unary() {
    if (this._peek()?.t === "o" && this._peek().v === "-") {
      this._next();
      return -this._primary();
    }
    if (this._peek()?.t === "o" && this._peek().v === "+") {
      this._next();
      return this._primary();
    }
    return this._primary();
  }

  _primary() {
    const t = this._peek();
    if (!t) {
      throw new Error("unexpected end");
    }
    if (t.t === "n") {
      this._next();
      return t.v;
    }
    if (t.t === "o" && t.v === "(") {
      this._next();
      const v = this._expr();
      this._expect(")");
      return v;
    }
    throw new Error(`unexpected: ${JSON.stringify(t)}`);
  }
}

/**
 * Evaluate a simple arithmetic expression safely.
 * Strips trailing/leading user fluff: "= ?", "?", "=", "what is", "calculate".
 *
 * Returns { matched: true, value: number } or { matched: false }.
 */
export function evalArithmetic(text) {
  // Strip common natural-language prefixes
  let cleaned = text
    .trim()
    .replace(/^\s*(what(?:'s|\s+is)?\s+|calculate\s+|compute\s+|eval\s+|solve\s+)/i, "")
    .replace(/[\s=?]+$/, "")
    .trim();

  if (!cleaned) {
    return { matched: false };
  }
  // Must be ONLY arithmetic chars
  if (!/^[\d\s+\-*/.()]+$/.test(cleaned)) {
    return { matched: false };
  }
  // Must have at least one digit
  if (!/\d/.test(cleaned)) {
    return { matched: false };
  }
  // Must have at least one operator or paren — bare numbers aren't useful
  if (!/[+\-*/()]/.test(cleaned)) {
    return { matched: false };
  }

  try {
    const tokens = _tokenize(cleaned);
    if (tokens.length === 0) {
      return { matched: false };
    }
    const value = new _ArithParser(tokens).parse();
    if (!Number.isFinite(value)) {
      return { matched: false };
    }
    return { matched: true, value };
  } catch {
    return { matched: false };
  }
}

/**
 * Format an arithmetic result as a clean string (no trailing zeros, up to 10 sig digits).
 */
export function formatArithResult(value) {
  // Handle integers cleanly
  if (Number.isInteger(value)) {
    return String(value);
  }
  // Floating point: up to 10 significant digits, strip trailing zeros
  return parseFloat(value.toPrecision(10)).toString();
}

// ── Approval phrase normalization ─────────────────────────────────────────────

/** Maps exact lowercase words/phrases → canonical token. */
const _EXACT = new Map([
  // affirmative → 'yes'
  ["yes", "yes"],
  ["y", "yes"],
  ["yep", "yes"],
  ["yeah", "yes"],
  ["sure", "yes"],
  ["ok", "yes"],
  ["okay", "yes"],
  ["k", "yes"],
  ["confirmed", "yes"],
  ["confirm", "yes"],
  ["affirmative", "yes"],
  ["yup", "yes"],
  ["aye", "yes"],
  ["alright", "yes"],
  ["approved", "yes"],
  // negative → 'no'
  ["no", "no"],
  ["n", "no"],
  ["nope", "no"],
  ["nah", "no"],
  ["negative", "no"],
  ["reject", "no"],
  ["denied", "no"],
  ["nein", "no"],
  // more details → 'more'
  ["more", "more"],
  ["details", "more"],
  ["info", "more"],
  ["explain", "more"],
  ["show", "more"],
  ["expand", "more"],
  ["elaborate", "more"],
  ["why", "more"],
  // edit/change → 'edit'
  ["edit", "edit"],
  ["change", "edit"],
  ["modify", "edit"],
  ["update", "edit"],
  ["revise", "edit"],
  ["redo", "edit"],
  ["tweak", "edit"],
  // cancel → 'cancel'
  ["cancel", "cancel"],
  ["stop", "cancel"],
  ["abort", "cancel"],
  ["quit", "cancel"],
]);

const _GO_AHEAD_RE =
  /^(go\s+ahead|run\s+it|do\s+it|proceed|execute\s*(it|that)?|let(?:'s|s)?\s+do\s+(it|that)|run\s+that|yes\s+do\s+it|just\s+do\s+it|sounds\s+good)$/i;
const _CANCEL_RE = /^(never\s+mind|nevermind|forget\s+(it|that)|no\s+thanks?|no\s+thank\s+you)$/i;

/**
 * Normalize a user reply to a canonical approval token.
 *
 * @returns 'yes' | 'no' | 'more' | 'edit' | 'go_ahead' | 'cancel' | null
 */
export function normalizeApproval(text) {
  const t = text.trim().toLowerCase();
  if (_EXACT.has(t)) {
    return _EXACT.get(t);
  }
  if (_GO_AHEAD_RE.test(t)) {
    return "go_ahead";
  }
  if (_CANCEL_RE.test(t)) {
    return "cancel";
  }
  return null;
}

// ── Stage-A deterministic planner ─────────────────────────────────────────────
// Extracts entities and detects intents from message text using a lexicon.
// Returns a Plan array or null (→ fall through to classify_intent).
//
// Plan step shape:
//   { type: 'action'|'chat', name?, args?, priority, can_run_in_background }

const _EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const _URL_RE = /https?:\/\/[^\s)>]+/g;
const _FILE_RE = /(?:^|\s)(\.\/|\/)[a-zA-Z0-9/_.-]+/g;

// Verb triggers for each action type (checked case-insensitively against full message)
const _VERB_TRIGGERS = {
  send_email: /\b(email|send\s+(an?\s+)?email|write\s+to|message|forward)\b/i,
  web_search:
    /\b(search|find|look\s+up|google|what\s+(is|are)|who\s+(is|are)|tell\s+me\s+about|weather|news|price\s+of|latest|current)\b/i,
  run_shell: /\b(run|execute|ls|ps|df|du|mkdir|rm|mv|cp|git|npm|node|python|bash)\b/i,
  write_file: /\b(write\s+(to\s+a?\s*)?file|create\s+(a?\s+)?(file|doc)|save\s+to\s+file|draft)\b/i,
  read_file: /\b(read|open|show\s+(me\s+)?(the\s+)?(file|content)|cat|display\s+file)\b/i,
};

/**
 * Deterministic Stage-A planner.
 *
 * If the message strongly matches exactly one action type (high confidence),
 * return a single-step plan so we skip the LLM classify call entirely.
 *
 * If multiple intents detected, return null → caller falls through to classify_intent.
 * If no intent detected, return null → caller falls through to classify_intent.
 *
 * @param {string} text - raw user message
 * @returns {Array|null} Plan steps or null
 */
export function planStageA(text) {
  const hits = [];

  for (const [action, re] of Object.entries(_VERB_TRIGGERS)) {
    if (re.test(text)) {
      hits.push(action);
    }
  }

  // Zero hits or 2+ hits → ambiguous → fall through
  if (hits.length !== 1) {
    return null;
  }

  const action = hits[0];

  // Extract action-specific args
  let args = {};
  if (action === "send_email") {
    const emails = [...text.matchAll(_EMAIL_RE)].map((m) => m[0]);
    if (emails.length === 0) {
      return null;
    } // need an email address
    args = { to: emails[0] };
  } else if (action === "web_search") {
    // Extract a search query by stripping verb
    const q = text
      .replace(_VERB_TRIGGERS.web_search, "")
      .replace(/[?!.]+$/, "")
      .trim();
    if (!q) {
      return null;
    }
    args = { q };
  } else if (action === "run_shell") {
    // Only match if the message looks like a literal command (starts with a known verb)
    const firstWord = text.trim().split(/\s+/)[0].toLowerCase();
    const SHELL_FIRST = new Set([
      "ls",
      "ps",
      "df",
      "du",
      "mkdir",
      "rm",
      "mv",
      "cp",
      "git",
      "npm",
      "node",
      "python",
      "python3",
      "bash",
      "sh",
      "curl",
      "wget",
      "cat",
      "head",
      "tail",
      "grep",
      "find",
    ]);
    if (!SHELL_FIRST.has(firstWord)) {
      return null;
    } // not confident enough
    args = { command: text.trim() };
  } else if (action === "write_file") {
    return null; // too many unknowns — let LLM handle
  } else if (action === "read_file") {
    const fileMatches = [...text.matchAll(_FILE_RE)];
    if (fileMatches.length === 0) {
      return null;
    }
    args = { path: fileMatches[0][0].trim() };
  }

  return [{ type: "action", name: action, args, priority: 1, can_run_in_background: false }];
}

// ── Long-task detector ─────────────────────────────────────────────────────────
/**
 * True if the message describes a long-running task that should be spawned as a background job.
 * These tasks should NOT block the main reply — spawn a job and reply with job_id immediately.
 */
const _LONG_TASK_RE =
  /\b(scan\s+(all\s+)?disk|find\s+(all\s+)?(\d+\+?\s+)?(homes?|houses?|apartments?|listings?|propert)|install\s+skill|build\s+skill|generate\s+(a\s+)?(\w+\s+)?(report|analysis|summary)|write\s+(a\s+)?(long|full|complete|comprehensive)|analyze\s+(all|full|entire)|crawl|scrape)\b/i;

/**
 * Returns true if this message should be executed as a background job.
 */
export function isLongTask(text) {
  return _LONG_TASK_RE.test(text);
}
