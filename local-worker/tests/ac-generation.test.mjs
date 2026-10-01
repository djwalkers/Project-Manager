// Phase 1E Acceptance Criteria generation pipeline tests (AC prompts/schema
// 1.0.0) — real prompts, excerpting, schema checks, provenance validation,
// quality gates and consolidation; a scripted fake model instead of Ollama.
// Proves: only the Requirement's own sentences are shown, labels outside the
// supplied input are refused (and retried), malformed JSON is retried then
// refused, Positive / Negative / Regression are typed and grounded, a
// scope note yields Regression coverage only when judged relevant, a human
// clarification is recorded, an open question is never a fact (Needs
// Review), invented values and vague criteria are refused or flagged,
// duplicates merge losslessly but different actors never merge, every
// obligation is covered or reported, stages are reused on retry, and the
// worker fails cleanly when Ollama is offline.
import assert from "node:assert/strict";
import {
  AC_MAX_ATTEMPTS, AcGenerationError, buildContext, distinctTerms, inventedValues, requirementExcerpt, runAcGeneration, sameCheck, vagueness, validateAcGenerationOutput,
} from "../ac-generation/pipeline.js";
import { AC_PROMPT_VERSION, AC_SCHEMA_VERSION, acPromptFingerprint } from "../ac-generation/prompts.js";
import { AC_IDENTITY, WORKER_VERSION, processAcGenerationRun, runAcGenerationOnce } from "../worker.js";
import { wordSet } from "../analysis/pipeline.js";

