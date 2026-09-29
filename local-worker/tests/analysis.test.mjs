// Phase 1C analysis pipeline tests — real chunking, prompts, schema checks,
// provenance validation and consolidation; a scripted fake model instead of
// Ollama (no network). Proves: structured output is validated before it is
// accepted, malformed output is retried then refused, fabricated fragment
// IDs never reach a proposal, Explicit claims must quote the source,
// metadata/template text does not become requirements, duplicates across
// sections are consolidated with every source reference, stage results are
// reused on retry, and the worker only ever talks to a loopback Ollama.
import assert from "node:assert/strict";
import { buildChunks, fragmentBody, groupSections } from "../analysis/chunk.js";
import { createOllama } from "../analysis/ollama.js";
import { AnalysisError, MAX_ATTEMPTS, SAME_SECTION_MERGE_SIMILARITY, runAnalysis, similarity, validateAnalysisOutput } from "../analysis/pipeline.js";
import { ANALYSIS_SCHEMA_VERSION, PROMPT_VERSION, promptFingerprint } from "../analysis/prompts.js";
import { STAGE_SCHEMAS, validateSchema } from "../analysis/schemas.js";
import { ANALYSIS_IDENTITY, processAnalysisRun, runAnalysisOnce, validateConfig } from "../worker.js";

async function run(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

// Released prompt versions and the fingerprint of their exact text. Changing
// any prompt wording without bumping PROMPT_VERSION fails this suite.
const PROMPT_FINGERPRINTS = {
  "1.0.0": "c551b499ced90cb52f8b65594c7a691e6e1f2128c725e5427a4df90b7eece615",
};

const f = (sequence, text, section = ["Change Request", "Detailed Requirements"], extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, sequence, fragment_type: "text",
  section_heading: section.at(-1) ?? null, section_number: null, section_path: section, page_start: 1, page_end: 1, text, metadata: {}, ...extra,
});
const idOf = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// A tracker-style export: metadata, a requirement repeated on two pages, a benefit, a template leftover.
const tracker = [
  f(1, "Status: Open\nPriority: Medium\nReporter: A Person", ["CR-1 Title"]),
  f(2, "The picker name must remain against the pick task after palletisation. MONO picks remain as they are.", ["CR-1 Title", "Detailed Requirements"]),
  f(3, "It gives the business traceability.", ["CR-1 Title", "Benefit"]),
  f(4, "Highlight the decision with red", ["CR-1 Title", "Decision"]),
  f(5, "We require the picker name to remain against the pick task, even after the pick task has been palletised.", ["CR-1 Title", "Description", "Change Description"], { page_start: 2, page_end: 2 }),
  f(6, "Priority: High", ["CR-1 Title", "Description"], { page_start: 2, page_end: 2 }),
];

const stageOf = (messages) => {
  const user = messages.find((m) => m.role === "user").content;
  if (user.startsWith("TASK: classify")) return "classification";
  if (user.startsWith("TASK: identify")) return "requirements";
  if (user.startsWith("TASK: find what")) return "ambiguities";
  return "consolidation";
};
const sourceOf = (messages) => messages.find((m) => m.role === "user").content.split("SOURCE:\n").at(-1);

/** Fake model: per-stage handlers get (messages, attempt) and return an object or raw string. */
function fakeLlm(handlers) {
  const calls = [];
  const attempts = {};
  return {
    calls,
    async chat({ messages, schema }) {
      const stage = stageOf(messages);
      const key = `${stage}:${messages[1].content.length}`;
      attempts[key] = (attempts[key] ?? 0) + 1;
      calls.push({ stage, messages: messages.map((m) => ({ ...m })), schema, attempt: attempts[key] });
      const out = handlers[stage](messages, attempts[key]);
      return { content: typeof out === "string" ? out : JSON.stringify(out), durationMs: 5 };
    },
  };
}

