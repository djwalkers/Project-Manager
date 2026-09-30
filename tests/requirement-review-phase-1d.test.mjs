// Phase 1D — human review and promotion of AI requirement analysis. REAL
// route handlers, role guards and server orchestration; only the session
// lookup and the service-role client are stubbed, the latter mirroring
// migration 040's functions (state machine, immutable AI originals, split /
// merge provenance, inferred acknowledgement, atomic idempotent promotion,
// issue promotion, scope-note acknowledgement). The migration itself was
// validated against the live database with the real SOMCR038 / PL10
// proposals in a rolled-back run.
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
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename });
  module._compile(result.outputText, filename);
};
Module._extensions[".tsx"] = Module._extensions[".ts"];

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
const req = Module.createRequire(import.meta.url);
const serverModule = req("../lib/supabase/server.ts");
const serviceRoleModule = req("../lib/supabase/service-role.ts");
const review = req("../lib/requirement-review.ts");
const { nextRef } = req("../lib/utils.ts");
const { isRequirementSignedOff } = req("../lib/lifecycle/requirement.ts");
const proposalsRoute = req("../app/api/analysis/proposals/route.ts");
const issuesRoute = req("../app/api/analysis/issues/route.ts");
const notesRoute = req("../app/api/analysis/scope-notes/route.ts");
const provenanceRoute = req("../app/api/requirements/provenance/route.ts");
const runsRoute = req("../app/api/analysis/runs/route.ts");
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const OTHER_P = "99999999-9999-4999-8999-999999999999";
const RUN = "55555555-5555-4555-8555-555555555555";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const F = [uuid(), uuid(), uuid(), uuid()]; // fragments of the run's extraction job (4 application sections)
const FOREIGN = uuid();

const proposal = (sequence, o = {}) => ({
  id: uuid(), analysis_run_id: RUN, project_id: P, sequence, proposal_type: "requirement",
  proposed_title: `AI title ${sequence}`, proposed_description: `AI description ${sequence}.`, proposed_category: "UI", proposed_priority: null,
  source_fragment_ids: [F[0]], primary_source_fragment_id: F[0], source_quote: "quote", rationale: "Stated.", evidence_basis: "Explicit", confidence: "High",
  review_status: "Proposed", consolidation: {}, origin: "ai", parent_proposal_ids: [],
  reviewed_title: null, reviewed_description: null, reviewed_category: null, reviewed_priority: null, review_note: null, rejection_reason: null,
  reviewed_by: null, reviewed_by_name: null, reviewed_at: null, inferred_acknowledged_by: null, inferred_acknowledged_by_name: null, inferred_acknowledged_at: null,
  promoted_record_id: null, promoted_ref: null, promoted_at: null, promoted_by: null, promoted_by_name: null, ...o,
});

// ── In-memory service-role stand-in (mirrors migration 040) ────────────────
let session = null;
let failNextRequirementInsert = false;
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  projects: [{ id: P, name: "Project" }],
  documents: [{ id: "doc1", project_id: P, document_name: "PL10 Spec", document_type: "Functional Specification", current_version_id: "ver1" }],
  document_versions: [{ id: "ver1", document_id: "doc1", project_id: P, version_number: 1, original_filename: "spec.pdf", content_type: "application/pdf" }],
  extraction_jobs: [{ id: "job1", project_id: P, document_version_id: "ver1", extractor_version: "1.2.0", completed_at: "2026-09-01" }],
  analysis_runs: [{ id: RUN, project_id: P, document_id: "doc1", document_version_id: "ver1", extraction_job_id: "job1", model: "qwen3:8b", prompt_version: "2.0.0", status: "Completed", diagnostics: {} }],
  source_fragments: F.map((id, n) => ({ id, project_id: P, extraction_job_id: "job1", sequence: n + 1, section_heading: `App ${n + 1}`, section_path: ["Spec", `App ${n + 1}`], page_start: n + 1, page_end: n + 1, text: `Add a plant filter (app ${n + 1}).`, metadata: {}, fragment_type: "text" })),
  requirement_proposals: [
    proposal(1, { proposed_title: "Plant filter", proposed_description: "Add a plant filter.\n\nApplies to: App 1; App 2; App 3; App 4.", source_fragment_ids: [...F], primary_source_fragment_id: F[0] }),
    proposal(2),
    proposal(3, { evidence_basis: "Inferred", review_status: "Needs Review", confidence: "Low" }),
    proposal(4, { proposed_category: null }),
    proposal(5),
  ],
  analysis_issues: [
    { id: uuid(), analysis_run_id: RUN, project_id: P, sequence: 1, issue_type: "Missing Information", severity: "High", description: "Values unclear.", suggested_question: "Which temperature values exist?", source_fragment_ids: [F[0]], related_proposal_sequences: [2], status: "Open", impact: ["test_design"], resolution_note: null, reviewed_by_name: null, reviewed_at: null, promoted_target_type: null, promoted_record_id: null, promoted_ref: null },
    { id: uuid(), analysis_run_id: RUN, project_id: P, sequence: 2, issue_type: "Ambiguity", severity: "Low", description: "Wording.", suggested_question: "Which wording applies here?", source_fragment_ids: [F[1]], related_proposal_sequences: [], status: "Open", impact: ["scope"], resolution_note: null, reviewed_by_name: null, reviewed_at: null, promoted_target_type: null, promoted_record_id: null, promoted_ref: null },
  ],
  analysis_scope_notes: [{ id: uuid(), analysis_run_id: RUN, project_id: P, sequence: 1, note_type: "No Change", area: "Pick Decanting", description: "No change required.", source_quote: "No change required.", source_fragment_ids: [F[2]], acknowledged_at: null }],
  // Canonical data — existing manual Requirements must never change.
  requirements: [
    { id: uuid(), project_id: P, requirement_ref: "REP-001", title: "Manual one", status: "Approved", owner: "A Person", priority: "High", category: "UI" },
    { id: uuid(), project_id: P, requirement_ref: "REP-007", title: "Manual two", status: "Complete", owner: "B", priority: "Low", category: "UI" },
    { id: uuid(), project_id: OTHER_P, requirement_ref: "REP-050", title: "Other project", status: "Open", owner: null, priority: "Low", category: "UI" },
  ],
  discovery_questions: [{ id: uuid(), project_id: P, question_ref: "QUE-004", question: "existing", status: "Open" }],
  actions: [], risks: [], decisions: [], artefact_links: [], audit_log: [],
};
const snapshotManual = () => JSON.stringify(db.requirements.filter((r) => !db.requirement_proposals.some((p) => p.promoted_record_id === r.id)));