async function run(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

// Released AC prompt versions and the fingerprint of their exact text.
// Changing any prompt wording without bumping AC_PROMPT_VERSION fails here.
const AC_PROMPT_FINGERPRINTS = {
  "1.0.0": "823269c2e07ec9dc2411ecfacc7d686e18b3fa79dff2c90655fc082f15a4c810",
  "1.1.0": "d602a2ae3dbbd7fe9be535b081eb02a8b2485cb7e6f7a716427aa79b87889c96",
  "1.2.0": "d26bbe628744bcfb14b74c4fe3d9f256999745528354d4124b73ee1ce61ecad2",
};

// ── Fixture: one promoted Requirement of a change request ───────────────────
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const F3 = { id: id(3), sequence: 3, fragment_type: "text", section_path: ["CR", "Detailed Requirements"], section_heading: "Detailed Requirements", page_start: 1, page_end: 1, metadata: {},
  text: "On the Admin Dashboard, the picker's user name must remain against the pick task, and not update with the palletiser name, after palletisation. After palletisation, the palletiser user name is to remain against the created palletised task. This detail would also need to be correct for any reporting extracts. MONO picks remain as they are." };
const F8 = { id: id(8), sequence: 8, fragment_type: "text", section_path: ["CR", "Change Description"], section_heading: "Change Description", page_start: 2, page_end: 2, metadata: {},
  text: "Currently the user name updates to the palletiser. We require the picker name to remain against the pick task on the dashboard, even after the pick task has been palletised." };
const SCOPE = { id: id(100), sequence: 1, note_type: "No Change", area: "MONO picks", description: "MONO picks remain as they are.", source_quote: "MONO picks remain as they are." };
const UNRELATED_SCOPE = { id: id(101), sequence: 2, note_type: "No Change", area: "Goods In", description: "Goods In screens remain as they are.", source_quote: "Goods In screens remain as they are." };
const OPEN = { id: id(200), sequence: 1, issue_type: "Missing Information", question: "Which palletiser name is shown when a task is palletised twice?", description: "Repeated palletisation is not described." };
const CLAR = { id: id(300), sequence: 2, issue_type: "Ambiguity", question: "Which picker is kept when a task has two pickers?", description: "Two pickers.", resolution_note: "Keep the first picker recorded against the task." };
const requirement = { ref: "REP-008", title: "Picker name remains on dashboard after palletisation", description: "On the Admin Dashboard, the picker's user name must remain against the pick task, and not update with the palletiser name, after palletisation.", category: "Business Rule", priority: "High" };
const proposal = { sequence: 1, origin: "ai", title: requirement.title, description: requirement.description, source_quote: requirement.description, source_quotes: [], edited: false };
const inputOf = (o = {}) => ({ run: { id: "g1", model: "qwen3:8b" }, requirement, proposal, fragments: [F3, F8], clarifications: [CLAR], open_questions: [OPEN], scope_notes: [SCOPE], ...o });

const userOf = (messages) => messages.find((m) => m.role === "user").content;
const stageOf = (messages) => {
  const u = userOf(messages);
  if (u.startsWith("TASK: list every distinct obligation")) return "obligations";
  if (u.startsWith("TASK: these OBLIGATIONS")) return "coverage";
  if (u.startsWith("TASK: each acceptance criterion below adds")) return "repair";
  return "criteria";
};
/** Fake model: per-stage handlers get (messages, attempt) and return an object or a raw string. */
function fakeLlm(handlers) {
  const calls = [];
  const attempts = {};
  return {
    calls,
    async chat({ messages, schema }) {
      const stage = stageOf(messages);
      attempts[stage] = (attempts[stage] ?? 0) + 1;
      calls.push({ stage, messages: messages.map((m) => ({ ...m })), schema, attempt: attempts[stage] });
      let out = (handlers[stage] ?? (() => (stage === "coverage" ? { criteria: [], gaps: [] } : {})))(messages, attempts[stage]);
      // Unless a test decides them, every supplied open question is "additional_coverage".
      if (out && typeof out === "object" && (stage === "criteria" || stage === "coverage") && !("questions" in out)) {
        const asked = stage === "criteria" ? [...(userOf(messages).split("OPEN QUESTIONS (unanswered — not facts):\n")[1] ?? "").matchAll(/^\[(Q\d+)\]/gm)].map((m) => m[1]) : [];
        out = { ...out, questions: asked.map((id) => ({ id, relation: "additional_coverage", reason: "r" })) };
      }
      return { content: typeof out === "string" ? out : JSON.stringify(out), durationMs: 5 };
    },
  };
}
const ob = (o) => ({ statement: "s", kind: "positive", source_ids: ["F3"], scope_note_ids: [], clarification_ids: [], open_question_ids: [], source_quote: "", ...o });
const cr = (o) => ({ obligations: ["O1"], criterion: "c", given: "", when: "", then: "", criterion_type: "Positive", basis: "Explicit", confidence: "High",
  source_ids: ["F3"], scope_note_ids: [], clarification_ids: [], blocking_question_ids: [], source_quote: "", rationale: "Stated in the source.", ...o });
const PICKER_Q = "the picker's user name must remain against the pick task";
const standard = {
  obligations: () => ({
    obligations: [
      ob({ statement: "The picker's user name must remain against the pick task after palletisation.", source_quote: PICKER_Q }),
      ob({ statement: "The picker's user name must not update with the palletiser name.", kind: "negative", source_quote: "not update with the palletiser name" }),
      ob({ statement: "MONO picks remain as they are.", kind: "regression", source_ids: [], scope_note_ids: ["N1"] }),
    ],
    scope_notes: [{ id: "N1", relevant: true, reason: "Same pick process." }],
  }),
  criteria: () => ({
    criteria: [
      cr({ criterion: "After palletisation, the Admin Dashboard shows the picker's user name against the pick task.", source_quote: PICKER_Q }),
      cr({ obligations: ["O2"], criterion: "After palletisation, the pick task on the Admin Dashboard does not show the palletiser name in place of the picker's.", criterion_type: "Negative", source_quote: "not update with the palletiser name" }),
      cr({ obligations: ["O3"], criterion: "MONO picks behave as before the change.", criterion_type: "Regression", source_ids: [], scope_note_ids: ["N1"] }),
    ],
    gaps: [],
  }),
};

// ── Versioning ──────────────────────────────────────────────────────────────

await run("AC prompts are versioned separately from requirement analysis, and the text is pinned to its version", () => {
  assert.equal(acPromptFingerprint(), AC_PROMPT_FINGERPRINTS[AC_PROMPT_VERSION], "AC prompt text changed — bump AC_PROMPT_VERSION and pin the new fingerprint");
  assert.equal(AC_PROMPT_VERSION, "1.2.0");
  assert.deepEqual(AC_IDENTITY, { ac_prompt_version: AC_PROMPT_VERSION, ac_prompt_sha256: acPromptFingerprint(), ac_schema_version: AC_SCHEMA_VERSION });
  assert.equal(WORKER_VERSION, "0.4.2");
});

// ── Input / context ─────────────────────────────────────────────────────────

await run("only the Requirement's own sentences are shown; a sibling requirement's sentences in the same fragment are not", () => {
  const ctx = buildContext(inputOf());
  assert.match(ctx.sourceText, /\[F3\][\s\S]*picker's user name must remain against the pick task/);
  assert.doesNotMatch(ctx.sourceText, /created palletised task|reporting extracts|MONO picks/, "sibling requirements and scope text are not SOURCE");
  assert.doesNotMatch(ctx.sourceText, /\[F8\]/, "a merely related sentence in another fragment is not shown (shared vocabulary is not enough)");
  assert.equal(ctx.excerpted, "anchored");
  const restated = { ...F8, text: "Currently the user name updates. On the Admin Dashboard the picker's user name must remain against the pick task and not update with the palletiser name after palletisation." };
  assert.match(buildContext(inputOf({ fragments: [F3, restated] })).sourceText, /\[F8\][\s\S]*picker's user name must remain against the pick task and not update/, "a near-identical restatement in another fragment is kept");
  assert.match(ctx.clarificationsText, /\[C1\] Question: Which picker is kept[\s\S]*Human resolution: Keep the first picker/);
  assert.match(ctx.openQuestionsText, /\[Q1\] Which palletiser name/);
  assert.match(ctx.scopeNotesText, /\[N1\] MONO picks: MONO picks remain as they are\./);
});

await run("a sentence that opens with a reference ('This detail…') brings the sentences it refers to, as referenced context", () => {
  const x = requirementExcerpt(F3, ["This detail would also need to be correct for any reporting extracts."]);
  assert.equal(x.text, "This detail would also need to be correct for any reporting extracts.");
  assert.match(x.context, /^On the Admin Dashboard[\s\S]*palletiser user name is to remain against the created palletised task\.$/);
  const ctx = buildContext(inputOf({ requirement: { ...requirement, description: "This detail would also need to be correct for any reporting extracts." }, proposal: { ...proposal, description: "This detail would also need to be correct for any reporting extracts.", source_quote: "This detail would also need to be correct for any reporting extracts." } }));
  assert.match(ctx.referencedText, /^\[F3\] On the Admin Dashboard/);
});

await run("the model's prompt carries the requirement, source, clarifications, open questions and scope notes — and no AC references", async () => {
  const llm = fakeLlm(standard);
  await runAcGeneration({ input: inputOf(), llm });
  const prompt = userOf(llm.calls[0].messages);
  for (const part of ["REQUIREMENT:\nReference: REP-008", "CLARIFICATIONS (authoritative human answers)", "OPEN QUESTIONS (unanswered — not facts)", "SCOPE NOTES (acknowledged"]) assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /AC-\d/);
  assert.match(llm.calls[0].messages[0].content, /Never assign acceptance criterion references such as AC-001/);
});

// ── Positive / Negative / Regression ───────────────────────────────────────

await run("positive, negative and regression criteria are typed, grounded and mapped to real ids; the DB decides review status", async () => {
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm(standard) });
  assert.deepEqual(result.proposals.map((p) => [p.criterion_type, p.basis]), [["Positive", "Explicit"], ["Negative", "Explicit"], ["Regression", "Explicit"]]);
  assert.deepEqual(result.proposals[0].source_fragment_ids, [F3.id]);
  assert.deepEqual(result.proposals[2].scope_note_ids, [SCOPE.id]);
  assert.equal(result.proposals[2].source_fragment_ids.length, 0, "regression rests on the acknowledged scope note");
  assert.ok(result.proposals.every((p) => !("review_status" in p) && !("ac_ref" in p)));
  assert.deepEqual(result.diagnostics.scope_note_decisions, [{ note: SCOPE.id, relevant: true, reason: "Same pick process." }]);
});

