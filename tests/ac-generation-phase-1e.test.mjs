// Phase 1E — AI Acceptance Criteria generation (generation only). REAL
// route handlers, role guards and server orchestration; only the session
// lookup and the service-role client are stubbed, the latter mirroring
// migration 043's functions (eligibility + exact input, one active run,
// claim/lease, provenance-checked completion, review status decided by the
// database, immutable output). The migration itself was validated against
// the live database (SOMCR038, promoted inside a rolled-back transaction).
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
const shared = req("../lib/ac-generation.ts");
const route = req("../app/api/requirements/ac-generation/route.ts");
const workerRoutes = Object.fromEntries(["claim", "stage", "complete", "fail"].map((r) => [r, req(`../app/api/worker/ac-generation/${r}/route.ts`)]));
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
const [ARUN, JOB] = [uuid(), uuid()];
const [F1, F2, F_OTHER] = [uuid(), uuid(), uuid()];
const [REQ_PROMOTED, REQ_MANUAL, REQ_SIGNED, REQ_BROKEN] = [uuid(), uuid(), uuid(), uuid()];
const [PROP, PROP_SIGNED, PROP_BROKEN, PROP_APPROVED] = [uuid(), uuid(), uuid(), uuid()];
const [I_RESOLVED, I_OPEN, I_UNRELATED, I_ADMIN, I_SHARED] = [uuid(), uuid(), uuid(), uuid(), uuid()];
const [N_ACK, N_UNACK, N_OTHER, N_CHANGE] = [uuid(), uuid(), uuid(), uuid()];
const REQ_SIBLING = uuid(), PROP_SIBLING = uuid(), I_SIBLING = uuid();