const classifyAll = (map) => (messages) => ({
  fragments: [...sourceOf(messages).matchAll(/\[(F\d+)\]/g)].map((m) => ({ id: m[1], classification: map[m[1]] ?? "requirement", reason: "test" })),
});
const TRACKER_CLASSES = { F1: "metadata", F2: "requirement", F3: "benefit", F4: "template_admin", F5: "requirement", F6: "metadata" };
const req = (o) => ({ category: "UI", priority: "Not stated", confidence: "High", rationale: "Stated directly.", evidence_basis: "Explicit", ...o });
const trackerRequirements = () => ({
  requirements: [
    req({ title: "Keep picker name after palletisation", description: "The picker name must remain against the pick task after palletisation.", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The picker name must remain against the pick task after palletisation." }),
    req({ title: "MONO picks unchanged", description: "MONO picks remain as they are.", source_ids: ["F2"], primary_source_id: "F2", source_quote: "MONO picks remain as they are." }),
    req({ title: "Picker name stays after palletising", description: "We require the picker name to remain against the pick task, even after the pick task has been palletised.", source_ids: ["F5"], primary_source_id: "F5", source_quote: "We require the picker name to remain against the pick task" }),
  ],
});
const noIssues = () => ({ issues: [] });

await run("prompts are versioned: the fingerprint of the released text is pinned", () => {
  assert.equal(PROMPT_VERSION, "1.0.0");
  assert.equal(ANALYSIS_SCHEMA_VERSION, "1.0.0");
  assert.equal(promptFingerprint(), PROMPT_FINGERPRINTS[PROMPT_VERSION], "prompt text changed — bump PROMPT_VERSION and pin the new fingerprint");
  assert.deepEqual(ANALYSIS_IDENTITY, { prompt_version: PROMPT_VERSION, prompt_sha256: promptFingerprint(), analysis_schema_version: ANALYSIS_SCHEMA_VERSION });
});

await run("section-aware chunking: consecutive fragments of one section stay together, keys are deterministic, tables stay structured", () => {
  const sections = groupSections(tracker);
  assert.deepEqual(sections.map((s) => s.fragments.map((x) => x.sequence)), [[1], [2], [3], [4], [5], [6]]);
  const table = f(7, "a b", ["T"], { fragment_type: "table", metadata: { table: { header: ["Field", "Rule"], rows: [["Plant", "defaults"], ["Temp", "changeable"]] } } });
  assert.equal(fragmentBody(table), "| Field | Rule |\n| Plant | defaults |\n| Temp | changeable |");
  const one = buildChunks(tracker);
  assert.equal(one.length, 1);
  assert.equal(one[0].key, "c01");
  assert.match(one[0].text, /### Section: CR-1 Title › Detailed Requirements \[page 1\]\n\[F2\]\n/);
  assert.deepEqual(buildChunks(tracker), one, "deterministic");
  const small = buildChunks(tracker, 150);
  assert.ok(small.length > 1);
  assert.deepEqual(small.map((c) => c.key), small.map((_, i) => `c${String(i + 1).padStart(2, "0")}`));
  assert.deepEqual(small.flatMap((c) => c.fragmentIds), tracker.map((x) => x.id), "every fragment exactly once, in order");
});

await run("an oversized section is split deterministically while keeping its section identity and fragment ID", () => {
  const big = f(1, Array.from({ length: 40 }, (_, i) => `Rule ${i}: the system shall do thing number ${i} exactly.`).join("\n"), ["Spec", "Rules"]);
  const chunks = buildChunks([big], 600);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.match(c.text, /^### Section: Spec › Rules/);
    assert.match(c.text, /\[F1\] \(part \d+\/\d+\)/);
    assert.deepEqual(c.aliases, ["F1"]);
  }
});

let happy;
await run("valid structured output is persisted per stage and mapped to real fragment IDs", async () => {
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues, consolidation: () => ({ duplicates: [{ members: ["R1", "R3"], reason: "same rule", title: "Keep the picker name after palletisation" }] }) });
  const stages = [];
  happy = await runAnalysis({ run: { id: "run-1", model: "fake" }, fragments: tracker, llm, onStage: async (s) => { stages.push(s); } });
  assert.deepEqual(stages.map((s) => s.stage), ["classification", "requirements", "ambiguities", "consolidation", "consolidation"].slice(0, stages.length));
  assert.ok(stages.every((s) => /^[0-9a-f]{64}$/.test(s.input_hash) && s.attempts === 1));
  assert.ok(happy.proposals.every((p) => p.source_fragment_ids.every((id) => tracker.some((x) => x.id === id))));
  assert.deepEqual(validateAnalysisOutput(happy, new Set(tracker.map((x) => x.id))), []);
  assert.ok(happy.proposals.every((p) => !("review_status" in p) && !("requirement_ref" in p)), "the analysis never sets review status or references");
});

await run("metadata, benefit and template text are never sent as requirement SOURCE and never become proposals", async () => {
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }) });
  await runAnalysis({ run: { id: "run-m", model: "fake" }, fragments: tracker, llm });
  const reqCall = llm.calls.find((c) => c.stage === "requirements");
  const source = sourceOf(reqCall.messages);
  assert.ok(!source.includes("[F1]") && !source.includes("[F3]") && !source.includes("[F4]") && !source.includes("[F6]"));
  assert.match(reqCall.messages[1].content, /CONTEXT \(not requirements; may inform priority or meaning\):\n[\s\S]*\[F1\]/, "metadata is context only");

  // A model that tries to make a requirement out of a metadata fragment is refused.
  const sneaky = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), ambiguities: noIssues, consolidation: () => ({ duplicates: [] }),
    requirements: () => ({ requirements: [req({ title: "Status is Open", description: "Status: Open", source_ids: ["F1"], primary_source_id: "F1", source_quote: "Status: Open" })] }),
  });
  const result = await runAnalysis({ run: { id: "run-s", model: "fake" }, fragments: tracker, llm: sneaky });
  assert.equal(result.proposals.length, 0);
  assert.equal(sneaky.calls.filter((c) => c.stage === "requirements").length, MAX_ATTEMPTS, "retried with the error fed back");
  assert.match(sneaky.calls.filter((c) => c.stage === "requirements").at(-1).messages.at(-1).content, /primary_source_id F1 must be a SOURCE fragment/);
  assert.ok(result.diagnostics.warnings.some((w) => /invalid item reference/.test(w)));
  const admin = result.issues.find((i) => i.issue_type === "Out of Scope / Administrative Content");
  assert.deepEqual(admin.source_fragment_ids, [idOf(4)], "template content is reported, not turned into a requirement");
});

