// Phase 1C analysis pipeline tests (prompts/schema 2.0.0) — real chunking,
// prompts, schema checks, provenance validation, consolidation and the issue
// gate; a scripted fake model instead of Ollama (no network). Proves:
// structured output is validated before it is accepted, malformed output is
// retried then refused, fabricated fragment IDs never reach a proposal,
// Explicit claims must quote the source, metadata/template/plan text does
// not become requirements, "no change" becomes a scope note while negative
// constraints stay requirements, consolidation is lossless and never merges
// different objects, the issue gate suppresses generic / speculative /
// already-answered questions, duplicate issues merge with every reference,
// stage results are reused on retry, and the worker only talks to a
// loopback Ollama.
import assert from "node:assert/strict";
import { buildChunks, fragmentBody, groupSections } from "../analysis/chunk.js";
import { createOllama } from "../analysis/ollama.js";
import {
  AnalysisError, MAX_ATTEMPTS, cleanQuestion, isGenericIssue, isNoChangeStatement, isPlanStatement, isSpecificQuestion,
  runAnalysis, validateAnalysisOutput,
} from "../analysis/pipeline.js";
import { ANALYSIS_SCHEMA_VERSION, PROMPT_VERSION, promptFingerprint, requirementsPrompt } from "../analysis/prompts.js";
import { STAGE_SCHEMAS, validateSchema } from "../analysis/schemas.js";
import { ANALYSIS_IDENTITY, processAnalysisRun, runAnalysisOnce, validateConfig } from "../worker.js";

async function run(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

// Released prompt versions and the fingerprint of their exact text. Changing
// any prompt wording without bumping PROMPT_VERSION fails this suite. 1.0.0
// is kept for the record (its text lives in git history; runs made with it
// keep their recorded version and fingerprint).
const PROMPT_FINGERPRINTS = {
  "1.0.0": "c551b499ced90cb52f8b65594c7a691e6e1f2128c725e5427a4df90b7eece615",
  "2.0.0": "da88c4c37c732ec73c6d358f10fba4623bcc02b26376a0d4898be47ba3abbe0a",
};

const f = (sequence, text, section, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, sequence, fragment_type: "text",
  section_heading: section.at(-1) ?? null, section_number: null, section_path: section, page_start: 1, page_end: 1, text, metadata: {}, ...extra,
});
const idOf = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// A tracker-style export: metadata, a requirement repeated on two pages, a benefit, a template leftover, a priority field.
const tracker = [
  f(1, "Status: Open\nPriority: Medium\nReporter: A Person", ["CR-1 Title"]),
  f(2, "The picker name must remain against the pick task after palletisation. MONO picks remain as they are.", ["CR-1 Title", "Detailed Requirements"]),
  f(3, "It gives the business traceability.", ["CR-1 Title", "Benefit"]),
  f(4, "Highlight the decision with red", ["CR-1 Title", "Decision"]),
  f(5, "We require the picker name to remain against the pick task, even after the pick task has been palletised.", ["CR-1 Title", "Description", "Change Description"], { page_start: 2, page_end: 2 }),
  f(6, "Priority: High", ["CR-1 Title", "Description"], { page_start: 2, page_end: 2 }),
];
const TRACKER_CLASSES = { F1: "metadata", F2: "requirement", F3: "benefit", F4: "template_admin", F5: "requirement", F6: "metadata" };

// A structured specification: per-screen sections, repeated rules, a no-change, a negative constraint, a plan.
const spec = [
  f(1, "1. Add colour to the item table.\n2. Colour shall default from the item table in all screens and shall be changeable by the user.", ["Spec", "Master Data"]),
  f(2, "1. Add a site filter, fixed to the value in the user table.\n2. Sort the pick list by colour: red first, then blue.", ["Spec", "Picking Screen"]),
  f(3, "1. Add a site filter, fixed to the value in the user table.\n2. Sort the stations by colour: red first, followed by blue.", ["Spec", "Packing Screen"]),
  f(4, "1. No change required.", ["Spec", "Returns Screen"]),
  f(5, "1. Site shall default from the user table; changeable only where the Support flag is set.\n2. No colour filter required.", ["Spec", "Dispatch Screen"]),
  f(6, "UI complete for all screens by 18th Sept.\n\nTest in QA w/c 21st Sept", ["Spec", "Plan"]),
];

const stageOf = (messages) => {
  const user = messages.find((m) => m.role === "user").content;
  if (user.startsWith("TASK: classify")) return "classification";
  if (user.startsWith("TASK: identify")) return "requirements";
  if (user.startsWith("TASK: the statements below")) return "coverage";
  if (user.startsWith("TASK: find the questions")) return "ambiguities";
  if (user.startsWith("TASK: these requirement candidates")) return "consolidation_requirements";
  if (user.startsWith("TASK: these open questions")) return "consolidation_issues";
  if (user.startsWith("TASK: for each open question")) return "source_check";
  throw new Error(`unknown stage prompt: ${user.slice(0, 60)}`);
};
const userOf = (messages) => messages.find((m) => m.role === "user").content;
const sourceOf = (messages) => userOf(messages).split("SOURCE:\n").at(-1);

const DEFAULTS = {
  coverage: () => ({ requirements: [] }),
  ambiguities: () => ({ issues: [] }),
  consolidation_requirements: () => ({ groups: [] }),
  consolidation_issues: () => ({ groups: [] }),
  source_check: (m) => ({ checks: [...userOf(m).split("QUESTIONS:\n").at(-1).matchAll(/^(I\d+):/gm)].map((x) => ({ key: x[1], answered: false, answer_id: "", answer_quote: "" })) }),
};

