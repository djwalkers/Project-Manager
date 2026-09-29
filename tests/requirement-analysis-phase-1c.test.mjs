// Phase 1C — AI requirement analysis: Manager/Admin queue/retry/read, the
// narrow worker protocol, provenance enforcement, non-authoritative output,
// System Health, audit, and the migration's guarantees. REAL route handlers
// and role guards; only the session lookup and the service-role client are
// stubbed, the latter mirroring migration 038's functions. The migration
// itself was validated against the live database in a rolled-back
// transaction; the analysis pipeline has its own suite in local-worker/tests.
import assert from "node:assert/strict";
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
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
const req = Module.createRequire(import.meta.url);
const { createHash } = req("node:crypto");
const serverModule = req("../lib/supabase/server.ts");
const serviceRoleModule = req("../lib/supabase/service-role.ts");
const shared = req("../lib/requirement-analysis.ts");
const analysisRoute = req("../app/api/source-documents/analysis/route.ts");
const runsRoute = req("../app/api/analysis/runs/route.ts");
const settingsRoute = req("../app/api/analysis/settings/route.ts");
const statusRoute = req("../app/api/worker/status/route.ts");
const heartbeatRoute = req("../app/api/worker/heartbeat/route.ts");
const workerRoutes = Object.fromEntries(["claim", "stage", "complete", "fail"].map((r) => [r, req(`../app/api/worker/analysis/${r}/route.ts`)]));
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
const sha = (v) => createHash("sha256").update(v).digest("hex");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const OTHER_P = "99999999-9999-4999-8999-999999999999";
const D = "33333333-3333-4333-8333-333333333333";
const V1 = "22222222-2222-4222-8222-222222222222";
const JOB_A = "44444444-4444-4444-8444-444444444444";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const TOKEN = `tmw_${"t".repeat(43)}`;
const OTHER_TOKEN = `tmw_${"o".repeat(43)}`;
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const later = () => new Date(Date.now() + ++seq * 1000).toISOString();

const fragment = (jobId, sequence, text, extra = {}) => ({
  id: uuid(), project_id: P, document_version_id: V1, extraction_job_id: jobId, sequence, fragment_type: "text",
  section_heading: "Detail", section_number: null, section_path: ["CR", "Detail"], page_start: 1, page_end: 1,
  text, text_hash: sha(text), char_count: text.length, metadata: {}, ...extra,
});

// ── In-memory service-role stand-in ─────────────────────────────────────────
let session = null;
const PL10_SENTINEL = "BENCHMARK-REQUIREMENT-SENTINEL";
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  projects: [{ id: P, name: "Project" }],
  documents: [{ id: D, project_id: P, document_name: "CR038", current_version_id: V1, archived_at: null }],
  document_versions: [{ id: V1, document_id: D, project_id: P, version_number: 1, extraction_status: "Completed", analysis_status: "Not Started", content_type: "application/pdf" }],
  extraction_jobs: [{ id: JOB_A, project_id: P, document_version_id: V1, status: "Completed", extractor_version: "1.2.0", completed_at: later(), fragment_count: 3 }],
  source_fragments: [],
  worker_credentials: [
    { id: "w1", name: "mac-worker", scope: "extraction", token_sha256: sha(TOKEN), revoked_at: null, last_seen_ollama: null },
    { id: "w0", name: "old-worker", scope: "extraction", token_sha256: sha(OTHER_TOKEN), revoked_at: "2026-01-01T00:00:00Z" },
  ],
  ai_settings: [{ id: "ai1", provider: "none", model: "qwen3:8b", analysis_model: null, created_at: "2026-01-01" }],
  analysis_runs: [], analysis_stage_results: [], requirement_proposals: [], analysis_issues: [], analysis_scope_notes: [], audit_log: [],
  // Canonical data that analysis must never read or write.
  requirements: [{ id: "r1", project_id: P, requirement_ref: "REQ-001", title: PL10_SENTINEL }],
  acceptance_criteria: [{ id: "ac1", project_id: P }], test_cases: [{ id: "t1", project_id: P }],
  actions: [], risks: [], decisions: [], discovery_questions: [], go_live_readiness_overrides: [],
  touched: new Set(), rpcCalls: [],
};
db.source_fragments.push(
  fragment(JOB_A, 1, "Status: Open\nPriority: Medium", { section_heading: "CR", section_path: ["CR"] }),
  fragment(JOB_A, 2, "The picker name must remain against the task after palletisation."),
  fragment(JOB_A, 3, "It gives the business traceability.", { section_heading: "Benefit", section_path: ["CR", "Benefit"] }),
);
const fragA = (n) => db.source_fragments.find((f) => f.extraction_job_id === JOB_A && f.sequence === n).id;
const CANONICAL = ["requirements", "acceptance_criteria", "test_cases", "actions", "risks", "decisions", "discovery_questions", "go_live_readiness_overrides"];
const snapshot = () => JSON.stringify([...CANONICAL.map((t) => db[t]), db.documents, db.document_versions, db.source_fragments, db.extraction_jobs]);