await run("a relevant scope note without a regression obligation still gets regression coverage; an irrelevant one gets none", async () => {
  const llm = fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })],
      scope_notes: [{ id: "N1", relevant: true, reason: "Same process." }, { id: "N2", relevant: false, reason: "Different screens." }] }),
    criteria: (m) => ({ criteria: /O2 \(regression\): MONO picks remain as they are\./.test(userOf(m))
      ? [cr({ criterion: "The Admin Dashboard shows the picker's user name against the pick task after palletisation.", source_quote: PICKER_Q }),
        cr({ obligations: ["O2"], criterion: "MONO picks are processed as before.", criterion_type: "Regression", source_ids: [], scope_note_ids: ["N1"] })]
      : [], gaps: [] }),
  });
  const result = await runAcGeneration({ input: inputOf({ scope_notes: [SCOPE, UNRELATED_SCOPE] }), llm });
  assert.deepEqual(result.proposals.map((p) => p.criterion_type), ["Positive", "Regression"]);
  assert.ok(!JSON.stringify(result.proposals).includes(UNRELATED_SCOPE.id), "the irrelevant note yields nothing");
  assert.match(result.diagnostics.warnings.join(" "), /N1 was judged relevant but had no regression obligation/);
});

await run("a regression criterion with no scope note or no-change statement is refused (no generic regression)", async () => {
  const result = await runAcGeneration({ input: inputOf({ scope_notes: [] }), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain.", source_quote: PICKER_Q }), ob({ statement: "Nothing else breaks.", kind: "regression" })], scope_notes: [] }),
    criteria: () => ({ criteria: [cr({ criterion: "The Admin Dashboard shows the picker's user name after palletisation.", source_quote: PICKER_Q }), cr({ criterion: "All other screens behave as before.", criterion_type: "Regression" })], gaps: [] }),
  }) });
  assert.deepEqual(result.proposals.map((p) => p.criterion_type), ["Positive"]);
  assert.ok(result.diagnostics.rejected_criteria.some((r) => /regression obligation without/.test(r.reason)));
  assert.ok(result.diagnostics.rejected_criteria.some((r) => /Regression criterion without/.test(r.reason)));
});

await run("a Negative criterion with no negative statement behind it is flagged for review", async () => {
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [cr({ criterion: "The Admin Dashboard does not hide the picker's user name.", criterion_type: "Negative", source_quote: PICKER_Q })], gaps: [] }),
  }) });
  assert.match(result.proposals[0].needs_review_reasons.join(" "), /Marked Negative, but no negative or prohibiting statement/);
});

// ── Human clarification and open questions ─────────────────────────────────

await run("a human clarification may ground a criterion and is recorded; a related open question attached to the obligation does not block the criterion", async () => {
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm({
    obligations: () => ({ obligations: [
      ob({ statement: "When a task has two pickers, the first picker recorded is kept.", source_ids: [], clarification_ids: ["C1"] }),
      ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q, open_question_ids: ["Q1"] }),
    ], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [
      cr({ criterion: "When a pick task has two pickers, the Admin Dashboard shows the first picker recorded against the task.", source_ids: [], clarification_ids: ["C1"] }),
      cr({ obligations: ["O2"], criterion: "After palletisation the Admin Dashboard shows the picker's user name against the pick task.", source_quote: PICKER_Q }),
    ], gaps: [], questions: [{ id: "Q1", relation: "additional_coverage", reason: "About repeated palletisation, which the criteria do not cover." }] }),
  }) });
  const [byClar, core] = result.proposals;
  assert.deepEqual([byClar.basis, byClar.clarification_issue_ids, byClar.source_fragment_ids], ["Explicit", [CLAR.id], []]);
  assert.deepEqual([core.open_issue_ids, core.needs_review_reasons], [[], []], "no inheritance from the obligation: the core criterion stays Proposed");
  const q = result.issues.find((i) => i.issue_type === "Unresolved Existing Analysis Issue");
  assert.deepEqual([q.relation, q.severity, q.analysis_issue_ids], ["Additional Coverage", "Low", [OPEN.id]]);
  assert.match(q.description, /^Additional coverage question — does not block the proposed criteria/);
});

await run("a BLOCKING open question (the expected result needs the answer) marks only the criterion that depends on it Needs Review", async () => {
  const SORT_Q = { id: id(201), sequence: 3, issue_type: "Missing Information", question: "Must the pick tasks be sorted ascending or descending by name?", description: "Order not stated." };
  const result = await runAcGeneration({ input: inputOf({ open_questions: [SORT_Q], clarifications: [] }), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [
      cr({ criterion: "The Admin Dashboard lists pick tasks sorted by picker name.", source_quote: PICKER_Q, blocking_question_ids: ["Q1"] }),
      cr({ criterion: "After palletisation the Admin Dashboard shows the picker's user name against the pick task.", source_quote: PICKER_Q }),
    ], gaps: [], questions: [{ id: "Q1", relation: "blocking", reason: "The sort order is the expected result." }] }),
  }) });
  assert.deepEqual(result.proposals.map((p) => p.open_issue_ids), [[SORT_Q.id], []]);
  assert.match(result.proposals[0].needs_review_reasons.join(), /Blocked by an open question: Must the pick tasks be sorted ascending or descending/);
  assert.deepEqual(result.proposals[1].needs_review_reasons, []);
  const q = result.issues.find((i) => i.relation);
  assert.deepEqual([q.relation, q.severity], ["Blocking", "Medium"]);
  assert.match(q.description, /^Blocking — this open analysis question must be answered before 1 criterion can be confirmed/);
});