/** Fake model: per-stage handlers get (messages, attempt) and return an object or raw string. */
function fakeLlm(handlers) {
  const calls = [];
  const attempts = {};
  const all = { ...DEFAULTS, ...handlers };
  return {
    calls,
    async chat({ messages, schema }) {
      const stage = stageOf(messages);
      const key = `${stage}:${messages[1].content.length}`;
      attempts[key] = (attempts[key] ?? 0) + 1;
      calls.push({ stage, messages: messages.map((m) => ({ ...m })), schema, attempt: attempts[key] });
      const out = all[stage](messages, attempts[key]);
      return { content: typeof out === "string" ? out : JSON.stringify(out), durationMs: 5 };
    },
  };
}

const classifyAll = (map) => (messages) => ({
  fragments: [...sourceOf(messages).matchAll(/\[(F\d+)\]/g)].map((m) => ({ id: m[1], classification: map[m[1]] ?? "requirement", reason: "test" })),
});
const req = (o) => ({ category: "UI", priority: "Not stated", confidence: "High", rationale: "Stated directly.", evidence_basis: "Explicit", statement_type: "behaviour", applies_to: "", ...o });
const trackerRequirements = () => ({
  requirements: [
    req({ title: "Keep picker name after palletisation", description: "The picker name must remain against the pick task after palletisation.", applies_to: "pick task", source_ids: ["F2", "F5"], primary_source_id: "F2", source_quote: "The picker name must remain against the pick task after palletisation." }),
    req({ title: "MONO picks unchanged", description: "MONO picks remain as they are.", applies_to: "MONO picks", source_ids: ["F2"], primary_source_id: "F2", source_quote: "MONO picks remain as they are." }),
  ],
});
const issue = (o) => ({ issue_type: "Missing Information", severity: "High", impact: ["implementation"], related_requirements: [], ...o });

await run("prompts are versioned: 2.0.0 is pinned; 1.0.0 is not silently altered", () => {
  assert.equal(PROMPT_VERSION, "2.0.0");
  assert.equal(ANALYSIS_SCHEMA_VERSION, "2.0.0");
  assert.equal(promptFingerprint(), PROMPT_FINGERPRINTS[PROMPT_VERSION], "prompt text changed — bump PROMPT_VERSION and pin the new fingerprint");
  assert.notEqual(PROMPT_FINGERPRINTS["2.0.0"], PROMPT_FINGERPRINTS["1.0.0"]);
  assert.deepEqual(ANALYSIS_IDENTITY, { prompt_version: PROMPT_VERSION, prompt_sha256: promptFingerprint(), analysis_schema_version: ANALYSIS_SCHEMA_VERSION });
});

await run("section-aware chunking: consecutive fragments of one section stay together, keys are deterministic, tables stay structured", () => {
  const sections = groupSections(tracker);
  assert.deepEqual(sections.map((s) => s.fragments.map((x) => x.sequence)), [[1], [2], [3], [4], [5], [6]]);
  const table = f(7, "a b", ["T"], { fragment_type: "table", metadata: { table: { header: ["Field", "Rule"], rows: [["Plant", "defaults"], ["Temp", "changeable"]] } } });
  assert.equal(fragmentBody(table), "| Field | Rule |\n| Plant | defaults |\n| Temp | changeable |");
  const one = buildChunks(tracker);
  assert.equal(one.length, 1);
  assert.match(one[0].text, /### Section: CR-1 Title › Detailed Requirements \[page 1\]\n\[F2\]\n/);
  assert.deepEqual(buildChunks(tracker), one, "deterministic");
  const small = buildChunks(tracker, 150);
  assert.ok(small.length > 1);
  assert.deepEqual(small.flatMap((c) => c.fragmentIds), tracker.map((x) => x.id), "every fragment exactly once, in order");
});

await run("an oversized section is split deterministically while keeping its section identity and fragment ID", () => {
  const big = f(1, Array.from({ length: 40 }, (_, i) => `Rule ${i}: the system shall do thing number ${i} exactly.`).join("\n"), ["Spec", "Rules"]);
  const chunks = buildChunks([big], 600);
  assert.ok(chunks.length > 1);
  for (const c of chunks) { assert.match(c.text, /^### Section: Spec › Rules/); assert.match(c.text, /\[F1\] \(part \d+\/\d+\)/); }
});

await run("valid structured output is persisted per stage and mapped to real fragment IDs", async () => {
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements });
  const stages = [];
  const result = await runAnalysis({ run: { id: "run-1", model: "fake" }, fragments: tracker, llm, onStage: async (s) => { stages.push(s); } });
  assert.ok(stages.every((s) => /^[0-9a-f]{64}$/.test(s.input_hash) && s.attempts === 1));
  assert.deepEqual(validateAnalysisOutput(result, new Set(tracker.map((x) => x.id))), []);
  assert.ok(result.proposals.every((p) => !("review_status" in p) && !("requirement_ref" in p)));
});

await run("SOMCR038-shaped export: repeated requirement cites both pages, MONO is a scope note, metadata/benefit/template never requirements", async () => {
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements });
  const result = await runAnalysis({ run: { id: "run-t", model: "fake" }, fragments: tracker, llm });
  assert.deepEqual(result.proposals.map((p) => p.proposed_title), ["Keep picker name after palletisation"]);
  assert.deepEqual(result.proposals[0].source_fragment_ids, [idOf(2), idOf(5)]);
  assert.deepEqual(result.scope_notes.map((n) => [n.area, n.description, n.source_fragment_ids]), [["MONO picks", "MONO picks remain as they are.", [idOf(2)]]]);
  const source = sourceOf(llm.calls.find((c) => c.stage === "requirements").messages);
  assert.ok(!["[F1]", "[F3]", "[F4]", "[F6]"].some((a) => source.includes(a)), "only requirement fragments are SOURCE");
  assert.ok(result.issues.some((i) => i.issue_type === "Contradiction" && /Medium or High/.test(i.suggested_question)), "the priority contradiction survives");
});

