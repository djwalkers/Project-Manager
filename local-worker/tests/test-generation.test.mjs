// Phase 1G test case generation pipeline tests (test prompts/schema 1.0.0) —
// real prompts, context building, schema checks, provenance validation,
// quality gates and dedup; a scripted fake model instead of Ollama.
// Proves: manual ACs (no type / Given-When-Then / provenance) are designed
// from their own text, AI-promoted ACs bring their fragments and Human
// Clarifications (labelled as such), open questions are never facts and
// never become placeholder tests, one AC can yield several tests, every test
// traces to an AC, fabricated labels are refused, invented values / UI
// controls / names are rejected or flagged, a restated criterion is not a
// procedure, duplicates consolidate, coverage gaps are surfaced, stages are
// reused on retry, and the worker runs test generation last.
import assert from "node:assert/strict";
import {
  RESTATEMENT_SIMILARITY, TEST_MAX_ATTEMPTS, TestGenerationError, buildTestContext, droppedAlternatives, inventedControls, inventedNames, runTestGeneration, sameTest, validateTestGenerationOutput,
} from "../test-generation/pipeline.js";
import { TEST_PROMPT_VERSION, TEST_SCHEMA_VERSION, testPromptFingerprint } from "../test-generation/prompts.js";
import { TEST_IDENTITY, WORKER_VERSION, processTestGenerationRun, runTestGenerationOnce } from "../worker.js";
import { wordSet } from "../analysis/pipeline.js";