await run("malformed output is retried with the validation error; accepted once valid", async () => {
  let n = 0;
  const llm = fakeLlm({
    classification: (m, attempt) => (attempt === 1 ? "Sure! Here is the JSON: {" : attempt === 2 ? { fragments: [{ id: "F2", classification: "requirement" }] } : classifyAll(TRACKER_CLASSES)(m)),
    requirements: () => { n++; return { requirements: [] }; }, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }),
  });
  const stages = [];
  await runAnalysis({ run: { id: "run-r", model: "fake" }, fragments: tracker, llm, onStage: async (s) => { stages.push(s); } });
  const cls = llm.calls.filter((c) => c.stage === "classification");
  assert.equal(cls.length, 3);
  assert.match(cls[1].messages.at(-1).content, /not valid JSON/);
  assert.match(cls[2].messages.at(-1).content, /reason: missing/);
  assert.equal(stages.find((s) => s.stage === "classification").attempts, 3);
  assert.ok(n >= 1);
});

await run("output that never becomes valid fails the stage cleanly — nothing malformed is persisted", async () => {
  const stages = [];
  const llm = fakeLlm({ classification: () => "not json at all", requirements: noIssues, ambiguities: noIssues, consolidation: noIssues });
  await assert.rejects(
    runAnalysis({ run: { id: "run-x", model: "fake" }, fragments: tracker, llm, onStage: async (s) => { stages.push(s); } }),
    (e) => e instanceof AnalysisError && e.category === "invalid_model_output" && /after 3 attempts/.test(e.message),
  );
  assert.equal(stages.length, 0);
  assert.equal(llm.calls.length, MAX_ATTEMPTS);
});