await run("a restatement found by the coverage pass folds into the existing requirement (no duplicate proposal)", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES),
    requirements: () => ({ requirements: [req({ title: "Keep picker name", description: "The picker name must remain against the pick task after palletisation.", applies_to: "pick task", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The picker name must remain against the pick task after palletisation." })] }),
    coverage: (m) => (/We require the picker name/.test(userOf(m)) ? { requirements: [req({ title: "Picker name stays", description: "We require the picker name to remain against the pick task, even after the pick task has been palletised.", applies_to: "pick task", source_ids: ["F5"], primary_source_id: "F5", source_quote: "We require the picker name to remain against the pick task" })] } : { requirements: [] }),
  });
  const result = await runAnalysis({ run: { id: "run-c", model: "fake" }, fragments: tracker, llm });
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.proposals[0].source_fragment_ids, [idOf(2), idOf(5)], "the restatement adds its provenance");
});

await run("malformed output is retried with the validation error; accepted once valid", async () => {
  const llm = fakeLlm({
    classification: (m, attempt) => (attempt === 1 ? "Sure! Here is the JSON: {" : attempt === 2 ? { fragments: [{ id: "F2", classification: "requirement" }] } : classifyAll(TRACKER_CLASSES)(m)),
    requirements: () => ({ requirements: [] }),
  });
  const stages = [];
  await runAnalysis({ run: { id: "run-r", model: "fake" }, fragments: tracker, llm, onStage: async (s) => { stages.push(s); } });
  const cls = llm.calls.filter((c) => c.stage === "classification");
  assert.equal(cls.length, 3);
  assert.match(cls[1].messages.at(-1).content, /not valid JSON/);
  assert.match(cls[2].messages.at(-1).content, /reason: missing/);
  assert.equal(stages.find((s) => s.stage === "classification").attempts, 3);
});

await run("output that never becomes valid fails the stage cleanly — nothing malformed is persisted", async () => {
  const stages = [];
  const llm = fakeLlm({ classification: () => "not json at all" });
  await assert.rejects(runAnalysis({ run: { id: "run-x", model: "fake" }, fragments: tracker, llm, onStage: async (s) => { stages.push(s); } }),
    (e) => e instanceof AnalysisError && e.category === "invalid_model_output" && /after 3 attempts/.test(e.message));
  assert.equal(stages.length, 0);
  assert.equal(llm.calls.length, MAX_ATTEMPTS);
});

await run("fabricated fragment IDs are refused: retried, then dropped — never stored on a proposal", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES),
    requirements: () => ({ requirements: [
      req({ title: "Real", description: "The picker name must remain.", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The picker name must remain" }),
      req({ title: "Invented", description: "Something else", source_ids: ["F42"], primary_source_id: "F42", source_quote: "x" }),
    ] }),
  });
  const result = await runAnalysis({ run: { id: "run-f", model: "fake" }, fragments: tracker, llm });
  assert.deepEqual(result.proposals.map((p) => p.proposed_title), ["Real"]);
  assert.match(llm.calls.filter((c) => c.stage === "requirements")[1].messages.at(-1).content, /cites F42, which is not in SOURCE or CONTEXT/);
  assert.ok(result.withWarnings);
});

await run("a proposal or scope note without provenance cannot pass", () => {
  assert.ok(validateSchema(STAGE_SCHEMAS.requirements, { requirements: [req({ title: "t", description: "d", source_ids: [], primary_source_id: "F2", source_quote: "" })] }).some((e) => /source_ids: needs at least 1/.test(e)));
  const problems = validateAnalysisOutput({
    proposals: [{ sequence: 1, proposed_title: "t", proposed_description: "d", rationale: "r", source_fragment_ids: [], primary_source_fragment_id: null, evidence_basis: "Explicit", confidence: "High" }],
    issues: [], scope_notes: [{ sequence: 1, description: "No change required.", source_fragment_ids: [] }],
  }, new Set());
  assert.ok(problems.some((p) => /no source fragments \(provenance required\)/.test(p)));
  assert.ok(problems.some((p) => /scope note 1: no source fragments/.test(p)));
});

await run("Explicit must quote the source verbatim; otherwise it is recorded as Inferred (→ Needs Review)", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES),
    requirements: () => ({ requirements: [
      req({ title: "Quoted", description: "Quoted picker rule", applies_to: "a", source_ids: ["F2"], primary_source_id: "F2", source_quote: "the picker name must remain against the pick task" }),
      req({ title: "Paraphrased", description: "Paraphrased rework rule", applies_to: "b", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The original picker must be preserved through rework" }),
    ] }),
  });
  const result = await runAnalysis({ run: { id: "run-e", model: "fake" }, fragments: tracker, llm });
  assert.deepEqual(result.proposals.map((p) => [p.proposed_title, p.evidence_basis]), [["Quoted", "Explicit"], ["Paraphrased", "Inferred"]]);
});

// ── Statement types ─────────────────────────────────────────────────────────