async function run(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

// Released test prompt versions and the fingerprint of their exact text.
const TEST_PROMPT_FINGERPRINTS = {
  "1.0.0": "7cd86d8b497609ca0508694f14020ad6ce8e67750e22539131a37865808483ba",
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const manualAc = (n, ref, criterion, description = null) => ({ id: id(n), ref, criterion, description, status: "Met", criterion_type: null, given_text: null, when_text: null, then_text: null, origin: "manual",
  proposal_id: null, source_quote: null, fragment_ids: [], human_clarification_ids: [], analysis_clarification_ids: [], scope_note_ids: [], resolved_issue_ids: [], open_issue_ids: [] });
const MANUAL = {
  requirement: { id: id(1), ref: "REP-010", title: "Loading Dashboard Plant Selection", description: "Loading Dashboard must default the plant from Plant/User configuration and permit plant changes only for Support Users.", promoted: false, source_quote: null, fragment_ids: [] },
  acceptance_criteria: [
    manualAc(11, "AC-029", "Loading Dashboard plant defaults from Plant/User configuration", "The Loading Dashboard's plant defaults from the user's Plant/User configuration."),
    manualAc(12, "AC-030", "Only a Support User can change plant in Loading Dashboard", "A Support User can change plant within the Loading Dashboard; a non-Support User cannot."),
  ],
  fragments: [], human_clarifications: [], analysis_clarifications: [], scope_notes: [], resolved_questions: [], open_questions: [],
};
const F3 = { id: id(3), sequence: 3, fragment_type: "text", section_path: ["CR", "Detailed Requirements"], section_heading: "Detailed Requirements", page_start: 1, page_end: 1, metadata: {},
  text: "On the Pick Admin Dashboard, the picker's user name must remain against the multi cage pick task, and not update with the palletiser name, after palletisation. MONO picks remain as they are. The Goods In screen is unrelated." };
const HC = { id: id(400), proposal_id: id(500), clarification: "The picker's name is the name of the user who completed the pick.", reason: "Vague wording", created_by_name: "Manager User", created_at: "2026-10-01" };
const RESOLVED = { id: id(600), question: "Which dashboard?", description: "d", status: "Resolved", resolution_note: "The Pick Admin Dashboard.", reviewed_by_name: "Manager User" };
const ADDITIONAL = { id: id(700), question: "What happens when the task is palletised twice?", description: "d", relation: "Additional Coverage", status: "Open" };
const REOPENED = { id: id(701), question: "Is the picker shown on reporting extracts?", description: "d", relation: "Blocking", status: "Open" };
const NOTE = { id: id(800), area: "MONO picks", description: "MONO picks remain as they are.", source_quote: "MONO picks remain as they are.", associated: true };
const AI_AC = { ...manualAc(21, "AC-001", "When a multi cage pick task is palletised on the Pick Admin Dashboard, the picker's name remains against the task and does not update to the palletiser's name."),
  origin: "ai", proposal_id: id(500), criterion_type: "Positive", given_text: "A multi cage pick task with a picker name on the Pick Admin Dashboard", when_text: "The task is palletised", then_text: "The picker's name remains against the task",
  source_quote: "the picker's user name must remain against the multi cage pick task", fragment_ids: [F3.id], human_clarification_ids: [HC.id], resolved_issue_ids: [RESOLVED.id], open_issue_ids: [ADDITIONAL.id] };
const PROMOTED = {
  requirement: { id: id(2), ref: "REP-001", title: "Picker name remains", description: "On the Pick Admin Dashboard, the picker's user name must remain against the multi cage pick task.", promoted: true, source_quote: null, fragment_ids: [F3.id] },
  acceptance_criteria: [AI_AC], fragments: [F3], human_clarifications: [HC], analysis_clarifications: [], scope_notes: [], resolved_questions: [RESOLVED], open_questions: [ADDITIONAL],
};
const inputOf = (base, o = {}) => ({ run: { id: "t1", model: "qwen3:8b" }, ...structuredClone(base), ...o });

const userOf = (messages) => messages.find((m) => m.role === "user").content;
const stageOf = (messages) => {
  const u = userOf(messages);
  if (u.startsWith("TASK: decompose")) return "behaviours";
  if (u.startsWith("TASK: these BEHAVIOURS")) return "coverage";
  return "tests";
};
function fakeLlm(handlers) {
  const calls = [];
  const attempts = {};
  return {
    calls,
    async chat({ messages, schema }) {
      const stage = stageOf(messages);
      attempts[stage] = (attempts[stage] ?? 0) + 1;
      calls.push({ stage, messages: messages.map((m) => ({ ...m })), schema, attempt: attempts[stage] });
      const out = (handlers[stage] ?? (() => ({ tests: [], gaps: [] })))(messages, attempts[stage]);
      return { content: typeof out === "string" ? out : JSON.stringify(out), durationMs: 5 };
    },
  };
}
const bh = (o) => ({ criteria: ["A1"], statement: "s", kind: "positive", variation: "", source_ids: [], clarification_ids: [], scope_note_ids: [], ...o });
const tc = (o) => ({ behaviours: ["B1"], criteria: ["A1"], title: "t", objective: "o", preconditions: [], steps: [{ action: "a", expected: "" }, { action: "b", expected: "" }], expected_result: "e",
  test_type: "Positive", variation: "", basis: "Explicit", confidence: "High", source_ids: [], clarification_ids: [], scope_note_ids: [], rationale: "Proves it.", ...o });

// Manual ACs: one AC with two variations (Support User / non-Support User) → two tests.
const manualStandard = {
  behaviours: () => ({ behaviours: [
    bh({ criteria: ["A1"], statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration.", variation: "" }),
    bh({ criteria: ["A2"], statement: "A Support User can change plant within the Loading Dashboard.", variation: "Support User" }),
    bh({ criteria: ["A2"], statement: "A non-Support User cannot change plant within the Loading Dashboard.", kind: "negative", variation: "non-Support User" }),
  ], scope_notes: [] }),
  tests: () => ({ tests: [
    tc({ behaviours: ["B1"], criteria: ["A1"], title: "Plant defaults from Plant/User configuration", objective: "Prove the Loading Dashboard plant defaults from Plant/User configuration.",
      preconditions: ["A user whose Plant/User configuration has a plant"], steps: [{ action: "Open the Loading Dashboard as that user.", expected: "" }, { action: "Observe the plant shown.", expected: "It is the plant from the user's Plant/User configuration." }],
      expected_result: "The Loading Dashboard shows the plant from the user's Plant/User configuration." }),
    tc({ behaviours: ["B2"], criteria: ["A2"], title: "Support User can change plant", objective: "Prove a Support User can change plant within the Loading Dashboard.", variation: "Support User",
      steps: [{ action: "Open the Loading Dashboard as a Support User.", expected: "" }, { action: "Change the plant.", expected: "The plant changes." }], expected_result: "A Support User can change plant within the Loading Dashboard." }),
    tc({ behaviours: ["B3"], criteria: ["A2"], title: "Non-Support User cannot change plant", objective: "Prove a non-Support User cannot change plant within the Loading Dashboard.", variation: "non-Support User", test_type: "Negative",
      steps: [{ action: "Open the Loading Dashboard as a non-Support User.", expected: "" }, { action: "Try to change the plant.", expected: "The plant cannot be changed." }], expected_result: "A non-Support User cannot change plant within the Loading Dashboard." }),
  ], gaps: [] }),
};

// ── Versioning ──────────────────────────────────────────────────────────────

await run("test prompts are versioned separately and the text is pinned to its version; the worker identifies them on claim", () => {
  assert.equal(testPromptFingerprint(), TEST_PROMPT_FINGERPRINTS[TEST_PROMPT_VERSION], "test prompt text changed — bump TEST_PROMPT_VERSION and pin the new fingerprint");
  assert.equal(TEST_PROMPT_VERSION, "1.0.0");
  assert.deepEqual(TEST_IDENTITY, { test_prompt_version: TEST_PROMPT_VERSION, test_prompt_sha256: testPromptFingerprint(), test_schema_version: TEST_SCHEMA_VERSION });
  assert.equal(WORKER_VERSION, "0.5.0");
});

// ── Eligibility / input ─────────────────────────────────────────────────────

await run("manual ACs (no type, no Given/When/Then, no provenance) are designed from their own text; no source section is invented", async () => {
  const ctx = buildTestContext(inputOf(MANUAL));
  assert.match(ctx.criteriaText, /\[A1\] AC-029: Loading Dashboard plant defaults/);
  assert.match(ctx.criteriaText, /written by the team — its text is the authority/);
  assert.doesNotMatch(ctx.criteriaText, /Given:/, "no Given/When/Then line for a manual AC without it");
  assert.equal(ctx.sourceText, "");
  const llm = fakeLlm(manualStandard);
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm });
  assert.equal(r.proposals.length, 3);
  assert.ok(r.proposals.every((p) => p.source_ac_ids.length >= 1 && p.source_fragment_ids.length === 0));
  assert.match(userOf(llm.calls[0].messages), /SOURCE \(.*\):\n\(none — the acceptance criteria text is the authority\)/);
});

await run("one AC can yield several tests (actor variations), each tracing to that AC", async () => {
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm(manualStandard) });
  const forA2 = r.proposals.filter((p) => p.source_ac_ids.includes(id(12)));
  assert.equal(forA2.length, 2);
  assert.deepEqual(forA2.map((p) => [p.test_type, p.variation]), [["Positive", "Support User"], ["Negative", "non-Support User"]]);
  assert.deepEqual(r.diagnostics.ac_coverage.map((c) => c.tests.length), [1, 2]);
  assert.equal(r.issues.length, 0);
});