await run("a question about an extra situation (multiple / repeated / existing data) never blocks a criterion that does not claim to cover it — even if the model says so", async () => {
  const { extraSituations } = await import("../ac-generation/pipeline.js");
  assert.deepEqual(extraSituations("What happens when a task is palletised multiple times?", "After palletisation the picker's name remains."), ["multiple"]);
  assert.deepEqual(extraSituations("How are existing extracts handled?", "Existing extracts show the picker's name."), [], "the criterion covers it");
  assert.deepEqual(extraSituations("Which sort order applies to the list?", "The list is sorted by name."), [], "no extra situation: may block");
  assert.deepEqual(extraSituations("What if the task is re-palletised?", "The name remains."), ["re-palletised"]);
  const result = await runAcGeneration({ input: inputOf({ open_questions: [{ ...OPEN, question: "What happens to the picker name when a task is palletised multiple times or by several palletisers?" }] }), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [cr({ criterion: "After palletisation the Admin Dashboard shows the picker's user name against the pick task.", source_quote: PICKER_Q, blocking_question_ids: ["Q1"] })],
      gaps: [], questions: [{ id: "Q1", relation: "blocking", reason: "model over-reach" }] }),
  }) });
  assert.deepEqual([result.proposals[0].open_issue_ids, result.proposals[0].needs_review_reasons], [[], []]);
  const rel = result.diagnostics.question_relations[0];
  assert.deepEqual([rel.decided, rel.relation], ["blocking", "Additional Coverage"]);
  assert.match(rel.not_blocking_because, /^asks about multiple, Repeated, which the criterion does not claim to cover$/);
  assert.equal(result.issues.find((i) => i.relation).relation, "Additional Coverage", "the question stays visible");
});

await run("an open question the model judges irrelevant produces no issue; an undecided question is refused and retried", async () => {
  const llm = fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: (m, attempt) => ({ criteria: [cr({ criterion: "After palletisation the Admin Dashboard shows the picker's user name against the pick task.", source_quote: PICKER_Q })],
      gaps: [], questions: attempt === 1 ? [] : [{ id: "Q1", relation: "irrelevant", reason: "About another requirement." }] }),
  });
  const result = await runAcGeneration({ input: inputOf(), llm });
  assert.match(llm.calls.filter((c) => c.stage === "criteria")[1].messages.at(-1).content, /Q1 is missing from questions/);
  assert.equal(result.issues.filter((i) => i.relation).length, 0);
  assert.deepEqual(result.diagnostics.question_relations.map((r) => [r.decided, r.relation]), [["irrelevant", null]]);
});

// ── No invention, vagueness ────────────────────────────────────────────────

await run("a criterion stating a value the source never gives is refused and recorded as Insufficient Source Support", async () => {
  assert.deepEqual(inventedValues("Response must complete within 2 seconds", "picker name must remain"), ["2 seconds"]);
  assert.deepEqual(inventedValues("Shown on page 2", "see page 2 of the spec"), []);
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [cr({ criterion: "The picker's user name is shown on the Admin Dashboard within 2 seconds of palletisation.", source_quote: PICKER_Q })], gaps: [] }),
    coverage: () => ({ criteria: [], gaps: [] }),
  }) });
  assert.equal(result.proposals.length, 0);
  assert.deepEqual(result.issues.map((i) => [i.issue_type, i.relation]), [["Insufficient Source Support", null], ["Missing Testable Outcome", null], ["Unresolved Existing Analysis Issue", "Additional Coverage"]]);
  assert.match(result.issues[0].description, /stated 2 seconds, which nothing in the requirement/);
});

await run("vague criteria: nothing concrete → refused; vague wording with concrete content → Needs Review", async () => {
  const ctxWords = wordSet("picker user name pick task admin dashboard palletisation");
  assert.equal(vagueness("The feature works correctly.", ctxWords).hollow, true);
  assert.equal(vagueness("The Admin Dashboard shows the picker user name as expected.", ctxWords).hollow, false);
  assert.ok(vagueness("The export shows the correct user names.", ctxWords));
  assert.ok(vagueness("In the export the user names must be correct.", ctxWords));
  assert.equal(vagueness("The Admin Dashboard shows the picker user name.", ctxWords), null);
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [cr({ criterion: "The system works correctly.", source_quote: PICKER_Q }), cr({ criterion: "The Admin Dashboard shows the picker's user name against the pick task as expected.", source_quote: PICKER_Q })], gaps: [] }),
  }) });
  assert.equal(result.proposals.length, 1);
  assert.match(result.proposals[0].needs_review_reasons[0], /Vague wording \("as expected"\)/);
  assert.ok(result.diagnostics.rejected_criteria.some((r) => /vague: "works correctly"/.test(r.reason)));
});

await run("Explicit without a verbatim source quote (its own or its obligation's), clarification or scope note is recorded as Inferred", async () => {
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: "words that are not in the source" })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [cr({ criterion: "The Admin Dashboard shows the picker's user name.", source_quote: "a quote that is not in the source text" })], gaps: [] }),
  }) });
  assert.equal(result.proposals[0].basis, "Inferred");
  assert.match(result.diagnostics.warnings.join(" "), /marked Explicit but not grounded/);
});

// ── Semantic fidelity (1.2.0) ──────────────────────────────────────────────

const EXTRACT_Q = "This detail would also need to be correct for any reporting extracts.";
const extractInput = () => inputOf({ requirement: { ...requirement, title: "Reporting extracts show correct names", description: EXTRACT_Q },
  proposal: { ...proposal, description: EXTRACT_Q, source_quote: EXTRACT_Q }, open_questions: [], clarifications: [], scope_notes: [] });