await run("deterministic statement types: no-change vs negative constraint vs plan", () => {
  for (const t of ["No change required.", "No change required — already filtered on warehouse.", "MONO picks and FULL PALLET picks remain as they are.", "Dashboard lite will keep as it is with no changes until settled."]) assert.ok(isNoChangeStatement(t), t);
  for (const t of ["No colour filter required.", "Temperature must not form part of the job input.", "The picker name must remain against the pick task."]) assert.ok(!isNoChangeStatement(t), t);
  for (const t of ["UI complete for all screens by 18th Sept.", "Test in QA w/c 21st Sept", "All services complete.", "Move to F28 w/c 28th Sept"]) assert.ok(isPlanStatement(t), t);
  for (const t of ["Add a site filter, fixed to the value in the user table.", "No colour filter required.", "Site shall default from the user table."]) assert.ok(!isPlanStatement(t), t);
});

let specResult, specLlm;
const SPEC_REQS = () => ({ requirements: [
  req({ title: "Add colour to item table", description: "Add colour to the item table.", applies_to: "item table colour", category: "Database", source_ids: ["F1"], primary_source_id: "F1", source_quote: "Add colour to the item table." }),
  req({ title: "Colour default and changeable", description: "Colour shall default from the item table in all screens and shall be changeable by the user.", applies_to: "item table colour", source_ids: ["F1"], primary_source_id: "F1", source_quote: "Colour shall default from the item table in all screens and shall be changeable by the user." }),
  req({ title: "Site filter on Picking Screen", description: "Add a site filter, fixed to the value in the user table.", applies_to: "Picking Screen site filter", source_ids: ["F2"], primary_source_id: "F2", source_quote: "Add a site filter, fixed to the value in the user table." }),
  req({ title: "Sort pick list", description: "Sort the pick list by colour: red first, then blue.", applies_to: "pick list", source_ids: ["F2"], primary_source_id: "F2", source_quote: "Sort the pick list by colour: red first, then blue." }),
  req({ title: "Site filter on Packing Screen", description: "Add a site filter, fixed to the value in the user table.", applies_to: "Packing Screen site filter", source_ids: ["F3"], primary_source_id: "F3", source_quote: "Add a site filter, fixed to the value in the user table." }),
  req({ title: "Sort stations", description: "Sort the stations by colour: red first, followed by blue.", applies_to: "stations", source_ids: ["F3"], primary_source_id: "F3", source_quote: "Sort the stations by colour: red first, followed by blue." }),
  // The model mislabels the no-change as behaviour, and the negative constraint as no_change.
  req({ title: "Returns unchanged", description: "No change required.", applies_to: "Returns Screen", statement_type: "behaviour", source_ids: ["F4"], primary_source_id: "F4", source_quote: "No change required." }),
  req({ title: "Dispatch site default", description: "Site shall default from the user table; changeable only where the Support flag is set.", applies_to: "Dispatch Screen site field", category: "UI", source_ids: ["F5"], primary_source_id: "F5", source_quote: "Site shall default from the user table; changeable only where the Support flag is set." }),
] });

await run("structured spec: consolidation is lossless, identical rules merge across screens, different objects never merge", async () => {
  specLlm = fakeLlm({
    classification: classifyAll({ F6: "template_admin" }),
    requirements: SPEC_REQS,
    // The model forgets the negative constraint; the coverage pass must catch it.
    coverage: (m) => {
      const text = userOf(m).split("UNCAPTURED STATEMENTS")[1];
      assert.ok(!/18th Sept|w\/c 21st/.test(text), "plan statements are not sent to the coverage pass");
      return /No colour filter required/.test(text)
        ? { requirements: [req({ title: "No colour filter on Dispatch", description: "No colour filter required on the Dispatch Screen.", applies_to: "Dispatch Screen colour filter", statement_type: "no_change", category: "Unknown", source_ids: ["F5"], primary_source_id: "F5", source_quote: "No colour filter required." })] }
        : { requirements: [] };
    },
    consolidation_requirements: () => ({ groups: [
      { kind: "parts", members: ["R1", "R2"], reason: "field and its default rule", title: "Colour in the item table: default and changeable" },
      { kind: "duplicate", members: ["R4", "R6"], reason: "both sort by colour", title: "Sort by colour" },
      { kind: "parts", members: ["R3", "R4"], reason: "Picking screen", title: "Picking screen" },
    ] }),
  });
  specResult = await runAnalysis({ run: { id: "run-s", model: "fake" }, fragments: spec, llm: specLlm });
  const byTitle = (t) => specResult.proposals.find((p) => p.proposed_title === t);

  // Lossless: every distinct clause of every member survives in the proposed requirement itself.
  const colour = byTitle("Colour in the item table: default and changeable");
  assert.ok(colour, "coherent sub-obligations (field + rule) consolidate");
  assert.match(colour.proposed_description, /Add colour to the item table\./);
  assert.match(colour.proposed_description, /default from the item table in all screens/);
  assert.match(colour.proposed_description, /changeable by the user/);
  assert.equal(colour.consolidation.kind, "parts");
  assert.equal(colour.consolidation.members.length, 2, "member candidates persisted");
  assert.equal(colour.proposed_category, "Business Rule", "a group containing a defaulting rule is a Business Rule, not Database");

  // Identical wording on two screens = one shared rule, deterministically, with every source and context.
  const filter = specResult.proposals.find((p) => /site filter/.test(p.proposed_description));
  assert.deepEqual(filter.source_fragment_ids, [idOf(2), idOf(3)]);
  assert.match(filter.proposed_description, /^Add a site filter, fixed to the value in the user table\.\n\nApplies to: Picking Screen; Packing Screen\.$/);
  assert.equal(filter.consolidation.kind, "duplicate");

  // Different objects (pick list vs stations) stay separate even though the model called them duplicates.
  assert.ok(byTitle("Sort pick list") && byTitle("Sort stations"), "moves/stations-style objects are not merged");
  assert.ok(specResult.diagnostics.consolidation_overrides.some((o) => o.group_kind === "duplicate" && o.proposed.join() === "R4,R6"));
  // An identical-wording member cannot be pulled into a one-screen "parts" group.
  assert.ok(!specResult.proposals.some((p) => p.consolidation.kind === "parts" && p.source_fragment_ids.includes(idOf(3)) && /pick list/.test(p.proposed_description)));
});