await run("AI-promoted ACs bring their fragments, Human Clarifications (labelled as such) and resolved questions; open questions are shown as non-facts", async () => {
  const ctx = buildTestContext(inputOf(PROMOTED));
  assert.match(ctx.criteriaText, /\[A1\] AC-001 \(Positive\):/);
  assert.match(ctx.criteriaText, /Given: A multi cage pick task .* \| When: The task is palletised \| Then:/);
  assert.match(ctx.criteriaText, /Relies on: F3, H1, R1/);
  assert.match(ctx.humanText, /^\[H1\] Human Clarification by Manager User: The picker's name is the name/);
  assert.match(ctx.resolvedText, /\[R1\] Which dashboard\? — Resolved: The Pick Admin Dashboard\./);
  assert.match(ctx.openQuestionsText, /\[Q1\] What happens when the task is palletised twice\?/);
  // Only the sentences stating these criteria are shown (not the unrelated Goods In sentence).
  assert.match(ctx.sourceText, /picker's user name must remain/);
  assert.doesNotMatch(ctx.sourceText, /Goods In/);
  const prompt = (await (async () => { const llm = fakeLlm({ behaviours: () => ({ behaviours: [bh({ statement: "The picker's name remains against the task." })], scope_notes: [] }), tests: () => ({ tests: [], gaps: [] }) }); await runTestGeneration({ input: inputOf(PROMOTED), llm }).catch(() => {}); return userOf(llm.calls[0].messages); })());
  assert.match(prompt, /OPEN QUESTIONS \(unanswered — NOT facts; never design a test for them\):\n\[Q1\]/);
  assert.match(prompt, /HUMAN CLARIFICATIONS \(authoritative answers recorded by a reviewer\):\n\[H1\]/);
});

await run("tests inherit the AI-promoted AC's provenance; ids map back deterministically", async () => {
  const r = await runTestGeneration({ input: inputOf(PROMOTED), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "After palletisation the picker's name remains against the multi cage pick task.", source_ids: ["F3"] })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ title: "Picker name remains after palletisation", objective: "Prove the picker's name remains against the multi cage pick task after palletisation.",
      preconditions: ["A multi cage pick task with a picker name on the Pick Admin Dashboard"], steps: [{ action: "Palletise the multi cage pick task.", expected: "" }, { action: "Open the task on the Pick Admin Dashboard.", expected: "The picker's name is shown against the task." }],
      expected_result: "The picker's name remains against the multi cage pick task and does not update to the palletiser's name." })], gaps: [] }),
  }) });
  const p = r.proposals[0];
  assert.deepEqual([p.source_ac_ids, p.source_fragment_ids, p.human_clarification_ids, p.resolved_issue_ids], [[AI_AC.id], [F3.id], [HC.id], [RESOLVED.id]]);
  assert.deepEqual(p.steps.map((s) => s.step), [1, 2]);
  assert.equal(p.steps[0].expected, null);
});

