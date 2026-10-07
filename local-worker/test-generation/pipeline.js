// Staged manual test-case design for ONE Requirement's canonical Acceptance
// Criteria (Phase 1G, prompts 1.0.0). Generation only — nothing here is
// canonical; proposals carry no test reference.
//
//   Stage 1  behaviours  — decomposition: every distinct testable behaviour of each AC
//   Stage 2  tests       — candidate test cases per behaviour, or a gap
//   Stage 3  coverage    — behaviours still uncovered get one more, focused pass
//   Stage 4  dedup       — deterministic, lossless consolidation of the same test
//   Stage 5  validation  — deterministic provenance, grounding and quality gates
//
// The model only sees short labels from THIS run's input — ACs [A<n>],
// source fragments [F<sequence>], Human Clarifications [H<n>], analysis
// clarifications [C<n>], resolved questions [R<n>], scope notes [N<n>],
// open questions [Q<n>] — mapped back to ids deterministically. A label
// outside the supplied set is fabricated and refused (bounded retry with the
// errors fed back). Existing canonical test cases are never part of the input.
//
// Deterministic rules (Phase 1E semantic-fidelity principles, applied to tests):
//   * Every test traces to at least one AC; every behaviour to at least one AC.
//   * A value (number, duration, percentage) that appears nowhere in the
//     input is invention: the test is rejected and an "Insufficient Source
//     Support" issue records what was missing.
//   * Names (capitalised terms, codes) and UI controls (button, tab, menu,
//     field …) that the input never uses are flagged: Needs Review, Inferred.
//   * A test whose only step restates its criterion has no procedure: rejected.
//   * Vague expected results are flagged; a hollow one is rejected.
//   * Expected results that add a rule for success the input never states
//     (comparison, source of truth, currency, timing, fallback) are flagged.
//   * A test that drops a name its behaviour states, or that combines several
//     independently testable variations, is flagged.
//   * Regression tests only for regression behaviours (a Regression AC, a
//     no-change statement, or a relevant scope note); Negative tests need
//     negative wording in their behaviour or criterion.
//   * Open questions never become tests: each is reported as an uncovered
//     test-design issue (Additional Coverage Question / Unresolved Question).
//   * Every behaviour and every AC ends with a test or a recorded issue.
//   * The same test proposed twice is consolidated; members are kept.

import { createHash } from "node:crypto";
import { aliasFor, buildChunks } from "../analysis/chunk.js";
import { components, containment, isNoChangeStatement, normaliseForQuote, similarity, wordSet } from "../analysis/pipeline.js";
import { cleanText, distinctTerms, inventedValues, namedTerms, novelWords, requirementExcerpt, unsupportedSemantics, vagueness } from "../ac-generation/pipeline.js";
import { TEST_PROMPT_VERSION, TEST_SCHEMA_VERSION, TEST_SYSTEM_PROMPT, behavioursPrompt, coveragePrompt, testsPrompt } from "./prompts.js";
import { TEST_STAGE_SCHEMAS, validateSchema } from "./schemas.js";

export const TEST_MAX_ATTEMPTS = 3;
export const TEST_MERGE_SIMILARITY = 0.6;
export const RESTATEMENT_SIMILARITY = 0.7;