function builder(table) {
  db.touched.add(table);
  assert.ok(!CANONICAL.includes(table), `analysis code must not touch canonical table ${table}`);
  const q = { op: "select", filters: [], payload: null, head: false, order: null, limit: null, columns: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "is" ? (r[k] ?? null) === v : kind === "gte" ? r[k] >= v : kind === "in" ? v.includes(r[k]) : r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), created_at: new Date().toISOString(), ...r })); db[table].push(...list); return list; }
    if (q.op === "update") { const hit = rows().filter(matches); hit.forEach((r) => Object.assign(r, q.payload)); return hit; }
    let out = rows().filter(matches);
    if (q.order) out = [...out].sort((a, b) => (a[q.order.col] > b[q.order.col] ? 1 : -1) * (q.order.asc ? 1 : -1));
    if (q.limit) out = out.slice(0, q.limit);
    // Like PostgREST: an explicit column list returns only those columns.
    if (q.columns) out = out.map((r) => Object.fromEntries(q.columns.filter((c) => c in r).map((c) => [c, r[c]])));
    return out;
  };
  const b = {
    select(c, opts) { if (opts?.head) q.head = true; if (typeof c === "string" && c !== "*") q.columns = c.split(",").map((x) => x.trim()); return b; },
    eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, is(k, v) { q.filters.push([k, v, "is"]); return b; },
    gte(k, v) { q.filters.push([k, v, "gte"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; },
    order(col, o) { q.order = { col, asc: o?.ascending !== false }; return b; }, limit(n) { q.limit = n; return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }), single: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve) { const data = exec(); return Promise.resolve(q.head ? { count: data.length, error: null } : { data, error: null }).then(resolve); },
  };
  return b;
}
const err = (code, message) => ({ data: null, error: { code, message } });

// Mirrors migration 038.
function rpc(name, a) {
  db.rpcCalls.push({ name, args: a });
  const runOf = (id) => db.analysis_runs.find((r) => r.id === id);
  const owned = (id, worker) => { const r = runOf(id); return r && r.status === "Running" && r.worker_id === worker ? r : null; };
  switch (name) {
    case "queue_analysis_run": {
      const job = db.extraction_jobs.find((j) => j.id === a.p_extraction_job_id && j.project_id === a.p_project_id);
      if (!job) return err("P0002", "Extraction run not found in this project");
      if (job.status !== "Completed") return err("55000", "Only a completed extraction can be analysed");
      const version = db.document_versions.find((v) => v.id === job.document_version_id);
      const doc = db.documents.find((d) => d.id === version.document_id);
      if (doc.archived_at) return err("55000", "This source document is archived");
      if (doc.current_version_id !== version.id) return err("55000", "Only the current version of a document can be analysed");
      if (db.analysis_runs.some((r) => r.extraction_job_id === job.id && ["Queued", "Running"].includes(r.status))) return err("23505", "Analysis is already in progress for this extraction");
      if (a.p_retry_of_run_id) {
        const prior = runOf(a.p_retry_of_run_id);
        if (!prior || prior.extraction_job_id !== job.id) return err("22023", "The run to retry does not belong to this extraction");
        if (prior.status !== "Failed") return err("55000", "Only a failed analysis run can be retried");
      }
      const r = {
        id: uuid(), project_id: P, document_id: doc.id, document_version_id: version.id, extraction_job_id: job.id, status: "Queued",
        trigger: a.p_retry_of_run_id ? "retry" : "manual", retry_of_run_id: a.p_retry_of_run_id, requested_by: a.p_user_id, requested_by_name: a.p_user_name,
        queued_at: later(), attempt_count: 0, model: a.p_model, prompt_version: null,
      };
      db.analysis_runs.push(r);
      return { data: [{ run_id: r.id, trigger: r.trigger, document_version_id: version.id }], error: null };
    }
    case "claim_analysis_run": {
      const r = db.analysis_runs.filter((x) => x.status === "Queued").sort((x, y) => x.queued_at.localeCompare(y.queued_at))[0];
      if (!r) return { data: [], error: null };
      Object.assign(r, { status: "Running", attempt_count: r.attempt_count + 1, worker_id: a.p_worker_id, worker_name: a.p_worker_name, worker_version: a.p_worker_version, prompt_version: a.p_prompt_version, prompt_sha256: a.p_prompt_sha256, analysis_schema_version: a.p_schema_version });
      return { data: [{ ...r }], error: null };
    }
    case "record_analysis_stage": {
      const r = owned(a.p_run_id, a.p_worker_id);
      if (!r) return err("55000", "This analysis run is not running for this worker");
      if (db.analysis_stage_results.some((s) => s.analysis_run_id === r.id && s.stage === a.p_stage && s.chunk_key === a.p_chunk_key)) return { data: false, error: null };
      db.analysis_stage_results.push({ id: uuid(), analysis_run_id: r.id, stage: a.p_stage, chunk_key: a.p_chunk_key, input_hash: a.p_input_hash, model: r.model, prompt_version: r.prompt_version, attempts: a.p_attempts, reused_from_run_id: a.p_reused_from, output: a.p_output });
      return { data: true, error: null };
    }
    case "complete_analysis_run": {
      const r = owned(a.p_run_id, a.p_worker_id);
      if (!r) return err("55000", "This analysis run is not running for this worker");
      const valid = new Set(db.source_fragments.filter((f) => f.extraction_job_id === r.extraction_job_id).map((f) => f.id));
      for (const row of [...a.p_proposals, ...a.p_issues, ...(a.p_scope_notes ?? [])]) {
        if (!row.source_fragment_ids.length) return err("23514", "cardinality");
        if (!row.source_fragment_ids.every((id) => valid.has(id))) return err("22023", "every cited source fragment must belong to the analysed extraction run");
      }
      db.requirement_proposals.push(...a.p_proposals.map((p) => ({ id: uuid(), analysis_run_id: r.id, project_id: r.project_id, proposal_type: "requirement", ...p, review_status: p.evidence_basis === "Inferred" ? "Needs Review" : "Proposed" })));
      db.analysis_issues.push(...a.p_issues.map((i) => ({ id: uuid(), analysis_run_id: r.id, project_id: r.project_id, status: "Open", ...i })));
      db.analysis_scope_notes.push(...(a.p_scope_notes ?? []).map((n) => ({ id: uuid(), analysis_run_id: r.id, project_id: r.project_id, ...n })));
      const status = a.p_with_warnings ? "Completed with warnings" : "Completed";
      const notes = (a.p_scope_notes ?? []).length;
      Object.assign(r, { status, completed_at: later(), model_digest: a.p_model_digest, diagnostics: a.p_diagnostics, proposal_count: a.p_proposals.length, issue_count: a.p_issues.length, scope_note_count: notes });
      return { data: [{ project_id: r.project_id, document_version_id: r.document_version_id, status, proposal_count: a.p_proposals.length, issue_count: a.p_issues.length, scope_note_count: notes }], error: null };
    }
    case "fail_analysis_run": {
      const r = runOf(a.p_run_id);
      if (!r || r.status !== "Running" || r.worker_id !== a.p_worker_id) return err("55000", "This analysis run is not running for this worker");
      Object.assign(r, { status: "Failed", completed_at: later(), error_category: a.p_category, error_message: a.p_message, diagnostics: a.p_diagnostics });
      return { data: [{ project_id: r.project_id, document_version_id: r.document_version_id }], error: null };
    }
  }
  return err("42883", `unknown function ${name}`);
}
serviceRoleModule.createServiceRoleClient = () => ({ from: builder, rpc: async (n, a) => rpc(n, a) });
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };

const call = async (handler, url, { body, token, method = "POST" } = {}) => {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await handler(new NextRequest(`http://localhost${url}`, method === "GET" ? { method, headers } : { method, headers, body: JSON.stringify(body ?? {}) }));
  return { status: res.status, body: await res.json() };
};
const IDENTITY = { prompt_version: "1.0.0", prompt_sha256: "a".repeat(64), analysis_schema_version: "1.0.0", worker_version: "0.2.0" };
const worker = (route, body, token = TOKEN) => call(workerRoutes[route].POST, `/api/worker/analysis/${route}`, { body, token });
const queue = (body) => call(analysisRoute.POST, "/api/source-documents/analysis", { body });
const proposal = (overrides = {}) => ({
  sequence: 1, proposed_title: "Keep the picker name", proposed_description: "The picker name must remain against the task after palletisation.",
  proposed_category: "UI", proposed_priority: null, source_fragment_ids: [fragA(2)], primary_source_fragment_id: fragA(2),
  source_quote: "The picker name must remain", rationale: "Directly stated.", evidence_basis: "Explicit", confidence: "High", consolidation: {}, ...overrides,
});
const issue = (overrides = {}) => ({
  sequence: 1, issue_type: "Missing Information", severity: "Medium", description: "Rework is not described.",
  suggested_question: "What happens on rework?", source_fragment_ids: [fragA(2)], related_proposal_sequences: [1], ...overrides,
});

// ── People: queue / retry / read ────────────────────────────────────────────

let runA;
await run("anon is refused; Viewer cannot start analysis or read runs", async () => {
  as(null);
  assert.equal((await queue({ project_id: P, version_id: V1 })).status, 401);
  assert.equal((await call(analysisRoute.GET, `/api/source-documents/analysis?project_id=${P}`, { method: "GET" })).status, 401);
  as("Viewer");
  const denied = await queue({ project_id: P, version_id: V1 });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Admin or Manager/);
  assert.equal((await call(analysisRoute.GET, `/api/source-documents/analysis?project_id=${P}`, { method: "GET" })).status, 403);
  assert.equal((await call(runsRoute.GET, `/api/analysis/runs?project_id=${P}&run_id=${JOB_A}`, { method: "GET" })).status, 403);
  assert.equal(db.analysis_runs.length, 0);
});