// ── In-memory service-role stand-in (mirrors migration 043) ────────────────
let session = null;
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  worker_credentials: [{ id: "w1", name: "mac-worker", scope: "extraction", token_sha256: sha(TOKEN), revoked_at: null }],
  projects: [{ id: P }, { id: OTHER_P }],
  documents: [{ id: "doc1", project_id: P, document_name: "PL10 Spec", document_type: "Functional Specification" }],
  document_versions: [{ id: "ver1", document_id: "doc1", project_id: P, version_number: 2, original_filename: "spec.pdf" }],
  extraction_jobs: [{ id: JOB, project_id: P, document_version_id: "ver1", extractor_version: "1.2.0" }],
  analysis_runs: [{ id: ARUN, project_id: P, document_id: "doc1", document_version_id: "ver1", extraction_job_id: JOB }],
  source_fragments: [
    { id: F1, extraction_job_id: JOB, sequence: 3, fragment_type: "text", section_heading: "Rules", section_number: null, section_path: ["Spec", "Rules"], page_start: 1, page_end: 1, text: "The picker name must remain against the pick task. MONO picks remain as they are. The palletiser name stays on the palletised task. FULL PALLET picks remain as they are.", metadata: {} },
    { id: F2, extraction_job_id: JOB, sequence: 8, fragment_type: "text", section_heading: "Change", section_number: null, section_path: ["Spec", "Change"], page_start: 2, page_end: 2, text: "We require the picker name to remain.", metadata: {} },
    { id: F_OTHER, extraction_job_id: JOB, sequence: 9, fragment_type: "text", section_heading: "Other", section_number: null, section_path: ["Spec", "Other"], page_start: 3, page_end: 3, text: "Unrelated requirement about colour.", metadata: {} },
  ],
  requirement_proposals: [
    { id: PROP, analysis_run_id: ARUN, project_id: P, sequence: 1, origin: "ai", parent_proposal_ids: [], proposed_title: "Picker name remains", proposed_description: "The picker name must remain against the pick task.", reviewed_title: null, reviewed_description: "The picker name must remain against the pick task. MONO picks remain as they are.", source_quote: "The picker name must remain against the pick task.", consolidation: {}, evidence_basis: "Explicit", source_fragment_ids: [F1, F2], review_status: "Promoted", promoted_record_id: REQ_PROMOTED },
    { id: PROP_SIGNED, analysis_run_id: ARUN, project_id: P, sequence: 2, origin: "ai", parent_proposal_ids: [], proposed_title: "Signed", proposed_description: "d", source_fragment_ids: [F1], review_status: "Promoted", promoted_record_id: REQ_SIGNED, consolidation: {} },
    { id: PROP_BROKEN, analysis_run_id: ARUN, project_id: P, sequence: 3, origin: "ai", parent_proposal_ids: [], proposed_title: "Broken", proposed_description: "d", source_fragment_ids: [uuid()], review_status: "Promoted", promoted_record_id: REQ_BROKEN, consolidation: {} },
    { id: PROP_SIBLING, analysis_run_id: ARUN, project_id: P, sequence: 5, origin: "ai", parent_proposal_ids: [], proposed_title: "Palletiser name stays", proposed_description: "The palletiser name stays on the palletised task.", source_quote: "The palletiser name stays on the palletised task.", source_fragment_ids: [F1], review_status: "Promoted", promoted_record_id: REQ_SIBLING, consolidation: {} },
    { id: PROP_APPROVED, analysis_run_id: ARUN, project_id: P, sequence: 4, origin: "ai", parent_proposal_ids: [], proposed_title: "Approved, not promoted", proposed_description: "d", source_fragment_ids: [F1], review_status: "Approved", promoted_record_id: null, consolidation: {} },
  ],
  analysis_issues: [
    { id: I_RESOLVED, analysis_run_id: ARUN, sequence: 1, issue_type: "Ambiguity", suggested_question: "Which picker is kept?", description: "d", status: "Resolved", resolution_note: "Keep the first picker.", related_proposal_sequences: [1], source_fragment_ids: [F1], reviewed_by_name: "Manager User" },
    { id: I_OPEN, analysis_run_id: ARUN, sequence: 2, issue_type: "Missing Information", suggested_question: "What about repeated palletisation?", description: "d", status: "Open", resolution_note: null, related_proposal_sequences: [], source_fragment_ids: [F2], trigger_quote: "The picker name must remain against the pick task." },
    // Tied to no proposal; shares fragment F1 but its trigger is another requirement's sentence.
    { id: I_SHARED, analysis_run_id: ARUN, sequence: 5, issue_type: "Missing Information", suggested_question: "What are FULL PALLET picks?", description: "d", status: "Open", resolution_note: null, related_proposal_sequences: [], source_fragment_ids: [F1], trigger_quote: "FULL PALLET picks remain as they are." },
    // Tied to the sibling proposal only.
    { id: I_SIBLING, analysis_run_id: ARUN, sequence: 6, issue_type: "Ambiguity", suggested_question: "Which palletised task keeps the palletiser name?", description: "d", status: "Open", resolution_note: null, related_proposal_sequences: [5], source_fragment_ids: [F1] },
    { id: I_UNRELATED, analysis_run_id: ARUN, sequence: 3, issue_type: "Missing Information", suggested_question: "Which colours?", description: "d", status: "Open", resolution_note: null, related_proposal_sequences: [4], source_fragment_ids: [F1] },
    { id: I_ADMIN, analysis_run_id: ARUN, sequence: 4, issue_type: "Out of Scope / Administrative Content", suggested_question: "x", description: "d", status: "Open", resolution_note: null, related_proposal_sequences: [], source_fragment_ids: [F1] },
  ],
  analysis_scope_notes: [
    { id: N_ACK, analysis_run_id: ARUN, sequence: 1, note_type: "No Change", area: "MONO picks", description: "MONO picks remain as they are.", source_quote: "MONO picks remain as they are.", source_fragment_ids: [F1], acknowledged_at: "2026-09-30", acknowledgement_note: null, acknowledged_by_name: "Manager User" },
    { id: N_UNACK, analysis_run_id: ARUN, sequence: 2, note_type: "No Change", area: "FULL PALLET", description: "FULL PALLET picks remain as they are.", source_fragment_ids: [F1], acknowledged_at: null },
    { id: N_OTHER, analysis_run_id: ARUN, sequence: 3, note_type: "No Change", area: "Goods In", description: "Goods In remains.", source_fragment_ids: [F_OTHER], acknowledged_at: "2026-09-30" },
    // Change-level: acknowledged, shares the fragment, but part of no Requirement's own statement.
    { id: N_CHANGE, analysis_run_id: ARUN, sequence: 4, note_type: "No Change", area: "FULL PALLET picks", description: "FULL PALLET picks remain as they are.", source_quote: "FULL PALLET picks remain as they are.", source_fragment_ids: [F1], acknowledged_at: "2026-09-30" },
  ],
  requirements: [
    { id: REQ_PROMOTED, project_id: P, requirement_ref: "REP-008", title: "Picker name remains", description: "The picker name must remain against the pick task.", category: "Business Rule", priority: "High", status: "Discovery" },
    { id: REQ_MANUAL, project_id: P, requirement_ref: "REP-001", title: "Manual", description: "Manual requirement", category: "UI", priority: "Low", status: "Open" },
    { id: REQ_SIGNED, project_id: P, requirement_ref: "REP-009", title: "Signed", description: "d", status: "Approved" },
    { id: REQ_BROKEN, project_id: P, requirement_ref: "REP-010", title: "Broken", description: "d", status: "Discovery" },
    { id: REQ_SIBLING, project_id: P, requirement_ref: "REP-011", title: "Palletiser name stays", description: "The palletiser name stays on the palletised task.", status: "Discovery" },
  ],
  // Canonical ACs: Phase 1E must never touch them.
  acceptance_criteria: [{ id: uuid(), project_id: P, requirement_id: REQ_MANUAL, ac_ref: "AC-001", criterion: "Existing manual AC", status: "Met" }],
  ac_generation_runs: [], ac_generation_stage_results: [], acceptance_criterion_proposals: [], ac_generation_issues: [], ai_settings: [], audit_log: [],
};
const canonicalSnapshot = JSON.stringify({ ac: db.acceptance_criteria, requirements: db.requirements, proposals: db.requirement_proposals, issues: db.analysis_issues, notes: db.analysis_scope_notes });

function builder(table) {
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : kind === "is" ? (r[k] ?? null) === v : r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), ...r })); db[table].push(...list); return list; }
    if (q.op === "update") { const hit = rows().filter(matches); hit.forEach((r) => Object.assign(r, q.payload)); return hit; }
    return rows().filter(matches).map((r) => ({ ...r }));
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; }, is(k, v) { q.filters.push([k, v, "is"]); return b; },
    order() { return b; }, limit() { return b; }, gte() { return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }), single: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve) { return Promise.resolve({ data: exec(), error: null }).then(resolve); },
  };
  return b;
}
const err = (code, message) => ({ data: null, error: { code, message } });
const overlap = (a, b) => a.some((x) => b.includes(x));