export class TestGenerationError extends Error {
  constructor(category, message, diagnostics = null) { super(message); this.category = category; this.diagnostics = diagnostics; }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const CONFIDENCE_RANK = { High: 3, Medium: 2, Low: 1 };
const NEGATION = /\b(not|no|never|without|nor|cannot|can't|won't|isn't|aren't|doesn't|don't|unchanged|prohibit(ed)?|prevent(ed|s)?|only|otherwise|refused?|rejected?|blocked|disabled|read-only)\b/i;
// Continuity wording in an AC ("continues to execute", "unaffected", "still") grounds a regression behaviour.
const CONTINUITY = /\b(continues? to|unaffected|unchanged|as before|still (works?|runs?|executes?|behaves?)|remains? (independent|unchanged|as (it is|they are)))\b/i;
// UI controls a procedure could invent.
const UI_CONTROL = /\b(button|tab|menu|link|icon|checkbox|check box|drop-?down|toggle|pop-?up|dialog|modal|textbox|text box|search box|radio button|hyperlink|tooltip|banner|toast)s?\b/gi;
// Testing vocabulary that is never invention by itself.
const TEST_VOCAB = wordSet("shown displayed visible value values data user users");
const PROCEDURE_WORDS = wordSet("verify verifies validate validates test tests log logs logged login sign signed open opens opened navigate navigates go goes select selects choose enter enters perform performs complete completes completed run runs execute verify verifies check checks confirm confirms observe observes note notes review reviews refresh refreshes reload repeat repeats wait waits locate locates find finds view views trigger triggers start starts stop submit submits save saves step steps test tester system application screen page record records process processes existing available following again prior previous previously each same new another ensure ensures result results expected outcome state states data user users");

/**
 * Names in a test (capitalised runs, codes) that the input never uses. A
 * title-cased run is grounded when its words — ignoring procedure verbs such
 * as "Verify" or "Open" — all appear in the input ("Verify Configured
 * Temperature" is not a new name; "Stock Control Centre" is).
 */
export function inventedNames(text, corpus, corpusWords = wordSet(corpus)) {
  const src = normaliseForQuote(corpus);
  return namedTerms(text).filter((t) => {
    if (src.includes(normaliseForQuote(t))) return false;
    const words = [...wordSet(t)].filter((w) => !PROCEDURE_WORDS.has(w));
    return words.length > 0 && !words.every((w) => corpusWords.has(w));
  });
}
// A comparison to a value the input itself names ("matches the user's configured plant") is ordinary test phrasing, not a new rule.
const COMPARISON_WORDS = wordSet("match matches matched matching equal equals equalled same identical consistent correspond corresponds corresponding agree agrees reconcile reconciles compared compare against verified validated checked with to as the");
export const groundedComparison = (u, corpusWords) => u.kind === "comparison" && [...wordSet(u.phrase)].filter((w) => !COMPARISON_WORDS.has(w)).every((w) => corpusWords.has(w) || TEST_VOCAB.has(w));
/** UI controls named by a procedure whose words the input never uses ("the Save button"). */
export function inventedControls(text, corpusWords) {
  const found = [];
  for (const m of String(text ?? "").matchAll(UI_CONTROL)) {
    const before = String(text).slice(0, m.index).split(/\s+/).filter(Boolean).slice(-3).join(" ");
    const phrase = `${before} ${m[0]}`.trim().replace(/^.*\b(the|a|an|on|in|of|click|press|tap|select|choose|use)\b\s+/i, "");
    const words = [...wordSet(phrase)].filter((w) => !PROCEDURE_WORDS.has(w));
    if (words.length && !words.every((w) => corpusWords.has(w))) found.push(phrase);
  }
  return [...new Set(found)];
}
// Alternatives a behaviour states ("set or unset", "Frozen or Chilled"): a test that names one must not silently drop the other.
const ALT_STOP = wordSet("not no any all the a an their its this that other another default");
export function droppedAlternatives(statement, text) {
  const said = normaliseForQuote(text);
  const out = [];
  for (const m of String(statement ?? "").matchAll(/\b([A-Za-z][\w-]{2,})\s+or\s+([A-Za-z][\w-]{2,})\b/g)) {
    const [a, b] = [m[1], m[2]];
    if (ALT_STOP.has(a.toLowerCase()) || ALT_STOP.has(b.toLowerCase())) continue;
    const has = (w) => new RegExp(`(^|[^a-z0-9])${normaliseForQuote(w)}([^a-z0-9]|$)`).test(said);
    if (has(a) !== has(b)) out.push(`${a} or ${b}`);
  }
  return out;
}
// A test's separate text segments: names are detected within one segment, never across a step boundary.
const segmentsOf = (t) => [t.title, t.objective, ...(t.preconditions ?? []), ...t.steps.flatMap((s) => [s.action, s.expected]), t.expected_result].filter(Boolean);
const testText = (t) => segmentsOf(t).join(". ");

/** Two candidates are the same test: same type and variation, no differing names/values, near-identical procedure and result. */
export function sameTest(a, b) {
  if (a.test_type !== b.test_type || normaliseForQuote(a.variation) !== normaliseForQuote(b.variation)) return false;
  if (!a.ac_labels.some((x) => b.ac_labels.includes(x))) return false;
  const x = `${a.title} ${a.expected_result}`, y = `${b.title} ${b.expected_result}`;
  if (normaliseForQuote(x) === normaliseForQuote(y)) return true;
  if (distinctTerms(testText(a), testText(b))) return false;
  return similarity(testText(a), testText(b)) >= TEST_MERGE_SIMILARITY && containment(a.expected_result, b.expected_result) >= 0.8;
}

const render = (fragments) => buildChunks(fragments, Number.MAX_SAFE_INTEGER).map((c) => c.text).join("\n\n");

/** The labelled context shown to the model, built deterministically from the claimed input. */
export function buildTestContext(input) {
  const label = (prefix, list) => new Map((list ?? []).map((x, i) => [`${prefix}${i + 1}`, x]));
  const acs = label("A", input.acceptance_criteria);
  const fragments = [...(input.fragments ?? [])].sort((a, b) => a.sequence - b.sequence);
  const byAlias = new Map(fragments.map((f) => [aliasFor(f), f]));
  const fragAlias = new Map(fragments.map((f) => [f.id, aliasFor(f)]));
  const human = label("H", input.human_clarifications);
  const clarifications = label("C", input.analysis_clarifications);
  const resolved = label("R", input.resolved_questions);
  const scopeNotes = label("N", input.scope_notes);
  const openQuestions = label("Q", input.open_questions);
  const humanAlias = new Map([...human].map(([k, h]) => [h.id, k]));
  const clarAlias = new Map([...clarifications].map(([k, c]) => [c.id, k]));
  const resolvedAlias = new Map([...resolved].map(([k, r]) => [r.id, k]));
  const noteAlias = new Map([...scopeNotes].map(([k, n]) => [n.id, k]));
  const r = input.requirement;

  // Only the sentences of the cited fragments that state these criteria / this requirement.
  const anchors = [...new Set([r.description, r.source_quote, ...[...acs.values()].flatMap((a) => [a.criterion, a.source_quote, a.then_text])].filter((x) => String(x ?? "").trim()))];
  const shown = fragments.map((f) => ({ f, x: requirementExcerpt(f, anchors) })).filter(({ x }) => x.text).map(({ f, x }) => ({ ...f, fragment_type: "text", metadata: {}, text: x.text }));
  const sourceText = fragments.length ? render(shown.length ? shown : fragments) : "";

  const requirementText = [`Reference: ${r.ref ?? "(none)"}`, `Title: ${r.title}`, `Description: ${r.description ?? ""}`, r.category ? `Category: ${r.category}` : null].filter(Boolean).join("\n");
  const criteriaText = [...acs].map(([k, a]) => {
    const relies = [...(a.fragment_ids ?? []).map((id) => fragAlias.get(id)), ...(a.human_clarification_ids ?? []).map((id) => humanAlias.get(id)),
      ...(a.analysis_clarification_ids ?? []).map((id) => clarAlias.get(id)), ...(a.resolved_issue_ids ?? []).map((id) => resolvedAlias.get(id)),
      ...(a.scope_note_ids ?? []).map((id) => noteAlias.get(id))].filter(Boolean);
    return [
      `[${k}] ${a.ref}${a.criterion_type ? ` (${a.criterion_type})` : ""}: ${a.criterion}`,
      a.description ? `   Description: ${a.description}` : null,
      a.given_text || a.when_text || a.then_text ? `   Given: ${a.given_text || "—"} | When: ${a.when_text || "—"} | Then: ${a.then_text || "—"}` : null,
      a.origin === "manual" ? "   (written by the team — its text is the authority)" : relies.length ? `   Relies on: ${relies.join(", ")}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n");
  const humanText = [...human].map(([k, h]) => `[${k}] Human Clarification by ${h.created_by_name}: ${h.clarification}`).join("\n");
  const clarificationsText = [...clarifications].map(([k, c]) => `[${k}] Question: ${c.question ?? c.description} — Human answer: ${c.resolution_note}`).join("\n");
  const resolvedText = [...resolved].map(([k, q]) => `[${k}] ${q.question ?? q.description} — ${q.status}: ${q.resolution_note ?? ""}`).join("\n");
  const scopeNotesText = [...scopeNotes].map(([k, n]) => `[${k}] ${n.area ? `${n.area}: ` : ""}${n.description}`).join("\n");
  const openQuestionsText = [...openQuestions].map(([k, q]) => `[${k}] ${q.question ?? q.description}`).join("\n");
  // Grounding corpus: the governed text only — context labels ([A1], [F3]) and record references (AC-029, REP-010) never ground a value or a name.
  const corpus = [requirementText, criteriaText, ...fragments.map((f) => f.text), humanText, clarificationsText, resolvedText, scopeNotesText].join("\n")
    .replace(/\[[A-Z]\d{1,5}\]/g, " ").replace(/\b(?:AC|REP|REQ|TC|TST|DEL)-\d+\b/g, " ").replace(/Relies on:[^\n]*/g, " ");
  return { acs, fragments, byAlias, human, clarifications, resolved, scopeNotes, openQuestions, fragAlias, humanAlias, clarAlias, resolvedAlias, noteAlias,
    requirementText, criteriaText, sourceText, humanText, clarificationsText, resolvedText, scopeNotesText, openQuestionsText, corpus };
}

/**
 * @param input    { run:{id, model}, requirement, acceptance_criteria, fragments, human_clarifications, analysis_clarifications, scope_notes, resolved_questions, open_questions }
 * @param llm      { chat({ messages, schema }) → { content, durationMs } }
 * @param reusable earlier validated stage results [{ run_id, stage, chunk_key, input_hash, output }]
 * @param onStage  async ({ stage, chunk_key, input_hash, attempts, reused_from, output }) persist hook
 */
export async function runTestGeneration({ input, llm, reusable = [], onStage = async () => {}, log = () => {} }) {
  const { run } = input;
  if (!input.requirement?.title) throw new TestGenerationError("validation_failed", "The generation input has no Requirement.");
  if (!Array.isArray(input.acceptance_criteria) || !input.acceptance_criteria.length) throw new TestGenerationError("validation_failed", "The generation input has no acceptance criteria.");
  const ctx = buildTestContext(input);
  const warnings = [];
  const stageCalls = [];
  const rejected = [];
  const flagged = [];
  const corpusWords = wordSet(ctx.corpus);
  const A = new Set(ctx.acs.keys()), F = new Set(ctx.byAlias.keys()), N = new Set(ctx.scopeNotes.keys());
  const CL = new Set([...ctx.human.keys(), ...ctx.clarifications.keys(), ...ctx.resolved.keys()]);

  async function callStage(stage, chunkKey, userPrompt, checkRefs) {
    const messages = [{ role: "system", content: TEST_SYSTEM_PROMPT }, { role: "user", content: userPrompt }];
    const inputHash = sha256(JSON.stringify({ stage, prompt_version: TEST_PROMPT_VERSION, schema_version: TEST_SCHEMA_VERSION, model: run.model, messages }));
    const schema = TEST_STAGE_SCHEMAS[stage];
    const check = (output) => checkRefs(structuredClone(output));
    const prior = reusable.find((x) => x.stage === stage && x.chunk_key === chunkKey && x.input_hash === inputHash);
    const reused = prior && validateSchema(schema, prior.output).length === 0 ? check(prior.output) : null;
    if (reused && reused.errors.length === 0) {
      if (prior.run_id !== run.id) await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: 1, reused_from: prior.run_id, output: prior.output });
      stageCalls.push({ stage, chunk: chunkKey, attempts: 0, reused: true });
      return reused.cleaned;
    }
    const conversation = [...messages];
    let lastErrors = [];
    let fallback = null;
    for (let attempt = 1; attempt <= TEST_MAX_ATTEMPTS; attempt++) {
      const { content, durationMs } = await llm.chat({ messages: conversation, schema });
      let parsed = null;
      let errors;
      try { parsed = JSON.parse(content); errors = validateSchema(schema, parsed); } catch { errors = ["the response is not valid JSON"]; }
      let checked = null;
      if (errors.length === 0) { checked = check(parsed); errors = checked.errors; fallback = checked; }
      if (errors.length === 0) {
        await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: attempt, reused_from: null, output: parsed });
        stageCalls.push({ stage, chunk: chunkKey, attempts: attempt, reused: false, duration_ms: durationMs });
        return checked.cleaned;
      }
      lastErrors = errors;
      log(`${stage}: attempt ${attempt} rejected (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
      conversation.push({ role: "assistant", content: content.slice(0, 8000) });
      conversation.push({ role: "user", content: `Your JSON was rejected:\n- ${errors.slice(0, 12).join("\n- ")}\nReturn the corrected JSON only, using only the IDs shown in the text.` });
    }
    if (fallback) {
      warnings.push(`${stage}: after ${TEST_MAX_ATTEMPTS} attempts ${fallback.errors.length} invalid item(s) were dropped (${fallback.errors.slice(0, 3).join("; ")})`);
      await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: TEST_MAX_ATTEMPTS, reused_from: null, output: fallback.cleaned });
      stageCalls.push({ stage, chunk: chunkKey, attempts: TEST_MAX_ATTEMPTS, reused: false, dropped: fallback.errors.length });
      return fallback.cleaned;
    }
    throw new TestGenerationError("invalid_model_output", `The model could not produce valid ${stage} output after ${TEST_MAX_ATTEMPTS} attempts: ${lastErrors.slice(0, 3).join("; ")}`.slice(0, 900), { stage_calls: stageCalls, warnings });
  }

  // A real label filed under the wrong list is unambiguous by its prefix: move it.
  const refile = (item) => {
    const all = [...(item.criteria ?? []), ...item.source_ids, ...item.clarification_ids, ...item.scope_note_ids];
    item.criteria = [...new Set(all.filter((l) => l.startsWith("A")))];
    item.source_ids = [...new Set(all.filter((l) => l.startsWith("F")))];
    item.clarification_ids = [...new Set(all.filter((l) => /^[HCR]/.test(l)))];
    item.scope_note_ids = [...new Set(all.filter((l) => l.startsWith("N")))];
    item.open_question_ids = [...new Set(all.filter((l) => l.startsWith("Q")))];
    return item;
  };
  const refErrors = (item, where) => [
    ...item.criteria.filter((id) => !A.has(id)).map((id) => `${where} cites ${id}, which is not an ACCEPTANCE CRITERION`),
    ...item.source_ids.filter((id) => !F.has(id)).map((id) => `${where} cites ${id}, which is not a SOURCE fragment`),
    ...item.clarification_ids.filter((id) => !CL.has(id)).map((id) => `${where} cites ${id}, which is not a CLARIFICATION`),
    ...item.scope_note_ids.filter((id) => !N.has(id)).map((id) => `${where} cites ${id}, which is not a SCOPE NOTE`),
    ...item.open_question_ids.map((id) => `${where} cites ${id}, an OPEN QUESTION — an open question is not a fact; do not design for it`),
    ...(item.criteria.length ? [] : [`${where} traces to no ACCEPTANCE CRITERION`]),
  ];

  const base = { requirementText: ctx.requirementText, criteriaText: ctx.criteriaText, sourceText: ctx.sourceText, humanText: ctx.humanText,
    clarificationsText: ctx.clarificationsText, resolvedText: ctx.resolvedText, scopeNotesText: ctx.scopeNotesText, openQuestionsText: ctx.openQuestionsText };

  // ── Stage 1: behaviours ────────────────────────────────────────────────
  const beh = await callStage("behaviours", "requirement", behavioursPrompt(base), (o) => {
    const errors = [];
    const kept = [];
    o.behaviours.forEach((b, i) => { refile(b); const e = refErrors(b, `behaviours[${i}]`); errors.push(...e); if (!e.length) kept.push(b); });
    const decided = new Set();
    const decisions = [];
    for (const d of o.scope_notes) {
      if (!N.has(d.id)) errors.push(`scope_notes cites ${d.id}, which is not a SCOPE NOTE`);
      else if (!decided.has(d.id)) { decided.add(d.id); decisions.push(d); }
    }
    for (const n of N) if (!decided.has(n)) errors.push(`${n} is missing from scope_notes — decide whether it applies`);
    return { errors, cleaned: { behaviours: kept, scope_notes: decisions } };
  });
  const noteDecisions = (beh.scope_notes ?? []).map((d) => ({ note: d.id, relevant: d.relevant, reason: cleanText(d.reason).slice(0, 300) }));
  const relevantNotes = new Set(noteDecisions.filter((d) => d.relevant).map((d) => d.note));
  const acText = (k) => { const a = ctx.acs.get(k); return [a.criterion, a.description, a.given_text, a.when_text, a.then_text].filter(Boolean).join(" "); };
  const behaviours = [];
  for (const b of beh.behaviours) {
    const statement = cleanText(b.statement);
    b.scope_note_ids = b.scope_note_ids.filter((n) => relevantNotes.has(n));
    const regressionGrounded = b.scope_note_ids.length > 0 || b.criteria.some((k) => ctx.acs.get(k).criterion_type === "Regression" || isNoChangeStatement(acText(k)) || CONTINUITY.test(acText(k)));
    if (b.kind === "regression" && !regressionGrounded) {
      // The behaviour still comes from its AC: keep it, but not as regression (no generic "nothing else breaks").
      rejected.push({ stage: "behaviours", text: statement.slice(0, 300), reason: "regression behaviour without a Regression criterion, a no-change statement or a relevant scope note — kept as an ordinary behaviour" });
      b.kind = "positive";
    }
    const same = behaviours.find((o) => o.kind === b.kind && normaliseForQuote(o.variation) === normaliseForQuote(cleanText(b.variation))
      && (normaliseForQuote(o.statement) === normaliseForQuote(statement) || (!distinctTerms(o.statement, statement) && similarity(o.statement, statement) >= 0.8)));
    if (same) {
      for (const k of ["criteria", "source_ids", "clarification_ids", "scope_note_ids"]) same[k] = [...new Set([...same[k], ...b[k]])];
      continue;
    }
    behaviours.push({ key: `B${behaviours.length + 1}`, statement, kind: b.kind, variation: cleanText(b.variation), criteria: b.criteria,
      source_ids: b.source_ids, clarification_ids: b.clarification_ids, scope_note_ids: b.scope_note_ids });
  }
  if (!behaviours.length) throw new TestGenerationError("validation_failed", "No testable behaviour of the acceptance criteria could be identified.", { stage_calls: stageCalls, warnings, rejected });
  const byKey = new Map(behaviours.map((b) => [b.key, b]));
  const behavioursText = (list) => list.map((b) => `${b.key} (${b.kind}${b.variation ? `; ${b.variation}` : ""}): ${b.statement} [${[...b.criteria, ...b.source_ids, ...b.clarification_ids, ...b.scope_note_ids].join(", ")}]`).join("\n");

  // ── Stage 2 / 3: tests and coverage ────────────────────────────────────
  const checkTests = (keys) => (o) => {
    const errors = [];
    const kept = [];
    o.tests.forEach((t, i) => {
      refile(t);
      const e = refErrors(t, `tests[${i}]`);
      e.push(...t.behaviours.filter((k) => !keys.has(k)).map((k) => `tests[${i}] covers ${k}, which is not one of the BEHAVIOURS`));
      errors.push(...e);
      if (!e.length) kept.push(t);
    });
    const gaps = [];
    o.gaps.forEach((g, i) => { if (keys.has(g.behaviour)) gaps.push(g); else errors.push(`gaps[${i}] is for ${g.behaviour}, which is not one of the BEHAVIOURS`); });
    return { errors, cleaned: { tests: kept, gaps } };
  };

  const candidates = [];
  const gaps = [];
  const issues = [];
  const accept = (t, origin) => {
    const covered = [...new Set(t.behaviours)].map((k) => byKey.get(k));
    const acLabels = [...new Set([...t.criteria, ...covered.flatMap((b) => b.criteria)])];
    const inherit = (k) => [...new Set([...t[k], ...covered.flatMap((b) => b[k])])];
    // AI-promoted ACs bring their own provenance (fragments, clarifications, scope notes).
    const fromAcs = (mapName, field) => acLabels.flatMap((k) => (ctx.acs.get(k)[field] ?? []).map((id) => ctx[mapName].get(id))).filter(Boolean);
    const sourceIds = [...new Set([...inherit("source_ids"), ...fromAcs("fragAlias", "fragment_ids")])];
    const clarIds = [...new Set([...inherit("clarification_ids"), ...fromAcs("humanAlias", "human_clarification_ids"), ...fromAcs("clarAlias", "analysis_clarification_ids"), ...fromAcs("resolvedAlias", "resolved_issue_ids")])];
    const noteIds = inherit("scope_note_ids").filter((n) => relevantNotes.has(n));
    const steps = t.steps.map((s) => ({ action: cleanText(s.action), expected: cleanText(s.expected) })).filter((s) => s.action);
    const cand = {
      title: cleanText(t.title), objective: cleanText(t.objective), preconditions: t.preconditions.map(cleanText).filter(Boolean), steps,
      expected_result: cleanText(t.expected_result), test_type: t.test_type, variation: cleanText(t.variation), basis: t.basis, confidence: t.confidence,
      reasons: [], ac_labels: acLabels, behaviours: covered.map((b) => b.key), source_ids: sourceIds, clarification_ids: clarIds, scope_note_ids: noteIds,
      rationale: cleanText(t.rationale) || "Proves the behaviour.", origin,
    };
    const all = testText(cand);
    const reject = (reason) => rejected.push({ stage: origin, text: cand.title.slice(0, 300), reason });
    if (!steps.length) return reject("no usable procedure");
    // A single step that only restates the criterion is not a procedure.
    if (steps.length === 1 && acLabels.some((k) => similarity(`${steps[0].action} ${steps[0].expected}`, ctx.acs.get(k).criterion) >= RESTATEMENT_SIMILARITY)) return reject("merely restates the acceptance criterion without a usable procedure");
    const invented = inventedValues(all, ctx.corpus);
    if (invented.length) {
      reject(`states ${invented.join(", ")}, which the input does not give`);
      issues.push({ issue_type: "Insufficient Source Support", severity: "Medium", behaviour: covered.map((b) => b.statement).join(" / ").slice(0, 1000),
        description: `A proposed test stated ${invented.join(", ")}, which neither the acceptance criteria nor their context give. It was not proposed; the value must come from the business.`.slice(0, 2000),
        suggested_question: null, ac_labels: acLabels, source_ids: [], open_question_ids: [] });
      return;
    }
    const expectedText = [cand.expected_result, ...steps.map((s) => s.expected)].filter(Boolean).join(" ");
    const vague = vagueness(cand.expected_result, corpusWords);
    if (vague?.hollow) return reject(`vague expected result: "${vague.phrase}" with nothing concrete to check`);
    if (vague) cand.reasons.push(`Vague expected result ("${vague.phrase}") — make it specific.`);
    if (cand.test_type === "Regression" && !covered.some((b) => b.kind === "regression")) return reject("Regression test for a behaviour that is not a regression behaviour");
    if (cand.test_type === "Negative" && !NEGATION.test(`${covered.map((b) => b.statement).join(" ")} ${acLabels.map(acText).join(" ")}`)) {
      cand.reasons.push("Marked Negative, but no negative or prohibiting statement was found in its criterion.");
    }
    const unsupported = unsupportedSemantics(expectedText, ctx.corpus, corpusWords).filter((u) => !groundedComparison(u, corpusWords));
    if (unsupported.length) cand.reasons.push(`Expected result introduces an unsupported interpretation: ${unsupported.map((u) => `"${u.phrase}"`).join(", ")}.`);
    const names = [...new Set(segmentsOf(cand).flatMap((seg) => inventedNames(seg, ctx.corpus, corpusWords)))];
    const controls = [...new Set(steps.flatMap((s) => inventedControls(s.action, corpusWords)))];
    if (names.length || controls.length) {
      cand.reasons.push(`Unsupported procedure detail — not in the acceptance criteria or their context: ${[...names, ...controls].map((x) => `"${x}"`).join(", ")}.`);
      flagged.push({ title: cand.title.slice(0, 200), names, controls });
    }
    const said = normaliseForQuote(all);
    const omitted = [...new Set(covered.flatMap((b) => namedTerms(b.statement)))].filter((x) => !said.includes(normaliseForQuote(x)));
    if (omitted.length) cand.reasons.push(`Omits ${omitted.map((x) => `"${x}"`).join(", ")}, named in its behaviour — check the condition is not lost.`);
    const alternatives = [...new Set(covered.flatMap((b) => droppedAlternatives(b.statement, all)))];
    if (alternatives.length) cand.reasons.push(`Covers only one of ${alternatives.map((x) => `"${x}"`).join(", ")} stated in its behaviour — check the other is tested.`);
    const variations = [...new Set(covered.map((b) => normaliseForQuote(b.variation)).filter(Boolean))];
    if (variations.length > 1) cand.reasons.push(`Combines ${variations.length} independently testable variations (${covered.map((b) => b.variation).filter(Boolean).join("; ")}) — a failure would not show which one; consider one test each.`);
    // Explicit only when the expected result is stated by the criteria / clarifications.
    const ground = wordSet([...acLabels.map(acText), ctx.humanText, ctx.clarificationsText, ctx.resolvedText, ...covered.map((b) => b.statement)].join(" "));
    if (cand.basis === "Explicit" && novelWords(cand.expected_result, ground).size > 3) {
      cand.basis = "Inferred";
      warnings.push(`test "${cand.title.slice(0, 60)}": marked Explicit but its expected result goes beyond the criteria — recorded as Inferred`);
    }
    if (names.length || controls.length) cand.basis = "Inferred";
    candidates.push(cand);
  };

  const allKeys = new Set(behaviours.map((b) => b.key));
  const out = await callStage("tests", "requirement", testsPrompt({ ...base, behavioursText: behavioursText(behaviours) }), checkTests(allKeys));
  for (const t of out.tests) accept(t, "tests");
  gaps.push(...out.gaps);
  const coveredKeys = () => new Set([...candidates.flatMap((c) => c.behaviours), ...gaps.map((g) => g.behaviour)]);
  const uncovered = behaviours.filter((b) => !coveredKeys().has(b.key));
  if (uncovered.length) {
    const keys = new Set(uncovered.map((b) => b.key));
    const cov = await callStage("coverage", "requirement", coveragePrompt({ ...base, behavioursText: behavioursText(uncovered) }), checkTests(keys));
    for (const t of cov.tests) accept(t, "coverage");
    gaps.push(...cov.gaps);
  }

  // ── Stage 4: lossless dedup ────────────────────────────────────────────
  const order = (c) => Math.min(...c.behaviours.map((k) => Number(k.slice(1))));
  const groups = components(candidates.map((_, i) => i), (a, b) => sameTest(candidates[a], candidates[b]));
  const merged = groups.map((members) => {
    const list = members.map((i) => candidates[i]);
    const rep = [...list].sort((a, b) => b.steps.length - a.steps.length || (a.basis === "Explicit" ? 0 : 1) - (b.basis === "Explicit" ? 0 : 1) || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])[0];
    const union = (k) => [...new Set(list.flatMap((c) => c[k]))];
    return {
      ...rep, reasons: [...new Set(list.flatMap((c) => c.reasons))],
      ac_labels: union("ac_labels"), behaviours: union("behaviours").sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      source_ids: union("source_ids"), clarification_ids: union("clarification_ids"), scope_note_ids: union("scope_note_ids"),
      consolidation: list.length > 1 ? { merged: true, member_count: list.length, reason: "the same test proposed more than once",
        members: list.map((c) => ({ title: c.title, expected_result: c.expected_result, steps: c.steps.length, origin: c.origin })) } : {},
    };
  }).sort((a, b) => order(a) - order(b) || ["Positive", "Negative", "Regression"].indexOf(a.test_type) - ["Positive", "Negative", "Regression"].indexOf(b.test_type));