const extractObligation = { obligations: [ob({ statement: "Reporting extracts must show the correct user names.", source_quote: EXTRACT_Q })], scope_notes: [] };

await run("an unsupported comparison or source-of-truth rule is detected; ordinary testable paraphrase and source-stated rules are not", async () => {
  const { unsupportedSemantics } = await import("../ac-generation/pipeline.js");
  const corpus = `${F3.text} ${F8.text}`;
  assert.deepEqual(unsupportedSemantics("The extract's user names must match the current user names in the system.", corpus).map((u) => u.kind), ["comparison", "source of truth", "currency"]);
  assert.deepEqual(unsupportedSemantics("The names are validated against the database.", corpus).map((u) => u.kind), ["comparison", "source of truth"]);
  assert.deepEqual(unsupportedSemantics("The picker's user name is shown immediately after palletisation.", corpus).map((u) => u.kind), ["timing"]);
  assert.deepEqual(unsupportedSemantics("After palletisation the Admin Dashboard shows the picker's user name against the pick task and does not update with the palletiser name.", corpus), [], "plain testable paraphrase");
  assert.deepEqual(unsupportedSemantics("The value must match the plant/user table.", `${corpus} The value must match the plant/user table.`), [], "the source states the comparison");
  assert.deepEqual(unsupportedSemantics("Currently the user name updates.", corpus), [], "a word the source uses ('Currently') is grounded");
});

await run("vague-but-grounded is distinguished from concrete-but-invented", async () => {
  const llm = fakeLlm({
    obligations: () => extractObligation,
    criteria: () => ({ criteria: [
      cr({ criterion: "The reporting extracts show the correct user names.", source_quote: EXTRACT_Q }),
      cr({ criterion: "The reporting extracts show user names that match the current user names in the system.", source_quote: EXTRACT_Q }),
    ], gaps: [] }),
    repair: () => ({ repairs: [{ key: "A1", criterion: "The reporting extracts show user names that match the system records.", given: "", when: "", then: "", unresolved: false }] }),
  });
  const result = await runAcGeneration({ input: extractInput(), llm });
  const [vague, invented] = result.proposals;
  assert.match(vague.needs_review_reasons.join(), /^Expected result is source-grounded but not sufficiently concrete to define correctness \("show the correct user names"\)\.$/);
  assert.match(invented.needs_review_reasons.join(), /^Expected result introduces an unsupported interpretation: "match the current user names in the system"/);
  assert.equal(result.diagnostics.semantic_repairs[0].outcome, "repair rejected", "the repair still compares against the system");
});

await run("repair removes the unsupported interpretation and invents no replacement; an unresolved definition stays Needs Review", async () => {
  const llm = fakeLlm({
    obligations: () => extractObligation,
    criteria: () => ({ criteria: [cr({ criterion: "The reporting extracts show user names that match the current user names in the system.", source_quote: EXTRACT_Q })], gaps: [] }),
    repair: (m) => {
      const u = userOf(m);
      assert.match(u, /A1: The reporting extracts show user names that match the current user names in the system\.\n\s+UNSUPPORTED: "match the current user names in the system" \(comparison\)/);
      assert.match(u, /Do not invent a replacement definition/);
      return { repairs: [{ key: "A1", criterion: "The reporting extracts show the picker's user name against the pick task.", given: "", when: "", then: "", unresolved: true }] };
    },
  });
  const result = await runAcGeneration({ input: extractInput(), llm });
  const p = result.proposals[0];
  assert.equal(p.criterion, "The reporting extracts show the picker's user name against the pick task.");
  assert.doesNotMatch(p.criterion, /match|system|current/);
  assert.deepEqual(p.needs_review_reasons, ["Expected result is source-grounded but not sufficiently concrete to define correctness."], "unresolved → still Needs Review, never silently Proposed");
  assert.deepEqual(result.diagnostics.semantic_repairs.map((r) => [r.outcome, r.unsupported[0].kind]), [["repaired", "comparison"]]);
  assert.deepEqual(llm.calls.map((c) => c.stage), ["obligations", "criteria", "repair"], "exactly one bounded repair call");
});

await run("a repair that swaps in a different invented rule, or no repair at all, leaves the criterion Needs Review", async () => {
  for (const repair of [
    () => ({ repairs: [{ key: "A1", criterion: "The reporting extracts show user names taken from the payroll register.", given: "", when: "", then: "", unresolved: false }] }),
    () => ({ repairs: [] }),
  ]) {
    const result = await runAcGeneration({ input: extractInput(), llm: fakeLlm({
      obligations: () => extractObligation,
      criteria: () => ({ criteria: [cr({ criterion: "The reporting extracts show user names that match the current user names in the system.", source_quote: EXTRACT_Q })], gaps: [] }),
      repair,
    }) });
    const p = result.proposals[0];
    assert.equal(p.criterion, "The reporting extracts show user names that match the current user names in the system.", "the original is kept, flagged");
    assert.match(p.needs_review_reasons.join(), /introduces an unsupported interpretation/);
    assert.ok(["repair rejected", "not repaired"].includes(result.diagnostics.semantic_repairs[0].outcome));
  }
  const rejected = (await runAcGeneration({ input: extractInput(), llm: fakeLlm({ obligations: () => extractObligation,
    criteria: () => ({ criteria: [cr({ criterion: "The reporting extracts show user names that match the current user names in the system.", source_quote: EXTRACT_Q })], gaps: [] }),
    repair: () => ({ repairs: [{ key: "A1", criterion: "The reporting extracts show user names taken from the payroll register.", given: "", when: "", then: "", unresolved: false }] }) }) })).diagnostics.semantic_repairs[0];
  assert.match(rejected.why, /^introduces taken, payroll, register$/, "an invented replacement is caught");
});