function builder(table) {
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), ...r })); db[table].push(...list); return list; }
    return rows().filter(matches).map((r) => ({ ...r }));
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; },
    order() { return b; }, limit() { return b; }, insert(p) { q.op = "insert"; q.payload = p; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }), single: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve) { return Promise.resolve({ data: exec(), error: null }).then(resolve); },
  };
  return b;
}
const err = (code, message) => ({ data: null, error: { code, message } });
const TRANSITIONS = { Proposed: ["Approved", "Rejected", "Needs Review", "Superseded"], "Needs Review": ["Approved", "Rejected", "Superseded"], Approved: ["Promoted", "Needs Review", "Rejected", "Superseded"], Rejected: ["Needs Review"], Promoted: [], Superseded: [] };
function setStatus(p, to) {
  if (p.review_status === to) return;
  if (!TRANSITIONS[p.review_status].includes(to)) throw Object.assign(new Error(`a proposal cannot move from ${p.review_status} to ${to}`), { code: "P0001" });
  if (to === "Approved" && p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at) throw Object.assign(new Error("inferred_acknowledged check"), { code: "23514" });
  p.review_status = to;
}
function refFor(table, col, prefix) {
  const rows = db[table].filter((r) => r.project_id === P);
  return nextRef(rows, col, prefix); // the SQL mirrors lib/utils nextRef exactly
}
function rpc(name, a) {
  const lock = (id) => db.requirement_proposals.find((p) => p.id === id && p.project_id === a.p_project_id);
  try {
    switch (name) {
      case "edit_requirement_proposal": {
        const p = lock(a.p_proposal_id); if (!p) return err("P0002", "Proposal not found in this project");
        if (!["Proposed", "Needs Review", "Approved"].includes(p.review_status)) return err("55000", `A ${p.review_status.toLowerCase()} proposal cannot be edited`);
        const pick = (v, orig) => (v == null || v === orig ? null : v);
        Object.assign(p, { reviewed_title: pick(a.p_title, p.proposed_title), reviewed_description: pick(a.p_description, p.proposed_description), reviewed_category: pick(a.p_category, p.proposed_category), reviewed_priority: pick(a.p_priority, p.proposed_priority), reviewed_by_name: a.p_user_name, reviewed_at: "now" });
        if (p.review_status === "Approved") setStatus(p, "Needs Review");
        return { data: { ...p }, error: null };
      }
      case "review_requirement_proposal": {
        const p = lock(a.p_proposal_id); if (!p) return err("P0002", "Proposal not found in this project");
        const target = { approve: "Approved", reject: "Rejected", needs_review: "Needs Review", reopen: "Needs Review" }[a.p_action];
        if (a.p_action === "reopen" && p.review_status !== "Rejected") return err("55000", "Only a rejected proposal can be reopened");
        if (p.review_status === target) return { data: { ...p }, error: null };
        if (target === "Approved" && p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at && !a.p_acknowledge_inferred) return err("55000", "This proposal is Inferred: confirm the interpretation is intended before approving it");
        if (target === "Approved" && p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at) Object.assign(p, { inferred_acknowledged_at: "now", inferred_acknowledged_by_name: a.p_user_name });
        setStatus(p, target);
        Object.assign(p, { review_note: a.p_note ?? p.review_note, rejection_reason: target === "Rejected" ? a.p_reason : null, reviewed_by_name: a.p_user_name, reviewed_at: "now" });
        return { data: { ...p }, error: null };
      }
      case "split_requirement_proposal": {
        const p = lock(a.p_proposal_id); if (!p) return err("P0002", "Proposal not found in this project");
        if (!["Proposed", "Needs Review", "Approved"].includes(p.review_status)) return err("55000", `A ${p.review_status.toLowerCase()} proposal cannot be split`);
        let next = Math.max(...db.requirement_proposals.filter((x) => x.analysis_run_id === p.analysis_run_id).map((x) => x.sequence)) + 1;
        const kids = [];
        for (const c of a.p_children) {
          if (!c.source_fragment_ids.length) return err("22023", "Every child proposal needs at least one source fragment");
          if (!c.source_fragment_ids.every((id) => p.source_fragment_ids.includes(id))) return err("22023", "A child proposal may only cite fragments of the proposal it was split from");
          kids.push(proposal(next++, { proposed_title: c.title, proposed_description: c.description, proposed_category: c.category ?? p.proposed_category, proposed_priority: c.priority ?? p.proposed_priority, source_fragment_ids: c.source_fragment_ids, primary_source_fragment_id: c.source_fragment_ids.includes(p.primary_source_fragment_id) ? p.primary_source_fragment_id : c.source_fragment_ids[0], evidence_basis: p.evidence_basis, review_status: "Needs Review", origin: "split", parent_proposal_ids: [p.id] }));
        }
        db.requirement_proposals.push(...kids);
        setStatus(p, "Superseded");
        return { data: kids, error: null };
      }
      case "merge_requirement_proposals": {
        const members = a.p_proposal_ids.map((id) => lock(id));
        if (members.some((m) => !m)) return err("P0002", "Proposal not found in this project");
        if (new Set(members.map((m) => m.analysis_run_id)).size > 1) return err("22023", "Only proposals from the same analysis run can be merged");
        const bad = members.find((m) => !["Proposed", "Needs Review", "Approved"].includes(m.review_status));
        if (bad) return err("55000", `Proposal #${bad.sequence} is ${bad.review_status.toLowerCase()} and cannot be merged`);
        const next = Math.max(...db.requirement_proposals.map((x) => x.sequence)) + 1;
        const merged = proposal(next, { proposed_title: a.p_title, proposed_description: a.p_description, proposed_category: a.p_category, proposed_priority: a.p_priority, source_fragment_ids: [...new Set(members.flatMap((m) => m.source_fragment_ids))], primary_source_fragment_id: members[0].primary_source_fragment_id, evidence_basis: members.some((m) => m.evidence_basis === "Inferred") ? "Inferred" : "Explicit", review_status: "Needs Review", origin: "merge", parent_proposal_ids: members.map((m) => m.id) });
        db.requirement_proposals.push(merged);
        members.forEach((m) => setStatus(m, "Superseded"));
        return { data: merged, error: null };
      }
      case "promote_requirement_proposal": {
        const p = lock(a.p_proposal_id); if (!p) return err("P0002", "Proposal not found in this project");
        if (p.review_status === "Promoted") return { data: [{ requirement_id: p.promoted_record_id, requirement_ref: p.promoted_ref, already_promoted: true, title: p.reviewed_title ?? p.proposed_title }], error: null };
        if (p.review_status !== "Approved") return err("55000", `Only an Approved proposal can be promoted (this one is ${p.review_status})`);
        if (p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at) return err("55000", "An Inferred proposal needs an acknowledged interpretation before promotion");
        const category = p.reviewed_category ?? p.proposed_category, priority = p.reviewed_priority ?? p.proposed_priority;
        if (!category || !priority) return err("22023", "Set the category and priority in the review before promoting — they are not chosen automatically");
        // One transaction: a failed insert leaves the proposal untouched.
        if (failNextRequirementInsert) { failNextRequirementInsert = false; return err("23505", "duplicate key value violates unique constraint \"requirements_project_ref_key\""); }
        const ref = refFor("requirements", "requirement_ref", a.p_ref_prefix);
        const row = { id: uuid(), project_id: a.p_project_id, requirement_ref: ref, title: p.reviewed_title ?? p.proposed_title, description: p.reviewed_description ?? p.proposed_description, priority, category, status: "Discovery", owner: null, source: a.p_source, notes: a.p_notes };
        db.requirements.push(row);
        setStatus(p, "Promoted");
        Object.assign(p, { promoted_record_id: row.id, promoted_ref: ref, promoted_at: "now", promoted_by_name: a.p_user_name });
        return { data: [{ requirement_id: row.id, requirement_ref: ref, already_promoted: false, title: row.title }], error: null };
      }
      case "review_analysis_issue": {
        const i = db.analysis_issues.find((x) => x.id === a.p_issue_id && x.project_id === a.p_project_id); if (!i) return err("P0002", "Issue not found in this project");
        Object.assign(i, { status: a.p_status, resolution_note: a.p_note ?? i.resolution_note, reviewed_by_name: a.p_user_name, reviewed_at: "now" });
        return { data: { ...i }, error: null };
      }
      case "promote_analysis_issue": {
        const i = db.analysis_issues.find((x) => x.id === a.p_issue_id && x.project_id === a.p_project_id); if (!i) return err("P0002", "Issue not found in this project");
        if (i.promoted_record_id) return { data: [{ record_id: i.promoted_record_id, record_ref: i.promoted_ref, already_promoted: true, target: i.promoted_target_type }], error: null };
        const col = { discovery_questions: "question_ref", actions: "action_ref", risks: "risk_ref", decisions: "decision_ref" }[a.p_target];
        const ref = refFor(a.p_target, col, a.p_ref_prefix);
        const row = { id: uuid(), project_id: a.p_project_id, [col]: ref, status: "Open", owner: null, ...a.p_fields };
        db[a.p_target].push(row);
        for (const s of i.related_proposal_sequences) {
          const pr = db.requirement_proposals.find((x) => x.analysis_run_id === i.analysis_run_id && x.sequence === s && x.promoted_record_id);
          if (pr) db.artefact_links.push({ id: uuid(), project_id: a.p_project_id, source_entity: "requirements", source_id: pr.promoted_record_id, target_entity: a.p_target, target_id: row.id });
        }
        Object.assign(i, { promoted_target_type: a.p_target, promoted_record_id: row.id, promoted_ref: ref, status: i.status === "Open" ? "Accepted" : i.status });
        return { data: [{ record_id: row.id, record_ref: ref, already_promoted: false, target: a.p_target }], error: null };
      }
      case "acknowledge_scope_note": {
        const n = db.analysis_scope_notes.find((x) => x.id === a.p_note_id && x.project_id === a.p_project_id); if (!n) return err("P0002", "Scope note not found in this project");
        if (!n.acknowledged_at) Object.assign(n, { acknowledged_at: "now", acknowledged_by_name: a.p_user_name, acknowledgement_note: a.p_note });
        return { data: { ...n }, error: null };
      }
    }
  } catch (e) { return err(e.code ?? "P0001", e.message); }
  return err("42883", `unknown function ${name}`);
}
serviceRoleModule.createServiceRoleClient = () => ({ from: builder, rpc: async (n, a) => rpc(n, a) });
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };
const call = async (handler, url, { body, method = "POST" } = {}) => {
  const res = await handler(new NextRequest(`http://localhost${url}`, method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
  return { status: res.status, body: await res.json() };
};
const act = (body) => call(proposalsRoute.POST, "/api/analysis/proposals", { body: { project_id: P, ...body } });
const pr = (n) => db.requirement_proposals.find((p) => p.sequence === n);
const lastAudit = () => db.audit_log.at(-1);

// ── Permissions ─────────────────────────────────────────────────────────────

await run("anon and Viewer cannot review, promote or read the review workspace; Viewer may read promoted provenance", async () => {
  for (const role of [null, "Viewer"]) {
    as(role);
    const expected = role ? 403 : 401;
    assert.equal((await act({ action: "approve", proposal_id: pr(2).id })).status, expected);
    assert.equal((await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: db.analysis_issues[0].id, action: "review", status: "Resolved" } })).status, expected);
    assert.equal((await call(notesRoute.POST, "/api/analysis/scope-notes", { body: { project_id: P, note_id: db.analysis_scope_notes[0].id, action: "acknowledge" } })).status, expected);
    assert.equal((await call(runsRoute.GET, `/api/analysis/runs?project_id=${P}&run_id=${RUN}`, { method: "GET" })).status, expected, "workspace data");
  }
  assert.equal(pr(2).review_status, "Proposed", "nothing changed");
  as("Viewer");
  assert.equal((await call(provenanceRoute.GET, `/api/requirements/provenance?project_id=${P}&requirement_id=${db.requirements[0].id}`, { method: "GET" })).status, 200, "Viewer reads authoritative provenance");
  as(null);
  assert.equal((await call(provenanceRoute.GET, `/api/requirements/provenance?project_id=${P}&requirement_id=${db.requirements[0].id}`, { method: "GET" })).status, 401);
});