await run("Manager queues analysis; the run records the exact extraction job and the configured model (never from the request); audited", async () => {
  as("Manager");
  const res = await queue({ project_id: P, version_id: V1, extraction_job_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", model: "evil-model" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  runA = res.body.run;
  assert.equal(runA.extraction_job_id, JOB_A, "the server picks the version's newest completed extraction");
  assert.equal(runA.model, "qwen3:8b", "default model — the request's model is ignored");
  assert.equal(runA.status, "Queued");
  const a = db.audit_log.at(-1);
  assert.deepEqual([a.entity_type, a.entity_id, a.field_name, a.new_value, a.changed_by], ["analysis_runs", runA.id, "analysis", "Queued (model qwen3:8b)", U.Manager]);
});

await run("only one active analysis per extraction run", async () => {
  as("Admin");
  const again = await queue({ project_id: P, version_id: V1 });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already in progress/);
  assert.equal(db.analysis_runs.length, 1);
});

// ── Worker protocol ─────────────────────────────────────────────────────────

let claim;
await run("worker routes refuse browser sessions and revoked tokens; claim needs the prompt identity", async () => {
  as("Admin");
  assert.equal((await worker("claim", IDENTITY, null)).status, 401, "a browser session is not a worker");
  assert.equal((await worker("claim", IDENTITY, OTHER_TOKEN)).status, 401, "revoked token");
  assert.equal((await worker("claim", { worker_version: "0.2.0" })).status, 400);
});

await run("claim returns the run and ONLY the fragments of its extraction job — no canonical requirements (PL10 benchmark protection)", async () => {
  db.touched.clear();
  claim = await worker("claim", IDENTITY);
  assert.equal(claim.status, 200);
  assert.equal(claim.body.run.id, runA.id);
  assert.equal(claim.body.run.extraction_job_id, JOB_A);
  assert.deepEqual(claim.body.fragments.map((f) => f.sequence), [1, 2, 3]);
  assert.ok(claim.body.fragments.every((f) => !("project_id" in f) && !("text_hash" in f)), "only provenance + text");
  const payload = JSON.stringify(claim.body);
  assert.ok(!payload.includes(PL10_SENTINEL) && !payload.includes("REQ-001"), "canonical requirements are never part of AI input");
  assert.ok(!db.touched.has("requirements"), "the requirements table is not even read");
  const r = db.analysis_runs.find((x) => x.id === runA.id);
  assert.deepEqual([r.status, r.worker_id, r.prompt_version, r.analysis_schema_version, r.prompt_sha256], ["Running", "w1", "1.0.0", "1.0.0", "a".repeat(64)]);
});

await run("stage results are persisted (idempotently) and validated", async () => {
  const body = { run_id: runA.id, stage: "classification", chunk_key: "c01", input_hash: "b".repeat(64), attempts: 2, output: { fragments: [] } };
  assert.equal((await worker("stage", body)).body.stored, true);
  assert.equal((await worker("stage", body)).body.stored, false, "a repeat is a no-op");
  assert.equal((await worker("stage", { ...body, stage: "promotion" })).status, 400);
  assert.equal((await worker("stage", { ...body, output: "not an object" })).status, 400);
  assert.equal(db.analysis_stage_results.length, 1);
});

await run("fabricated fragment IDs are refused and nothing is stored", async () => {
  const before = db.requirement_proposals.length;
  const res = await worker("complete", { run_id: runA.id, proposals: [proposal({ source_fragment_ids: ["deadbeef-0000-4000-8000-000000000000"], primary_source_fragment_id: "deadbeef-0000-4000-8000-000000000000" })], issues: [] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not part of the analysed extraction run/);
  assert.equal(db.requirement_proposals.length, before);
});

await run("a proposal without provenance is refused", async () => {
  const res = await worker("complete", { run_id: runA.id, proposals: [proposal({ source_fragment_ids: [], primary_source_fragment_id: "" })], issues: [] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /provenance is required/);
});

await run("the analysis cannot choose review status or invent requirement references", async () => {
  const res = await worker("complete", { run_id: runA.id, proposals: [proposal({ review_status: "Approved", requirement_ref: "REQ-001" })], issues: [] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /review status and requirement references are not set by analysis/);
});

await run("another worker cannot complete a run it does not hold", async () => {
  db.worker_credentials.push({ id: "w2", name: "intruder", scope: "extraction", token_sha256: sha(`tmw_${"i".repeat(43)}`), revoked_at: null });
  const res = await worker("complete", { run_id: runA.id, proposals: [proposal()], issues: [] }, `tmw_${"i".repeat(43)}`);
  assert.equal(res.status, 409);
  db.worker_credentials.pop();
});

await run("valid output is persisted: proposals and issues separately; Inferred → Needs Review; counts; audited as the worker", async () => {
  const canonicalBefore = snapshot();
  const res = await worker("complete", {
    run_id: runA.id, model_digest: "500a1f067a9f", with_warnings: false, diagnostics: { warnings: [] },
    proposals: [proposal(), proposal({ sequence: 2, proposed_title: "Preserve other pick types", evidence_basis: "Inferred", confidence: "Low", source_fragment_ids: [fragA(2), fragA(1)] })],
    issues: [issue({ impact: ["data_migration", "test_design"], trigger_quote: "must remain", consolidation: { merged: true, members: [{ question: "a?", source_ids: [fragA(2)] }, { question: "b?", source_ids: [fragA(2)] }] } }), issue({ sequence: 2, issue_type: "Contradiction", severity: "Low", related_proposal_sequences: [] })],
    scope_notes: [{ sequence: 1, note_type: "No Change", area: "Other pick types", description: "Other pick types remain as they are.", source_quote: null, source_fragment_ids: [fragA(2)] }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.status, res.body.proposal_count, res.body.issue_count, res.body.scope_note_count], ["Completed", 2, 2, 1]);
  const props = db.requirement_proposals.filter((p) => p.analysis_run_id === runA.id);
  assert.deepEqual(props.map((p) => [p.evidence_basis, p.review_status]), [["Explicit", "Proposed"], ["Inferred", "Needs Review"]]);
  assert.ok(props.every((p) => !("requirement_ref" in p)));
  const stored = db.analysis_issues.filter((i) => i.analysis_run_id === runA.id);
  assert.equal(stored.length, 2);
  assert.deepEqual([stored[0].impact, stored[0].trigger_quote, stored[0].consolidation.members.length], [["data_migration", "test_design"], "must remain", 2], "impact, trigger and merge evidence kept");
  const notes = db.analysis_scope_notes.filter((n) => n.analysis_run_id === runA.id);
  assert.deepEqual(notes.map((n) => [n.note_type, n.area, n.source_fragment_ids]), [["No Change", "Other pick types", [fragA(2)]]], "scope notes stored separately, not as proposals");
  assert.equal(snapshot(), canonicalBefore, "canonical project data, documents and fragments untouched");
  const a = db.audit_log.at(-1);
  assert.equal(a.changed_by_name, "Analysis worker (mac-worker)");
  assert.equal(a.new_value, "Completed — 2 proposed requirements, 2 issues, 1 scope note (model qwen3:8b, prompts 1.0.0)");
});

await run("Manager reads the run list (counts only) and the run detail with provenance fragments", async () => {
  as("Manager");
  const list = await call(analysisRoute.GET, `/api/source-documents/analysis?project_id=${P}`, { method: "GET" });
  assert.equal(list.status, 200);
  const summary = list.body.runs.find((r) => r.id === runA.id);
  assert.deepEqual([summary.proposal_count, summary.open_issue_count], [2, 2]);
  assert.equal(list.body.configured_model, "qwen3:8b");
  const detail = await call(runsRoute.GET, `/api/analysis/runs?project_id=${P}&run_id=${runA.id}`, { method: "GET" });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.proposals.length, 2);
  assert.equal(detail.body.scope_notes.length, 1, "scope notes are returned for the workspace");
  assert.equal(detail.body.fragments.length, 3);
  assert.equal(detail.body.extraction_job.id, JOB_A);
  assert.equal((await call(runsRoute.GET, `/api/analysis/runs?project_id=${OTHER_P}&run_id=${runA.id}`, { method: "GET" })).status, 404, "scoped to its project");
});

// ── Re-extraction and history ──────────────────────────────────────────────

let jobB, runB;
await run("a later re-extraction does not affect the earlier analysis; the new extraction gets its own run", async () => {
  const before = JSON.stringify([db.analysis_runs.find((r) => r.id === runA.id), db.requirement_proposals.filter((p) => p.analysis_run_id === runA.id)]);
  jobB = uuid();
  db.extraction_jobs.push({ id: jobB, project_id: P, document_version_id: V1, status: "Completed", extractor_version: "1.3.0", completed_at: later(), fragment_count: 1 });
  db.source_fragments.push(fragment(jobB, 1, "The picker name must remain against the task after palletisation."));
  as("Manager");
  const res = await queue({ project_id: P, version_id: V1 });
  assert.equal(res.status, 200);
  runB = res.body.run;
  assert.equal(runB.extraction_job_id, jobB, "the newest completed extraction");
  const after = JSON.stringify([db.analysis_runs.find((r) => r.id === runA.id), db.requirement_proposals.filter((p) => p.analysis_run_id === runA.id)]);
  assert.equal(after, before, "run A and its proposals still point at extraction A, unchanged");
});

await run("run B cannot cite run A's extraction fragments", async () => {
  const c = await worker("claim", IDENTITY);
  assert.equal(c.body.run.id, runB.id);
  assert.deepEqual(c.body.fragments.map((f) => f.id), db.source_fragments.filter((f) => f.extraction_job_id === jobB).map((f) => f.id));
  const res = await worker("complete", { run_id: runB.id, proposals: [proposal()], issues: [] });
  assert.equal(res.status, 400, "fragment of extraction A is foreign to run B");
});

await run("a failure keeps a categorised, safe error; canonical data untouched; audited", async () => {
  const before = snapshot();
  const res = await worker("fail", { run_id: runB.id, error_category: "invalid_model_output", error_message: "  The model could not\nproduce valid output  ", diagnostics: { warnings: ["x"], secret_prompt: "SOURCE: confidential" } });
  assert.equal(res.status, 200);
  const r = db.analysis_runs.find((x) => x.id === runB.id);
  assert.deepEqual([r.status, r.error_category, r.error_message], ["Failed", "invalid_model_output", "The model could not produce valid output"]);
  assert.ok(!JSON.stringify(r.diagnostics).includes("confidential"), "only whitelisted diagnostics are kept");
  assert.equal(snapshot(), before, "source document, fragments and canonical data untouched");
  assert.equal(db.audit_log.at(-1).new_value, "Failed — invalid_model_output");
  const unknown = await worker("fail", { run_id: runB.id, error_category: "x" });
  assert.equal(unknown.status, 409, "already failed");
});

await run("manual retry creates a NEW run for the same extraction and reuses the failed run's stage results", async () => {
  db.analysis_stage_results.push({ id: uuid(), analysis_run_id: runB.id, stage: "classification", chunk_key: "c01", input_hash: "c".repeat(64), model: "qwen3:8b", prompt_version: "1.0.0", attempts: 1, output: { fragments: [] } });
  db.analysis_stage_results.push({ id: uuid(), analysis_run_id: runB.id, stage: "requirements", chunk_key: "c01", input_hash: "d".repeat(64), model: "qwen3:8b", prompt_version: "0.9.0", attempts: 1, output: { requirements: [] } });
  as("Viewer");
  assert.equal((await queue({ project_id: P, retry_of_run_id: runB.id })).status, 403);
  as("Manager");
  const res = await queue({ project_id: P, retry_of_run_id: runB.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const retry = res.body.run;
  assert.deepEqual([retry.trigger, retry.retry_of_run_id, retry.extraction_job_id], ["retry", runB.id, jobB]);
  assert.equal(db.analysis_runs.find((r) => r.id === runB.id).status, "Failed", "the failed run stays as history");
  assert.equal(db.audit_log.at(-1).new_value, "Queued (manual retry, model qwen3:8b)");
  const c = await worker("claim", IDENTITY);
  assert.equal(c.body.run.id, retry.id);
  assert.deepEqual(c.body.reusable_stages.map((s) => [s.run_id, s.stage]), [[runB.id, "classification"]], "only same model + prompt version results are offered");
});

await run("retry is only for failed runs of the same extraction", async () => {
  as("Manager");
  const res = await queue({ project_id: P, retry_of_run_id: runA.id });
  assert.ok([400, 409].includes(res.status), "run A completed; its extraction is not the retry's");
});

await run("a non-current version cannot be analysed", async () => {
  const V2 = uuid(), J2 = uuid();
  db.document_versions.push({ id: V2, document_id: D, project_id: P, version_number: 2, extraction_status: "Completed" });
  db.extraction_jobs.push({ id: J2, project_id: P, document_version_id: V2, status: "Completed", completed_at: later() });
  as("Manager");
  const res = await queue({ project_id: P, version_id: V2 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /current version/);
});

// ── Configuration and System Health ─────────────────────────────────────────

await run("heartbeat records a sanitised Ollama report; System Health shows Ollama, model and analysis queue (Manager/Admin)", async () => {
  const hb = await call(heartbeatRoute.POST, "/api/worker/heartbeat", {
    token: TOKEN,
    body: { worker_version: "0.2.0", extractor_version: "1.2.0", analysis_version: "1.0.0", ollama: { reachable: true, version: "0.34.2", models: [{ name: "qwen3:8b", digest: "500a1f067a9f", family: "qwen3", parameter_size: "8.2B" }, { name: "bad name; drop", digest: "x" }, { name: "nomic-embed-text:latest", family: "nomic-bert" }], prompt: "leak?" } },
  });
  assert.equal(hb.status, 200);
  const cred = db.worker_credentials.find((c) => c.id === "w1");
  assert.deepEqual(cred.last_seen_ollama.models.map((m) => m.name), ["qwen3:8b", "nomic-embed-text:latest"]);
  assert.ok(!("prompt" in cred.last_seen_ollama));
  assert.equal(cred.last_seen_analysis_version, "1.0.0");
  as("Viewer");
  assert.equal((await call(statusRoute.GET, "/api/worker/status", { method: "GET" })).status, 403);
  as("Manager");
  const status = await call(statusRoute.GET, "/api/worker/status", { method: "GET" });
  assert.equal(status.status, 200);
  const a = status.body.analysis;
  assert.deepEqual([a.ollama.reachable, a.ollama.version, a.configured_model, a.configured_model_installed, a.analysis_version], [true, "0.34.2", "qwen3:8b", true, "1.0.0"]);
  assert.deepEqual(a.queue, { queued: 0, running: 1, failed_24h: 1, completed_24h: 1 });
});

await run("only Admin can change the analysis model, and only to an installed model", async () => {
  as("Manager");
  assert.equal((await call(settingsRoute.PATCH, "/api/analysis/settings", { method: "PATCH", body: { model: "qwen3:4b" } })).status, 403);
  as("Admin");
  const missing = await call(settingsRoute.PATCH, "/api/analysis/settings", { method: "PATCH", body: { model: "llama3:70b" } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /not installed/);
  assert.equal((await call(settingsRoute.PATCH, "/api/analysis/settings", { method: "PATCH", body: { model: "rm -rf /" } })).status, 400);
  db.worker_credentials.find((c) => c.id === "w1").last_seen_ollama.models.push({ name: "qwen3:4b" });
  const ok = await call(settingsRoute.PATCH, "/api/analysis/settings", { method: "PATCH", body: { model: "qwen3:4b" } });
  assert.equal(ok.status, 200);
  assert.equal(db.ai_settings[0].analysis_model, "qwen3:4b");
  assert.equal(db.ai_settings[0].model, "qwen3:8b", "the conversational assistant's model is separate");
  const reset = await call(settingsRoute.PATCH, "/api/analysis/settings", { method: "PATCH", body: { model: null } });
  assert.deepEqual(reset.body, { analysis_model: "qwen3:8b", is_default: true });
});

// ── Shared validation ──────────────────────────────────────────────────────

await run("shared validation: scope notes need provenance; issue impacts must be known values", () => {
  const ids = new Set(["f1"]);
  const note = { sequence: 1, note_type: "No Change", area: "A", description: "No change required.", source_quote: "No change required.", source_fragment_ids: ["f1"] };
  assert.equal(shared.validateAnalysisSubmission([], [], ids, [note]).ok, true);
  const bad = shared.validateAnalysisSubmission([], [{ sequence: 1, issue_type: "Ambiguity", severity: "Low", description: "x", source_fragment_ids: ["f1"], impact: ["vibes"] }], ids, [{ ...note, source_fragment_ids: [] }, { ...note, sequence: 1, source_fragment_ids: ["zz"] }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /invalid impact/.test(p)));
  assert.ok(bad.problems.some((p) => /scope note 1: no source fragments/.test(p)));
  assert.ok(bad.problems.some((p) => /scope note 2: .*not part of the analysed extraction run/.test(p)));
});

await run("shared validation: duplicate sequences, bad enums and dangling issue→proposal links are refused", () => {
  const ids = new Set(["f1"]);
  const p = { sequence: 1, proposed_title: "t", proposed_description: "d", source_fragment_ids: ["f1"], primary_source_fragment_id: "f1", rationale: "r", evidence_basis: "Explicit", confidence: "High" };
  assert.equal(shared.validateAnalysisSubmission([p], [], ids).ok, true);
  const bad = shared.validateAnalysisSubmission([p, { ...p, confidence: "Certain", evidence_basis: "Guess" }], [{ sequence: 1, issue_type: "Ambiguity", severity: "Low", description: "x", source_fragment_ids: ["f1"], related_proposal_sequences: [9] }], ids);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((x) => /duplicate or invalid sequence/.test(x)));
  assert.ok(bad.problems.some((x) => /confidence/.test(x)) && bad.problems.some((x) => /evidence_basis/.test(x)));
  assert.ok(bad.problems.some((x) => /proposal that does not exist/.test(x)));
});

// ── Migration 038 ───────────────────────────────────────────────────────────

const m038 = code(read("supabase/migrations/038_requirement_analysis.sql"));
await run("038: runs pin one extraction job; one active run per extraction; runs, stages and generated content are history", () => {
  assert.match(m038, /FOREIGN KEY \(extraction_job_id, document_version_id, project_id\)\s+REFERENCES public\.extraction_jobs \(id, document_version_id, project_id\)/);
  assert.match(m038, /CREATE UNIQUE INDEX analysis_runs_one_active_per_extraction ON public\.analysis_runs \(extraction_job_id\) WHERE status IN \('Queued', 'Running'\)/);
  assert.match(m038, /RAISE EXCEPTION 'an analysis run cannot be moved to another extraction run or model'/);
  assert.match(m038, /RAISE EXCEPTION 'a finished analysis run cannot be changed'/);
  assert.match(m038, /RAISE EXCEPTION 'analysis stage results are immutable'/);
  assert.match(m038, /generated proposal content is immutable; only its review status may change/);
  assert.match(m038, /IF v_doc\.current_version_id <> v_version\.id THEN/);
  assert.match(m038, /IF v_job\.status <> 'Completed' THEN/);
});

await run("038: provenance, Inferred → Needs Review, no requirement references, statuses", () => {
  assert.match(m038, /source_fragment_ids\s+uuid\[\]\s+NOT NULL CHECK \(cardinality\(source_fragment_ids\) >= 1\)/);
  assert.match(m038, /CONSTRAINT requirement_proposals_primary_is_source CHECK \(primary_source_fragment_id = ANY \(source_fragment_ids\)\)/);
  assert.match(m038, /WHERE f\.id = ANY \(NEW\.source_fragment_ids\) AND f\.extraction_job_id = v_job;/);
  assert.match(m038, /CONSTRAINT requirement_proposals_inferred_needs_review CHECK \(evidence_basis <> 'Inferred' OR review_status <> 'Proposed'\)/);
  assert.match(m038, /CASE WHEN p\.v->>'evidence_basis' = 'Inferred' THEN 'Needs Review' ELSE 'Proposed' END/);
  assert.match(m038, /review_status\s+text\s+NOT NULL CHECK \(review_status IN \('Proposed', 'Needs Review', 'Approved', 'Rejected', 'Promoted', 'Superseded'\)\)/);
  assert.match(m038, /status\s+text\s+NOT NULL DEFAULT 'Open' CHECK \(status IN \('Open', 'Resolved', 'Accepted', 'Not Applicable'\)\)/);
  assert.doesNotMatch(m038, /requirement_ref/, "proposals carry no canonical reference");
});

await run("038: nothing touches canonical data or the version's status; Manager/Admin read only; service-role writes; anon nothing", () => {
  assert.doesNotMatch(m038, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(requirements|acceptance_criteria|test_cases|actions|risks|decisions|discovery_questions|project_snapshots|go_live_\w+|documents|document_versions|source_fragments|extraction_jobs)\b/);
  assert.doesNotMatch(m038, /analysis_status\s*=/, "document_versions.analysis_status is not driven by analysis");
  for (const t of ["analysis_runs", "requirement_proposals", "analysis_issues"]) assert.match(m038, new RegExp(`CREATE POLICY "${t}_select" ON public\\.${t} FOR SELECT TO authenticated USING \\(\\(SELECT public\\.can_write\\(\\)\\)\\)`));
  assert.match(m038, /REVOKE ALL ON public\.analysis_runs, public\.analysis_stage_results, public\.requirement_proposals, public\.analysis_issues FROM anon;/);
  assert.match(m038, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.analysis_runs, public\.requirement_proposals, public\.analysis_issues FROM authenticated;/);
  assert.match(m038, /EXECUTE format\('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn\);\s+EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO service_role', fn\);/);
  assert.ok(req("../lib/schema.ts").latestMigration >= "038_requirement_analysis");
});

const m039 = code(read("supabase/migrations/039_analysis_quality_hardening.sql"));
await run("039: scope notes are provenance-checked, immutable, Manager/Admin read only; issues gain impact/trigger/merge evidence", () => {
  assert.match(m039, /CREATE TABLE public\.analysis_scope_notes/);
  assert.match(m039, /source_fragment_ids uuid\[\]\s+NOT NULL CHECK \(cardinality\(source_fragment_ids\) >= 1\)/);
  assert.match(m039, /CREATE TRIGGER analysis_scope_notes_provenance BEFORE INSERT OR UPDATE OF source_fragment_ids ON public\.analysis_scope_notes\s+FOR EACH ROW EXECUTE FUNCTION public\.analysis_output_provenance_guard\(\);/);
  assert.match(m039, /CREATE TRIGGER analysis_scope_notes_immutable BEFORE UPDATE ON public\.analysis_scope_notes/);
  assert.match(m039, /CREATE POLICY "analysis_scope_notes_select" ON public\.analysis_scope_notes FOR SELECT TO authenticated USING \(\(SELECT public\.can_write\(\)\)\)/);
  assert.match(m039, /REVOKE ALL ON public\.analysis_scope_notes FROM anon;/);
  assert.match(m039, /ADD COLUMN IF NOT EXISTS impact text\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(m039, /CHECK \(stage IN \('classification', 'requirements', 'coverage', 'ambiguities', 'consolidation', 'source_check'\)\)/);
  assert.match(m039, /'\[\]'::jsonb, p_diagnostics, p_with_warnings\) c;/, "the 038 signature stays as a no-notes wrapper for deployed code");
  assert.doesNotMatch(m039, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(requirements|acceptance_criteria|test_cases|actions|risks|decisions|discovery_questions|documents|document_versions|source_fragments|extraction_jobs)\b/, "no canonical or source data touched");
  assert.doesNotMatch(m039, /UPDATE public\.(requirement_proposals|analysis_issues)\b|DROP TABLE|DELETE FROM public\.analysis/, "existing runs, proposals and issues are not rewritten");
  assert.equal(req("../lib/schema.ts").latestMigration, "039_analysis_quality_hardening");
});

// ── Code-level guarantees ───────────────────────────────────────────────────

await run("server analysis code never reads canonical tables and never calls an external AI provider", () => {
  const server = read("lib/requirement-analysis-server.ts").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(server, /from\("(requirements|acceptance_criteria|test_cases|actions|risks|decisions|discovery_questions)"\)/);
  assert.doesNotMatch(server, /openai|anthropic|gemini|generativelanguage|fetch\(/i, "the server only orchestrates; the model runs on the worker");
});

// ── UI ─────────────────────────────────────────────────────────────────────

await run("UI: Source Documents shows Analyse / status / counts / Review analysis for Manager/Admin only", () => {
  const page = read("components/source-documents-page.tsx");
  assert.match(page, /if \(!mayViewAnalysis \|\| !version\) return <span className="text-xs text-muted-foreground">—<\/span>;/, "Viewer sees no analysis state");
  assert.match(page, /const canStart = mayAnalyse && isCurrent && Boolean\(success\) && !isActiveAnalysis\(latest\);/);
  assert.match(page, /\{latest \? "Analyse latest extraction" : "Analyse document"\}/);
  assert.match(page, /proposed requirement\{lastCompleted\.proposal_count === 1 \? "" : "s"\} · \{lastCompleted\.open_issue_count\} open issue/);
  assert.match(page, /Review analysis/);
  assert.match(page, /Retry analysis/);
  assert.match(page, /if \(!mayViewAnalysis \|\| !analysisProjectId\) return;/, "Viewers never request analysis runs");
  assert.doesNotMatch(page, /requirement_proposals|proposed_title/, "no proposal review in the Source Documents row");
});

await run("UI: the workspace is Manager/Admin only, shows provenance, and cannot promote anything", () => {
  const ws = read("components/requirement-analysis-page.tsx");
  assert.match(ws, /if \(!mayView\) \{\n\s+return <AppShell><EmptyState title="Manager or Admin access required"/);
  for (const tab of ["Overview", "Source", "Proposed Requirements", "Issues", "Scope & Regression Notes"]) assert.match(ws, new RegExp(`label: "${tab}"`));
  assert.match(ws, /Raised by: “\{i\.trigger_quote\}”/);
  assert.match(ws, /This run used analysis schema 1\.0\.0, which did not record scope notes\./, "older runs stay readable");
  assert.match(ws, /Open original\{isPdf && focused\.page_start \? ` at page \$\{focused\.page_start\}` : ""\}/);
  assert.match(ws, /p\.evidence_basis === "Explicit" \? "ok" : "warn"/);
  assert.doesNotMatch(ws, /saveRecord|\/api\/requirements|Promote|Approve/, "no canonical writes or promotion in Phase 1C");
});

await run("UI: System Health shows Ollama, the analysis model and queue; only Admin can change the model", () => {
  const health = read("components/extraction-worker-health.tsx");
  assert.match(health, /<Tile label="Ollama"/);
  assert.match(health, /<Tile label="Analysis model"/);
  assert.match(health, /<Tile label="Analyses failed \(24h\)"/);
  assert.match(health, /\{isAdmin \? \(\n\s+<label className="mt-3 flex flex-wrap items-center gap-2 text-sm">/);
  assert.match(read("components/audit-trail-page.tsx"), /analysis_runs: "Analysis Run"/);
});

console.log("\nAll Phase 1C requirement-analysis tests passed.\n");