await run("fabricated fragment IDs are refused: retried, then dropped — never stored on a proposal", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), ambiguities: () => ({ issues: [{ issue_type: "Ambiguity", severity: "Low", description: "x", suggested_question: "y?", source_ids: ["F99"], related_requirements: [] }] }),
    consolidation: () => ({ duplicates: [] }),
    requirements: () => ({ requirements: [
      req({ title: "Real", description: "The picker name must remain.", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The picker name must remain" }),
      req({ title: "Invented", description: "Something else", source_ids: ["F42"], primary_source_id: "F42", source_quote: "x" }),
    ] }),
  });
  const result = await runAnalysis({ run: { id: "run-f", model: "fake" }, fragments: tracker, llm });
  assert.deepEqual(result.proposals.map((p) => p.proposed_title), ["Real"]);
  assert.ok(result.issues.every((i) => i.issue_type !== "Ambiguity"), "the issue citing F99 was dropped");
  assert.match(llm.calls.filter((c) => c.stage === "requirements")[1].messages.at(-1).content, /cites F42, which is not in SOURCE or CONTEXT/);
  assert.ok(result.withWarnings);
});

await run("a proposal without provenance cannot pass: schema requires a source, deterministic validation refuses none", () => {
  const errors = validateSchema(STAGE_SCHEMAS.requirements, { requirements: [req({ title: "t", description: "d", source_ids: [], primary_source_id: "F2", source_quote: "" })] });
  assert.ok(errors.some((e) => /source_ids: needs at least 1/.test(e)));
  const problems = validateAnalysisOutput({ proposals: [{ sequence: 1, proposed_title: "t", proposed_description: "d", rationale: "r", source_fragment_ids: [], primary_source_fragment_id: null, evidence_basis: "Explicit", confidence: "High" }], issues: [] }, new Set());
  assert.ok(problems.some((p) => /no source fragments \(provenance required\)/.test(p)));
});

await run("Explicit must quote the source verbatim; otherwise it is recorded as Inferred (→ Needs Review)", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), ambiguities: noIssues, consolidation: () => ({ duplicates: [] }),
    requirements: () => ({ requirements: [
      req({ title: "Quoted", description: "d", source_ids: ["F2"], primary_source_id: "F2", source_quote: "the picker name must remain against the pick task" }),
      req({ title: "Paraphrased", description: "d", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The original picker must be preserved through rework" }),
      req({ title: "Honest inference", description: "d", source_ids: ["F2"], primary_source_id: "F2", source_quote: "MONO picks remain as they are", evidence_basis: "Inferred", confidence: "Low" }),
    ] }),
  });
  const result = await runAnalysis({ run: { id: "run-e", model: "fake" }, fragments: tracker, llm });
  assert.deepEqual(result.proposals.map((p) => [p.proposed_title, p.evidence_basis]), [["Quoted", "Explicit"], ["Paraphrased", "Inferred"], ["Honest inference", "Inferred"]]);
  assert.ok(result.diagnostics.warnings.some((w) => /R2: marked Explicit but its quote was not found verbatim/.test(w)));
});

await run("ambiguities are kept as separate issues with provenance and links to the proposals they affect", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, consolidation: () => ({ duplicates: [] }),
    ambiguities: () => ({ issues: [{ issue_type: "Missing Information", severity: "High", description: "Rework is not described.", suggested_question: "What happens if the task is reworked? ?", source_ids: ["F2"], related_requirements: ["R1", "R9"] }] }),
  });
  const result = await runAnalysis({ run: { id: "run-a", model: "fake" }, fragments: tracker, llm });
  const missing = result.issues.find((i) => i.issue_type === "Missing Information");
  assert.deepEqual(missing.source_fragment_ids, [idOf(2)]);
  assert.deepEqual(missing.related_proposal_sequences, [1], "unknown R9 dropped");
  assert.equal(missing.suggested_question, "What happens if the task is reworked?");
  assert.ok(!result.proposals.some((p) => /rework/i.test(p.proposed_description)), "the gap is an issue, not an invented requirement");
});