// ── Open questions ──────────────────────────────────────────────────────────

await run("open Additional Coverage questions never become placeholder tests: each is an uncovered test-design issue; a re-opened blocking question is High", async () => {
  const input = inputOf(PROMOTED, { open_questions: [ADDITIONAL, REOPENED] });
  const r = await runTestGeneration({ input, llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The picker's name remains against the multi cage pick task." })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ title: "Picker name remains", objective: "Prove the picker's name remains.", steps: [{ action: "Palletise the multi cage pick task.", expected: "" }, { action: "Open it on the Pick Admin Dashboard.", expected: "The picker's name is shown." }], expected_result: "The picker's name remains against the multi cage pick task." })], gaps: [] }),
  }) });
  const add = r.issues.find((i) => i.issue_type === "Additional Coverage Question");
  const blk = r.issues.find((i) => i.issue_type === "Unresolved Question");
  assert.deepEqual([add.severity, add.source_issue_ids], ["Low", [ADDITIONAL.id]]);
  assert.match(add.description, /Not covered by any test until answered: "What happens when the task is palletised twice\?". No placeholder test/);
  assert.deepEqual([blk.severity, blk.source_issue_ids], ["High", [REOPENED.id]]);
  assert.equal(r.proposals.length, 1, "no test for either question");
});

await run("a test or behaviour that cites an OPEN QUESTION is refused and retried (an open question is not a fact)", async () => {
  const llm = fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The picker's name remains against the multi cage pick task." })], scope_notes: [] }),
    tests: (_m, attempt) => ({ tests: [tc({ title: "Palletised twice", objective: "o", clarification_ids: attempt === 1 ? ["Q1"] : [], steps: [{ action: "Palletise the multi cage pick task.", expected: "" }, { action: "Check the Pick Admin Dashboard.", expected: "The picker's name is shown." }], expected_result: "The picker's name remains against the multi cage pick task." })], gaps: [] }),
  });
  await runTestGeneration({ input: inputOf(PROMOTED), llm });
  const testsCalls = llm.calls.filter((c) => c.stage === "tests");
  assert.equal(testsCalls.length, 2);
  assert.match(testsCalls[1].messages.at(-1).content, /cites Q1, an OPEN QUESTION — an open question is not a fact/);
});

// ── Grounding and anti-invention ────────────────────────────────────────────

await run("every test traces to an AC: a fabricated or missing AC label is refused, retried, then dropped", async () => {
  const llm = fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ criteria: ["A9"], title: "x", objective: "o", steps: [{ action: "Open the Loading Dashboard.", expected: "" }, { action: "Observe the plant.", expected: "The configured plant." }], expected_result: "The Loading Dashboard shows the plant from Plant/User configuration." })], gaps: [] }),
  });
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm });
  assert.equal(llm.calls.filter((c) => c.stage === "tests").length, TEST_MAX_ATTEMPTS);
  assert.equal(r.proposals.length, 0);
  assert.ok(r.issues.some((i) => i.issue_type === "Uncovered Acceptance Criterion" && i.ac_ids[0] === id(11)), "the AC's missing coverage is surfaced");
  assert.ok(r.diagnostics.warnings.some((w) => /invalid item/.test(w)));
});

await run("an invented value is rejected with an Insufficient Source Support issue; invented UI controls and names are flagged (Needs Review, Inferred)", async () => {
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." }), bh({ criteria: ["A2"], statement: "A Support User can change plant within the Loading Dashboard.", variation: "Support User" })], scope_notes: [] }),
    tests: () => ({ tests: [
      tc({ title: "Default within 2 seconds", objective: "o", steps: [{ action: "Open the Loading Dashboard.", expected: "" }, { action: "Wait.", expected: "The plant appears within 2 seconds." }], expected_result: "The plant from Plant/User configuration is shown within 2 seconds." }),
      tc({ behaviours: ["B2"], criteria: ["A2"], title: "Support User changes plant", objective: "o", variation: "Support User", steps: [{ action: "Open the Loading Dashboard as a Support User.", expected: "" }, { action: "Click the green Change Plant button on the Settings tab.", expected: "A Plant Picker Dialog opens." }], expected_result: "A Support User can change plant within the Loading Dashboard." }),
    ], gaps: [] }),
  }) });
  assert.ok(r.diagnostics.rejected_tests.some((x) => /states 2 seconds/.test(x.reason)));
  assert.ok(r.issues.some((i) => i.issue_type === "Insufficient Source Support" && /2 seconds/.test(i.description)));
  const flagged = r.proposals.find((p) => p.title === "Support User changes plant");
  assert.equal(flagged.basis, "Inferred");
  assert.ok(flagged.needs_review_reasons.some((x) => /^Unsupported procedure detail/.test(x) && /Change Plant button|Settings tab|Plant Picker Dialog/.test(x)));
  assert.ok(r.issues.some((i) => i.issue_type === "Uncovered Behaviour" || i.issue_type === "Uncovered Acceptance Criterion"), "the rejected test's behaviour stays visible as uncovered");
});