  // ── Issues: gaps, uncovered behaviours / criteria, open questions ──────
  const withTests = new Set(merged.flatMap((c) => c.behaviours));
  const suppressed = [];
  for (const g of gaps) {
    const b = byKey.get(g.behaviour);
    if (withTests.has(g.behaviour)) { suppressed.push({ behaviour: g.behaviour, issue_type: g.issue_type }); continue; }
    issues.push({ issue_type: g.issue_type, severity: "Medium", behaviour: b.statement, description: cleanText(g.description), suggested_question: cleanText(g.question) || null,
      ac_labels: b.criteria, source_ids: b.source_ids, open_question_ids: [] });
  }
  const gapped = new Set(gaps.map((g) => g.behaviour));
  for (const b of behaviours.filter((x) => !withTests.has(x.key) && !gapped.has(x.key))) {
    warnings.push(`${b.key}: no acceptable test and no gap — recorded as Uncovered Behaviour`);
    issues.push({ issue_type: "Uncovered Behaviour", severity: "Medium", behaviour: b.statement,
      description: `No acceptable test could be designed for this behaviour from the acceptance criteria and their context: "${b.statement}". A human must define the procedure or expected result.`.slice(0, 2000),
      suggested_question: null, ac_labels: b.criteria, source_ids: b.source_ids, open_question_ids: [] });
  }
  const testedAcs = new Set(merged.flatMap((c) => c.ac_labels));
  for (const [k, a] of ctx.acs) {
    if (testedAcs.has(k)) continue;
    issues.push({ issue_type: "Uncovered Acceptance Criterion", severity: "High", behaviour: null,
      description: `No test was proposed for ${a.ref}: "${a.criterion}".${issues.some((x) => x.ac_labels.includes(k)) ? " See the related test-design issues." : ""}`.slice(0, 2000),
      suggested_question: null, ac_labels: [k], source_ids: [], open_question_ids: [] });
  }
  for (const n of relevantNotes) {
    if (merged.some((c) => c.test_type === "Regression" && c.scope_note_ids.includes(n))) continue;
    const note = ctx.scopeNotes.get(n);
    issues.push({ issue_type: "Uncovered Behaviour", severity: "Low", behaviour: note.description,
      description: `Scope note ${note.area ? `"${note.area}" ` : ""}was judged relevant, but no regression test traced to an acceptance criterion covers it: "${note.description}".`.slice(0, 2000),
      suggested_question: null, ac_labels: [], source_ids: [], open_question_ids: [] });
  }
  for (const [k, q] of ctx.openQuestions) {
    const text = q.question ?? q.description;
    const additional = q.relation === "Additional Coverage";
    issues.push({ issue_type: additional ? "Additional Coverage Question" : "Unresolved Question", severity: additional ? "Low" : "High", behaviour: null,
      description: (additional
        ? `Not covered by any test until answered: "${text}". No placeholder test was designed; answer it in the acceptance criteria review, then regenerate.`
        : `Unresolved question an acceptance criterion depends on: "${text}". Tests that need its answer were not designed.`).slice(0, 2000),
      suggested_question: text ?? null, ac_labels: [], source_ids: [], open_question_ids: [k] });
  }