await run("duplicates across sections are consolidated into one proposal with ALL source references and consolidation evidence", () => {
  const merged = happy.proposals.find((p) => p.consolidation.merged);
  assert.ok(merged, "R1 and R3 merged");
  assert.deepEqual(merged.source_fragment_ids, [idOf(2), idOf(5)]);
  assert.equal(merged.primary_source_fragment_id, idOf(2), "the strongest member's primary");
  assert.equal(merged.proposed_title, "Keep the picker name after palletisation");
  assert.match(merged.proposed_description, /^The picker name must remain against the pick task after palletisation\.\n\nStated in: Detailed Requirements; Change Description\.$/, "verbatim wording of the strongest member");
  assert.deepEqual(merged.consolidation.members.map((m) => m.key), ["R1", "R3"]);
  assert.equal(happy.proposals.length, 2, "MONO stays separate");
  const dup = happy.issues.find((i) => i.issue_type === "Duplicate / Repeated Requirement");
  assert.deepEqual(dup.related_proposal_sequences, [merged.sequence]);
});

await run("a model over-merge of different behaviours is split by the deterministic similarity check", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues,
    consolidation: (m) => (m[1].content.includes("requirement candidates") ? { duplicates: [{ members: ["R1", "R2", "R3"], reason: "all about picks", title: "Picks" }] } : { duplicates: [] }),
  });
  const result = await runAnalysis({ run: { id: "run-o", model: "fake" }, fragments: tracker, llm });
  assert.equal(result.proposals.length, 2, "MONO (R2) is not merged into the picker-name requirement");
  assert.ok(result.diagnostics.consolidation_overrides.length === 1);
  assert.ok(similarity("MONO picks unchanged MONO picks remain as they are.", "Keep picker name after palletisation The picker name must remain against the pick task after palletisation.") < SAME_SECTION_MERGE_SIMILARITY);
});

await run("conflicting priority fields: no priority is proposed and a Contradiction issue is raised", async () => {
  const llm = fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), ambiguities: noIssues, consolidation: () => ({ duplicates: [] }),
    requirements: () => ({ requirements: [req({ title: "Keep", description: "d", source_ids: ["F2", "F6"], primary_source_id: "F2", source_quote: "The picker name must remain", priority: "High" })] }),
  });
  const result = await runAnalysis({ run: { id: "run-p", model: "fake" }, fragments: tracker, llm });
  assert.equal(result.proposals[0].proposed_priority, null);
  const c = result.issues.find((i) => i.issue_type === "Contradiction");
  assert.deepEqual(c.source_fragment_ids, [idOf(1), idOf(6)]);
  assert.match(c.suggested_question, /Medium or High/);

  const single = tracker.filter((x) => x.sequence !== 6);
  const one = await runAnalysis({ run: { id: "run-p2", model: "fake" }, fragments: single, llm: fakeLlm({
    classification: classifyAll(TRACKER_CLASSES), ambiguities: noIssues, consolidation: () => ({ duplicates: [] }),
    requirements: () => ({ requirements: [req({ title: "Keep", description: "d", source_ids: ["F2"], primary_source_id: "F2", source_quote: "The picker name must remain", priority: "Medium" })] }),
  }) });
  assert.equal(one.proposals[0].proposed_priority, "Medium", "a single stated priority is used");
  assert.ok(one.proposals[0].source_fragment_ids.includes(idOf(1)), "and the priority field is cited as support");
});

