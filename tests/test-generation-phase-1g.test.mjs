// Phase 1G — AI Test Case generation (generation only). REAL route handlers,
// role guards and server orchestration; only the session lookup and the
// service-role client are stubbed, the latter mirroring migration 047's
// functions (eligibility + exact input from canonical ACs, one active run per
// Requirement, claim/lease, provenance-checked completion, review status
// decided by the database, immutable output). The migration itself was
// validated against the live database in a rolled-back transaction (PL10
// manual ACs, SOMCR038 promoted AC) and its SQL is asserted below.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const target = path.join(root, request.slice(2));
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts"), target]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
Module._extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename });
  module._compile(result.outputText, filename);
};
Module._extensions[".tsx"] = Module._extensions[".ts"];

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
const req = Module.createRequire(import.meta.url);
const serverModule = req("../lib/supabase/server.ts");
const serviceRoleModule = req("../lib/supabase/service-role.ts");
const shared = req("../lib/test-generation.ts");
const route = req("../app/api/requirements/test-generation/route.ts");
const workerRoutes = Object.fromEntries(["claim", "stage", "complete", "fail"].map((r) => [r, req(`../app/api/worker/test-generation/${r}/route.ts`)]));
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const OTHER_P = "99999999-9999-4999-8999-999999999999";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const TOKEN = `tmw_${"t".repeat(43)}`;
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const [REQ_MANUAL, REQ_PROMOTED, REQ_EMPTY, REQ_OTHER] = [uuid(), uuid(), uuid(), uuid()];
const [AC_M1, AC_M2, AC_AI, AC_OTHER] = [uuid(), uuid(), uuid(), uuid()];
const [F1, JOB, PROP, HC, G_RES, G_OPEN] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];

// ── In-memory service-role stand-in (mirrors migration 047) ────────────────
let session = null;
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  worker_credentials: [{ id: "w1", name: "mac-worker", scope: "extraction", token_sha256: sha(TOKEN), revoked_at: null }],
  projects: [{ id: P }, { id: OTHER_P }],
  requirements: [
    { id: REQ_MANUAL, project_id: P, requirement_ref: "REP-010", title: "Loading Dashboard Plant Selection", description: "Loading Dashboard must default the plant from Plant/User configuration.", status: "Approved" },
    { id: REQ_PROMOTED, project_id: P, requirement_ref: "REP-001", title: "Picker name remains", description: "The picker's name must remain.", status: "Discovery" },
    { id: REQ_EMPTY, project_id: P, requirement_ref: "REP-020", title: "No ACs", description: "d", status: "Open" },
    { id: REQ_OTHER, project_id: OTHER_P, requirement_ref: "REP-001", title: "Other project", description: "d", status: "Open" },
  ],
  acceptance_criteria: [
    { id: AC_M1, project_id: P, requirement_id: REQ_MANUAL, ac_ref: "AC-029", criterion: "Loading Dashboard plant defaults from Plant/User configuration", description: null, status: "Met", criterion_type: null, given_text: null, when_text: null, then_text: null },
    { id: AC_M2, project_id: P, requirement_id: REQ_MANUAL, ac_ref: "AC-030", criterion: "Only a Support User can change plant in Loading Dashboard", description: null, status: "Met", criterion_type: null, given_text: null, when_text: null, then_text: null },
    { id: AC_AI, project_id: P, requirement_id: REQ_PROMOTED, ac_ref: "AC-001", criterion: "The picker's name remains after palletisation", description: null, status: "Not Started", criterion_type: "Positive", given_text: "g", when_text: "w", then_text: "t" },
    { id: AC_OTHER, project_id: OTHER_P, requirement_id: REQ_OTHER, ac_ref: "AC-001", criterion: "Other", description: null, status: "Met", criterion_type: null, given_text: null, when_text: null, then_text: null },
  ],
  // The promoted AC's proposal, its Human Clarification and generation questions (one resolved, one open Additional Coverage).
  acceptance_criterion_proposals: [{ id: PROP, project_id: P, promoted_ac_id: AC_AI, source_fragment_ids: [F1], scope_note_ids: [], clarification_issue_ids: [], open_issue_ids: ["q-res"], source_quote: "The picker's name must remain." }],
  ac_human_clarifications: [{ id: HC, proposal_id: PROP, clarification: "The picker is the user who completed the pick.", reason: null, created_by_name: "Manager User", created_at: "2026-10-01" }],
  ac_generation_issues: [
    { id: G_RES, analysis_issue_ids: ["q-res"], status: "Resolved", relation: "Blocking", description: "d", suggested_question: "Which dashboard?", resolution_note: "Pick Admin Dashboard." },
    { id: G_OPEN, analysis_issue_ids: ["q-open"], status: "Open", relation: "Additional Coverage", description: "d", suggested_question: "What if palletised twice?", resolution_note: null },
  ],
  source_fragments: [{ id: F1, extraction_job_id: JOB, sequence: 3, fragment_type: "text", section_heading: "Rules", section_number: null, section_path: ["Spec", "Rules"], page_start: 1, page_end: 1, text: "The picker's name must remain.", metadata: {} }],
  // Canonical tests and links: Phase 1G must never read or touch them.
  test_cases: [{ id: uuid(), project_id: P, test_ref: "TC-001", scenario: "MANUAL TEST SCENARIO — must never reach the model", expected_result: "x", status: "Pass" }],
  artefact_links: [{ id: uuid(), project_id: P, source_entity: "test_cases", target_entity: "acceptance_criteria", target_id: AC_M1 }],
  test_generation_runs: [], test_generation_stage_results: [], test_case_proposals: [], test_generation_issues: [], ai_settings: [], audit_log: [],
};
const canonicalSnapshot = JSON.stringify({ tc: db.test_cases, links: db.artefact_links, ac: db.acceptance_criteria, req: db.requirements });
const touched = new Set();