function acInput(projectId, requirementId) {
  const r = db.requirements.find((x) => x.id === requirementId && x.project_id === projectId);
  if (!r) throw Object.assign(new Error("Requirement not found in this project"), { code: "P0002" });
  const out = { eligible: false, reason: null, requirement_proposal_id: null };
  const p = db.requirement_proposals.find((x) => x.promoted_record_id === r.id && x.project_id === projectId && x.review_status === "Promoted");
  if (!p) return { ...out, reason: "Only Requirements promoted from an approved AI proposal can generate acceptance criteria (manually-created Requirements are not supported yet)." };
  out.requirement_proposal_id = p.id;
  if (["approved", "complete", "closed"].includes(String(r.status).trim().toLowerCase())) return { ...out, reason: `This Requirement is ${r.status} (signed off); acceptance criteria are generated only for Requirements still in progress.` };
  const run = db.analysis_runs.find((x) => x.id === p.analysis_run_id);
  const found = db.source_fragments.filter((f) => p.source_fragment_ids.includes(f.id) && f.extraction_job_id === run?.extraction_job_id);
  if (!run || found.length !== new Set(p.source_fragment_ids).size) return { ...out, reason: "The promoted proposal's source provenance is incomplete, so acceptance criteria cannot be generated safely." };
  const lineage = [p.sequence];
  // Migration 044: lineage, or (no proposal) a trigger sentence that is part of THIS Requirement's own statement.
  const norm = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const own = norm([p.source_quote, p.reviewed_description ?? p.proposed_description].filter(Boolean).join(" ¦ "));
  const partOfOwn = (t) => norm(t).length >= 8 && own.includes(norm(t));
  const related = (i) => i.analysis_run_id === p.analysis_run_id && i.issue_type !== "Out of Scope / Administrative Content"
    && (overlap(i.related_proposal_sequences, lineage) || (i.related_proposal_sequences.length === 0 && partOfOwn(i.trigger_quote)));
  const clar = db.analysis_issues.filter((i) => related(i) && ["Resolved", "Accepted"].includes(i.status) && String(i.resolution_note ?? "").trim());
  const open = db.analysis_issues.filter((i) => related(i) && (i.status === "Open" || (i.status === "Accepted" && !String(i.resolution_note ?? "").trim())));
  const notes = db.analysis_scope_notes.filter((n) => n.analysis_run_id === p.analysis_run_id && n.acknowledged_at && overlap(n.source_fragment_ids, p.source_fragment_ids) && partOfOwn(n.source_quote ?? n.description));
  const snapshot = {
    requirement: { id: r.id, ref: r.requirement_ref, title: r.title, description: r.description, category: r.category, priority: r.priority, status: r.status },
    proposal: { id: p.id, sequence: p.sequence, origin: p.origin, title: p.reviewed_title ?? p.proposed_title, description: p.reviewed_description ?? p.proposed_description, original_title: p.proposed_title, original_description: p.proposed_description, edited: false, source_quote: p.source_quote, source_quotes: [p.source_quote].filter(Boolean) },
    document: { id: "doc1", name: "PL10 Spec", type: "Functional Specification" }, version: { id: "ver1", version_number: 2, original_filename: "spec.pdf" }, extraction_job: { id: JOB, extractor_version: "1.2.0" },
    fragment_ids: p.source_fragment_ids,
    clarifications: clar.map((i) => ({ id: i.id, sequence: i.sequence, issue_type: i.issue_type, question: i.suggested_question, description: i.description, status: i.status, resolution_note: i.resolution_note, reviewed_by_name: i.reviewed_by_name ?? null, reviewed_at: null })),
    open_questions: open.map((i) => ({ id: i.id, sequence: i.sequence, issue_type: i.issue_type, question: i.suggested_question, description: i.description, status: i.status })),
    scope_notes: notes.map((n) => ({ id: n.id, sequence: n.sequence, note_type: n.note_type, area: n.area, description: n.description, source_quote: n.source_quote ?? null, acknowledgement_note: n.acknowledgement_note ?? null, acknowledged_by_name: n.acknowledged_by_name ?? null })),
  };
  return { eligible: true, reason: null, requirement_proposal_id: p.id, analysis_run_id: run.id, extraction_job_id: run.extraction_job_id, allowed_fragment_ids: [...p.source_fragment_ids],
    clarification_issue_ids: clar.map((i) => i.id), open_issue_ids: open.map((i) => i.id), scope_note_ids: notes.map((n) => n.id), snapshot };
}
function owner(runId, workerId) {
  const r = db.ac_generation_runs.find((x) => x.id === runId);
  if (!r || r.status !== "Running" || r.worker_id !== workerId) throw Object.assign(new Error("This generation run is not running for this worker"), { code: "55000" });
  return r;
}
function rpc(name, a) {
  try {
    switch (name) {
      case "ac_generation_input": return { data: [acInput(a.p_project_id, a.p_requirement_id)], error: null };
      case "queue_ac_generation_run": {
        const input = acInput(a.p_project_id, a.p_requirement_id);
        if (!input.eligible) return err("55000", input.reason);
        if (db.ac_generation_runs.some((r) => r.requirement_id === a.p_requirement_id && ["Queued", "Running"].includes(r.status))) return err("23505", "Acceptance criteria generation is already in progress for this Requirement");
        if (a.p_retry_of_run_id) {
          const prior = db.ac_generation_runs.find((r) => r.id === a.p_retry_of_run_id && r.project_id === a.p_project_id);
          if (!prior || prior.requirement_id !== a.p_requirement_id) return err("22023", "The run to retry does not belong to this Requirement");
          if (prior.status !== "Failed") return err("55000", "Only a failed generation run can be retried");
        }
        const row = { id: uuid(), project_id: a.p_project_id, requirement_id: a.p_requirement_id, requirement_proposal_id: input.requirement_proposal_id, analysis_run_id: input.analysis_run_id,
          extraction_job_id: input.extraction_job_id, status: "Queued", trigger: a.p_retry_of_run_id ? "retry" : "manual", retry_of_run_id: a.p_retry_of_run_id, requested_by_name: a.p_user_name,
          queued_at: new Date(Date.now() + seq).toISOString(), attempt_count: 0, model: a.p_model, input_snapshot: input.snapshot, input_sha256: sha(JSON.stringify(input.snapshot)),
          allowed_fragment_ids: input.allowed_fragment_ids, clarification_issue_ids: input.clarification_issue_ids, open_issue_ids: input.open_issue_ids, scope_note_ids: input.scope_note_ids, worker_id: null, prompt_version: null };
        db.ac_generation_runs.push(row);
        return { data: [{ run_id: row.id, trigger: row.trigger, input_sha256: row.input_sha256 }], error: null };
      }
      case "claim_ac_generation_run": {
        const r = db.ac_generation_runs.filter((x) => x.status === "Queued").sort((x, y) => x.queued_at.localeCompare(y.queued_at))[0];
        if (!r) return { data: [], error: null };
        Object.assign(r, { status: "Running", attempt_count: r.attempt_count + 1, worker_id: a.p_worker_id, prompt_version: a.p_prompt_version, prompt_sha256: a.p_prompt_sha256, schema_version: a.p_schema_version });
        return { data: [{ ...r }], error: null };
      }
      case "record_ac_generation_stage": {
        const r = owner(a.p_run_id, a.p_worker_id);
        if (db.ac_generation_stage_results.some((s) => s.generation_run_id === r.id && s.stage === a.p_stage && s.chunk_key === a.p_chunk_key)) return { data: false, error: null };
        db.ac_generation_stage_results.push({ generation_run_id: r.id, stage: a.p_stage, chunk_key: a.p_chunk_key, input_hash: a.p_input_hash, model: r.model, prompt_version: r.prompt_version, output: a.p_output });
        return { data: true, error: null };
      }
      case "complete_ac_generation_run": {
        const r = owner(a.p_run_id, a.p_worker_id);
        for (const p of a.p_proposals) {
          // The 043 guard: cited ids ⊆ the run's sets.
          if (!p.source_fragment_ids.every((x) => r.allowed_fragment_ids.includes(x))) return err("22023", "every cited source fragment must be one supplied to the generation run");
        }
        const status = (p) => (p.basis === "Inferred" || p.confidence === "Low" || p.open_issue_ids.length || p.needs_review_reasons.length ? "Needs Review" : "Proposed");
        db.acceptance_criterion_proposals.push(...a.p_proposals.map((p, i) => ({ id: uuid(), generation_run_id: r.id, project_id: r.project_id, requirement_id: r.requirement_id, ...p, sequence: i + 1, review_status: status(p) })));
        db.ac_generation_issues.push(...a.p_issues.map((x, i) => ({ id: uuid(), generation_run_id: r.id, project_id: r.project_id, requirement_id: r.requirement_id, ...x, sequence: i + 1, status: "Open" })));
        const nr = db.acceptance_criterion_proposals.filter((p) => p.generation_run_id === r.id && p.review_status === "Needs Review").length;
        Object.assign(r, { status: a.p_with_warnings ? "Completed with warnings" : "Completed", proposal_count: a.p_proposals.length, issue_count: a.p_issues.length, needs_review_count: nr, completed_at: "now" });
        return { data: [{ project_id: r.project_id, requirement_id: r.requirement_id, status: r.status, proposal_count: r.proposal_count, issue_count: r.issue_count, needs_review_count: nr }], error: null };
      }
      case "fail_ac_generation_run": {
        const r = owner(a.p_run_id, a.p_worker_id);
        Object.assign(r, { status: "Failed", error_category: a.p_category, error_message: a.p_message, completed_at: "now" });
        return { data: [{ project_id: r.project_id, requirement_id: r.requirement_id }], error: null };
      }
    }
  } catch (e) { return err(e.code ?? "P0001", e.message); }
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
const read1 = (requirementId) => call(route.GET, `/api/requirements/ac-generation?project_id=${P}&requirement_id=${requirementId}`, { method: "GET" });
const queue = (requirementId, extra = {}) => call(route.POST, "/api/requirements/ac-generation", { body: { project_id: P, requirement_id: requirementId, ...extra } });
const IDENTITY = { ac_prompt_version: "1.0.0", ac_prompt_sha256: "a".repeat(64), ac_schema_version: "1.0.0" };
const worker = (r, body, token = TOKEN) => call(workerRoutes[r].POST, `/api/worker/ac-generation/${r}`, { body, token });
const lastAudit = () => db.audit_log.at(-1);
const proposalOf = (o = {}) => ({ sequence: 1, criterion: "After palletisation the dashboard shows the picker name against the pick task.", given_text: null, when_text: null, then_text: null,
  criterion_type: "Positive", basis: "Explicit", confidence: "High", needs_review_reasons: [], source_fragment_ids: [F1], scope_note_ids: [], clarification_issue_ids: [], open_issue_ids: [],
  source_quote: "The picker name must remain against the pick task.", rationale: "Stated.", obligations: [], consolidation: {}, ...o });

// ── Permissions ─────────────────────────────────────────────────────────────

await run("anon and Viewer can neither read generation nor start it; Manager and Admin can", async () => {
  for (const [role, status] of [[null, 401], ["Viewer", 403]]) {
    as(role);
    assert.equal((await read1(REQ_PROMOTED)).status, status, `${role ?? "anon"} read`);
    assert.equal((await queue(REQ_PROMOTED)).status, status, `${role ?? "anon"} start`);
    assert.equal((await call(route.GET, `/api/requirements/ac-generation?project_id=${P}&run_id=${uuid()}`, { method: "GET" })).status, status, `${role ?? "anon"} proposals`);
  }
  assert.equal(db.ac_generation_runs.length, 0);
  for (const role of ["Manager", "Admin"]) { as(role); assert.equal((await read1(REQ_PROMOTED)).status, 200, role); }
  // Worker routes accept only the worker token.
  as("Admin");
  assert.equal((await worker("claim", IDENTITY, null)).status, 401);
});

// ── Eligibility ─────────────────────────────────────────────────────────────

await run("only a promoted, not signed-off Requirement with intact provenance is eligible; manual Requirements are silent", async () => {
  as("Manager");
  const promoted = (await read1(REQ_PROMOTED)).body;
  assert.deepEqual(promoted.eligibility, { eligible: true, reason: null, promoted: true });
  assert.deepEqual(promoted.context, { clarifications: 1, open_questions: 1, scope_notes: 1 });
  const manual = (await read1(REQ_MANUAL)).body.eligibility;
  assert.deepEqual([manual.eligible, manual.promoted], [false, false]);
  assert.match(manual.reason, /manually-created Requirements are not supported yet/);
  assert.match((await read1(REQ_SIGNED)).body.eligibility.reason, /Approved \(signed off\)/);
  assert.match((await read1(REQ_BROKEN)).body.eligibility.reason, /source provenance is incomplete/);
  for (const r of [REQ_MANUAL, REQ_SIGNED, REQ_BROKEN]) assert.equal((await queue(r)).status, 409, "ineligible cannot be queued");
  assert.equal((await call(route.GET, `/api/requirements/ac-generation?project_id=${OTHER_P}&requirement_id=${REQ_PROMOTED}`, { method: "GET" })).status, 404, "project scoped");
  assert.equal(db.ac_generation_runs.length, 0);
});

await run("an Approved-but-unpromoted proposal never makes anything eligible (raw proposals cannot generate)", async () => {
  assert.equal(db.requirement_proposals.find((p) => p.id === PROP_APPROVED).promoted_record_id, null);
  assert.ok(!db.requirements.some((r) => db.requirement_proposals.some((p) => p.id === PROP_APPROVED && p.promoted_record_id === r.id)));
  const m043 = code(read("supabase/migrations/043_ac_generation.sql"));
  assert.match(m043, /WHERE p\.promoted_record_id = v_req\.id AND p\.project_id = p_project_id AND p\.review_status = 'Promoted';/);
});

// ── Queue → claim → complete ───────────────────────────────────────────────

let runId;
await run("Manager queues generation: one active run per Requirement, model from configuration, audited", async () => {
  as("Manager");
  const res = await queue(REQ_PROMOTED, { model: "evil-model" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  runId = res.body.run.id;
  assert.deepEqual([res.body.run.status, res.body.run.trigger, res.body.run.model], ["Queued", "manual", "qwen3:8b"], "the request cannot choose the model");
  assert.deepEqual([lastAudit().entity_type, lastAudit().action_type, lastAudit().entity_name, lastAudit().new_value], ["ac_generation_runs", "Status Change", "REP-008 — acceptance criteria generation", "Queued (model qwen3:8b)"]);
  assert.equal((await queue(REQ_PROMOTED)).status, 409, "already in progress");
});

await run("the worker receives exactly the Requirement's provenance: its own fragments, related clarification/question, acknowledged related note", async () => {
  const res = await worker("claim", IDENTITY);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const c = res.body;
  assert.equal(c.run.id, runId);
  assert.deepEqual(c.fragments.map((f) => f.id).sort(), [F1, F2].sort(), "the unrelated fragment of the same extraction is excluded");
  assert.deepEqual(c.clarifications.map((x) => [x.id, x.resolution_note]), [[I_RESOLVED, "Keep the first picker."]]);
  assert.deepEqual(c.open_questions.map((x) => x.id), [I_OPEN], "tied to no proposal and raised by its own sentence → included; sharing a fragment only, another proposal's issue, admin content → excluded");
  assert.deepEqual(c.scope_notes.map((x) => x.id), [N_ACK], "a note that is part of its statement is supplied; unacknowledged, unrelated and change-level notes are not");
  assert.equal(c.requirement.ref, "REP-008");
  assert.ok(!JSON.stringify(c).includes("Existing manual AC"), "canonical ACs are never sent to the model");
  assert.equal((await worker("claim", IDENTITY)).body.run, null, "nothing else queued");
});

await run("completion is re-validated on the server: fabricated ids, missing provenance and model-chosen status are refused, nothing stored", async () => {
  const badRelation = await worker("complete", { run_id: runId, proposals: [proposalOf()], issues: [{ sequence: 1, issue_type: "Unresolved Existing Analysis Issue", severity: "Low", relation: "Maybe", description: "d", source_fragment_ids: [], analysis_issue_ids: [] }], diagnostics: {} });
  assert.equal(badRelation.status, 400);
  assert.match(badRelation.body.error, /relation must be Blocking, Additional Coverage or Informational/);
  for (const bad of [proposalOf({ source_fragment_ids: [F_OTHER] }), proposalOf({ source_fragment_ids: [] }), proposalOf({ review_status: "Approved" }), proposalOf({ ac_ref: "AC-002" }), proposalOf({ open_issue_ids: [I_UNRELATED] })]) {
    const res = await worker("complete", { run_id: runId, proposals: [bad], issues: [], diagnostics: {}, with_warnings: false });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(db.acceptance_criterion_proposals.length, 0);
  assert.equal(db.ac_generation_runs.find((r) => r.id === runId).status, "Running");
});

await run("a valid completion stores proposals (the database sets Needs Review), issues and an audit row — canonical data untouched", async () => {
  const proposals = [
    proposalOf(),
    proposalOf({ sequence: 2, criterion: "MONO picks behave as before.", criterion_type: "Regression", source_fragment_ids: [], scope_note_ids: [N_ACK], source_quote: null }),
    proposalOf({ sequence: 3, criterion: "Depends on the open question.", open_issue_ids: [I_OPEN], needs_review_reasons: ["Depends on an open question."] }),
    proposalOf({ sequence: 4, criterion: "Relies on the clarification.", source_fragment_ids: [], clarification_issue_ids: [I_RESOLVED], source_quote: null }),
  ];
  const issues = [{ sequence: 1, issue_type: "Unresolved Existing Analysis Issue", severity: "Medium", relation: "Blocking", description: "Open question.", obligation: null, suggested_question: null, source_fragment_ids: [], analysis_issue_ids: [I_OPEN] }];
  const res = await worker("complete", { run_id: runId, model_digest: "500a1f067a9f", proposals, issues, diagnostics: { warnings: [] }, with_warnings: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(db.acceptance_criterion_proposals.map((p) => p.review_status), ["Proposed", "Proposed", "Needs Review", "Proposed"]);
  assert.ok(db.acceptance_criterion_proposals.every((p) => !("ac_ref" in p)));
  assert.equal(db.ac_generation_issues[0].relation, "Blocking");
  assert.equal(lastAudit().new_value, "Completed — 4 proposed acceptance criteria, 1 needing review, 1 generation issue (model qwen3:8b, AC prompts 1.0.0)");
  assert.equal(JSON.stringify({ ac: db.acceptance_criteria, requirements: db.requirements, proposals: db.requirement_proposals, issues: db.analysis_issues, notes: db.analysis_scope_notes }), canonicalSnapshot,
    "canonical ACs, Requirements and Phase 1C/1D history unchanged");
  as("Manager");
  const detail = await call(route.GET, `/api/requirements/ac-generation?project_id=${P}&run_id=${runId}`, { method: "GET" });
  assert.deepEqual([detail.body.proposals.length, detail.body.issues.length, detail.body.fragments.map((f) => f.id).sort()], [4, 1, [F1, F2].sort()]);
  assert.equal(shared.acGenerationSummary(detail.body.run), "4 proposed Acceptance Criteria · 2 items need review");
});

await run("failure and retry: a failed run is retried as a NEW run with the same input; the failure changes no data", async () => {
  as("Admin");
  const second = (await queue(REQ_PROMOTED)).body.run.id;
  await worker("claim", IDENTITY);
  const before = db.acceptance_criterion_proposals.length;
  assert.equal((await worker("fail", { run_id: second, error_category: "ollama_unreachable", error_message: "Ollama is not reachable." })).status, 200);
  assert.equal(lastAudit().new_value, "Failed — ollama_unreachable");
  assert.equal(db.acceptance_criterion_proposals.length, before);
  assert.equal((await queue(REQ_PROMOTED, { retry_of_run_id: runId })).status, 409, "a completed run cannot be retried");
  const retry = await queue(REQ_PROMOTED, { retry_of_run_id: second });
  assert.deepEqual([retry.status, retry.body.run.trigger, retry.body.run.retry_of_run_id], [200, "retry", second]);
  assert.equal(retry.body.run.input_sha256, db.ac_generation_runs.find((r) => r.id === second).input_sha256, "same input → reproducible");
  assert.equal(lastAudit().new_value, "Queued (retry, model qwen3:8b)");
  // Provenance that disappears fails the claimed run safely.
  db.source_fragments = db.source_fragments.filter((f) => f.id !== F2);
  const claim = await worker("claim", IDENTITY);
  assert.equal(claim.body.run, null);
  assert.deepEqual([db.ac_generation_runs.find((r) => r.id === retry.body.run.id).status, db.ac_generation_runs.find((r) => r.id === retry.body.run.id).error_category], ["Failed", "validation_failed"]);
  assert.equal(db.acceptance_criteria.length, 1);
});

// ── Requirement-specific relevance (migration 044) ──────────────────────────

await run("sibling Requirements of one source never inherit one another's issues or change-level scope notes", async () => {
  as("Manager");
  const res = await queue(REQ_SIBLING);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = db.ac_generation_runs.find((x) => x.id === res.body.run.id);
  assert.deepEqual(r.open_issue_ids, [I_SIBLING], "only the issue tied to its own proposal");
  assert.deepEqual(r.clarification_issue_ids, [], "the other Requirement's clarification does not leak");
  assert.deepEqual(r.scope_note_ids, [], "MONO / FULL PALLET notes are not part of its statement");
  const first = db.ac_generation_runs.find((x) => x.id === runId);
  assert.ok(!first.open_issue_ids.includes(I_SIBLING) && !first.open_issue_ids.includes(I_SHARED));
  assert.ok(!first.scope_note_ids.includes(N_CHANGE) && !r.scope_note_ids.includes(N_CHANGE), "a change-level note stays unassigned");
  // It stays preserved in the analysis run for later regression-test generation.
  assert.ok(db.analysis_scope_notes.some((n) => n.id === N_CHANGE && n.acknowledged_at));
  assert.equal(db.acceptance_criteria.length, 1, "canonical AC count unchanged");
});

const m044 = code(read("supabase/migrations/044_ac_generation_issue_relevance.sql"));
await run("044: unlinked issues and scope notes must be part of the Requirement's own statement; issue relation recorded; nothing rewritten", () => {
  assert.equal((m044.match(/OR \(cardinality\(i\.related_proposal_sequences\) = 0 AND length\(public\.ac_generation_norm\(i\.trigger_quote\)\) >= 8\s+AND strpos\(v_own, public\.ac_generation_norm\(i\.trigger_quote\)\) > 0\)\)/g) ?? []).length, 2, "clarifications and open questions");
  assert.doesNotMatch(m044, /i\.source_fragment_ids && v_p\.source_fragment_ids/, "sharing a fragment alone no longer relates an issue");
  assert.match(m044, /AND strpos\(v_own, public\.ac_generation_norm\(coalesce\(n\.source_quote, n\.description\)\)\) > 0/);
  assert.match(m044, /v_own := public\.ac_generation_norm\(array_to_string\(v_quotes \|\| coalesce\(v_p\.reviewed_description, v_p\.proposed_description\), ' ¦ '\)\);/);
  assert.match(m044, /ADD COLUMN relation text CHECK \(relation IS NULL OR relation IN \('Blocking', 'Additional Coverage', 'Informational'\)\);/);
  assert.match(m044, /nullif\(i\.v->>'relation', ''\)/);
  const topLevel = m044.replace(/\$\$[\s\S]*?\$\$/g, "");
  assert.doesNotMatch(topLevel, /\b(UPDATE|DELETE FROM|INSERT INTO)\b/, "the migration itself changes no data: no existing run, Phase 1C issue or canonical record is rewritten");
  assert.doesNotMatch(m044, /\b(UPDATE|DELETE FROM|INSERT INTO) public\.(analysis_issues|analysis_scope_notes|acceptance_criteria|requirements)\b/);
  assert.doesNotMatch(m044, /DROP |ALTER TABLE public\.(ac_generation_runs|acceptance_criterion_proposals|analysis_issues|analysis_scope_notes)/);
  const schema = req("../lib/schema.ts");
  assert.ok(schema.latestMigration >= "044_ac_generation_issue_relevance");
});

await run("UI: blocking vs additional-coverage questions are distinguished; a criterion is only 'Blocked by' a blocking question", () => {
  const page = read("components/ac-generation-review-page.tsx");
  assert.ok(page.includes('"Additional Coverage": "Additional coverage question — does not block this criterion"'));
  assert.ok(page.includes('Blocking: "Blocking issue — affected criteria need review"'));
  assert.match(page, /Blocked by open question \{openById\.get\(id\)\?\.label\}/);
  assert.match(page, /\{i\.relation \? <Pill tone=\{i\.relation === "Blocking" \? "warn" : "info"\}>\{RELATION_LABEL\[i\.relation\]\}<\/Pill> : null\}/);
});

await run("045: the semantic-fidelity repair stage is persisted like every other stage; nothing else changes", async () => {
  const m045 = code(read("supabase/migrations/045_ac_generation_repair_stage.sql"));
  assert.deepEqual(m045.split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean), [
    "ALTER TABLE public.ac_generation_stage_results DROP CONSTRAINT ac_generation_stage_results_stage_check",
    "ALTER TABLE public.ac_generation_stage_results ADD CONSTRAINT ac_generation_stage_results_stage_check CHECK (stage IN ('obligations', 'criteria', 'coverage', 'repair'))",
  ]);
  assert.deepEqual(shared.AC_GENERATION_STAGES, ["obligations", "criteria", "coverage", "repair"]);
  assert.equal(req("../lib/schema.ts").latestMigration, "045_ac_generation_repair_stage");
  // The stage route accepts it for a running run (and still refuses unknown stages).
  // The sibling Requirement's run (queued above) is the next one the worker claims.
  const claim = await worker("claim", IDENTITY);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const runIdNow = claim.body.run.id;
  const ok = await worker("stage", { run_id: runIdNow, stage: "repair", chunk_key: "requirement", input_hash: "d".repeat(64), attempts: 1, output: { repairs: [] } });
  assert.deepEqual([ok.status, ok.body.stored], [200, true]);
  assert.equal((await worker("stage", { run_id: runIdNow, stage: "rewrite", chunk_key: "requirement", input_hash: "d".repeat(64), attempts: 1, output: {} })).status, 400);
  assert.equal(db.acceptance_criteria.length, 1, "canonical AC count unchanged");
});

// ── Migration 043 ──────────────────────────────────────────────────────────

const m043 = code(read("supabase/migrations/043_ac_generation.sql"));
await run("043: generation only — no canonical writes, no AC references, review status decided by the database", () => {
  assert.doesNotMatch(m043, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(acceptance_criteria|evidence|requirement_sign_offs|artefact_links|requirements|test_cases)\b/);
  assert.doesNotMatch(m043, /\bac_ref\b/);
  assert.match(m043, /CASE WHEN p\.v->>'basis' = 'Inferred' OR p\.v->>'confidence' = 'Low'\s+OR jsonb_array_length\(coalesce\(p\.v->'open_issue_ids', '\[\]'::jsonb\)\) > 0\s+OR jsonb_array_length\(coalesce\(p\.v->'needs_review_reasons', '\[\]'::jsonb\)\) > 0 THEN 'Needs Review' ELSE 'Proposed' END/);
  assert.match(m043, /CONSTRAINT acceptance_criterion_proposals_provenance CHECK \(cardinality\(source_fragment_ids\) \+ cardinality\(scope_note_ids\) \+ cardinality\(clarification_issue_ids\) >= 1\)/);
  assert.match(m043, /criterion_type\s+text\s+NOT NULL CHECK \(criterion_type IN \('Positive', 'Negative', 'Regression'\)\)/);
});

await run("043: eligibility, exact input and relevance rules; every cited id must be one the run was given", () => {
  assert.match(m043, /IF lower\(btrim\(coalesce\(v_req\.status, ''\)\)\) IN \('approved', 'complete', 'closed'\) THEN/);
  assert.match(m043, /i\.related_proposal_sequences && v_lineage OR \(cardinality\(i\.related_proposal_sequences\) = 0 AND i\.source_fragment_ids && v_p\.source_fragment_ids\)/);
  assert.match(m043, /AND i\.status IN \('Resolved', 'Accepted'\) AND nullif\(btrim\(i\.resolution_note\), ''\) IS NOT NULL/);
  assert.match(m043, /n\.acknowledged_at IS NOT NULL AND n\.source_fragment_ids && v_p\.source_fragment_ids/);
  for (const k of ["source_fragment_ids <@ v_run.allowed_fragment_ids", "scope_note_ids <@ v_run.scope_note_ids", "clarification_issue_ids <@ v_run.clarification_issue_ids", "open_issue_ids <@ v_run.open_issue_ids"]) assert.ok(m043.includes(`NOT NEW.${k}`), k);
  assert.match(m043, /v_sha := encode\(sha256\(convert_to\(v_in\.snapshot::text, 'UTF8'\)\), 'hex'\);/);
  assert.match(m043, /CREATE UNIQUE INDEX ac_generation_runs_one_active_per_requirement ON public\.ac_generation_runs \(requirement_id\) WHERE status IN \('Queued', 'Running'\);/);
});

await run("043: output and runs are immutable history; reads Manager/Admin only; writes service role only; 1C/1D untouched", () => {
  assert.match(m043, /generated acceptance criteria and generation issues are immutable in Phase 1E/);
  assert.match(m043, /a finished generation run cannot be changed/);
  assert.match(m043, /IF EXISTS \(SELECT 1 FROM public\.projects pr WHERE pr\.id = OLD\.project_id\) THEN\s+RAISE EXCEPTION 'acceptance criteria generation runs are history/);
  for (const t of ["ac_generation_runs", "acceptance_criterion_proposals", "ac_generation_issues"]) assert.match(m043, new RegExp(`CREATE POLICY "${t}_select" ON public\\.${t} FOR SELECT TO authenticated USING \\(\\(SELECT public\\.can_write\\(\\)\\)\\);`));
  assert.match(m043, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.ac_generation_runs, public\.acceptance_criterion_proposals, public\.ac_generation_issues FROM authenticated;/);
  assert.match(m043, /EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO service_role', fn\);/);
  assert.doesNotMatch(m043, /ALTER TABLE public\.(requirement_proposals|analysis_runs|analysis_issues|analysis_scope_notes|acceptance_criteria|requirements)\b/);
  assert.doesNotMatch(m043, /FUNCTION public\.(analysis_|queue_analysis|claim_analysis|complete_analysis|promote_|review_|edit_|split_|merge_|acknowledge_|requirements_promoted|documents_promoted)/, "no Phase 1C/1D function is replaced");
  const schema = req("../lib/schema.ts");
  assert.ok(schema.latestMigration >= "043_ac_generation");
  assert.equal(schema.schemaVersion, schema.latestMigration);
});

// ── Unaffected calculations, UI ────────────────────────────────────────────

await run("ProjectState / Go-Live / test verification / reports never read generated criteria", () => {
  for (const f of ["lib/project-state.ts", "lib/go-live-readiness.ts", "lib/lifecycle/test-verification.ts", "lib/lifecycle/requirement.ts", "lib/test-report-format.ts", "lib/supabase/data-store.ts"]) {
    assert.doesNotMatch(read(f), /ac_generation|acceptance_criterion_proposals|ac-generation/, f);
  }
});

await run("UI: the drawer panel is Manager/Admin only, silent for manual Requirements, and never promotes", () => {
  const appClient = read("components/app-client.tsx");
  assert.match(appClient, /\{canViewRequirementAnalysis\(user\?\.role\) && <RequirementAcGenerationPanel projectId=\{pid\} requirementId=\{recordId\} mayRun=\{canRunRequirementAnalysis\(user\?\.role\)\} \/>\}/);
  const panel = read("components/requirement-ac-generation.tsx");
  assert.match(panel, /if \(state && !state\.eligibility\.promoted\) return null;/);
  assert.match(panel, /"Generate Acceptance Criteria"/);
  assert.match(panel, /Review Acceptance Criteria/);
  assert.match(panel, /AI proposals only — no canonical Acceptance Criteria are created\./);
  const page = read("components/ac-generation-review-page.tsx");
  assert.match(page, /if \(!mayView\) return <AppShell><EmptyState title="Manager or Admin access required"/);
  assert.doesNotMatch(page + panel, /saveRecord|createRecord|acceptance_criteria"|Promote/, "no canonical AC write and no promotion");
  for (const s of ["Positive", "Needs Review", "Blocked by open question", "Relies on human clarification", "Scope note"]) assert.ok(page.includes(s), s);
  assert.ok(read("components/audit-trail-page.tsx").includes('ac_generation_runs: "AC Generation Run"'));
});

console.log("\nAll Phase 1E acceptance criteria generation tests passed.\n");