// ── Editing ────────────────────────────────────────────────────────────────

await run("editing keeps the AI original intact, stores the reviewed version, and audits each changed field", async () => {
  as("Manager");
  const res = await act({ action: "edit", proposal_id: pr(2).id, title: "Reviewed title", description: pr(2).proposed_description, category: "Business Rule", priority: "High" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = pr(2);
  assert.deepEqual([p.proposed_title, p.reviewed_title, p.reviewed_description, p.reviewed_category, p.reviewed_priority], ["AI title 2", "Reviewed title", null, "Business Rule", "High"], "unchanged fields stay null (= AI original)");
  const edits = db.audit_log.filter((a) => a.entity_id === p.id && a.action_type === "Update");
  assert.deepEqual(edits.map((a) => [a.field_name, a.old_value, a.new_value]), [["title", "AI title 2", "Reviewed title"], ["category", "UI", "Business Rule"], ["priority", null, "High"]]);
  assert.ok(edits.every((a) => a.entity_type === "requirement_proposals" && a.changed_by === U.Manager && a.changed_by_name === "Manager User"));
  assert.deepEqual(review.effectiveProposal(p), { title: "Reviewed title", description: "AI description 2.", category: "Business Rule", priority: "High" });
  assert.equal((await act({ action: "edit", proposal_id: pr(2).id, category: "Wizardry" })).status, 400, "category options enforced");
});

// ── State transitions ──────────────────────────────────────────────────────

await run("approve / needs review / reject / reopen transitions; rejected proposals stay in history; audited", async () => {
  as("Manager");
  assert.equal((await act({ action: "needs_review", proposal_id: pr(5).id, note: "check wording" })).body.proposal.review_status, "Needs Review");
  const rej = await act({ action: "reject", proposal_id: pr(5).id, reason: "Duplicate", note: "same as #2" });
  assert.deepEqual([rej.body.proposal.review_status, rej.body.proposal.rejection_reason], ["Rejected", "Duplicate"]);
  assert.ok(db.requirement_proposals.some((p) => p.id === pr(5).id), "not deleted");
  assert.match(lastAudit().new_value, /^Rejected \(Duplicate\) — same as #2$/);
  assert.equal((await act({ action: "approve", proposal_id: pr(5).id })).status, 409, "Rejected → Approved is not allowed");
  assert.equal((await act({ action: "reopen", proposal_id: pr(5).id })).body.proposal.review_status, "Needs Review");
  assert.equal((await act({ action: "reject", proposal_id: pr(5).id, reason: "Made up" })).status, 400, "reason list enforced");
  assert.equal((await act({ action: "approve", proposal_id: pr(2).id, note: "fine" })).body.proposal.review_status, "Approved");
  assert.deepEqual([lastAudit().field_name, lastAudit().old_value, lastAudit().new_value], ["review_status", "Proposed", "Approved — fine"]);
  assert.deepEqual(review.allowedProposalActions({ review_status: "Approved" })[0], "promote");
  assert.deepEqual(review.allowedProposalActions({ review_status: "Promoted" }), []);
  assert.deepEqual(review.allowedProposalActions({ review_status: "Rejected" }), ["reopen"]);
});

await run("an Inferred proposal cannot be approved without an explicit, recorded acknowledgement", async () => {
  as("Manager");
  const blocked = await act({ action: "approve", proposal_id: pr(3).id });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Inferred: confirm the interpretation/);
  const ok = await act({ action: "approve", proposal_id: pr(3).id, acknowledge_inferred: true });
  assert.equal(ok.body.proposal.review_status, "Approved");
  assert.deepEqual([pr(3).inferred_acknowledged_by_name, Boolean(pr(3).inferred_acknowledged_at)], ["Manager User", true]);
  assert.match(lastAudit().new_value, /\[inferred interpretation acknowledged\]/);
});

// ── Bulk ───────────────────────────────────────────────────────────────────

await run("bulk approve needs the confirmed count, skips unacknowledged Inferred proposals, and never promotes", async () => {
  as("Manager");
  db.requirement_proposals.push(proposal(6), proposal(7, { evidence_basis: "Inferred", review_status: "Needs Review" }));
  const ids = [pr(6).id, pr(7).id];
  assert.equal((await act({ action: "bulk_review", decision: "approve", proposal_ids: ids })).status, 400, "confirmation required");
  const res = await act({ action: "bulk_review", decision: "approve", proposal_ids: ids, confirmed_count: 2 });
  assert.deepEqual(res.body.updated, [pr(6).id]);
  assert.match(res.body.skipped[0].reason, /Inferred/);
  assert.equal(pr(7).review_status, "Needs Review");
  assert.ok(!db.requirements.some((r) => r.title === "AI title 6"), "bulk never promotes");
  const rej = await act({ action: "bulk_review", decision: "reject", proposal_ids: [pr(7).id], confirmed_count: 1, reason: "Too granular" });
  assert.deepEqual([rej.body.updated.length, pr(7).review_status, pr(7).rejection_reason], [1, "Rejected", "Too granular"]);
});

// ── Split / merge ──────────────────────────────────────────────────────────

let children;
await run("split: the cross-application proposal becomes app-specific children with their own provenance; the original is Superseded", async () => {
  as("Manager");
  const kids = F.map((f, n) => ({ title: `App ${n + 1} plant filter`, description: `App ${n + 1}: add a plant filter.`, source_fragment_ids: [f] }));
  assert.equal((await act({ action: "split", proposal_id: pr(1).id, children: [kids[0]] })).status, 400, "at least two children");
  assert.equal((await act({ action: "split", proposal_id: pr(1).id, children: [kids[0], { ...kids[1], source_fragment_ids: [] }] })).status, 400, "no child without provenance");
  const foreign = await act({ action: "split", proposal_id: pr(1).id, children: [kids[0], { ...kids[1], source_fragment_ids: [FOREIGN] }] });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /only cite fragments of the proposal it was split from/);
  const res = await act({ action: "split", proposal_id: pr(1).id, children: kids });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  children = res.body.children;
  assert.equal(pr(1).review_status, "Superseded");
  assert.deepEqual(children.map((c) => [c.origin, c.review_status, c.parent_proposal_ids[0], c.source_fragment_ids.length, c.analysis_run_id]), F.map(() => ["split", "Needs Review", pr(1).id, 1, RUN]));
  assert.deepEqual(children.map((c) => c.source_fragment_ids[0]), F, "every source fragment is kept by a child");
  assert.match(db.audit_log.find((a) => a.entity_id === pr(1).id && /split into/.test(a.new_value ?? "")).new_value, /^Superseded — split into #\d+, #\d+, #\d+, #\d+$/);
  assert.equal(db.audit_log.filter((a) => a.action_type === "Create" && /Split from proposal #1/.test(a.new_value ?? "")).length, 4);
  assert.equal((await act({ action: "split", proposal_id: pr(1).id, children: kids })).status, 409, "a superseded proposal cannot be split again");
});

await run("merge: lossless provenance (every member's fragments), members Superseded, new proposal Needs Review", async () => {
  as("Manager");
  const [a, b] = children;
  const res = await act({ action: "merge", proposal_ids: [a.id, b.id], title: "Execution plant filters", description: "- App 1 plant filter.\n- App 2 plant filter.", category: "UI", priority: "Medium" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const m = res.body.proposal;
  assert.deepEqual([m.origin, m.review_status, m.source_fragment_ids.sort()], ["merge", "Needs Review", [F[0], F[1]].sort()]);
  assert.deepEqual(m.parent_proposal_ids, [a.id, b.id]);
  assert.ok([a.id, b.id].every((id) => db.requirement_proposals.find((p) => p.id === id).review_status === "Superseded"));
  assert.equal((await act({ action: "merge", proposal_ids: [pr(5).id], title: "x", description: "y" })).status, 400, "at least two");
});

// ── Promotion ──────────────────────────────────────────────────────────────

let promoted;
await run("promotion creates ONE canonical Requirement: next REP ref (canonical nextRef), status Discovery, no owner, reviewed values, provenance note", async () => {
  as("Manager");
  const before = snapshotManual();
  const res = await act({ action: "promote", proposal_id: pr(2).id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  promoted = res.body.requirement;
  assert.equal(promoted.requirement_ref, "REP-008", "highest REP-n in THIS project + 1 (another project's REP-050 is ignored)");
  assert.equal(promoted.requirement_ref, nextRef(db.requirements.filter((r) => r.project_id === P && r.id !== promoted.id), "requirement_ref", "REP"));
  assert.deepEqual([promoted.title, promoted.category, promoted.priority, promoted.status, promoted.owner, promoted.source], ["Reviewed title", "Business Rule", "High", "Discovery", null, "Functional Specification"]);
  assert.equal(isRequirementSignedOff(promoted.status), false, "a promoted Requirement is not signed off");
  assert.match(promoted.notes, /Promoted from AI analysis proposal #2 of "PL10 Spec" v1/);
  assert.match(promoted.notes, /Source: Spec › App 1 \(p\. 1\)/);
  assert.deepEqual([pr(2).review_status, pr(2).promoted_record_id, pr(2).promoted_ref], ["Promoted", promoted.id, "REP-008"]);
  const created = db.audit_log.find((a) => a.entity_type === "requirements" && a.entity_id === promoted.id);
  assert.deepEqual([created.action_type, created.entity_name, created.changed_by], ["Create", "REP-008", U.Manager]);
  assert.equal(lastAudit().new_value, "Promoted → REP-008");
  assert.equal(snapshotManual(), before, "existing manual Requirements unchanged");
});

await run("promotion is idempotent: a double click / retry returns the same Requirement and creates nothing", async () => {
  as("Admin");
  const count = db.requirements.length, audits = db.audit_log.length;
  const again = await Promise.all([act({ action: "promote", proposal_id: pr(2).id }), act({ action: "promote", proposal_id: pr(2).id })]);
  assert.ok(again.every((r) => r.status === 200 && r.body.already_promoted === true && r.body.requirement.id === promoted.id));
  assert.equal(db.requirements.length, count);
  assert.equal(db.audit_log.length, audits, "no duplicate audit");
});

await run("promotion refuses unapproved, unacknowledged or incomplete proposals; a failed insert leaves the proposal unpromoted", async () => {
  as("Manager");
  assert.equal((await act({ action: "promote", proposal_id: pr(5).id })).status, 409, "Needs Review cannot be promoted");
  await act({ action: "approve", proposal_id: pr(4).id });
  const missing = await act({ action: "promote", proposal_id: pr(4).id });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /category and priority/, "no invented defaults");
  assert.equal(review.promotionBlocker({ ...pr(4) }), "Set the category and priority first — they are not chosen automatically");
  await act({ action: "edit", proposal_id: pr(4).id, category: "UI", priority: "Low" });
  assert.equal(pr(4).review_status, "Needs Review", "editing an approved proposal requires re-approval");
  await act({ action: "approve", proposal_id: pr(4).id });
  const count = db.requirements.length;
  failNextRequirementInsert = true;
  const failed = await act({ action: "promote", proposal_id: pr(4).id });
  assert.equal(failed.status, 409);
  assert.deepEqual([pr(4).review_status, pr(4).promoted_record_id, db.requirements.length], ["Approved", null, count], "nothing half-done");
  const ok = await act({ action: "promote", proposal_id: pr(4).id });
  assert.equal(ok.body.requirement.requirement_ref, "REP-009");
});

await run("the AI can never set a Requirement owner or reference: promotion ignores any such request fields", async () => {
  as("Manager");
  await act({ action: "approve", proposal_id: pr(3).id });
  const res = await act({ action: "promote", proposal_id: pr(3).id, owner: "AI Owner", requirement_ref: "REP-999", status: "Approved" });
  // pr(3) has no priority yet → refused; set it, re-approve, promote with the same stray fields.
  assert.equal(res.status, 400);
  await act({ action: "edit", proposal_id: pr(3).id, priority: "Medium" });
  await act({ action: "approve", proposal_id: pr(3).id });
  const ok = await act({ action: "promote", proposal_id: pr(3).id, owner: "AI Owner", requirement_ref: "REP-999", status: "Approved" });
  assert.deepEqual([ok.body.requirement.owner, ok.body.requirement.requirement_ref, ok.body.requirement.status], [null, "REP-010", "Discovery"]);
  assert.ok(pr(3).inferred_acknowledged_at, "the inferred acknowledgement persisted through the edit");
});

await run("provenance after promotion: Requirement → proposal → fragments → extraction → version → document", async () => {
  as("Viewer");
  const res = await call(provenanceRoute.GET, `/api/requirements/provenance?project_id=${P}&requirement_id=${promoted.id}`, { method: "GET" });
  const v = res.body.provenance;
  assert.deepEqual([v.proposal.sequence, v.document.document_name, v.version.version_number, v.extraction_job.id, v.fragments.map((f) => f.id)], [2, "PL10 Spec", 1, "job1", [F[0]]]);
  assert.ok(!("proposed_title" in v.proposal) && !("rationale" in v.proposal), "no proposal content leaks to Viewers");
  const manual = await call(provenanceRoute.GET, `/api/requirements/provenance?project_id=${P}&requirement_id=${db.requirements[0].id}`, { method: "GET" });
  assert.equal(manual.body.provenance, null, "manual Requirements have no analysis provenance");
  const other = await call(provenanceRoute.GET, `/api/requirements/provenance?project_id=${OTHER_P}&requirement_id=${promoted.id}`, { method: "GET" });
  assert.equal(other.body.provenance, null, "project scoped");
});

// ── Issues ─────────────────────────────────────────────────────────────────

await run("issues: resolve with a note (no canonical record), reopen; audited", async () => {
  as("Manager");
  const i = db.analysis_issues[1];
  const counts = ["discovery_questions", "actions", "risks", "decisions"].map((t) => db[t].length).join();
  const res = await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: i.id, action: "review", status: "Resolved", note: "Answered in workshop" } });
  assert.deepEqual([res.status, i.status, i.resolution_note], [200, "Resolved", "Answered in workshop"]);
  assert.equal(["discovery_questions", "actions", "risks", "decisions"].map((t) => db[t].length).join(), counts, "resolving creates nothing canonical");
  assert.equal(lastAudit().new_value, "Resolved — Answered in workshop");
  assert.equal((await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: i.id, action: "review", status: "Closed" } })).status, 400);
  assert.equal((await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: i.id, action: "review", status: "Open" } })).body.issue.status, "Open");
});

