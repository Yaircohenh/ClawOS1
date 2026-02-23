/**
 * Unit tests for fastpath.js
 * Run: node clawos/scripts/test_fastpath.mjs
 */
import {
  evalArithmetic,
  formatArithResult,
  normalizeApproval,
  planStageA,
  isLongTask,
} from "../bridge/src/fastpath.js";

let pass = 0,
  fail = 0;

function test(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(
      `  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(actual)}`,
    );
    fail++;
  }
}

// ── evalArithmetic ────────────────────────────────────────────────────────────
console.log("\n── evalArithmetic ───────────────────────────────────────────────────────");

{
  const r = evalArithmetic("85*3");
  test("85*3 matched", r.matched, true);
  test("85*3 = 255", formatArithResult(r.value), "255");
}
{
  const r = evalArithmetic("10 + 5");
  test("10 + 5 matched", r.matched, true);
  test("10 + 5 = 15", r.value, 15);
}
{
  const r = evalArithmetic("(2 + 3) * 4");
  test("(2+3)*4 matched", r.matched, true);
  test("(2+3)*4 = 20", r.value, 20);
}
{
  const r = evalArithmetic("100/4");
  test("100/4 matched", r.matched, true);
  test("100/4 = 25", r.value, 25);
}
{
  const r = evalArithmetic("-5+3");
  test("-5+3 matched", r.matched, true);
  test("-5+3 = -2", r.value, -2);
}
{
  const r = evalArithmetic("what is 8*7");
  test("'what is 8*7' matched (strips prefix)", r.matched, true);
  test("8*7 = 56", r.value, 56);
}
{
  const r = evalArithmetic("3+4 =");
  test("'3+4 =' matched (strips trailing =)", r.matched, true);
  test("3+4 = 7", r.value, 7);
}
test("bare number NOT matched", evalArithmetic("42").matched, false);
test("plain text NOT matched", evalArithmetic("hello world").matched, false);
test("'alert(1)' NOT matched (injection guard)", evalArithmetic("alert(1)").matched, false);
test("div-by-zero NOT matched", evalArithmetic("5/0").matched, false);
test("empty string NOT matched", evalArithmetic("").matched, false);

// ── normalizeApproval ─────────────────────────────────────────────────────────
console.log("\n── normalizeApproval ────────────────────────────────────────────────────");

test("yes → yes", normalizeApproval("yes"), "yes");
test("Y → yes", normalizeApproval("Y"), "yes");
test("sure → yes", normalizeApproval("sure"), "yes");
test("ok → yes", normalizeApproval("ok"), "yes");
test("okay → yes", normalizeApproval("okay"), "yes");
test("confirmed → yes", normalizeApproval("confirmed"), "yes");
test("no → no", normalizeApproval("no"), "no");
test("nope → no", normalizeApproval("nope"), "no");
test("nah → no", normalizeApproval("nah"), "no");
test("reject → no", normalizeApproval("reject"), "no");
test("cancel → cancel", normalizeApproval("cancel"), "cancel");
test("stop → cancel", normalizeApproval("stop"), "cancel");
test("abort → cancel", normalizeApproval("abort"), "cancel");
test("go ahead → go_ahead", normalizeApproval("go ahead"), "go_ahead");
test("GO AHEAD → go_ahead", normalizeApproval("GO AHEAD"), "go_ahead");
test("run it → go_ahead", normalizeApproval("run it"), "go_ahead");
test("do it → go_ahead", normalizeApproval("do it"), "go_ahead");
test("proceed → go_ahead", normalizeApproval("proceed"), "go_ahead");
test("never mind → cancel", normalizeApproval("never mind"), "cancel");
test("nevermind → cancel", normalizeApproval("nevermind"), "cancel");
test("more → more", normalizeApproval("more"), "more");
test("details → more", normalizeApproval("details"), "more");
test("edit → edit", normalizeApproval("edit"), "edit");
test("change → edit", normalizeApproval("change"), "edit");
test("random text → null", normalizeApproval("what is the weather today"), null);
test("sentence → null", normalizeApproval("i want to search for something"), null);

// ── planStageA ────────────────────────────────────────────────────────────────
console.log("\n── planStageA ───────────────────────────────────────────────────────────");

{
  const p = planStageA("ls /tmp");
  test("'ls /tmp' → run_shell", p?.[0]?.name, "run_shell");
  test("'ls /tmp' command preserved", p?.[0]?.args?.command, "ls /tmp");
}
{
  const p = planStageA("git status");
  test("'git status' → run_shell", p?.[0]?.name, "run_shell");
}
{
  const p = planStageA("what is quantum computing");
  test("'what is quantum computing' → web_search", p?.[0]?.name, "web_search");
}
test("email without address → null", planStageA("send an email to my boss"), null);
test(
  "multi-intent → null",
  planStageA("email john@example.com and also search for React docs"),
  null,
);
test("hello world → null", planStageA("hello how are you"), null);

// ── isLongTask ────────────────────────────────────────────────────────────────
console.log("\n── isLongTask ───────────────────────────────────────────────────────────");

test("'scan all disk' → true", isLongTask("scan all disk space"), true);
test("'find 10 homes in Austin' → true", isLongTask("find 10 homes in Austin Texas"), true);
test("'generate a full report' → true", isLongTask("generate a full analysis report"), true);
test(
  "'write a comprehensive guide' → true",
  isLongTask("write a comprehensive guide to K8s"),
  true,
);
test("short message → false", isLongTask("what is the weather"), false);
test("regular search → false", isLongTask("search for React hooks tutorial"), false);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────────────────────────────────────────────`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