await run("\"No change required\" becomes a scope/regression note (whatever the model called it); a negative constraint stays a requirement", () => {
  assert.deepEqual(specResult.scope_notes.map((n) => [n.note_type, n.area, n.description, n.source_fragment_ids]), [["No Change", "Returns Screen", "No change required.", [idOf(4)]]]);
  assert.ok(!specResult.proposals.some((p) => /^No change required/.test(p.proposed_description)), "a no-change never inflates the requirement count");
  const negative = specResult.proposals.find((p) => /No colour filter/.test(p.proposed_description));
  assert.ok(negative, "the explicit negative constraint is captured (by the coverage pass) as a requirement");
  assert.deepEqual(negative.source_fragment_ids, [idOf(5)]);
  assert.equal(negative.consolidation.members[0].statement_type, "constraint", "mislabelled no_change corrected to constraint");
  assert.ok(!specResult.proposals.some((p) => /18th Sept|w\/c/.test(p.proposed_description)), "plans and dates are not requirements");
  assert.equal(specResult.diagnostics.coverage_candidates, 1);
});

await run("categories reflect the obligation: rule wording (default / only where / flag) is a Business Rule, not UI", () => {
  const dispatch = specResult.proposals.find((p) => /changeable only where the Support flag/.test(p.proposed_description));
  assert.equal(dispatch.proposed_category, "Business Rule");
  const prompt = requirementsPrompt({ sourceText: "{s}", contextText: "" });
  assert.match(prompt, /classify by the NATURE of the obligation, not by where it will be seen/);
  assert.match(prompt, /"Business Rule": defaulting rules, role- or flag-driven behaviour/);
  assert.match(prompt, /"Database": adding or changing a table, column, field or flag/);
  assert.match(prompt, /"Backend": scheduled jobs/);
  assert.match(prompt, /"no_change": .* scope\/regression information, not a new requirement/);
  assert.match(prompt, /"constraint": an explicit NEGATIVE or limiting requirement/);
});

await run("a data-model definition may join the rule that uses it; clauses about different objects are split", async () => {
  const llm = fakeLlm({
    classification: classifyAll({ F6: "template_admin" }),
    requirements: () => ({ requirements: [
      req({ title: "Support flag", description: "Add a Support flag to the user table.", applies_to: "Support flag", category: "Database", source_ids: ["F1"], primary_source_id: "F1", source_quote: "Add colour to the item table." }),
      req({ title: "Dispatch site default", description: "Site shall default from the user table; changeable only where the Support flag is set.", applies_to: "Dispatch Screen site field", source_ids: ["F5"], primary_source_id: "F5", source_quote: "Site shall default from the user table; changeable only where the Support flag is set." }),
      req({ title: "Sort pick list", description: "Sort the pick list by colour: red first, then blue.", applies_to: "pick list", source_ids: ["F2"], primary_source_id: "F2", source_quote: "Sort the pick list by colour: red first, then blue." }),
    ] }),
    consolidation_requirements: () => ({ groups: [{ kind: "parts", members: ["R1", "R2", "R3"], reason: "all about users", title: "Everything" }] }),
  });
  const result = await runAnalysis({ run: { id: "run-d", model: "fake" }, fragments: spec, llm });
  assert.equal(result.proposals.length, 3, "rules on different objects split; the definition then stands alone");
  const ok = fakeLlm({
    classification: classifyAll({ F6: "template_admin" }),
    requirements: () => ({ requirements: [
      req({ title: "Support flag", description: "Add a Support flag to the user table.", applies_to: "Support flag", category: "Database", source_ids: ["F1"], primary_source_id: "F1", source_quote: "Add colour to the item table." }),
      req({ title: "Dispatch site default", description: "Site shall default from the user table; changeable only where the Support flag is set.", applies_to: "Dispatch Screen site field", source_ids: ["F5"], primary_source_id: "F5", source_quote: "Site shall default from the user table; changeable only where the Support flag is set." }),
    ] }),
    consolidation_requirements: () => ({ groups: [{ kind: "parts", members: ["R1", "R2"], reason: "flag and the rule it drives", title: "Support flag and Dispatch site rule" }] }),
  });
  const merged = await runAnalysis({ run: { id: "run-d2", model: "fake" }, fragments: spec, llm: ok });
  assert.equal(merged.proposals.length, 1);
  assert.match(merged.proposals[0].proposed_description, /^- Add a Support flag to the user table\.\n- Site shall default/);
  assert.equal(merged.proposals[0].proposed_category, "Business Rule", "a group containing a rule is a Business Rule");
});

// ── Issue quality gate ───────────────────────────────────────────────────────