await run("controls and names already in the governed context are not invention", () => {
  const corpus = "Replenishment Dashboard presents a Temperature filter control. Plant/User configuration. Support User.";
  assert.deepEqual(inventedControls("Open the Replenishment Dashboard and use the Temperature filter control.", wordSet(corpus)), []);
  assert.deepEqual(inventedControls("Click the Save button.", wordSet(corpus)), ["Save button"]);
  assert.deepEqual(inventedNames("Log in as a Support User and open the Replenishment Dashboard.", corpus), []);
  assert.deepEqual(inventedNames("Open the Stock Control Centre.", corpus), ["Stock Control Centre"]);
  assert.deepEqual(inventedNames("Verify Replenishment Dashboard Support User", corpus), [], "a title-cased procedure verb does not make a new name");
});

await run("names are never detected across step boundaries (\"…Dashboard\" + \"Check …\" is not a name)", async () => {
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ title: "Plant default", objective: "Prove the Loading Dashboard plant default.", preconditions: ["The user is a Support User"],
      steps: [{ action: "Open the Loading Dashboard", expected: "" }, { action: "Check the plant value", expected: "The plant from the user's Plant/User configuration" }], expected_result: "The Loading Dashboard shows the plant from the user's Plant/User configuration." })], gaps: [] }),
  }) });
  assert.deepEqual(r.proposals[0].needs_review_reasons, []);
  assert.equal(r.proposals[0].basis, "Explicit");
});

await run("a single step that merely restates the criterion is not a procedure (rejected); a hollow vague expected result is rejected", async () => {
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." }), bh({ criteria: ["A2"], statement: "A Support User can change plant within the Loading Dashboard." })], scope_notes: [] }),
    tests: () => ({ tests: [
      tc({ title: "Restated", objective: "o", steps: [{ action: "Loading Dashboard plant defaults from Plant/User configuration", expected: "" }], expected_result: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." }),
      tc({ behaviours: ["B2"], criteria: ["A2"], title: "Vague", objective: "o", steps: [{ action: "Open the Loading Dashboard as a Support User.", expected: "" }, { action: "Change the plant.", expected: "" }], expected_result: "It works as expected." }),
    ], gaps: [] }),
  }) });
  assert.ok(RESTATEMENT_SIMILARITY > 0.5);
  assert.ok(r.diagnostics.rejected_tests.some((x) => /merely restates/.test(x.reason)));
  assert.ok(r.diagnostics.rejected_tests.some((x) => /vague expected result/.test(x.reason)));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.issues.filter((i) => i.issue_type === "Uncovered Behaviour").length, 2, "both behaviours stay visible as uncovered");
});

await run("dropped alternatives and combined variations are flagged; an unsupported success rule is flagged", async () => {
  assert.deepEqual(droppedAlternatives("The Support User flag can be set or unset per user.", "Set the Support User flag."), ["set or unset"]);
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [
      bh({ criteria: ["A2"], statement: "A Support User can change plant within the Loading Dashboard.", variation: "Support User" }),
      bh({ criteria: ["A2"], statement: "A non-Support User cannot change plant within the Loading Dashboard.", kind: "negative", variation: "non-Support User" }),
      bh({ criteria: ["A1"], statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." }),
    ], scope_notes: [] }),
    tests: () => ({ tests: [
      tc({ behaviours: ["B1", "B2"], criteria: ["A2"], title: "Both users", objective: "o", steps: [{ action: "Open the Loading Dashboard as a Support User and change plant.", expected: "" }, { action: "Repeat as a non-Support User.", expected: "The plant cannot be changed." }], expected_result: "Only a Support User can change plant within the Loading Dashboard." }),
      tc({ behaviours: ["B3"], criteria: ["A1"], title: "Default", objective: "o", steps: [{ action: "Open the Loading Dashboard.", expected: "" }, { action: "Observe the plant.", expected: "" }], expected_result: "The plant shown matches the plant stored in the database." }),
    ], gaps: [] }),
  }) });
  assert.ok(r.proposals[0].needs_review_reasons.some((x) => /^Combines 2 independently testable variations/.test(x)));
  assert.ok(r.proposals[1].needs_review_reasons.some((x) => /^Expected result introduces an unsupported interpretation/.test(x)));
  // A comparison to a value the input names is ordinary test phrasing.
  const r2 = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ title: "Verify Loading Dashboard Plant Default", objective: "o", steps: [{ action: "Open the Loading Dashboard.", expected: "" }, { action: "Check the displayed plant.", expected: "" }], expected_result: "The displayed plant matches the user's Plant/User configuration." })], gaps: [] }),
  }) });
  assert.deepEqual(r2.proposals[0].needs_review_reasons, []);
});