await run("issue promotion: human-chosen target, canonical ref, linked to the promoted Requirement, only once", async () => {
  as("Manager");
  const i = db.analysis_issues[0];
  const bad = await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: i.id, action: "promote", target: "risks", fields: { text: "Risk", impact: "High" } } });
  assert.equal(bad.status, 400, "a risk needs a reviewer-chosen probability");
  const res = await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: i.id, action: "promote", target: "discovery_questions", fields: { text: i.suggested_question } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.record_ref, "QUE-005", "next QUE after the project's QUE-004");
  const dq = db.discovery_questions.find((q) => q.id === res.body.record_id);
  assert.deepEqual([dq.question, dq.status, dq.owner], ["Which temperature values exist?", "Open", null]);
  assert.match(dq.notes, /From analysis issue #1 \(Missing Information\)/);
  assert.deepEqual([i.promoted_target_type, i.promoted_ref, i.status], ["discovery_questions", "QUE-005", "Accepted"]);
  assert.ok(db.artefact_links.some((l) => l.source_entity === "requirements" && l.source_id === promoted.id && l.target_entity === "discovery_questions" && l.target_id === dq.id), "canonical traceability to the Requirement its proposal became");
  const again = await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: P, issue_id: i.id, action: "promote", target: "actions", fields: { text: "x" } } });
  assert.deepEqual([again.body.already_promoted, again.body.record_ref, db.actions.length], [true, "QUE-005", 0], "promoted once");
  assert.ok(db.audit_log.some((a) => a.entity_type === "discovery_questions" && a.entity_id === dq.id && a.action_type === "Create"));
});