await run("issue gate helpers: generic, speculative and vague questions are recognised; citations are stripped", () => {
  for (const q of ["What happens in edge cases?", "What happens if an error occurs during palletisation?", "What if the user enters invalid data?", "What happens when the temperature field is changed?", "What if temperature is inadvertently used as job input?"]) assert.ok(isGenericIssue({ suggested_question: q, description: "" }), q);
  assert.ok(!isGenericIssue({ suggested_question: "What happens to the picker name if the palletised pick task is reworked?", description: "" }));
  assert.ok(!isSpecificQuestion("Is the header visible in specific views of the Housekeeping app?", "Housekeeping header"));
  assert.ok(!isSpecificQuestion("What is the exact behavior when the Support flag is set?", "Support flag"));
  assert.ok(isSpecificQuestion("Which colour values are supported, and in what order must they sort?", "Sort the pick list by colour"));
  assert.equal(cleanQuestion("Which extracts are in scope? [F3, F8]"), "Which extracts are in scope?");
  assert.equal(cleanQuestion("Which users are affected? (Dispatch Screen, filter)?"), "Which users are affected?");
});

let gated;
await run("generic, untriggered, vague and non-requirement issues are suppressed; material ones survive with impact and trigger", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements,
    ambiguities: () => ({ issues: [
      issue({ description: "Rework is not described.", suggested_question: "What happens to the picker name if the palletised pick task is reworked? [F2]", trigger_quote: "must remain against the pick task after palletisation", source_ids: ["F2"], related_requirements: ["R1"], impact: ["implementation", "test_design"] }),
      issue({ description: "Errors.", suggested_question: "What happens if an error occurs while palletising the pick task?", trigger_quote: "after palletisation", source_ids: ["F2"] }),
      issue({ description: "Invented trigger.", suggested_question: "Should the palletiser be able to override the picker name on the pick task?", trigger_quote: "palletisers may override names", source_ids: ["F2"] }),
      issue({ description: "Vague.", suggested_question: "Is the picker name shown in specific views of the pick task screen?", trigger_quote: "The picker name must remain", source_ids: ["F2"] }),
      issue({ issue_type: "Contradiction", description: "Conflict in one sentence.", suggested_question: "Does the picker name remain against the pick task after palletisation or not?", trigger_quote: "The picker name must remain", source_ids: ["F2"] }),
      issue({ description: "About benefit text.", suggested_question: "What level of traceability does the business need from the pick task data?", trigger_quote: "It gives the business traceability", source_ids: ["F3"] }),
    ] }),
  });
  gated = await runAnalysis({ run: { id: "run-g", model: "fake" }, fragments: tracker, llm });
  const questions = gated.issues.filter((i) => i.issue_type !== "Contradiction" || i.trigger_quote?.startsWith("Priority")).map((i) => i.suggested_question);
  assert.ok(questions.includes("What happens to the picker name if the palletised pick task is reworked?"), "the material, source-triggered question survives (citation stripped)");
  const kept = gated.issues.find((i) => /reworked/.test(i.suggested_question));
  assert.deepEqual([kept.impact, kept.trigger_quote, kept.related_proposal_sequences], [["implementation", "test_design"], "must remain against the pick task after palletisation", [1]]);
  const reasons = gated.diagnostics.suppressed_issues.map((s) => s.reason);
  assert.deepEqual(reasons.sort(), ["contradiction without two conflicting statements", "generic / speculative question", "no verbatim source trigger", "not about requirement content", "question not specific to the source"].sort());
  assert.equal(gated.issues.filter((i) => i.issue_type === "Contradiction").length, 1, "only the deterministic priority contradiction");
});

await run("source-answer check: a question answered elsewhere in the extraction is suppressed — only on a verifiable quote, never by its own trigger", async () => {
  const doc = [
    f(1, "The export shall include the picker name for every pick task.", ["Spec", "Exports"]),
    f(2, "Mobile apps keep one site per user, regardless of the Support flag.", ["Spec", "Mobile"]),
    f(3, "Dashboards show the site selector for Support users. Any reporting extracts must be correct.", ["Spec", "Dashboards"]),
  ];
  const llm = fakeLlm({
    classification: classifyAll({}),
    requirements: () => ({ requirements: [req({ title: "Selector", description: "Dashboards show the site selector for Support users.", applies_to: "dashboard site selector", source_ids: ["F3"], primary_source_id: "F3", source_quote: "Dashboards show the site selector for Support users." })] }),
    ambiguities: () => ({ issues: [
      issue({ description: "Mobile behaviour for Support users is unclear.", suggested_question: "Can Support users choose a different site in the mobile apps?", trigger_quote: "site selector for Support users", source_ids: ["F3"] }),
      issue({ description: "Which extracts is unclear.", suggested_question: "Which reporting extracts must show the correct picker name?", trigger_quote: "Any reporting extracts must be correct", source_ids: ["F3"] }),
      issue({ description: "Hallucinated answer.", suggested_question: "Which dashboards show the site selector for Support users?", trigger_quote: "Dashboards show the site selector", source_ids: ["F3"] }),
    ] }),
    source_check: () => ({ checks: [
      { key: "I1", answered: true, answer_id: "F2", answer_quote: "Mobile apps keep one site per user, regardless of the Support flag." },
      { key: "I2", answered: true, answer_id: "F3", answer_quote: "Any reporting extracts must be correct." },
      { key: "I3", answered: true, answer_id: "F1", answer_quote: "All dashboards show it." },
    ] }),
  });
  const result = await runAnalysis({ run: { id: "run-a", model: "fake" }, fragments: doc, llm });
  const questions = result.issues.map((i) => i.suggested_question);
  assert.ok(!questions.includes("Can Support users choose a different site in the mobile apps?"), "answered by F2 → suppressed");
  assert.ok(questions.includes("Which reporting extracts must show the correct picker name?"), "its own trigger sentence is not an answer");
  assert.ok(questions.includes("Which dashboards show the site selector for Support users?"), "a non-verbatim 'answer' does not suppress");
  const s = result.diagnostics.suppressed_issues.find((x) => x.reason === "answered by the source");
  assert.deepEqual([s.answered_by, s.answer_quote], [idOf(2), "Mobile apps keep one site per user, regardless of the Support flag."]);
});