await run("the same test proposed twice is consolidated losslessly; tests for different variations never merge", () => {
  const a = { test_type: "Positive", variation: "", ac_labels: ["A1"], title: "Plant defaults", objective: "o", preconditions: [], steps: [{ action: "Open the Loading Dashboard.", expected: "" }], expected_result: "The Loading Dashboard shows the configured plant." };
  assert.equal(sameTest(a, { ...a, title: "Plant defaults" }), true);
  assert.equal(sameTest(a, { ...a, variation: "Support User" }), false);
  assert.equal(sameTest(a, { ...a, ac_labels: ["A2"] }), false);
});

await run("duplicate tests from the tests and coverage stages are consolidated, with members kept", async () => {
  const dup = tc({ title: "Plant defaults from Plant/User configuration", objective: "o", steps: [{ action: "Open the Loading Dashboard.", expected: "" }, { action: "Observe the plant.", expected: "" }], expected_result: "The Loading Dashboard shows the plant from the user's Plant/User configuration." });
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." }), bh({ criteria: ["A2"], statement: "A Support User can change plant within the Loading Dashboard." })], scope_notes: [] }),
    tests: () => ({ tests: [dup, { ...dup, rationale: "Again." }], gaps: [{ behaviour: "B2", issue_type: "Missing Test Detail", description: "How a Support User changes plant is not stated.", question: "Which control changes the plant?" }] }),
  }) });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].consolidation.member_count, 2);
  assert.ok(r.issues.some((i) => i.issue_type === "Missing Test Detail" && i.suggested_question === "Which control changes the plant?"));
});

// ── Scope / regression ──────────────────────────────────────────────────────

await run("regression tests only for regression behaviours grounded in a relevant (associated) scope note; otherwise refused", async () => {
  const withNote = inputOf(PROMOTED, { scope_notes: [NOTE], open_questions: [] });
  const r = await runTestGeneration({ input: withNote, llm: fakeLlm({
    behaviours: () => ({ behaviours: [
      bh({ statement: "The picker's name remains against the multi cage pick task." }),
      bh({ statement: "MONO picks remain as they are.", kind: "regression", scope_note_ids: ["N1"] }),
    ], scope_notes: [{ id: "N1", relevant: true, reason: "Same dashboard." }] }),
    tests: () => ({ tests: [
      tc({ title: "Picker name remains", objective: "o", steps: [{ action: "Palletise the multi cage pick task.", expected: "" }, { action: "Open the Pick Admin Dashboard.", expected: "" }], expected_result: "The picker's name remains against the multi cage pick task." }),
      tc({ behaviours: ["B2"], title: "MONO picks unchanged", objective: "o", test_type: "Regression", scope_note_ids: ["N1"], steps: [{ action: "Complete a MONO pick.", expected: "" }, { action: "Open the Pick Admin Dashboard.", expected: "" }], expected_result: "MONO picks remain as they are." }),
    ], gaps: [] }),
  }) });
  const reg = r.proposals.find((p) => p.test_type === "Regression");
  assert.deepEqual([reg.scope_note_ids, reg.source_ac_ids], [[NOTE.id], [AI_AC.id]]);
  // Without a relevant note, a regression behaviour is refused (no generic "nothing else breaks").
  const r2 = await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The Loading Dashboard's plant defaults from the user's Plant/User configuration." }), bh({ statement: "Everything else still works.", kind: "regression" })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ title: "Default", objective: "o", steps: [{ action: "Open the Loading Dashboard.", expected: "" }, { action: "Observe the plant.", expected: "" }], expected_result: "The Loading Dashboard shows the plant from the user's Plant/User configuration." })], gaps: [] }),
  }) });
  assert.ok(r2.diagnostics.rejected_tests.some((x) => /regression behaviour without .* kept as an ordinary behaviour/.test(x.reason)));
  assert.equal(r2.proposals.filter((p) => p.test_type === "Regression").length, 0);
  assert.ok(r2.diagnostics.behaviours.some((b) => b.statement === "Everything else still works." && b.kind === "positive"), "kept, not as regression");
  // Continuity wording in the AC itself grounds a regression behaviour.
  const cont = inputOf(MANUAL, { acceptance_criteria: [manualAc(13, "AC-020", "Scheduled Replenishment job remains independently executable per plant", "The scheduled Replenishment job continues to execute independently for each plant, unaffected by the dashboard filter.")] });
  const r3 = await runTestGeneration({ input: cont, llm: fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The scheduled Replenishment job continues to execute independently for each plant.", kind: "regression" })], scope_notes: [] }),
    tests: () => ({ tests: [tc({ title: "Job still runs per plant", objective: "o", test_type: "Regression", steps: [{ action: "Change the dashboard filter.", expected: "" }, { action: "Let the scheduled Replenishment job run.", expected: "" }], expected_result: "The scheduled Replenishment job executes independently for each plant." })], gaps: [] }),
  }) });
  assert.deepEqual(r3.proposals.map((p) => p.test_type), ["Regression"]);
});