  // ── Stage 5: id mapping and deterministic validation ───────────────────
  const id = {
    A: (l) => ctx.acs.get(l).id, F: (l) => ctx.byAlias.get(l).id, N: (l) => ctx.scopeNotes.get(l).id, Q: (l) => ctx.openQuestions.get(l).id,
    H: (l) => ctx.human.get(l)?.id, C: (l) => ctx.clarifications.get(l)?.id, R: (l) => ctx.resolved.get(l)?.id,
  };
  const ofPrefix = (list, p) => list.filter((l) => l.startsWith(p)).map(id[p]);
  const proposals = merged.map((c, i) => ({
    sequence: i + 1, title: c.title.slice(0, 300), objective: (c.objective || c.title).slice(0, 2000), preconditions: c.preconditions.slice(0, 20).map((x) => x.slice(0, 1000)),
    steps: c.steps.slice(0, 30).map((s, n) => ({ step: n + 1, action: s.action.slice(0, 1000), expected: s.expected ? s.expected.slice(0, 1000) : null })),
    expected_result: c.expected_result.slice(0, 2000), test_type: c.test_type, variation: c.variation ? c.variation.slice(0, 300) : null,
    basis: c.basis, confidence: c.confidence, needs_review_reasons: c.reasons.map((r) => r.slice(0, 500)),
    source_ac_ids: c.ac_labels.map(id.A), source_fragment_ids: c.source_ids.map(id.F),
    human_clarification_ids: ofPrefix(c.clarification_ids, "H"), analysis_clarification_ids: ofPrefix(c.clarification_ids, "C"), resolved_issue_ids: ofPrefix(c.clarification_ids, "R"),
    scope_note_ids: c.scope_note_ids.map(id.N), rationale: c.rationale.slice(0, 2000),
    behaviours: c.behaviours.map((k) => ({ key: k, statement: byKey.get(k).statement, kind: byKey.get(k).kind, variation: byKey.get(k).variation || null })),
    consolidation: c.consolidation,
  }));
  const outIssues = issues.map((x, i) => ({
    sequence: i + 1, issue_type: x.issue_type, severity: x.severity, description: x.description.slice(0, 2000) || "Needs review.",
    behaviour: x.behaviour ? x.behaviour.slice(0, 1000) : null, suggested_question: x.suggested_question ? x.suggested_question.slice(0, 1000) : null,
    ac_ids: x.ac_labels.map(id.A), source_fragment_ids: x.source_ids.map(id.F), source_issue_ids: x.open_question_ids.map(id.Q),
  }));
  const allowed = {
    acs: new Set([...ctx.acs.values()].map((a) => a.id)), fragments: new Set(ctx.fragments.map((f) => f.id)),
    human: new Set([...ctx.human.values()].map((x) => x.id)), clarifications: new Set([...ctx.clarifications.values()].map((x) => x.id)),
    resolved: new Set([...ctx.resolved.values()].map((x) => x.id)), scopeNotes: new Set([...ctx.scopeNotes.values()].map((x) => x.id)),
    openQuestions: new Set([...ctx.openQuestions.values()].map((x) => x.id)),
  };
  const problems = validateTestGenerationOutput({ proposals, issues: outIssues }, allowed);
  const diagnostics = {
    prompt_version: TEST_PROMPT_VERSION, schema_version: TEST_SCHEMA_VERSION,
    ac_count: ctx.acs.size, fragment_count: ctx.fragments.length, human_clarification_count: ctx.human.size, open_question_count: ctx.openQuestions.size, scope_note_count: ctx.scopeNotes.size,
    behaviours: behaviours.map((b) => ({ key: b.key, statement: b.statement, kind: b.kind, variation: b.variation || null, criteria: b.criteria.map((k) => ctx.acs.get(k).ref),
      covered_by: proposals.filter((p) => p.behaviours.some((x) => x.key === b.key)).map((p) => p.sequence), gap: gapped.has(b.key) })),
    ac_coverage: [...ctx.acs.values()].map((a) => ({ ac_id: a.id, ref: a.ref, origin: a.origin, tests: proposals.filter((p) => p.source_ac_ids.includes(a.id)).map((p) => p.sequence) })),
    scope_note_decisions: noteDecisions.map((d) => ({ ...d, note: ctx.scopeNotes.get(d.note)?.id })),
    candidates_before_dedup: candidates.length, proposal_count: proposals.length, issue_count: outIssues.length,
    needs_review_count: proposals.filter((p) => p.basis === "Inferred" || p.confidence === "Low" || p.needs_review_reasons.length).length,
    unsupported_detail: flagged, rejected_tests: rejected, suppressed_gaps: suppressed, stage_calls: stageCalls, warnings,
  };
  if (problems.length) throw new TestGenerationError("validation_failed", `Deterministic validation failed: ${problems.slice(0, 3).join("; ")}`.slice(0, 900), diagnostics);
  return { proposals, issues: outIssues, diagnostics, withWarnings: warnings.length > 0 };
}