await run("duplicate issues consolidate across the run with every source, impact and proposal reference; unrelated merges are split", async () => {
  const llm = fakeLlm({
    classification: classifyAll({ F6: "template_admin" }), requirements: SPEC_REQS,
    ambiguities: (m) => {
      const src = sourceOf(m);
      const out = [];
      if (src.includes("[F2]")) out.push(issue({ description: "Existing items have no colour.", suggested_question: "Must existing items in the item table be given a colour value when the change goes live?", trigger_quote: "Sort the pick list by colour", source_ids: ["F2"], related_requirements: ["R4"], impact: ["data_migration"] }));
      if (src.includes("[F3]")) out.push(issue({ description: "Existing items have no colour value.", suggested_question: "Must existing items in the item table be given a colour value before go-live?", trigger_quote: "Sort the stations by colour", source_ids: ["F3"], related_requirements: ["R6"], impact: ["data_migration", "test_design"] }));
      if (src.includes("[F5]")) out.push(issue({ description: "Support flag holders unclear.", suggested_question: "Which users will have the Support flag set on the Dispatch Screen?", trigger_quote: "changeable only where the Support flag is set", source_ids: ["F5"], impact: ["scope"] }));
      return { issues: out };
    },
    consolidation_issues: () => ({ groups: [
      { kind: "duplicate", members: ["I1", "I2"], reason: "same migration decision", title: "Must existing items in the item table be given a colour value, and when?" },
    ] }),
  });
  const result = await runAnalysis({ run: { id: "run-i", model: "fake" }, fragments: spec, llm });
  const migration = result.issues.filter((i) => /existing items/i.test(i.suggested_question));
  assert.equal(migration.length, 1, "one merged migration question");
  const m = migration[0];
  assert.deepEqual(m.source_fragment_ids, [idOf(2), idOf(3)], "all sources kept");
  assert.deepEqual(m.impact.sort(), ["data_migration", "test_design"], "all impacts kept");
  assert.equal(m.related_proposal_sequences.length, 2, "links to both affected proposals kept");
  assert.equal(m.consolidation.members.length, 2);
  assert.ok(result.issues.some((i) => /Support flag set/.test(i.suggested_question)), "the unrelated question is untouched");
  assert.equal(m.suggested_question, "Must existing items in the item table be given a colour value, and when?", "a genuinely merged question is used");

  // Identical questions merge without the model; an unrelated model merge is split.
  const llm2 = fakeLlm({
    classification: classifyAll({ F6: "template_admin" }), requirements: SPEC_REQS,
    ambiguities: (mm) => ({ issues: [
      ...(sourceOf(mm).includes("[F2]") ? [issue({ description: "a", suggested_question: "Which colour values exist and how must they sort in the lists?", trigger_quote: "Sort the pick list by colour", source_ids: ["F2"], impact: ["test_design"] })] : []),
      ...(sourceOf(mm).includes("[F3]") ? [issue({ description: "b", suggested_question: "Which colour values exist and how must they sort in the lists?", trigger_quote: "Sort the stations by colour", source_ids: ["F3"], impact: ["test_design"] })] : []),
      ...(sourceOf(mm).includes("[F5]") ? [issue({ description: "c", suggested_question: "Which users will have the Support flag set on the Dispatch Screen?", trigger_quote: "changeable only where the Support flag is set", source_ids: ["F5"], impact: ["scope"] })] : []),
    ] }),
    consolidation_issues: () => ({ groups: [{ kind: "duplicate", members: ["I1", "I3"], reason: "both about setup", title: "Setup?" }] }),
  });
  const r2 = await runAnalysis({ run: { id: "run-i2", model: "fake" }, fragments: spec, llm: llm2 });
  assert.equal(r2.issues.filter((i) => /colour values exist/.test(i.suggested_question)).length, 1, "identical questions merged deterministically");

  // A merged "question" that is only one member's wording would drop the other: keep both.
  const llm3 = fakeLlm({
    classification: classifyAll({ F6: "template_admin" }), requirements: SPEC_REQS,
    ambiguities: (mm) => ({ issues: [
      ...(sourceOf(mm).includes("[F2]") ? [issue({ description: "a", suggested_question: "Must existing items be given a colour value when the pick list change goes live?", trigger_quote: "Sort the pick list by colour", source_ids: ["F2"], impact: ["data_migration"] })] : []),
      ...(sourceOf(mm).includes("[F3]") ? [issue({ description: "b", suggested_question: "Must existing items be given a colour value before the stations change goes live?", trigger_quote: "Sort the stations by colour", source_ids: ["F3"], impact: ["data_migration"] })] : []),
    ] }),
    consolidation_issues: () => ({ groups: [{ kind: "duplicate", members: ["I1", "I2"], reason: "same", title: "Must existing items be given a colour value when the pick list change goes live?" }] }),
  });
  const r3 = await runAnalysis({ run: { id: "run-i3", model: "fake" }, fragments: spec, llm: llm3 });
  const q3 = r3.issues.find((i) => /existing items/.test(i.suggested_question)).suggested_question;
  assert.ok(/pick list change/.test(q3) && /stations change/.test(q3), "both member questions survive in the merged question");
  assert.ok(r2.issues.some((i) => /Support flag set/.test(i.suggested_question)), "unrelated merge refused");
});