await run("a change-level note that is not supplied is never used; a relevant supplied note without a regression test is surfaced, not duplicated per AC", async () => {
  const second = { ...AI_AC, id: id(22), ref: "AC-002", criterion: "After palletisation the palletiser's name remains against the palletised pick task.", scope_note_ids: [NOTE.id] };
  const input = inputOf(PROMOTED, { acceptance_criteria: [{ ...AI_AC, scope_note_ids: [NOTE.id] }, second], scope_notes: [NOTE], open_questions: [] });
  const llm = fakeLlm({
    behaviours: () => ({ behaviours: [bh({ statement: "The picker's name remains against the multi cage pick task." }), bh({ criteria: ["A2"], statement: "The palletiser's name remains against the palletised pick task." })], scope_notes: [{ id: "N1", relevant: true, reason: "r" }] }),
    tests: () => ({ tests: [
      tc({ title: "Picker name remains", objective: "o", steps: [{ action: "Palletise the multi cage pick task.", expected: "" }, { action: "Open the Pick Admin Dashboard.", expected: "" }], expected_result: "The picker's name remains against the multi cage pick task." }),
      tc({ behaviours: ["B2"], criteria: ["A2"], title: "Palletiser name", objective: "o", steps: [{ action: "Palletise the multi cage pick task.", expected: "" }, { action: "Open the palletised pick task.", expected: "" }], expected_result: "The palletiser's name remains against the palletised pick task." }),
    ], gaps: [] }),
  });
  const r = await runTestGeneration({ input, llm });
  assert.equal(r.issues.filter((i) => /Scope note "MONO picks" was judged relevant/.test(i.description)).length, 1, "one issue for the note, not one per AC");
  assert.equal((userOf(llm.calls[0].messages).match(/\[N1\] MONO picks/g) ?? []).length, 1, "the note is shown once, not per AC");
  assert.doesNotMatch(userOf(llm.calls[0].messages), /Goods In/, "unrelated change-level text is not supplied");
});

// ── Coverage and validation ─────────────────────────────────────────────────

await run("uncovered behaviours get one focused coverage pass; still uncovered → issue; every AC is covered or reported", async () => {
  const llm = fakeLlm({ ...manualStandard, tests: () => ({ tests: [manualStandard.tests().tests[0]], gaps: [] }) });
  const r = await runTestGeneration({ input: inputOf(MANUAL), llm });
  assert.equal(llm.calls.filter((c) => c.stage === "coverage").length, 1);
  assert.match(userOf(llm.calls.find((c) => c.stage === "coverage").messages), /UNCOVERED BEHAVIOURS:\nB2 \(positive; Support User\)/);
  assert.equal(r.issues.filter((i) => i.issue_type === "Uncovered Behaviour").length, 2);
  assert.ok(r.issues.some((i) => i.issue_type === "Uncovered Acceptance Criterion" && i.ac_ids[0] === id(12) && i.severity === "High"));
});