function builder(table) {
  touched.add(table);
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : r[k] === v));
  const exec = () => {
    if (q.op === "insert") {
      if (table !== "audit_log") throw new Error(`direct insert into ${table} — writes go through migration 047's functions`);
      const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), ...r })); db[table].push(...list); return list;
    }
    if (q.op === "update") { const hit = rows().filter(matches); hit.forEach((r) => Object.assign(r, q.payload)); return hit; }
    return rows().filter(matches).map((r) => ({ ...r }));
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; }, is() { return b; },
    order() { return b; }, limit() { return b; }, gte() { return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }), single: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve) { return Promise.resolve({ data: exec(), error: null }).then(resolve); },
  };
  return b;
}
const err = (code, message) => ({ data: null, error: { code, message } });

function tgInput(projectId, requirementId, acIds) {
  const r = db.requirements.find((x) => x.id === requirementId && x.project_id === projectId);
  if (!r) throw Object.assign(new Error("Requirement not found in this project"), { code: "P0002" });
  const out = { eligible: false, reason: null };
  if (acIds && acIds.length > 50) return { ...out, reason: "Choose at most 50 acceptance criteria for one test generation run." };
  const acs = db.acceptance_criteria.filter((a) => a.requirement_id === r.id && a.project_id === projectId && (!acIds || acIds.includes(a.id))).sort((a, b) => a.ac_ref.localeCompare(b.ac_ref));
  if (acIds && acs.length !== new Set(acIds).size) return { ...out, reason: "Every selected acceptance criterion must belong to this Requirement in this project." };
  if (!acs.length) return { ...out, reason: "This Requirement has no acceptance criteria to design tests from." };
  const frag = [], h = [], res = [], open = [];
  const snapAcs = acs.map((a) => {
    const p = db.acceptance_criterion_proposals.find((x) => x.promoted_ac_id === a.id);
    let acH = [], acR = [], acO = [];
    if (p) {
      frag.push(...p.source_fragment_ids);
      acH = db.ac_human_clarifications.filter((c) => c.proposal_id === p.id).map((c) => c.id);
      acR = db.ac_generation_issues.filter((g) => g.analysis_issue_ids.some((x) => p.open_issue_ids.includes(x)) && ["Resolved", "Not Applicable"].includes(g.status)).map((g) => g.id);
      acO = db.ac_generation_issues.filter((g) => ["Open", "Accepted"].includes(g.status) && (g.analysis_issue_ids.some((x) => p.open_issue_ids.includes(x)) || g.relation === "Additional Coverage")).map((g) => g.id);
      h.push(...acH); res.push(...acR); open.push(...acO);
    }
    return { id: a.id, ref: a.ac_ref, criterion: a.criterion, description: a.description, status: a.status, criterion_type: a.criterion_type, given_text: a.given_text, when_text: a.when_text, then_text: a.then_text,
      origin: p ? "ai" : "manual", proposal_id: p?.id ?? null, source_quote: p?.source_quote ?? null, fragment_ids: p ? p.source_fragment_ids : [], human_clarification_ids: acH, analysis_clarification_ids: [], scope_note_ids: [], resolved_issue_ids: acR, open_issue_ids: acO };
  });
  const snapshot = {
    requirement: { id: r.id, ref: r.requirement_ref, title: r.title, description: r.description, category: null, priority: null, status: r.status, promoted: false, source_quote: null, fragment_ids: [] },
    acceptance_criteria: snapAcs, fragment_ids: [...new Set(frag)],
    human_clarifications: db.ac_human_clarifications.filter((c) => h.includes(c.id)), analysis_clarifications: [], scope_notes: [],
    resolved_questions: db.ac_generation_issues.filter((g) => res.includes(g.id)).map((g) => ({ id: g.id, description: g.description, question: g.suggested_question, status: g.status, resolution_note: g.resolution_note, reviewed_by_name: null })),
    open_questions: db.ac_generation_issues.filter((g) => open.includes(g.id) && !res.includes(g.id)).map((g) => ({ id: g.id, description: g.description, question: g.suggested_question, relation: g.relation, status: g.status })),
  };
  return { eligible: true, reason: null, ac_ids: acs.map((a) => a.id), allowed_fragment_ids: [...new Set(frag)], extraction_job_ids: frag.length ? [JOB] : [], human_clarification_ids: [...new Set(h)],
    analysis_clarification_ids: [], scope_note_ids: [], resolved_issue_ids: [...new Set(res)], open_issue_ids: [...new Set(open)].filter((x) => !res.includes(x)), snapshot };
}
function owner(runId, workerId) {
  const r = db.test_generation_runs.find((x) => x.id === runId);
  if (!r || r.status !== "Running" || r.worker_id !== workerId) throw Object.assign(new Error("This test generation run is not running for this worker"), { code: "55000" });
  return r;
}
function rpc(name, a) {
  try {
    switch (name) {
      case "test_generation_input": return { data: [tgInput(a.p_project_id, a.p_requirement_id, a.p_ac_ids)], error: null };
      case "queue_test_generation_run": {
        let acIds = a.p_ac_ids;
        if (a.p_retry_of_run_id) {
          const prior = db.test_generation_runs.find((r) => r.id === a.p_retry_of_run_id && r.project_id === a.p_project_id);
          if (!prior || prior.requirement_id !== a.p_requirement_id) return err("22023", "The run to retry does not belong to this Requirement");
          if (prior.status !== "Failed") return err("55000", "Only a failed test generation run can be retried");
          acIds = acIds ?? prior.ac_ids;
        }
        const input = tgInput(a.p_project_id, a.p_requirement_id, acIds);
        if (!input.eligible) return err("55000", input.reason);
        if (db.test_generation_runs.some((r) => r.requirement_id === a.p_requirement_id && ["Queued", "Running"].includes(r.status))) return err("23505", "Test generation is already in progress for this Requirement");
        const row = { id: uuid(), project_id: a.p_project_id, requirement_id: a.p_requirement_id, ac_ids: input.ac_ids, status: "Queued", trigger: a.p_retry_of_run_id ? "retry" : "manual", retry_of_run_id: a.p_retry_of_run_id,
          requested_by_name: a.p_user_name, queued_at: new Date(Date.now() + seq).toISOString(), attempt_count: 0, model: a.p_model, input_snapshot: input.snapshot, input_sha256: sha(JSON.stringify(input.snapshot)),
          allowed_fragment_ids: input.allowed_fragment_ids, extraction_job_ids: input.extraction_job_ids, human_clarification_ids: input.human_clarification_ids, analysis_clarification_ids: [], scope_note_ids: [],
          resolved_issue_ids: input.resolved_issue_ids, open_issue_ids: input.open_issue_ids, worker_id: null, prompt_version: null };
        db.test_generation_runs.push(row);
        return { data: [{ run_id: row.id, trigger: row.trigger, input_sha256: row.input_sha256 }], error: null };
      }
      case "claim_test_generation_run": {
        const r = db.test_generation_runs.filter((x) => x.status === "Queued").sort((x, y) => x.queued_at.localeCompare(y.queued_at))[0];
        if (!r) return { data: [], error: null };
        Object.assign(r, { status: "Running", attempt_count: r.attempt_count + 1, worker_id: a.p_worker_id, prompt_version: a.p_prompt_version, prompt_sha256: a.p_prompt_sha256, schema_version: a.p_schema_version });
        return { data: [{ ...r }], error: null };
      }
      case "record_test_generation_stage": {
        const r = owner(a.p_run_id, a.p_worker_id);
        if (db.test_generation_stage_results.some((s) => s.generation_run_id === r.id && s.stage === a.p_stage && s.chunk_key === a.p_chunk_key)) return { data: false, error: null };
        db.test_generation_stage_results.push({ generation_run_id: r.id, stage: a.p_stage, chunk_key: a.p_chunk_key, input_hash: a.p_input_hash, output: a.p_output, model: r.model, prompt_version: r.prompt_version });
        return { data: true, error: null };
      }
      case "complete_test_generation_run": {
        const r = owner(a.p_run_id, a.p_worker_id);
        if (db.test_case_proposals.some((x) => x.generation_run_id === r.id)) return err("55000", "This test generation run already has output");
        for (const [i, p] of a.p_proposals.entries()) {
          if (!p.source_ac_ids.length || !p.source_ac_ids.every((x) => r.ac_ids.includes(x))) return err("22023", "every source acceptance criterion must be one of the run's acceptance criteria");
          db.test_case_proposals.push({ id: uuid(), generation_run_id: r.id, project_id: r.project_id, requirement_id: r.requirement_id, ...p, sequence: i + 1,
            review_status: p.basis === "Inferred" || p.confidence === "Low" || p.needs_review_reasons.length ? "Needs Review" : "Proposed" });
        }
        for (const [i, x] of a.p_issues.entries()) db.test_generation_issues.push({ id: uuid(), generation_run_id: r.id, project_id: r.project_id, requirement_id: r.requirement_id, ...x, sequence: i + 1, status: "Open" });
        const nr = db.test_case_proposals.filter((x) => x.generation_run_id === r.id && x.review_status === "Needs Review").length;
        Object.assign(r, { status: a.p_with_warnings ? "Completed with warnings" : "Completed", proposal_count: a.p_proposals.length, issue_count: a.p_issues.length, needs_review_count: nr, completed_at: "now" });
        return { data: [{ project_id: r.project_id, requirement_id: r.requirement_id, status: r.status, proposal_count: r.proposal_count, issue_count: r.issue_count, needs_review_count: nr }], error: null };
      }
      case "fail_test_generation_run": {
        const r = db.test_generation_runs.find((x) => x.id === a.p_run_id);
        if (!r || r.status !== "Running" || r.worker_id !== a.p_worker_id) return err("55000", "This test generation run is not running for this worker");
        Object.assign(r, { status: "Failed", error_category: a.p_category, error_message: a.p_message, completed_at: "now" });
        return { data: [{ project_id: r.project_id, requirement_id: r.requirement_id }], error: null };
      }
    }
  } catch (e) {
    return err(e.code ?? "XX000", e.message);
  }
  return err("42883", `unknown function ${name}`);
}
serviceRoleModule.createServiceRoleClient = () => ({ from: builder, rpc: async (n, a) => rpc(n, a) });
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };
const call = async (handler, url, { body, method = "POST", token } = {}) => {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await handler(new NextRequest(`http://localhost${url}`, method === "GET" ? { method, headers } : { method, headers, body: JSON.stringify(body ?? {}) }));
  return { status: res.status, body: await res.json() };
};
const read1 = (requirementId, projectId = P) => call(route.GET, `/api/requirements/test-generation?project_id=${projectId}&requirement_id=${requirementId}`, { method: "GET" });
const queue = (requirementId, extra = {}) => call(route.POST, "/api/requirements/test-generation", { body: { project_id: P, requirement_id: requirementId, ...extra } });
const IDENTITY = { test_prompt_version: "1.0.0", test_prompt_sha256: "a".repeat(64), test_schema_version: "1.0.0" };
const worker = (r, body, token = TOKEN) => call(workerRoutes[r].POST, `/api/worker/test-generation/${r}`, { body, token });
const proposal = (o = {}) => ({ sequence: 1, title: "Plant defaults", objective: "Prove the default.", preconditions: [], steps: [{ action: "Open the Loading Dashboard.", expected: null }, { action: "Observe the plant.", expected: "The configured plant." }],
  expected_result: "The Loading Dashboard shows the configured plant.", test_type: "Positive", variation: null, basis: "Explicit", confidence: "High", needs_review_reasons: [],
  source_ac_ids: [AC_M1], source_fragment_ids: [], human_clarification_ids: [], analysis_clarification_ids: [], scope_note_ids: [], resolved_issue_ids: [], rationale: "Stated.", behaviours: [], consolidation: {}, ...o });