// ── Scope notes ────────────────────────────────────────────────────────────

await run("scope notes can be acknowledged (once, audited) and never become Requirements", async () => {
  as("Manager");
  const n = db.analysis_scope_notes[0];
  const count = db.requirements.length;
  const res = await call(notesRoute.POST, "/api/analysis/scope-notes", { body: { project_id: P, note_id: n.id, action: "acknowledge", note: "For regression" } });
  assert.deepEqual([res.status, Boolean(n.acknowledged_at), n.acknowledgement_note], [200, true, "For regression"]);
  assert.equal(lastAudit().entity_type, "analysis_scope_notes");
  const audits = db.audit_log.length;
  await call(notesRoute.POST, "/api/analysis/scope-notes", { body: { project_id: P, note_id: n.id, action: "acknowledge" } });
  assert.equal(db.audit_log.length, audits, "repeat is a no-op");
  assert.equal((await call(notesRoute.POST, "/api/analysis/scope-notes", { body: { project_id: P, note_id: n.id, action: "promote" } })).status, 400);
  assert.equal(db.requirements.length, count);
  assert.equal((await act({ action: "promote", proposal_id: n.id })).status, 404, "a scope note is not a proposal");
});

await run("everything is project scoped", async () => {
  as("Manager");
  assert.equal((await call(proposalsRoute.POST, "/api/analysis/proposals", { body: { project_id: OTHER_P, action: "approve", proposal_id: pr(6).id } })).status, 404);
  assert.equal((await call(issuesRoute.POST, "/api/analysis/issues", { body: { project_id: OTHER_P, issue_id: db.analysis_issues[1].id, action: "review", status: "Resolved" } })).status, 404);
});