await run("stage results are reused on retry (same input) — earlier stages are not regenerated", async () => {
  const stages = [];
  const first = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }) });
  await runAnalysis({ run: { id: "run-1", model: "fake" }, fragments: tracker, llm: first, onStage: async (s) => { stages.push({ ...s, run_id: "run-1" }); } });
  const second = fakeLlm({ classification: () => { throw new Error("must not be called"); }, requirements: () => { throw new Error("must not be called"); }, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }) });
  const recorded = [];
  const reusable = stages.filter((s) => s.stage !== "ambiguities");
  await runAnalysis({ run: { id: "run-2", model: "fake" }, fragments: tracker, llm: second, reusable, onStage: async (s) => { recorded.push(s); } });
  assert.deepEqual([...new Set(second.calls.map((c) => c.stage))], ["ambiguities"]);
  assert.ok(recorded.filter((s) => s.reused_from === "run-1").length >= 2, "reused results are recorded against the new run with their origin");
  const otherModel = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }) });
  await runAnalysis({ run: { id: "run-3", model: "other-model" }, fragments: tracker, llm: otherModel, reusable });
  assert.ok(otherModel.calls.some((c) => c.stage === "classification"), "a different model does not reuse (input hash differs)");
});

await run("the model only ever sees this run's fragments", async () => {
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }) });
  await runAnalysis({ run: { id: "run-v", model: "fake" }, fragments: tracker, llm });
  const labels = new Set(llm.calls.flatMap((c) => c.messages.flatMap((m) => [...m.content.matchAll(/\[(F\d+)\]/g)].map((x) => x[1]))));
  assert.ok([...labels].every((l) => ["F1", "F2", "F3", "F4", "F5", "F6"].includes(l)));
  assert.ok(llm.calls.every((c) => c.messages[0].content.includes("NO INVENTION")), "every call carries the no-invention rule");
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
  const missing = await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ models: [{ name: "qwen3:4b" }] }) });
  assert.deepEqual([missing.status, missing.category], ["Failed", "model_unavailable"]);
  const down = await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ reachable: false }) });
  assert.equal(down.category, "ollama_unreachable");
  assert.deepEqual(calls.map((c) => c.route), ["analysis/fail", "analysis/fail"]);
});

await run("worker: stages are posted as they complete, then the validated result with the model digest", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  const llm = fakeLlm({ classification: classifyAll(TRACKER_CLASSES), requirements: trackerRequirements, ambiguities: noIssues, consolidation: () => ({ duplicates: [] }) });
  const summary = await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ llm }) });
  assert.equal(summary.status, "Completed");
  assert.ok(calls.slice(0, -1).every((c) => c.route === "analysis/stage" && c.body.run_id === "r1"));
  const done = calls.at(-1);
  assert.equal(done.route, "analysis/complete");
  assert.equal(done.body.model_digest, "500a1f067a9f (ollama 0.34.2)");
  assert.equal(done.body.proposals.length, 3);
  assert.ok(!JSON.stringify(done.body).includes("tmw_"));
});

await run("worker: an invalid-output failure is reported with its category and without document text", async () => {
  const calls = [];
  const api = async (route, body) => { calls.push({ route, body }); return { ok: true }; };
  const llm = fakeLlm({ classification: () => "garbage", requirements: noIssues, ambiguities: noIssues, consolidation: noIssues });
  const summary = await processAnalysisRun(claimOf(), { api, ollama: fakeOllama({ llm }) });
  assert.equal(summary.category, "invalid_model_output");
  const failBody = calls.at(-1).body;
  assert.ok(!JSON.stringify(failBody).includes("picker name"), "no document content in the failure report");
});

await run("worker: a server without the analysis routes (404) is tolerated quietly — extraction keeps working", async () => {
  const logs = [];
  const state = {};
  const api = async () => { const e = new Error("analysis/claim failed (404)"); e.status = 404; throw e; };
  assert.equal(await runAnalysisOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(await runAnalysisOnce({ api, ollama: fakeOllama({}), log: (m) => logs.push(m), state }), null);
  assert.equal(logs.length, 1, "logged once");
  const boom = async () => { const e = new Error("500"); e.status = 500; throw e; };
  await assert.rejects(runAnalysisOnce({ api: boom, ollama: fakeOllama({}), state }), /500/, "other errors still surface");
});

console.log("\nAll analysis pipeline tests passed.\n");