await run("conflicting priority fields: no priority is proposed and a Contradiction issue is raised", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES),
    requirements: () => ({ requirements: [req({ title: "Keep", description: "d", source_ids: ["F2", "F6"], primary_source_id: "F2", source_quote: "The picker name must remain", priority: "High" })] }),
  });
  const result = await runAnalysis({ run: { id: "run-p", model: "fake" }, fragments: tracker, llm });
  assert.equal(result.proposals[0].proposed_priority, null);
  const c = result.issues.find((i) => i.issue_type === "Contradiction");
  assert.deepEqual(c.source_fragment_ids, [idOf(1), idOf(6)]);
});

await run("stage results are reused on retry (same input) — earlier stages are not regenerated", async () => {
  const stages = [];
  const first = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements });
  await runAnalysis({ run: { id: "run-1", model: "fake" }, fragments: tracker, llm: first, onStage: async (s) => { stages.push({ ...s, run_id: "run-1" }); } });
  const second = fakeLlm({ classification: () => { throw new Error("must not be called"); }, requirements: () => { throw new Error("must not be called"); } });
  const recorded = [];
  await runAnalysis({ run: { id: "run-2", model: "fake" }, fragments: tracker, llm: second, reusable: stages.filter((s) => s.stage !== "ambiguities"), onStage: async (s) => { recorded.push(s); } });
  assert.ok(!second.calls.some((c) => ["classification", "requirements"].includes(c.stage)));
  assert.ok(recorded.filter((s) => s.reused_from === "run-1").length >= 2);
});

await run("the model only ever sees this run's fragments, and every call carries the no-invention rule", async () => {
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements });
  await runAnalysis({ run: { id: "run-v", model: "fake" }, fragments: tracker, llm });
  const labels = new Set(llm.calls.flatMap((c) => c.messages.flatMap((m) => [...m.content.matchAll(/\[(F\d+)\]/g)].map((x) => x[1]))));
  assert.ok([...labels].every((l) => ["F1", "F2", "F3", "F4", "F5", "F6"].includes(l)));
  assert.ok(llm.calls.every((c) => c.messages[0].content.includes("NO INVENTION")));
});

// ── Worker wiring ───────────────────────────────────────────────────────────

await run("Ollama must be loopback: a remote URL is refused by the client and by the worker config", () => {
  assert.throws(() => createOllama({ ollamaUrl: "https://api.example.com" }), /must point at this Mac/);
  assert.throws(() => validateConfig({ apiBaseUrl: "https://app.example", workerToken: `tmw_${"a".repeat(43)}`, ollamaUrl: "http://10.0.0.5:11434" }), /must point at this Mac/);
  const ok = validateConfig({ apiBaseUrl: "https://app.example", workerToken: `tmw_${"a".repeat(43)}` });
  assert.deepEqual([ok.analysisEnabled, ok.ollamaUrl], [true, "http://127.0.0.1:11434"]);
});

function fakeOllama({ reachable = true, models = [{ name: "qwen3:8b", digest: "500a1f067a9fabc" }], llm } = {}) {
  return {
    status: async () => ({ reachable, version: "0.34.2", models }),
    show: async () => ({ capabilities: ["completion", "thinking"], contextLength: 40960 }),
    chat: async (args) => { assert.equal(args.think, false); assert.equal(args.model, "qwen3:8b"); return llm.chat(args); },
  };
}
const claimOf = () => ({ run: { id: "r1", model: "qwen3:8b", attempt_count: 1 }, fragments: tracker, reusable_stages: [] });

await run("worker: a missing model or unreachable Ollama fails the run with a clear category (nothing analysed)", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  assert.equal((await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ models: [{ name: "qwen3:4b" }] }) })).category, "model_unavailable");
  assert.equal((await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ reachable: false }) })).category, "ollama_unreachable");
  assert.deepEqual(calls.map((c) => c.route), ["analysis/fail", "analysis/fail"]);
});

await run("worker: stages are posted as they complete, then proposals, issues and scope notes with the model digest", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements });
  const summary = await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ llm }) });
  assert.equal(summary.status, "Completed");
  assert.ok(calls.slice(0, -1).every((c) => c.route === "analysis/stage" && c.body.run_id === "r1"));
  const done = calls.at(-1);
  assert.equal(done.route, "analysis/complete");
  assert.equal(done.body.model_digest, "500a1f067a9f (ollama 0.34.2)");
  assert.deepEqual([done.body.proposals.length, done.body.scope_notes.length], [1, 1]);
  assert.ok(!JSON.stringify(done.body).includes("tmw_"));
});

await run("worker: an invalid-output failure is reported with its category and without document text", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  const summary = await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ llm: fakeLlm({ classification: () => "garbage" }) }) });
  assert.equal(summary.category, "invalid_model_output");
  assert.ok(!JSON.stringify(calls.at(-1).body).includes("picker name"));
});

await run("worker: a server without the analysis routes (404) is tolerated quietly — extraction keeps working", async () => {
  const logs = [];
  const state = {};
  const api = async () => { const e = new Error("analysis/claim failed (404)"); e.status = 404; throw e; };
  assert.equal(await runAnalysisOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(await runAnalysisOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(logs.length, 1);
  const boom = async () => { const e = new Error("500"); e.status = 500; throw e; };
  await assert.rejects(runAnalysisOnce({ api: boom, ollama: fakeOllama({}), state }), /500/);
});

console.log("\nAll analysis pipeline tests passed.\n");