// ── Migration 040 ──────────────────────────────────────────────────────────

const m040 = code(read("supabase/migrations/040_requirement_review_promotion.sql"));
await run("040: AI originals immutable; state machine; Promoted only with its record; inferred acknowledgement enforced", () => {
  assert.match(m040, /RAISE EXCEPTION 'generated proposal content is immutable; only its review fields may change'/);
  for (const col of ["proposed_title", "proposed_description", "source_fragment_ids", "evidence_basis", "rationale"]) assert.ok(!new RegExp(`v_review_cols := ARRAY\\[[^\\]]*'${col}'`).test(m040), `${col} is not a review column`);
  assert.match(m040, /OLD\.review_status = 'Rejected' AND NEW\.review_status = 'Needs Review'/);
  assert.match(m040, /RAISE EXCEPTION 'a proposal becomes Promoted only with the canonical record it created'/);
  assert.match(m040, /CONSTRAINT requirement_proposals_inferred_acknowledged CHECK \(\s*evidence_basis <> 'Inferred' OR review_status NOT IN \('Approved', 'Promoted'\) OR inferred_acknowledged_at IS NOT NULL\)/);
  assert.match(m040, /CREATE UNIQUE INDEX IF NOT EXISTS requirement_proposals_promoted_record_key ON public\.requirement_proposals \(promoted_record_id\)/);
  assert.match(m040, /CREATE UNIQUE INDEX IF NOT EXISTS analysis_issues_promoted_record_key ON public\.analysis_issues \(promoted_record_id\)/);
});