await run("a human clarification may legitimately supply the missing semantics (no flag, no repair)", async () => {
  const clar = { ...CLAR, question: "What does 'correct' mean for the extracts?", resolution_note: "The extract names must match the user names held in the user table." };
  const llm = fakeLlm({
    obligations: () => extractObligation,
    criteria: () => ({ criteria: [cr({ criterion: "The reporting extracts show user names that match the user names held in the user table.", source_quote: EXTRACT_Q, clarification_ids: ["C1"] })], gaps: [] }),
  });
  const result = await runAcGeneration({ input: { ...extractInput(), clarifications: [clar] }, llm });
  assert.deepEqual([result.proposals[0].needs_review_reasons, result.proposals[0].clarification_issue_ids], [[], [clar.id]]);
  assert.ok(!llm.calls.some((c) => c.stage === "repair"));
});

await run("REP-003-shaped run: 'match the current user names in the system' never passes as Proposed", async () => {
  const result = await runAcGeneration({ input: extractInput(), llm: fakeLlm({
    obligations: () => extractObligation,
    criteria: () => ({ criteria: [
      cr({ criterion: "When exported pick task data into Excel is viewed, the user names displayed must match the current user names in the system.", source_quote: EXTRACT_Q }),
      cr({ criterion: "When data extracts for reporting are viewed, the user names displayed must match the current user names in the system.", source_quote: EXTRACT_Q }),
    ], gaps: [] }),
    repair: () => ({ repairs: [] }),
  }) });
  for (const p of result.proposals) {
    const proposed = p.basis === "Explicit" && p.confidence !== "Low" && !p.open_issue_ids.length && !p.needs_review_reasons.length;
    assert.equal(proposed, false, p.criterion);
  }
});

// ── Provenance and malformed output ────────────────────────────────────────

await run("fabricated labels are refused and retried with the errors fed back; a real label filed in the wrong list is re-filed", async () => {
  const llm = fakeLlm({
    ...standard,
    obligations: (m, attempt) => (attempt === 1
      ? { obligations: [ob({ statement: "Invented.", source_ids: ["F99"] })], scope_notes: [{ id: "N1", relevant: true, reason: "r" }] }
      : { obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_ids: ["F3", "N1"], source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: true, reason: "r" }] }),
  });
  const result = await runAcGeneration({ input: inputOf(), llm });
  const second = llm.calls.filter((c) => c.stage === "obligations")[1];
  assert.match(second.messages.at(-1).content, /F99, which is not a SOURCE fragment/);
  assert.ok(result.diagnostics.obligations[0].statement.startsWith("The picker's"));
  assert.ok(result.proposals.every((p) => p.source_fragment_ids.every((x) => [F3.id, F8.id].includes(x))));
});

await run("malformed JSON is retried and, if it never becomes valid, the run fails cleanly with no output", async () => {
  const llm = fakeLlm({ obligations: () => "not json {" });
  await assert.rejects(runAcGeneration({ input: inputOf(), llm }), (e) => e instanceof AcGenerationError && e.category === "invalid_model_output");
  assert.equal(llm.calls.length, AC_MAX_ATTEMPTS);
});

await run("no provenance at all (no fragments) fails safely before any model call", async () => {
  const llm = fakeLlm(standard);
  await assert.rejects(runAcGeneration({ input: inputOf({ fragments: [] }), llm }), (e) => e.category === "validation_failed");
  assert.equal(llm.calls.length, 0);
});

await run("Stage 5 refuses ids outside the supplied input, missing provenance, and model-chosen status/references", () => {
  const allowed = { fragments: new Set([F3.id]), scopeNotes: new Set(), clarifications: new Set(), openQuestions: new Set() };
  const ok = { sequence: 1, criterion: "c", rationale: "r", criterion_type: "Positive", basis: "Explicit", confidence: "High", source_fragment_ids: [F3.id], scope_note_ids: [], clarification_issue_ids: [], open_issue_ids: [] };
  assert.deepEqual(validateAcGenerationOutput({ proposals: [ok], issues: [] }, allowed), []);
  assert.match(validateAcGenerationOutput({ proposals: [{ ...ok, source_fragment_ids: [F8.id] }], issues: [] }, allowed).join(), /outside the Requirement's provenance/);
  assert.match(validateAcGenerationOutput({ proposals: [{ ...ok, source_fragment_ids: [] }], issues: [] }, allowed).join(), /no provenance/);
  assert.match(validateAcGenerationOutput({ proposals: [{ ...ok, review_status: "Approved", ac_ref: "AC-001" }], issues: [] }, allowed).join(), /not chosen by generation/);
});

await run("a name or condition the obligation's source clause carries ('Support User') but the criterion drops is flagged", async () => {
  const { clauseTerms, namedTerms } = await import("../ac-generation/pipeline.js");
  assert.deepEqual(namedTerms("Dashboard apps — Support User flagged: the Pick Admin Dashboard shows MONO picks."), ["Support User", "Pick Admin Dashboard", "MONO"]);
  const quote = "Plant and temperature shall default from the plant/user table; temperature shall be changeable, and plant shall be changeable only where the Support User flag is set (otherwise greyed out).";
  assert.deepEqual(clauseTerms(quote, "Temperature shall be changeable."), [], "the temperature clause carries no condition");
  assert.deepEqual(clauseTerms(quote, "Plant shall be changeable only where the Support User flag is set."), ["Support User"]);
  assert.deepEqual(clauseTerms("Dashboard apps — Support User flagged: where the plant is defaulted, the plant field shall be selectable.", "The plant field shall be selectable."), ["Support User"], "a label prefix applies to its item");
  const Fs = { ...F3, text: "Dashboard apps — Support User flagged: the plant field shall be selectable." };
  const result = await runAcGeneration({ input: inputOf({ fragments: [Fs], requirement: { ...requirement, description: "Dashboard apps — Support User flagged: the plant field shall be selectable." }, proposal: { ...proposal, description: "Dashboard apps — Support User flagged: the plant field shall be selectable.", source_quote: "Dashboard apps — Support User flagged: the plant field shall be selectable." }, scope_notes: [] }), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The plant field shall be selectable.", source_quote: "Dashboard apps — Support User flagged: the plant field shall be selectable." })], scope_notes: [] }),
    criteria: () => ({ criteria: [cr({ criterion: "In the Dashboard apps the plant field is selectable." }), cr({ criterion: "In the Dashboard apps, for a Support User, the plant field is selectable." })], gaps: [] }),
  }) });
  assert.match(result.proposals[0].needs_review_reasons.join(" "), /Omits "Support User", named in its source/);
  assert.deepEqual(result.proposals[1].needs_review_reasons, []);
  assert.equal(result.proposals[0].basis, "Explicit", "grounded by the obligation's verified quote");
});