// ── Permissions ─────────────────────────────────────────────────────────────

await run("anon and Viewer can neither read nor start test generation; Manager and Admin can; worker routes need the worker token", async () => {
  for (const [role, status] of [[null, 401], ["Viewer", 403]]) {
    as(role);
    assert.equal((await read1(REQ_MANUAL)).status, status, `${role ?? "anon"} read`);
    assert.equal((await queue(REQ_MANUAL)).status, status, `${role ?? "anon"} start`);
    assert.equal((await call(route.GET, `/api/requirements/test-generation?project_id=${P}&run_id=${uuid()}`, { method: "GET" })).status, status, `${role ?? "anon"} run`);
  }
  as("Manager");
  assert.equal((await read1(REQ_MANUAL)).status, 200);
  assert.equal((await worker("claim", IDENTITY, `tmw_${"x".repeat(43)}`)).status, 401);
  assert.equal(db.test_generation_runs.length, 0);
});

// ── Eligibility ─────────────────────────────────────────────────────────────

await run("manual ACs are eligible (no type / Given-When-Then / provenance needed); a Requirement without ACs is not; project-scoped", async () => {
  as("Manager");
  const m = await read1(REQ_MANUAL);
  assert.deepEqual([m.body.eligibility.eligible, m.body.acceptance_criteria.map((a) => [a.ref, a.origin, a.criterion_type])], [true, [["AC-029", "manual", null], ["AC-030", "manual", null]]]);
  assert.equal(m.body.configured_model, "qwen3:8b");
  const e = await read1(REQ_EMPTY);
  assert.deepEqual([e.body.eligibility.eligible, e.body.eligibility.reason], [false, "This Requirement has no acceptance criteria to design tests from."]);
  assert.equal((await read1(REQ_OTHER)).status, 404, "another project's Requirement is not found here");
  assert.equal((await queue(REQ_MANUAL, { ac_ids: [AC_OTHER] })).status, 409, "an AC from another Requirement/project is refused");
  assert.equal((await queue(REQ_MANUAL, { ac_ids: [] })).status, 400);
});