await run("040: promotion is locked, atomic, idempotent and uses the app's nextRef numbering; split children draw on parent fragments", () => {
  assert.match(m040, /IF v\.review_status = 'Promoted' THEN\s+requirement_id := v\.promoted_record_id;/);
  assert.match(m040, /PERFORM pg_advisory_xact_lock\(hashtext\('requirement-ref:' \|\| p_project_id::text\)\);/);
  assert.match(m040, /lpad\(\(coalesce\(max\(\(substring\(r\.requirement_ref FROM '\(\?i\)\^' \|\| p_ref_prefix \|\| '-\(\\d\+\)\$'\)\)::integer\), 0\) \+ 1\)::text, 3, '0'\)/);
  assert.match(m040, /v_priority, v_category, 'Discovery', NULL, p_source, p_notes\)/, "status Discovery, owner NULL");
  assert.match(m040, /IF NOT v_ids <@ v\.source_fragment_ids THEN RAISE EXCEPTION 'A child proposal may only cite fragments/);
  assert.match(m040, /IF cardinality\(v_ids\) = 0 THEN RAISE EXCEPTION 'Every child proposal needs at least one source fragment'/);
  assert.doesNotMatch(m040, /UPDATE public\.requirements\b|DELETE FROM public\.requirements\b/, "existing canonical Requirements are never modified");
  for (const fn of ["promote_requirement_proposal", "split_requirement_proposal", "promote_analysis_issue"]) assert.match(m040, new RegExp(`'public\\.${fn}\\(`), `${fn} is service-role only`);
  assert.match(m040, /EXECUTE format\('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn\);\s+EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO service_role', fn\);/);
  assert.equal(req("../lib/schema.ts").latestMigration, "040_requirement_review_promotion");
});