await run("every application in 'Applies to:' must be named by a criterion: uncovered ones get a coverage pass from their own fragment, else an issue", async () => {
  const { appliesTo } = await import("../ac-generation/pipeline.js");
  assert.deepEqual(appliesTo("Add a plant filter.\n\nApplies to: Pick Execution; Palletising; Loading Execution."), ["Pick Execution", "Palletising", "Loading Execution"]);
  const frag = (n, app) => ({ id: id(500 + n), sequence: 20 + n, fragment_type: "list", section_path: ["Spec", app], section_heading: app, page_start: null, page_end: null, metadata: {}, text: "1. Add a plant filter, fixed to the value in the plant/user table." });
  const fragments = [frag(1, "Pick Execution"), frag(2, "Palletising"), frag(3, "Loading Execution")];
  const description = "Add a plant filter, fixed to the value in the plant/user table.\n\nApplies to: Pick Execution; Palletising; Loading Execution.";
  const llm = fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "A plant filter fixed to the plant/user table value is added.", source_ids: ["F21", "F22", "F23"], source_quote: "Add a plant filter, fixed to the value in the plant/user table." })], scope_notes: [] }),
    criteria: () => ({ criteria: [cr({ criterion: "Pick Execution shows a plant filter fixed to the plant/user table value.", source_ids: ["F21"] })], gaps: [] }),
    coverage: (m) => {
      assert.match(userOf(m), /O2 \(positive\): In Palletising: A plant filter[\s\S]*\[F22\][\s\S]*O3 \(positive\): In Loading Execution:/);
      return { criteria: [cr({ obligations: ["O2"], criterion: "Palletising shows a plant filter fixed to the plant/user table value.", source_ids: ["F22"] })], gaps: [] };
    },
  });
  const result = await runAcGeneration({ input: inputOf({ fragments, requirement: { ...requirement, description }, proposal: { ...proposal, description, source_quote: "Add a plant filter, fixed to the value in the plant/user table." }, scope_notes: [], open_questions: [], clarifications: [] }), llm });
  assert.deepEqual(result.proposals.map((p) => p.criterion.split(" ")[0]), ["Pick", "Palletising"]);
  assert.deepEqual(result.proposals[1].source_fragment_ids, [id(502)], "its own application's fragment");
  assert.ok(result.issues.some((i) => i.issue_type === "Missing Testable Outcome" && /^In Loading Execution:/.test(i.obligation)));
});

// ── Consolidation and coverage ─────────────────────────────────────────────

await run("the same check stated from two fragments merges losslessly; different actors or values never merge", async () => {
  assert.equal(sameCheck({ criterion_type: "Positive", criterion: "The dashboard shows the picker name." }, { criterion_type: "Positive", criterion: "The dashboard shows the picker name against the pick task." }), true);
  assert.equal(sameCheck({ criterion_type: "Positive", criterion: "The dashboard shows the picker name against the pick task." }, { criterion_type: "Positive", criterion: "The dashboard shows the palletiser name against the pick task." }), false);
  assert.equal(sameCheck({ criterion_type: "Positive", criterion: "MONO picks behave as before." }, { criterion_type: "Regression", criterion: "MONO picks behave as before." }), false, "positive and regression stay apart");
  assert.ok(distinctTerms("Shown on the Loading Dashboard", "Shown on the Pick Dashboard"));
  const result = await runAcGeneration({ input: inputOf(), llm: fakeLlm({
    obligations: () => ({ obligations: [ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q })], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [
      cr({ criterion: "The dashboard shows the picker name.", source_ids: ["F8"], source_quote: "We require the picker name to remain against the pick task on the dashboard" }),
      cr({ criterion: "The dashboard shows the picker name against the pick task.", source_quote: PICKER_Q }),
      cr({ criterion: "The dashboard shows the palletiser name against the pick task.", source_quote: PICKER_Q }),
    ], gaps: [] }),
  }) });
  assert.equal(result.proposals.length, 2);
  const merged = result.proposals.find((p) => p.consolidation.merged);
  assert.equal(merged.criterion, "The dashboard shows the picker name against the pick task.", "the most complete wording represents the group");
  assert.deepEqual(merged.consolidation.members.map((m) => m.criterion).sort(), ["The dashboard shows the picker name against the pick task.", "The dashboard shows the picker name."]);
  assert.deepEqual(merged.source_fragment_ids.sort(), [F3.id, F8.id].sort(), "both fragments' provenance kept");
});