await run("AI-promoted ACs bring their fragments, Human Clarifications and resolved questions; open Additional Coverage questions are supplied as non-facts", async () => {
  as("Manager");
  const r = await queue(REQ_PROMOTED);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const run1 = db.test_generation_runs.at(-1);
  const ac = run1.input_snapshot.acceptance_criteria[0];
  assert.deepEqual([ac.origin, ac.fragment_ids, ac.human_clarification_ids, ac.resolved_issue_ids], ["ai", [F1], [HC], [G_RES]]);
  assert.deepEqual(run1.open_issue_ids, [G_OPEN]);
  assert.equal(run1.input_snapshot.human_clarifications[0].clarification, "The picker is the user who completed the pick.");
  assert.equal(run1.input_snapshot.open_questions[0].relation, "Additional Coverage");
  // Claim it (so the manual run below is next in line) and fail it for the retry test.
  as(null);
  const claim = await worker("claim", IDENTITY);
  assert.deepEqual([claim.status, claim.body.acceptance_criteria.length, claim.body.fragments.length], [200, 1, 1]);
  assert.equal((await worker("fail", { run_id: run1.id, error_category: "model_timeout", error_message: "timed out" })).status, 200);
});

await run("queue: one active run per Requirement; a subset of ACs may be chosen; audited; existing tests never reach the input", async () => {
  as("Manager");
  const r = await queue(REQ_MANUAL, { ac_ids: [AC_M2] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.run.ac_ids, [AC_M2]);
  assert.equal((await queue(REQ_MANUAL)).status, 409, "already in progress");
  assert.ok(db.audit_log.some((x) => x.entity_type === "test_generation_runs" && /Queued \(1 acceptance criterion, model qwen3:8b\)/.test(x.new_value)));
  const snapshot = JSON.stringify(db.test_generation_runs.map((x) => x.input_snapshot));
  assert.doesNotMatch(snapshot, /MANUAL TEST SCENARIO|TC-001/);
  assert.ok(!touched.has("test_cases") && !touched.has("artefact_links"), "test_cases / artefact_links never read");
});

// ── Worker protocol ─────────────────────────────────────────────────────────

await run("worker: claim returns the fixed input; stage results stored; completion refuses foreign ACs and fabricated ids; the database decides review status", async () => {
  as(null);
  const claim = await worker("claim", IDENTITY);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const runId = claim.body.run.id;
  assert.deepEqual(claim.body.acceptance_criteria.map((a) => a.ref), ["AC-030"]);
  assert.equal((await worker("claim", { ...IDENTITY, test_prompt_sha256: "zz" })).status, 400);
  assert.equal((await worker("stage", { run_id: runId, stage: "behaviours", chunk_key: "requirement", input_hash: "b".repeat(64), attempts: 1, output: { behaviours: [] } })).body.stored, true);
  assert.equal((await worker("stage", { run_id: runId, stage: "rewrite", chunk_key: "requirement", input_hash: "b".repeat(64), attempts: 1, output: {} })).status, 400);
  const foreign = await worker("complete", { run_id: runId, proposals: [proposal({ source_ac_ids: [AC_M1] })], issues: [] });
  assert.equal(foreign.status, 400, "AC-029 is not part of this run");
  assert.match(foreign.body.error, /must trace to at least one of the run's acceptance criteria/);
  assert.equal((await worker("complete", { run_id: runId, proposals: [proposal({ source_ac_ids: [AC_M2], source_fragment_ids: [uuid()] })], issues: [] })).status, 400, "fragment outside the run");
  assert.equal((await worker("complete", { run_id: runId, proposals: [proposal({ source_ac_ids: [AC_M2], steps: [] })], issues: [] })).status, 400, "no procedure");
  assert.equal((await worker("complete", { run_id: runId, proposals: [{ ...proposal({ source_ac_ids: [AC_M2] }), test_ref: "TC-099" }], issues: [] })).status, 400, "no test reference from generation");
  const ok = await worker("complete", { run_id: runId, model_digest: "abc", with_warnings: false, diagnostics: { warnings: [] },
    proposals: [proposal({ source_ac_ids: [AC_M2] }), proposal({ sequence: 2, source_ac_ids: [AC_M2], basis: "Inferred", test_type: "Negative", variation: "non-Support User" })],
    issues: [{ sequence: 1, issue_type: "Uncovered Behaviour", severity: "Medium", description: "d", ac_ids: [AC_M2], source_fragment_ids: [], source_issue_ids: [] }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(db.test_case_proposals.filter((p) => p.generation_run_id === runId).map((p) => p.review_status), ["Proposed", "Needs Review"]);
  assert.ok(db.audit_log.some((x) => x.entity_id === runId && /Completed — 2 proposed test cases, 1 needing review, 1 test-design issue/.test(x.new_value)));
  assert.equal(JSON.stringify({ tc: db.test_cases, links: db.artefact_links, ac: db.acceptance_criteria, req: db.requirements }), canonicalSnapshot, "canonical tests, links, ACs and Requirements untouched");
});

await run("retry: only a failed run; it keeps the failed run's ACs and reuses its validated stages; completed runs are preserved", async () => {
  as("Manager");
  const failed = db.test_generation_runs.find((r) => r.status === "Failed");
  const completed = db.test_generation_runs.find((r) => r.status === "Completed");
  assert.equal((await queue(REQ_MANUAL, { retry_of_run_id: completed.id })).status, 409, "a completed run cannot be retried");
  const retry = await queue(REQ_PROMOTED, { retry_of_run_id: failed.id });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual([retry.body.run.trigger, retry.body.run.ac_ids], ["retry", failed.ac_ids]);
  db.test_generation_stage_results.push({ generation_run_id: failed.id, stage: "behaviours", chunk_key: "requirement", input_hash: "c".repeat(64), output: { behaviours: [] }, model: "qwen3:8b", prompt_version: "1.0.0" });
  as(null);
  const claim = await worker("claim", IDENTITY);
  assert.equal(claim.body.reusable_stages.length, 1, "the failed run's stage is offered for reuse");
  assert.ok(db.audit_log.some((x) => x.entity_id === failed.id && x.new_value === "Failed — model_timeout"));
  assert.equal(completed.status, "Completed");
});

await run("run detail: a Manager reads one run with its proposals, issues and sibling runs", async () => {
  as("Admin");
  const completed = db.test_generation_runs.find((r) => r.status === "Completed");
  const r = await call(route.GET, `/api/requirements/test-generation?project_id=${P}&run_id=${completed.id}`, { method: "GET" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.proposals.length, r.body.issues.length, r.body.latest_run_id], [2, 1, completed.id]);
  assert.equal((await call(route.GET, `/api/requirements/test-generation?project_id=${OTHER_P}&run_id=${completed.id}`, { method: "GET" })).status, 404);
});

// ── Shared rules ────────────────────────────────────────────────────────────

await run("shared: summary, canonical mapping preview and server re-validation mirror the worker", () => {
  assert.equal(shared.testGenerationSummary({ proposal_count: 3, needs_review_count: 1, issue_count: 2 }), "3 proposed test cases · 3 items need review");
  assert.equal(shared.canonicalScenarioPreview({ title: "T", objective: "O", preconditions: ["P"], steps: [{ step: 1, action: "A", expected: "E" }] }), "T\nO\nPreconditions: P\n1. A → E");
  const allowed = { acs: new Set([AC_M1]), fragments: new Set(), human: new Set(), clarifications: new Set(), resolved: new Set(), scopeNotes: new Set(), openQuestions: new Set([G_OPEN]) };
  assert.equal(shared.validateTestGenerationSubmission([proposal()], [{ sequence: 1, issue_type: "Additional Coverage Question", severity: "Low", description: "d", ac_ids: [], source_fragment_ids: [], source_issue_ids: [G_OPEN] }], allowed).ok, true);
  assert.equal(shared.validateTestGenerationSubmission([proposal({ test_type: "Smoke" })], [], allowed).ok, false);
  assert.deepEqual([...shared.TEST_GENERATION_STAGES], ["behaviours", "tests", "coverage"]);
});

// ── Migration 047 ───────────────────────────────────────────────────────────

const m047 = code(read("supabase/migrations/047_test_generation.sql"));
await run("047: eligibility from any canonical AC; never reads test_cases / artefact_links; review status decided by the database; immutable history", () => {
  const input = m047.slice(m047.indexOf("FUNCTION public.test_generation_input"), m047.indexOf("FUNCTION public.queue_test_generation_run"));
  assert.doesNotMatch(input, /test_cases|artefact_links/, "the input function never reads canonical tests or links");
  assert.doesNotMatch(input, /criterion_type IS NOT NULL|given_text IS NOT NULL/, "type / Given-When-Then are not required");
  assert.doesNotMatch(input, /'approved', 'complete', 'closed'/, "signed-off Requirements are not excluded");
  assert.match(m047, /source_ac_ids\s+uuid\[\]\s+NOT NULL CHECK \(cardinality\(source_ac_ids\) >= 1\)/);
  assert.match(m047, /IF NOT NEW\.source_ac_ids <@ v_run\.ac_ids THEN/);
  assert.match(m047, /CASE WHEN p\.v->>'basis' = 'Inferred' OR p\.v->>'confidence' = 'Low'\s+OR jsonb_array_length\(coalesce\(p\.v->'needs_review_reasons', '\[\]'::jsonb\)\) > 0 THEN 'Needs Review' ELSE 'Proposed' END/);
  assert.match(m047, /CREATE UNIQUE INDEX test_generation_runs_one_active_per_requirement ON public\.test_generation_runs \(requirement_id\) WHERE status IN \('Queued', 'Running'\)/);
  assert.match(m047, /RAISE EXCEPTION 'generated test cases and test-generation issues are immutable in Phase 1G/);
  assert.match(m047, /IF v_retry\.status <> 'Failed' THEN RAISE EXCEPTION 'Only a failed test generation run can be retried'/);
  assert.match(m047, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  const topLevel = m047.replace(/(AS|DO) \$\$[\s\S]*?\n\$\$;/g, "");
  assert.doesNotMatch(topLevel, /^\s*(UPDATE|DELETE FROM|INSERT INTO)\b/m, "the migration itself changes no data");
  assert.doesNotMatch(m047, /\b(UPDATE|DELETE FROM|INSERT INTO) public\.(test_cases|artefact_links|acceptance_criteria|requirements)\b/);
  assert.ok(req("../lib/schema.ts").latestMigration >= "047_test_generation");
});

// ── UI and unaffected calculations ──────────────────────────────────────────

await run("UI: drawer panel and review page are Manager/Admin only and never write canonical tests directly", () => {
  const appClient = read("components/app-client.tsx");
  assert.match(appClient, /\{canViewRequirementAnalysis\(user\?\.role\) && <RequirementTestGenerationPanel projectId=\{pid\} requirementId=\{recordId\} mayRun=\{canRunRequirementAnalysis\(user\?\.role\)\} \/>\}/);
  const panel = read("components/requirement-test-generation.tsx"), page = read("components/test-generation-review-page.tsx");
  for (const s of ['"Generate Tests"', "Generate Tests (", "Retry", "Review generated tests"]) assert.ok(panel.includes(s.replace(/"/g, "")) || panel.includes(s), s);
  assert.match(page, /if \(!mayView\) return <AppShell><EmptyState title="Manager or Admin access required"/);
  assert.doesNotMatch(panel + page, /saveRecord|createRecord|deleteRecord|"test_cases"/, "no generic canonical write");
  assert.doesNotMatch(panel, /Promote/, "the drawer panel never promotes (Phase 1H promotion lives in the review workspace)");
  for (const s of ["Coverage by acceptance criterion", "Proposed test cases", "Test-design issues", "Expected result:", "Preconditions", "What the generation was given"]) assert.ok(page.includes(s), s);
  assert.ok(read("components/audit-trail-page.tsx").includes('test_generation_runs: "Test Generation Run"'));
  for (const f of ["lib/project-state.ts", "lib/go-live-readiness.ts", "lib/lifecycle/test-verification.ts", "lib/lifecycle/requirement.ts", "lib/test-report-format.ts", "lib/supabase/data-store.ts"]) {
    assert.doesNotMatch(read(f), /test_generation|test_case_proposals|test-generation/, f);
  }
});

console.log("\nAll Phase 1G test case generation tests passed.\n");