await run("the SQL reference numbering matches lib/utils nextRef (the canonical client rule)", () => {
  const rows = ["REP-001", "REP-012", "rep-003", "REP-9", "XYZ-100", "REP-12a"].map((r) => ({ requirement_ref: r }));
  assert.equal(nextRef(rows, "requirement_ref", "REP"), "REP-013");
  assert.equal(req("../lib/requirement-review-server.ts").refPrefixFor("requirements"), "REP");
  assert.deepEqual(["discovery_questions", "actions", "risks", "decisions"].map((t) => req("../lib/requirement-review-server.ts").refPrefixFor(t)), ["QUE", "ACT", "RSK", "DEC"]);
});

// ── Unchanged calculations & UI ────────────────────────────────────────────

await run("ProjectState / Go-Live / test-verification code does not depend on proposals or review", () => {
  for (const f of ["lib/project-state.ts", "lib/go-live-readiness.ts", "lib/lifecycle/test-verification.ts", "lib/lifecycle/requirement.ts", "lib/test-report-format.ts"]) {
    assert.doesNotMatch(read(f), /requirement_proposals|requirement-review|analysis_issues|scope_notes/, f);
  }
  assert.deepEqual(req("../lib/lifecycle/requirement.ts").SIGNED_OFF_REQUIREMENT_STATUSES, ["Approved", "Complete", "Closed"]);
  assert.equal(review.PROMOTED_REQUIREMENT_STATUS, "Discovery");
});

await run("UI: only state-valid actions; inferred acknowledgement and bulk confirmation; provenance on the Requirement drawer", () => {
  const ws = read("components/requirement-analysis-page.tsx");
  const dlg = read("components/analysis-review-dialogs.tsx");
  assert.match(ws, /const actions = mayReview \? allowedProposalActions\(p\) : \[\];/);
  assert.match(ws, /Show AI original/);
  assert.match(ws, /Promoted as <Link className="underline" href="\/requirements">\{p\.promoted_ref\}<\/Link>/);
  assert.match(dlg, /I confirm this interpretation is intended/);
  assert.match(dlg, /disabled=\{needsAck && !ack\}/);
  assert.match(dlg, /Bulk actions never promote/);
  assert.match(dlg, /disabled=\{!confirmed\}/);
  assert.match(dlg, /a proposal cannot lose its provenance/);
  assert.match(dlg, /never becomes a Requirement/);
  assert.match(read("components/app-client.tsx"), /<RequirementProvenancePanel projectId=\{pid\} requirementId=\{recordId\} \/>/);
  assert.doesNotMatch(read("components/source-documents-page.tsx"), /proposalReview|Promote/, "no review controls on Source Documents");
  for (const label of ["requirement_proposals: \"Requirement Proposal\"", "analysis_issues: \"Analysis Issue\"", "analysis_scope_notes: \"Scope Note\""]) assert.ok(read("components/audit-trail-page.tsx").includes(label));
});

console.log("\nAll Phase 1D requirement-review tests passed.\n");