await run("every obligation is covered: an uncovered one gets a coverage pass, then an issue if still uncovered; gaps on covered obligations are dropped", async () => {
  const llm = fakeLlm({
    obligations: () => ({ obligations: [
      ob({ statement: "The picker's user name must remain against the pick task.", source_quote: PICKER_Q }),
      ob({ statement: "The user name must not update with the palletiser name.", kind: "negative", source_quote: "not update with the palletiser name" }),
      ob({ statement: "The picker name must remain on the dashboard.", source_ids: ["F8"], source_quote: "We require the picker name to remain against the pick task on the dashboard" }),
    ], scope_notes: [{ id: "N1", relevant: false, reason: "n/a" }] }),
    criteria: () => ({ criteria: [cr({ criterion: "The Admin Dashboard shows the picker's user name against the pick task.", source_quote: PICKER_Q })],
      gaps: [{ obligation: "O1", issue_type: "Missing Testable Outcome", description: "Depends on Q1.", question: "x?" }] }),
    coverage: (m) => {
      assert.match(userOf(m), /UNCOVERED OBLIGATIONS:\nO2 \(negative\)[\s\S]*O3 \(positive\)/);
      assert.doesNotMatch(userOf(m), /^O1 /m);
      return { criteria: [cr({ obligations: ["O2"], criterion: "The pick task on the Admin Dashboard does not show the palletiser name in place of the picker's.", criterion_type: "Negative", source_quote: "not update with the palletiser name" })], gaps: [] };
    },
  });
  const result = await runAcGeneration({ input: inputOf(), llm });
  assert.deepEqual(llm.calls.map((c) => c.stage), ["obligations", "criteria", "coverage"]);
  assert.deepEqual(result.diagnostics.obligations.map((o) => o.covered_by.length > 0), [true, true, false]);
  assert.ok(result.issues.some((i) => i.issue_type === "Missing Testable Outcome" && /picker name must remain on the dashboard/.test(i.obligation)));
  assert.equal(result.diagnostics.suppressed_gaps.length, 1, "the gap for covered O1 is dropped");
  assert.equal(result.withWarnings, true);
});

await run("a retry reuses earlier validated stages (same input, model and prompt version) instead of calling the model", async () => {
  const stored = [];
  await runAcGeneration({ input: inputOf(), llm: fakeLlm(standard), onStage: async (s) => { stored.push({ run_id: "g0", ...s }); } });
  const llm = fakeLlm({ obligations: () => { throw new Error("should be reused"); }, criteria: () => { throw new Error("should be reused"); } });
  const reposted = [];
  const result = await runAcGeneration({ input: inputOf(), llm, reusable: stored, onStage: async (s) => { reposted.push(s); } });
  assert.equal(llm.calls.length, 0);
  assert.equal(result.proposals.length, 3);
  assert.ok(reposted.every((s) => s.reused_from === "g0"));
  // A changed input (e.g. a new clarification) does not reuse.
  const fresh = fakeLlm(standard);
  await runAcGeneration({ input: inputOf({ clarifications: [] }), llm: fresh, reusable: stored });
  assert.ok(fresh.calls.length > 0);
});

// ── Worker ──────────────────────────────────────────────────────────────────

function fakeOllama({ reachable = true, models = [{ name: "qwen3:8b", digest: "500a1f067a9fabc" }], llm } = {}) {
  return {
    status: async () => ({ reachable, version: "0.34.2", models }),
    show: async () => ({ capabilities: ["completion", "thinking"], contextLength: 40960 }),
    chat: async (args) => { assert.equal(args.think, false); assert.equal(args.model, "qwen3:8b"); return llm.chat(args); },
  };
}
const claimOf = () => ({ ...inputOf(), run: { id: "g1", model: "qwen3:8b", attempt_count: 1 }, reusable_stages: [] });

await run("worker: Ollama offline or the model missing fails the run cleanly (nothing generated)", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  assert.equal((await processAcGenerationRun(claimOf(), { api, ollama: fakeOllama({ reachable: false }) })).category, "ollama_unreachable");
  assert.equal((await processAcGenerationRun(claimOf(), { api, ollama: fakeOllama({ models: [{ name: "qwen3:4b" }] }) })).category, "model_unavailable");
  assert.deepEqual(calls.map((c) => c.route), ["ac-generation/fail", "ac-generation/fail"]);
});

await run("worker: stages are posted as they complete, then the criteria and issues with the model digest — no document text in a failure", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  const summary = await processAcGenerationRun(claimOf(), { api, ollama: fakeOllama({ llm: fakeLlm(standard) }) });
  assert.equal(summary.status, "Completed");
  assert.ok(calls.slice(0, -1).every((c) => c.route === "ac-generation/stage" && c.body.run_id === "g1"));
  const done = calls.at(-1);
  assert.deepEqual([done.route, done.body.model_digest, done.body.proposals.length], ["ac-generation/complete", "500a1f067a9f (ollama 0.34.2)", 3]);
  const failCalls = [];
  await processAcGenerationRun(claimOf(), { api: async (route, body) => { failCalls.push({ route, body }); return {}; }, ollama: fakeOllama({ llm: fakeLlm({ obligations: () => "garbage" }) }) });
  assert.equal(failCalls.at(-1).body.error_category, "invalid_model_output");
  assert.ok(!JSON.stringify(failCalls.at(-1).body).includes("picker's user name must remain"));
});

await run("worker: a server without AC-generation routes (404) is tolerated quietly; other errors surface", async () => {
  const logs = [];
  const state = {};
  const api = async () => { const e = new Error("ac-generation/claim failed (404)"); e.status = 404; throw e; };
  assert.equal(await runAcGenerationOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(await runAcGenerationOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(logs.length, 1);
  const boom = async () => { const e = new Error("500"); e.status = 500; throw e; };
  await assert.rejects(runAcGenerationOnce({ api: boom, ollama: fakeOllama({}), state }), /500/);
  const idle = async (route, body) => { assert.equal(route, "ac-generation/claim"); assert.deepEqual(body, AC_IDENTITY); return { run: null }; };
  assert.equal(await runAcGenerationOnce({ api: idle, ollama: fakeOllama({}), state }), null);
});

await run("worker loop priority is deterministic: extraction → requirement analysis → AC generation", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("while (!stopping)"));
  assert.ok(loop.indexOf("runOnce(") < loop.indexOf("runAnalysisOnce(") && loop.indexOf("runAnalysisOnce(") < loop.indexOf("runAcGenerationOnce("));
});

console.log("\nAll AC generation pipeline tests passed.\n");