await run("Stage 5 refuses a test outside the run's ACs, a missing procedure, or a chosen review status / reference", () => {
  const allowed = { acs: new Set([id(11)]), fragments: new Set(), human: new Set(), clarifications: new Set(), resolved: new Set(), scopeNotes: new Set(), openQuestions: new Set() };
  const ok = { sequence: 1, title: "t", objective: "o", expected_result: "e", rationale: "r", steps: [{ step: 1, action: "a", expected: null }], test_type: "Positive", basis: "Explicit", confidence: "High",
    source_ac_ids: [id(11)], source_fragment_ids: [], human_clarification_ids: [], analysis_clarification_ids: [], resolved_issue_ids: [], scope_note_ids: [] };
  assert.deepEqual(validateTestGenerationOutput({ proposals: [ok], issues: [] }, allowed), []);
  assert.ok(validateTestGenerationOutput({ proposals: [{ ...ok, source_ac_ids: [id(99)] }], issues: [] }, allowed).some((x) => /trace to at least one/.test(x)));
  assert.ok(validateTestGenerationOutput({ proposals: [{ ...ok, source_ac_ids: [] }], issues: [] }, allowed).some((x) => /trace to at least one/.test(x)));
  assert.ok(validateTestGenerationOutput({ proposals: [{ ...ok, steps: [] }], issues: [] }, allowed).some((x) => /1–30 steps/.test(x)));
  assert.ok(validateTestGenerationOutput({ proposals: [{ ...ok, test_ref: "TC-001" }], issues: [] }, allowed).some((x) => /not chosen by generation/.test(x)));
});

await run("malformed JSON is retried with the errors fed back, then the run fails as invalid_model_output", async () => {
  await assert.rejects(runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm({ behaviours: () => "not json" }) }), (e) => e instanceof TestGenerationError && e.category === "invalid_model_output");
});

await run("validated stage output is reused on retry (same model, prompt and input)", async () => {
  const stored = [];
  await runTestGeneration({ input: inputOf(MANUAL), llm: fakeLlm(manualStandard), onStage: async (s) => stored.push({ ...s, run_id: "t0" }) });
  const llm = fakeLlm(manualStandard);
  const r = await runTestGeneration({ input: { ...inputOf(MANUAL), run: { id: "t1", model: "qwen3:8b" } }, llm, reusable: stored });
  assert.equal(llm.calls.length, 0, "no model call on retry");
  assert.ok(r.diagnostics.stage_calls.every((c) => c.reused));
});

// ── Worker ──────────────────────────────────────────────────────────────────

function fakeOllama({ reachable = true, models = [{ name: "qwen3:8b", digest: "500a1f067a9fabc" }], llm } = {}) {
  return {
    status: async () => ({ reachable, version: "0.34.2", models }),
    show: async () => ({ capabilities: ["completion", "thinking"], contextLength: 40960 }),
    chat: async (args) => { assert.equal(args.think, false); assert.equal(args.model, "qwen3:8b"); return llm.chat(args); },
  };
}
const claimOf = () => ({ ...inputOf(MANUAL), run: { id: "t1", model: "qwen3:8b", attempt_count: 1 }, reusable_stages: [] });

await run("worker: Ollama offline or the model missing fails the run cleanly; a completed run posts its tests with the model digest", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  assert.equal((await processTestGenerationRun(claimOf(), { api, ollama: fakeOllama({ reachable: false }) })).category, "ollama_unreachable");
  assert.equal((await processTestGenerationRun(claimOf(), { api, ollama: fakeOllama({ models: [{ name: "qwen3:4b" }] }) })).category, "model_unavailable");
  calls.length = 0;
  const summary = await processTestGenerationRun(claimOf(), { api, ollama: fakeOllama({ llm: fakeLlm(manualStandard) }) });
  assert.equal(summary.status, "Completed");
  assert.ok(calls.slice(0, -1).every((c) => c.route === "test-generation/stage"));
  assert.deepEqual([calls.at(-1).route, calls.at(-1).body.model_digest, calls.at(-1).body.proposals.length], ["test-generation/complete", "500a1f067a9f (ollama 0.34.2)", 3]);
});

await run("worker: a server without test-generation routes (404) is tolerated quietly; the claim sends the test prompt identity", async () => {
  const logs = [];
  const state = {};
  const api = async () => { const e = new Error("404"); e.status = 404; throw e; };
  assert.equal(await runTestGenerationOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(await runTestGenerationOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(logs.length, 1);
  const idle = async (route, body) => { assert.equal(route, "test-generation/claim"); assert.deepEqual(body, TEST_IDENTITY); return { run: null }; };
  assert.equal(await runTestGenerationOnce({ api: idle, ollama: fakeOllama({}), state }), null);
});

await run("worker loop priority is deterministic: extraction → requirement analysis → AC generation → test generation", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("while (!stopping)"));
  const order = ["runOnce(", "runAnalysisOnce(", "runAcGenerationOnce(", "runTestGenerationOnce("].map((x) => loop.indexOf(x));
  assert.ok(order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
});

console.log("\nAll test generation pipeline tests passed.\n");