const ENUMS = {
  test_type: ["Positive", "Negative", "Regression"], basis: ["Explicit", "Inferred"], confidence: ["High", "Medium", "Low"], severity: ["High", "Medium", "Low"],
  issue_type: ["Uncovered Acceptance Criterion", "Uncovered Behaviour", "Missing Test Detail", "Additional Coverage Question", "Unresolved Question", "Insufficient Source Support", "Ambiguous Expected Result", "Conflicting Context"],
};

/** Stage 5 — mirrored by the server (lib/test-generation.ts) before anything is stored. */
export function validateTestGenerationOutput({ proposals, issues }, allowed) {
  const problems = [];
  const seq = new Set();
  const subset = (list, set) => Array.isArray(list) && list.every((x) => set.has(x));
  proposals.forEach((p, i) => {
    const where = `test ${i + 1}`;
    if (!Number.isInteger(p.sequence) || seq.has(p.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    seq.add(p.sequence);
    if (!String(p.title ?? "").trim() || !String(p.objective ?? "").trim() || !String(p.expected_result ?? "").trim() || !String(p.rationale ?? "").trim()) problems.push(`${where}: title, objective, expected result and rationale are required`);
    if (!Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > 30 || p.steps.some((s) => !String(s?.action ?? "").trim())) problems.push(`${where}: 1–30 steps, each with an action`);
    if (!ENUMS.test_type.includes(p.test_type)) problems.push(`${where}: invalid test_type`);
    if (!ENUMS.basis.includes(p.basis)) problems.push(`${where}: invalid basis`);
    if (!ENUMS.confidence.includes(p.confidence)) problems.push(`${where}: invalid confidence`);
    if (!Array.isArray(p.source_ac_ids) || p.source_ac_ids.length === 0 || !subset(p.source_ac_ids, allowed.acs)) problems.push(`${where}: must trace to at least one of the run's acceptance criteria`);
    if (!subset(p.source_fragment_ids, allowed.fragments)) problems.push(`${where}: cites a fragment outside the run's provenance`);
    if (!subset(p.human_clarification_ids, allowed.human) || !subset(p.analysis_clarification_ids, allowed.clarifications) || !subset(p.resolved_issue_ids, allowed.resolved)) problems.push(`${where}: cites a clarification that was not supplied`);
    if (!subset(p.scope_note_ids, allowed.scopeNotes)) problems.push(`${where}: cites a scope note that was not supplied`);
    if ("review_status" in p || "test_ref" in p) problems.push(`${where}: review status and test references are not chosen by generation`);
  });
  const iseq = new Set();
  issues.forEach((x, i) => {
    const where = `issue ${i + 1}`;
    if (!Number.isInteger(x.sequence) || iseq.has(x.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    iseq.add(x.sequence);
    if (!ENUMS.issue_type.includes(x.issue_type)) problems.push(`${where}: invalid issue_type`);
    if (!ENUMS.severity.includes(x.severity)) problems.push(`${where}: invalid severity`);
    if (!String(x.description ?? "").trim()) problems.push(`${where}: description is required`);
    if (!subset(x.ac_ids, allowed.acs)) problems.push(`${where}: cites an acceptance criterion outside the run`);
    if (!subset(x.source_fragment_ids, allowed.fragments)) problems.push(`${where}: cites a fragment outside the run's provenance`);
    if (!subset(x.source_issue_ids, new Set([...allowed.openQuestions, ...allowed.resolved]))) problems.push(`${where}: cites a question that was not supplied`);
  });
  return problems;
}
