// Phase 1F — human Acceptance Criteria review and promotion. REAL route
// handlers, role guards, server orchestration and shared review rules; only
// the session lookup and the service-role client are stubbed, the latter
// mirroring migration 046's functions (state machine, approval blockers,
// split/merge provenance, atomic idempotent promotion, issue review, Human
// Clarifications, scope-note association). The migration itself was
// validated against the live database inside rolled-back transactions
// (SOMCR038 REP-001/002/003 and PL10) — its SQL is also asserted below.
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
const rules = req("../lib/ac-review.ts");
const routes = Object.fromEntries(["proposals", "generation-issues", "clarifications", "scope-notes", "provenance"].map((r) => [r, req(`../app/api/acceptance-criteria/${r}/route.ts`)]));
const runRoute = req("../app/api/requirements/ac-generation/route.ts");
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const OTHER_P = "99999999-9999-4999-8999-999999999999";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const [ARUN, JOB, RUN, RUN_OLD] = [uuid(), uuid(), uuid(), uuid()];
const [F1, F2, F3, F_OTHER] = [uuid(), uuid(), uuid(), uuid()];
const [REQ, REQ_SIGNED, REQ_MANUAL, REQ_OTHER_RUN] = [uuid(), uuid(), uuid(), uuid()];
const [Q_BLOCK, Q_COVER] = [uuid(), uuid()];
const [G_BLOCK, G_COVER, G_INFO] = [uuid(), uuid(), uuid()];
const [N_MONO, N_UNACK] = [uuid(), uuid()];
const PROP_REQ = uuid(), PROP_REQ_SIGNED = uuid(), RUN_SIGNED = uuid();
const ids = {};

// ── In-memory service-role stand-in (mirrors migration 046) ────────────────
let session = null;
const proposal = (o) => ({
  id: uuid(), generation_run_id: RUN, project_id: P, requirement_id: REQ, given_text: null, when_text: null, then_text: null, criterion_type: "Positive",
  basis: "Explicit", confidence: "High", review_status: "Proposed", needs_review_reasons: [], source_fragment_ids: [F1], scope_note_ids: [], clarification_issue_ids: [], open_issue_ids: [],
  source_quote: null, rationale: "Stated.", obligations: [], consolidation: {}, origin: "ai", parent_proposal_ids: [], human_authored: false,
  reviewed_criterion: null, reviewed_description: null, reviewed_criterion_type: null, reviewed_given_text: null, reviewed_when_text: null, reviewed_then_text: null,
  review_note: null, rejection_reason: null, review_confirmed_at: null, review_confirmed_by_name: null, reviewed_by_name: null, reviewed_at: null,
  promoted_ac_id: null, promoted_ac_ref: null, promoted_at: null, promoted_by_name: null, ...o,
});
const MANUAL_ACS = Array.from({ length: 44 }, (_, i) => ({ id: uuid(), project_id: P, requirement_id: REQ_MANUAL, ac_ref: `AC-${String(i + 1).padStart(3, "0")}`, criterion: `Manual AC ${i + 1}`, description: null, status: "Met", owner: null, evidence: null, notes: null }));
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  projects: [{ id: P }, { id: OTHER_P }],
  documents: [{ id: "doc1", project_id: P, document_name: "SOMCR038 Spec", document_type: "Functional Specification" }],
  document_versions: [{ id: "ver1", document_id: "doc1", project_id: P, version_number: 1, original_filename: "spec.pdf", content_type: "application/pdf" }],
  extraction_jobs: [{ id: JOB, project_id: P, document_version_id: "ver1", extractor_version: "1.2.0" }],
  analysis_runs: [{ id: ARUN, project_id: P, document_id: "doc1", document_version_id: "ver1", extraction_job_id: JOB }],
  source_fragments: [F1, F2, F3, F_OTHER].map((id, i) => ({ id, extraction_job_id: JOB, sequence: i + 1, fragment_type: "text", section_heading: `S${i + 1}`, section_number: null, section_path: ["Spec", `S${i + 1}`], page_start: i + 1, page_end: i + 1, text: `Fragment ${i + 1} text.`, metadata: {} })),
  requirement_proposals: [
    { id: PROP_REQ, analysis_run_id: ARUN, project_id: P, sequence: 1, origin: "ai", source_fragment_ids: [F1, F2, F3], review_status: "Promoted", promoted_record_id: REQ, promoted_at: "2026-10-01", promoted_by_name: "Manager User" },
    { id: PROP_REQ_SIGNED, analysis_run_id: ARUN, project_id: P, sequence: 2, origin: "ai", source_fragment_ids: [F1], review_status: "Promoted", promoted_record_id: REQ_SIGNED },
    { id: uuid(), analysis_run_id: ARUN, project_id: P, sequence: 3, origin: "ai", source_fragment_ids: [F_OTHER], review_status: "Promoted", promoted_record_id: REQ_OTHER_RUN },
  ],
  analysis_issues: [
    { id: Q_BLOCK, analysis_run_id: ARUN, sequence: 1, issue_type: "Missing Information", suggested_question: "Which users can configure the dashboard?", description: "d", status: "Open" },
    { id: Q_COVER, analysis_run_id: ARUN, sequence: 2, issue_type: "Missing Information", suggested_question: "Should exports be covered?", description: "d", status: "Open" },
  ],
  analysis_scope_notes: [
    { id: N_MONO, analysis_run_id: ARUN, project_id: P, sequence: 1, note_type: "No Change", area: "MONO picks", description: "MONO picks remain as they are.", source_quote: null, source_fragment_ids: [F1], acknowledged_at: "2026-10-01", acknowledged_by_name: "Manager User", acknowledgement_note: null },
    { id: N_UNACK, analysis_run_id: ARUN, project_id: P, sequence: 2, note_type: "No Change", area: "FULL PALLET", description: "FULL PALLET remains.", source_fragment_ids: [F1], acknowledged_at: null },
  ],
  requirements: [
    { id: REQ, project_id: P, requirement_ref: "REP-001", title: "Dashboard loads", description: "d", status: "Discovery" },
    { id: REQ_SIGNED, project_id: P, requirement_ref: "REP-002", title: "Signed", description: "d", status: "Approved" },
    { id: REQ_MANUAL, project_id: P, requirement_ref: "REP-050", title: "Manual", description: "d", status: "Open" },
    { id: REQ_OTHER_RUN, project_id: P, requirement_ref: "REP-003", title: "Other", description: "d", status: "Discovery" },
  ],
  acceptance_criteria: MANUAL_ACS.map((a) => ({ ...a })),
  evidence: [{ id: uuid(), project_id: P, ac_id: MANUAL_ACS[0].id, title: "Proof" }],
  requirement_signoffs: [{ id: uuid(), project_id: P, requirement_id: REQ_MANUAL }],
  ac_generation_runs: [
    { id: RUN, project_id: P, requirement_id: REQ, requirement_proposal_id: PROP_REQ, analysis_run_id: ARUN, extraction_job_id: JOB, status: "Completed", queued_at: "2026-10-05T10:00:00Z", prompt_version: "1.2.0", proposal_count: 0, model: "qwen3:8b",
      allowed_fragment_ids: [F1, F2, F3], scope_note_ids: [N_MONO], clarification_issue_ids: [], open_issue_ids: [Q_BLOCK, Q_COVER], input_snapshot: { requirement: { ref: "REP-001" }, fragment_ids: [F1, F2, F3], clarifications: [], open_questions: [], scope_notes: [] } },
    { id: RUN_OLD, project_id: P, requirement_id: REQ, requirement_proposal_id: PROP_REQ, analysis_run_id: ARUN, extraction_job_id: JOB, status: "Completed", queued_at: "2026-10-04T10:00:00Z", prompt_version: "1.0.0", proposal_count: 1, model: "qwen3:8b",
      allowed_fragment_ids: [F1], scope_note_ids: [], clarification_issue_ids: [], open_issue_ids: [], input_snapshot: { requirement: { ref: "REP-001" }, fragment_ids: [F1], clarifications: [], open_questions: [], scope_notes: [] } },
    { id: RUN_SIGNED, project_id: P, requirement_id: REQ_SIGNED, requirement_proposal_id: PROP_REQ_SIGNED, analysis_run_id: ARUN, extraction_job_id: JOB, status: "Completed", queued_at: "2026-10-05T09:00:00Z", allowed_fragment_ids: [F1], scope_note_ids: [], open_issue_ids: [] },
  ],
  acceptance_criterion_proposals: [],
  ac_generation_issues: [
    { id: G_BLOCK, generation_run_id: RUN, project_id: P, requirement_id: REQ, sequence: 1, issue_type: "Missing Information", severity: "High", description: "Who can configure?", relation: "Blocking", status: "Open", analysis_issue_ids: [Q_BLOCK], resolution_note: null, source_fragment_ids: [F1] },
    { id: G_COVER, generation_run_id: RUN, project_id: P, requirement_id: REQ, sequence: 2, issue_type: "Missing Information", severity: "Medium", description: "Exports?", relation: "Additional Coverage", status: "Open", analysis_issue_ids: [Q_COVER], resolution_note: null, source_fragment_ids: [F1] },
    { id: G_INFO, generation_run_id: RUN, project_id: P, requirement_id: REQ, sequence: 3, issue_type: "Ambiguity", severity: "Low", description: "FYI", relation: "Informational", status: "Open", analysis_issue_ids: [], resolution_note: null, source_fragment_ids: [F1] },
  ],
  ac_human_clarifications: [], ac_scope_note_requirements: [], audit_log: [],
};
const P_PLAIN = proposal({ sequence: 1, criterion: "The dashboard loads for the Support User." });
const P_BLOCKED = proposal({ sequence: 2, criterion: "Only configured users can change the dashboard.", review_status: "Needs Review", needs_review_reasons: ["Blocked by an open question (Q1)."], open_issue_ids: [Q_BLOCK] });
const P_COVER = proposal({ sequence: 3, criterion: "The dashboard shows today's picks.", open_issue_ids: [] });
const P_VAGUE = proposal({ sequence: 4, criterion: "The dashboard loads correctly.", review_status: "Needs Review", needs_review_reasons: ["Vague wording: \"correctly\" is not defined by the source."] });
const P_INVENTED = proposal({ sequence: 5, criterion: "The dashboard loads within 2 seconds.", review_status: "Needs Review", needs_review_reasons: ["Expected result introduces an unsupported interpretation (\"within 2 seconds\")."] });
const P_DROPPED = proposal({ sequence: 6, criterion: "The dashboard is available to users.", review_status: "Needs Review", needs_review_reasons: ["Omits \"Support User\" named in the source."] });
const P_SPAN = proposal({ sequence: 7, criterion: "The picker name is shown in Pick Dashboard, Pallet Console and Despatch Monitor.", source_fragment_ids: [F1, F2, F3] });
const P_NEG = proposal({ sequence: 8, criterion: "A user without the role cannot open the dashboard.", criterion_type: "Negative" });
const P_M1 = proposal({ sequence: 9, criterion: "Pick totals are shown.", source_fragment_ids: [F1] });
const P_M2 = proposal({ sequence: 10, criterion: "Pick totals are refreshed.", source_fragment_ids: [F2] });
const P_REG = proposal({ sequence: 11, criterion: "MONO picks behave as before.", criterion_type: "Regression", scope_note_ids: [N_MONO] });
const P_OLD = proposal({ generation_run_id: RUN_OLD, sequence: 1, criterion: "Old wording." });
const P_SIGNED = proposal({ generation_run_id: RUN_SIGNED, requirement_id: REQ_SIGNED, sequence: 1, criterion: "Signed requirement AC.", review_status: "Approved" });
db.acceptance_criterion_proposals.push(P_PLAIN, P_BLOCKED, P_COVER, P_VAGUE, P_INVENTED, P_DROPPED, P_SPAN, P_NEG, P_M1, P_M2, P_REG, P_OLD, P_SIGNED);
const aiOriginal = JSON.stringify(db.acceptance_criterion_proposals.map((p) => [p.criterion, p.criterion_type, p.given_text, p.when_text, p.then_text, p.basis, p.source_fragment_ids]));
const manualSnapshot = JSON.stringify(MANUAL_ACS);

function builder(table) {
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : kind === "overlaps" ? (r[k] ?? []).some((x) => v.includes(x)) : r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), ...r })); db[table].push(...list); return list; }
    if (q.op === "update" || q.op === "delete") throw new Error(`direct ${q.op} on ${table} — review writes must go through migration 046's functions`);
    return rows().filter(matches).map((r) => ({ ...r }));
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; }, overlaps(k, v) { q.filters.push([k, v, "overlaps"]); return b; },
    order() { return b; }, limit() { return b; },
    insert(p) { if (table !== "audit_log") throw new Error(`direct insert into ${table}`); q.op = "insert"; q.payload = p; return b; },
    update(p) { q.op = "update"; q.payload = p; return b; }, delete() { q.op = "delete"; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve, reject) { try { return Promise.resolve({ data: exec(), error: null }).then(resolve); } catch (e) { return Promise.reject(e).then(null, reject); } },
  };
  return b;
}
class DbError extends Error { constructor(code, message) { super(message); this.code = code; } }
const raise = (code, message) => { throw new DbError(code, message); };
const OPEN = ["Proposed", "Needs Review", "Approved"];
const lock = (id, project) => db.acceptance_criterion_proposals.find((p) => p.id === id && p.project_id === project) ?? raise("P0002", "Acceptance criterion proposal not found in this project");
const subset = (a, b) => a.every((x) => b.includes(x));
const blockersOf = (v, confirmed) => {
  const out = [];
  const text = [v.reviewed_criterion ?? v.criterion, v.reviewed_given_text ?? v.given_text, v.reviewed_when_text ?? v.when_text, v.reviewed_then_text ?? v.then_text].filter(Boolean).join(" ").toLowerCase();
  const clarified = db.ac_human_clarifications.some((c) => c.proposal_id === v.id);
  const edited = v.reviewed_criterion != null && v.reviewed_criterion !== v.criterion;
  for (const q of v.open_issue_ids) if (!db.ac_generation_issues.some((g) => g.generation_run_id === v.generation_run_id && g.analysis_issue_ids.includes(q) && ["Resolved", "Not Applicable"].includes(g.status))) out.push(`Resolve (or set Not Applicable) the blocking question first: ${db.analysis_issues.find((i) => i.id === q)?.suggested_question}`);
  for (const r of v.needs_review_reasons) {
    if (/^(Blocked by|Depends on) an open question/i.test(r)) continue;
    if (/^Omits /i.test(r)) { for (const m of r.matchAll(/"([^"]+)"/g)) if (!text.includes(m[1].toLowerCase())) out.push(`Restore "${m[1]}" in the criterion — it is named in the source.`); }
    else if (/^(Expected result is source-grounded|Vague wording)/i.test(r)) { if (!clarified) out.push("Record a Human Clarification that defines the expected result (the source does not)."); }
    else if (/^Expected result introduces an unsupported interpretation/i.test(r)) { if (!(edited || clarified)) out.push("Correct the unsupported wording (edit), or record a Human Clarification that supports it."); }
  }
  if (v.review_status === "Needs Review" && !confirmed) out.push("Confirm that you reviewed this criterion against its source.");
  return out;
};
const nextSeq = (runId) => Math.max(0, ...db.acceptance_criterion_proposals.filter((p) => p.generation_run_id === runId).map((p) => p.sequence)) + 1;
const insertReviewed = (runRow, child, origin, parents, basis, confidence, reasons, rationale, consolidation, a) => {
  if (!String(child.criterion ?? "").trim()) raise("22023", "Every acceptance criterion needs its wording");
  // ac_generation_output_guard: provenance within the run's allowed input.
  if (!subset(child.source_fragment_ids ?? [], runRow.allowed_fragment_ids)) raise("22023", "A proposal may cite only the source fragments its generation run was given");
  const row = proposal({ generation_run_id: runRow.id, project_id: runRow.project_id, requirement_id: runRow.requirement_id, sequence: nextSeq(runRow.id), criterion: child.criterion.trim(),
    given_text: child.given_text || null, when_text: child.when_text || null, then_text: child.then_text || null, criterion_type: child.criterion_type ?? "Positive", basis, confidence,
    review_status: "Needs Review", needs_review_reasons: reasons, source_fragment_ids: child.source_fragment_ids ?? [], scope_note_ids: child.scope_note_ids ?? [],
    clarification_issue_ids: child.clarification_issue_ids ?? [], open_issue_ids: child.open_issue_ids ?? [], rationale, consolidation: consolidation ?? {}, origin, parent_proposal_ids: parents,
    human_authored: true, reviewed_description: child.description || null, reviewed_by_name: a.p_user_name });
  db.acceptance_criterion_proposals.push(row);
  return row;
};
const failPromotionOnce = { armed: false };
function rpc(name, a) {
  try {
    switch (name) {
      case "ac_approval_blockers": return { data: blockersOf(db.acceptance_criterion_proposals.find((p) => p.id === a.p_proposal_id), a.p_confirmed), error: null };
      case "edit_ac_proposal": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (!OPEN.includes(v.review_status)) raise("55000", `A ${v.review_status.toLowerCase()} proposal cannot be edited`);
        const t = (x) => String(x ?? "").trim();
        Object.assign(v, {
          reviewed_criterion: !t(a.p_criterion) || t(a.p_criterion) === v.criterion ? null : t(a.p_criterion), reviewed_description: t(a.p_description) || null,
          reviewed_criterion_type: a.p_type == null || a.p_type === v.criterion_type ? null : a.p_type,
          reviewed_given_text: t(a.p_given) === (v.given_text ?? "") ? null : t(a.p_given), reviewed_when_text: t(a.p_when) === (v.when_text ?? "") ? null : t(a.p_when), reviewed_then_text: t(a.p_then) === (v.then_text ?? "") ? null : t(a.p_then),
          review_status: v.review_status === "Approved" ? "Needs Review" : v.review_status, review_confirmed_at: v.review_status === "Approved" ? null : v.review_confirmed_at, reviewed_by_name: a.p_user_name,
        });
        return { data: { ...v }, error: null };
      }
      case "review_ac_proposal": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        const target = { approve: "Approved", reject: "Rejected", needs_review: "Needs Review", reopen: "Needs Review" }[a.p_action];
        if (a.p_action === "reopen" && v.review_status !== "Rejected") raise("55000", "Only a rejected proposal can be reopened");
        if (v.review_status === target) return { data: { ...v }, error: null };
        // ac_generation_output_guard transitions.
        const allowed = { Proposed: ["Approved", "Needs Review", "Rejected", "Superseded"], "Needs Review": ["Approved", "Rejected", "Superseded"], Approved: ["Promoted", "Needs Review", "Rejected", "Superseded"], Rejected: ["Needs Review"] };
        if (!(allowed[v.review_status] ?? []).includes(target)) raise("55000", `A proposal cannot move from ${v.review_status} to ${target}`);
        if (target === "Approved") { const b = blockersOf(v, a.p_confirm); if (b.length) raise("55000", `This proposal cannot be approved yet: ${b.join(" ")}`); }
        const confirmedNow = target === "Approved" && v.review_status === "Needs Review";
        Object.assign(v, { review_status: target, review_note: a.p_note ?? v.review_note, rejection_reason: target === "Rejected" ? a.p_reason : null,
          review_confirmed_at: confirmedNow ? "now" : target === "Approved" ? v.review_confirmed_at : null, review_confirmed_by_name: confirmedNow ? a.p_user_name : target === "Approved" ? v.review_confirmed_by_name : null, reviewed_by_name: a.p_user_name });
        return { data: { ...v }, error: null };
      }
      case "split_ac_proposal": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (!OPEN.includes(v.review_status)) raise("55000", `A ${v.review_status.toLowerCase()} proposal cannot be split`);
        if (a.p_children.length < 2) raise("22023", "A split needs at least two acceptance criteria");
        const runRow = db.ac_generation_runs.find((r) => r.id === v.generation_run_id);
        for (const c of a.p_children) {
          if (!(subset(c.source_fragment_ids, v.source_fragment_ids) && subset(c.scope_note_ids, v.scope_note_ids) && subset(c.clarification_issue_ids, v.clarification_issue_ids) && subset(c.open_issue_ids, v.open_issue_ids))) raise("22023", "A split acceptance criterion may only cite provenance of the proposal it was split from");
          if (c.source_fragment_ids.length + c.scope_note_ids.length + c.clarification_issue_ids.length === 0) raise("22023", "Every split acceptance criterion needs at least one source reference");
        }
        const kids = a.p_children.map((c) => insertReviewed(runRow, { ...c, criterion_type: c.criterion_type ?? v.reviewed_criterion_type ?? v.criterion_type }, "split", [v.id], v.basis, v.confidence,
          [...v.needs_review_reasons.filter((r) => !/^(Blocked by|Depends on) an open question/i.test(r) || c.open_issue_ids.length), `Split from #${v.sequence} by ${a.p_user_name} — confirm before approval.`], `Split from proposal #${v.sequence}.`, {}, a));
        Object.assign(v, { review_status: "Superseded" });
        return { data: kids, error: null };
      }
      case "merge_ac_proposals": {
        const members = a.p_proposal_ids.map((id) => lock(id, a.p_project_id));
        for (const m of members) if (!OPEN.includes(m.review_status)) raise("55000", `Proposal #${m.sequence} is ${m.review_status.toLowerCase()} and cannot be merged`);
        if (new Set(members.map((m) => m.generation_run_id)).size > 1) raise("22023", "Only proposals from the same generation run can be merged");
        if (new Set(members.map((m) => m.reviewed_criterion_type ?? m.criterion_type)).size > 1) raise("22023", "Only acceptance criteria of the same type (Positive / Negative / Regression) can be merged");
        const runRow = db.ac_generation_runs.find((r) => r.id === members[0].generation_run_id);
        const union = (k) => [...new Set(members.flatMap((m) => m[k]))];
        const merged = insertReviewed(runRow, { ...a.p_fields, criterion_type: members[0].reviewed_criterion_type ?? members[0].criterion_type, source_fragment_ids: union("source_fragment_ids"), scope_note_ids: union("scope_note_ids"), clarification_issue_ids: union("clarification_issue_ids"), open_issue_ids: union("open_issue_ids") },
          "merge", members.map((m) => m.id), members.some((m) => m.basis === "Inferred") ? "Inferred" : "Explicit", "High", [...new Set(members.flatMap((m) => m.needs_review_reasons)), "Merged — confirm before approval."], "Merged.",
          { merged: true, member_count: members.length, members: members.map((m) => ({ proposal_id: m.id, criterion: m.reviewed_criterion ?? m.criterion, source_ids: m.source_fragment_ids })) }, a);
        members.forEach((m) => { m.review_status = "Superseded"; });
        return { data: merged, error: null };
      }
      case "create_manual_ac_proposal": {
        const runRow = db.ac_generation_runs.find((r) => r.id === a.p_run_id && r.project_id === a.p_project_id) ?? raise("P0002", "Generation run not found in this project");
        if (!["Completed", "Completed with warnings"].includes(runRow.status)) raise("55000", "Manual acceptance criteria can be added only to a completed generation run");
        const f = a.p_fields;
        if (f.source_fragment_ids.length + f.scope_note_ids.length + f.clarification_issue_ids.length === 0) raise("22023", "Select at least one source reference (fragment, scope note or clarification) for the acceptance criterion");
        return { data: insertReviewed(runRow, f, "manual", [], "Inferred", "Medium", ["Human-authored acceptance criterion — confirm before approval."], f.rationale ?? "Added.", {}, a), error: null };
      }
      case "promote_ac_proposal": {
        if (!/^[A-Z]{2,6}$/.test(a.p_ref_prefix)) raise("22023", "Invalid reference prefix");
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (v.review_status === "Promoted") return { data: [{ ac_id: v.promoted_ac_id, ac_ref: v.promoted_ac_ref, already_promoted: true, criterion: v.reviewed_criterion ?? v.criterion }], error: null };
        if (v.review_status !== "Approved") raise("55000", `Only an Approved acceptance criterion proposal can be promoted (this one is ${v.review_status})`);
        const b = blockersOf(v, true);
        if (b.length) raise("55000", `This proposal cannot be promoted: ${b.join(" ")}`);
        const r = db.requirements.find((x) => x.id === v.requirement_id && x.project_id === a.p_project_id) ?? raise("P0002", "The Requirement no longer exists in this project");
        if (["approved", "complete", "closed"].includes(String(r.status).toLowerCase())) raise("55000", `Requirement ${r.requirement_ref} is ${r.status} (signed off); acceptance criteria are not added to a signed-off Requirement`);
        if (failPromotionOnce.armed) { failPromotionOnce.armed = false; raise("40001", "could not serialize access"); } // the whole transaction rolls back
        const n = Math.max(0, ...db.acceptance_criteria.filter((x) => x.project_id === a.p_project_id).map((x) => Number(new RegExp(`^${a.p_ref_prefix}-(\\d+)$`, "i").exec(x.ac_ref)?.[1] ?? 0))) + 1;
        const ref = `${a.p_ref_prefix}-${String(n).padStart(3, "0")}`;
        const clar = db.ac_human_clarifications.filter((c) => c.proposal_id === v.id).length;
        const ac = { id: uuid(), project_id: a.p_project_id, requirement_id: v.requirement_id, ac_ref: ref, criterion: v.reviewed_criterion ?? v.criterion, description: v.reviewed_description, status: "Not Started", owner: null, evidence: null,
          notes: `Promoted from AI acceptance criteria proposal #${v.sequence} for ${r.requirement_ref} by ${a.p_user_name}.${clar ? ` Relies on ${clar} Human Clarification${clar === 1 ? "" : "s"}.` : ""}`,
          criterion_type: v.reviewed_criterion_type ?? v.criterion_type, given_text: v.reviewed_given_text ?? v.given_text, when_text: v.reviewed_when_text ?? v.when_text, then_text: v.reviewed_then_text ?? v.then_text };
        db.acceptance_criteria.push(ac);
        Object.assign(v, { review_status: "Promoted", promoted_ac_id: ac.id, promoted_ac_ref: ref, promoted_at: "now", promoted_by_name: a.p_user_name });
        return { data: [{ ac_id: ac.id, ac_ref: ref, already_promoted: false, criterion: ac.criterion }], error: null };
      }
      case "review_ac_generation_issue": {
        const v = db.ac_generation_issues.find((i) => i.id === a.p_issue_id && i.project_id === a.p_project_id) ?? raise("P0002", "Generation issue not found in this project");
        if (["Resolved", "Not Applicable"].includes(a.p_status) && !String(a.p_note ?? v.resolution_note ?? "").trim()) raise("22023", "Record how the issue was resolved (or why it does not apply)");
        Object.assign(v, { status: a.p_status, resolution_note: a.p_note ?? v.resolution_note, reviewed_by_name: a.p_user_name });
        return { data: { ...v }, error: null };
      }
      case "save_ac_clarification": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (["Promoted", "Superseded"].includes(v.review_status)) raise("55000", "Clarifications of a promoted or superseded proposal are final");
        let c;
        if (!a.p_clarification_id) { c = { id: uuid(), project_id: a.p_project_id, generation_run_id: v.generation_run_id, proposal_id: v.id, analysis_issue_id: a.p_analysis_issue_id, generation_issue_id: a.p_generation_issue_id, clarification: a.p_text, reason: a.p_reason, created_by_name: a.p_user_name, created_at: "now", updated_by_name: null }; db.ac_human_clarifications.push(c); }
        else { c = db.ac_human_clarifications.find((x) => x.id === a.p_clarification_id && x.proposal_id === v.id) ?? raise("P0002", "Clarification not found for this proposal"); Object.assign(c, { clarification: a.p_text, reason: a.p_reason, updated_by_name: a.p_user_name }); }
        if (v.review_status === "Approved") Object.assign(v, { review_status: "Needs Review", review_confirmed_at: null, review_confirmed_by_name: null });
        return { data: { ...c }, error: null };
      }
      case "set_scope_note_association": {
        const n = db.analysis_scope_notes.find((x) => x.id === a.p_note_id && x.project_id === a.p_project_id) ?? raise("P0002", "Scope note not found in this project");
        if (a.p_associate) {
          if (!n.acknowledged_at) raise("55000", "Acknowledge the scope note in the analysis review before associating it");
          if (!db.requirement_proposals.some((p) => p.promoted_record_id === a.p_requirement_id && p.review_status === "Promoted" && p.analysis_run_id === n.analysis_run_id)) raise("22023", "A scope note can be associated only with a Requirement promoted from the same analysis");
          if (db.ac_scope_note_requirements.some((x) => x.scope_note_id === n.id && x.requirement_id === a.p_requirement_id)) return { data: false, error: null };
          db.ac_scope_note_requirements.push({ id: uuid(), project_id: a.p_project_id, scope_note_id: n.id, requirement_id: a.p_requirement_id, note: a.p_note, associated_by_name: a.p_user_name, associated_at: "now" });
          return { data: true, error: null };
        }
        const before = db.ac_scope_note_requirements.length;
        db.ac_scope_note_requirements = db.ac_scope_note_requirements.filter((x) => !(x.scope_note_id === n.id && x.requirement_id === a.p_requirement_id));
        return { data: before !== db.ac_scope_note_requirements.length, error: null };
      }
      case "supersede_older_ac_proposals": {
        const r = db.ac_generation_runs.find((x) => x.id === a.p_run_id && x.project_id === a.p_project_id) ?? raise("P0002", "Generation run not found in this project");
        const older = db.ac_generation_runs.filter((x) => x.requirement_id === r.requirement_id && x.id !== r.id && x.queued_at < r.queued_at).map((x) => x.id);
        const hit = db.acceptance_criterion_proposals.filter((p) => older.includes(p.generation_run_id) && OPEN.includes(p.review_status));
        hit.forEach((p) => { p.review_status = "Superseded"; });
        return { data: hit.length, error: null };
      }
    }
  } catch (e) {
    if (e instanceof DbError) return { data: null, error: { code: e.code, message: e.message } };
    throw e;
  }
  return { data: null, error: { code: "42883", message: `unknown function ${name}` } };
}
serviceRoleModule.createServiceRoleClient = () => ({ from: builder, rpc: async (n, a) => rpc(n, a) });
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };
const call = async (handler, url, { body, method = "POST" } = {}) => {
  const headers = { "content-type": "application/json" };
  const res = await handler(new NextRequest(`http://localhost${url}`, method === "GET" ? { method, headers } : { method, headers, body: JSON.stringify(body ?? {}) }));
  return { status: res.status, body: await res.json() };
};
const act = (action, body) => call(routes.proposals.POST, "/api/acceptance-criteria/proposals", { body: { project_id: P, action, ...body } });
const issue = (issue_id, status, note) => call(routes["generation-issues"].POST, "/api/acceptance-criteria/generation-issues", { body: { project_id: P, issue_id, status, note } });
const clarify = (proposal_id, clarification, extra = {}) => call(routes.clarifications.POST, "/api/acceptance-criteria/clarifications", { body: { project_id: P, proposal_id, clarification, ...extra } });
const associate = (scope_note_id, requirement_id, action = "associate") => call(routes["scope-notes"].POST, "/api/acceptance-criteria/scope-notes", { body: { project_id: P, scope_note_id, requirement_id, action } });
const provenance = (acId) => call(routes.provenance.GET, `/api/acceptance-criteria/provenance?project_id=${P}&ac_id=${acId}`, { method: "GET" });
const get = (id) => db.acceptance_criterion_proposals.find((p) => p.id === id);
const promotedAcs = () => db.acceptance_criteria.filter((a) => !MANUAL_ACS.some((m) => m.id === a.id));

// ── Permissions ─────────────────────────────────────────────────────────────

await run("anon and Viewer cannot review, clarify, resolve issues or associate notes; Manager and Admin can", async () => {
  for (const [role, status] of [[null, 401], ["Viewer", 403]]) {
    as(role);
    assert.equal((await act("approve", { proposal_id: P_PLAIN.id })).status, status, `${role ?? "anon"} approve`);
    assert.equal((await act("promote", { proposal_id: P_PLAIN.id })).status, status, `${role ?? "anon"} promote`);
    assert.equal((await issue(G_INFO, "Accepted")).status, status);
    assert.equal((await clarify(P_VAGUE.id, "x")).status, status);
    assert.equal((await associate(N_MONO, REQ)).status, status);
    assert.equal((await call(runRoute.GET, `/api/requirements/ac-generation?project_id=${P}&run_id=${RUN}`, { method: "GET" })).status, status, "workspace");
  }
  assert.equal(get(P_PLAIN.id).review_status, "Proposed");
  as("Manager");
  const ws = await call(runRoute.GET, `/api/requirements/ac-generation?project_id=${P}&run_id=${RUN}`, { method: "GET" });
  assert.equal(ws.status, 200);
  assert.equal(ws.body.latest_run_id, RUN, "this is the latest run");
  assert.equal(ws.body.older_open_proposals, 1, "the older run has one open proposal");
  assert.deepEqual(ws.body.scope_notes.map((n) => n.id), [N_MONO], "only acknowledged scope notes");
  assert.ok(ws.body.approval_blockers[P_BLOCKED.id].some((b) => /blocking question/.test(b)));
  as("Admin");
  assert.equal((await act("bogus", {})).status, 400);
  assert.equal((await call(routes.proposals.POST, "/api/acceptance-criteria/proposals", { body: { project_id: OTHER_P, action: "approve", proposal_id: P_PLAIN.id } })).status, 404, "project scoped");
});

// ── Shared rules ────────────────────────────────────────────────────────────

await run("rules: only valid actions per status; bulk approve Proposed only; blocking issues gate, others do not", () => {
  assert.deepEqual(rules.allowedAcActions({ review_status: "Rejected" }), ["reopen"]);
  assert.deepEqual(rules.allowedAcActions({ review_status: "Promoted" }), []);
  assert.deepEqual(rules.allowedAcActions({ review_status: "Superseded" }), []);
  assert.ok(rules.allowedAcActions({ review_status: "Approved" }).includes("promote"));
  assert.ok(!rules.allowedAcActions({ review_status: "Needs Review" }).includes("promote"));
  assert.ok(!rules.allowedAcActions({ review_status: "Needs Review" }).includes("needs_review"));
  assert.equal(rules.bulkApprovable({ review_status: "Needs Review" }), false);
  assert.equal(rules.bulkApprovable({ review_status: "Proposed" }), true);
  assert.equal(rules.issueBlocksApproval({ relation: "Blocking", status: "Open" }), true);
  assert.equal(rules.issueBlocksApproval({ relation: "Blocking", status: "Accepted" }), true, "Accepted does not resolve a blocking question");
  assert.equal(rules.issueBlocksApproval({ relation: "Blocking", status: "Not Applicable" }), false);
  assert.equal(rules.issueBlocksApproval({ relation: "Additional Coverage", status: "Open" }), false);
  assert.equal(rules.issueBlocksApproval({ relation: "Informational", status: "Open" }), false);
  assert.deepEqual(["Blocked by an open question", "Omits \"x\"", "Vague wording", "Expected result introduces an unsupported interpretation", "Split from #1"].map(rules.reasonKind), ["blocking", "condition", "clarify", "correct", "confirm"]);
  assert.equal(rules.suggestsSplit(P_SPAN.criterion), true, "application-spanning wording suggests a split");
  assert.equal(rules.suggestsSplit(P_PLAIN.criterion), false);
  assert.equal(rules.PROMOTED_AC_STATUS, "Not Started");
});

// ── Edit, approve, needs review, reject, reopen ────────────────────────────

await run("edit keeps the AI original, is audited, and editing an Approved proposal returns it to Needs Review", async () => {
  as("Manager");
  assert.equal((await act("approve", { proposal_id: P_PLAIN.id })).status, 200);
  assert.equal(get(P_PLAIN.id).review_status, "Approved");
  const r = await act("edit", { proposal_id: P_PLAIN.id, criterion: "The dashboard loads for the Support User after login.", criterion_type: "Positive", given_text: "a Support User", when_text: "they log in", then_text: "the dashboard loads" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = get(P_PLAIN.id);
  assert.equal(p.criterion, "The dashboard loads for the Support User.", "AI original immutable");
  assert.equal(p.reviewed_criterion, "The dashboard loads for the Support User after login.");
  assert.equal(p.reviewed_criterion_type, null, "a value equal to the AI original is stored as unedited");
  assert.equal(p.review_status, "Needs Review");
  const audits = db.audit_log.filter((x) => x.entity_id === P_PLAIN.id);
  assert.ok(audits.some((x) => x.field_name === "criterion" && x.old_value === "The dashboard loads for the Support User." && x.changed_by_name === "Manager User"));
  assert.ok(audits.some((x) => x.field_name === "given_text"));
  assert.ok(audits.some((x) => x.action_type === "Status Change" && /edited after approval/.test(x.new_value)));
  assert.equal((await act("edit", { proposal_id: P_PLAIN.id, criterion_type: "Sideways" })).status, 400);
});

await run("Needs Review requires explicit confirmation; reject with a reason and reopen; never hard-deleted", async () => {
  as("Manager");
  const unconfirmed = await act("approve", { proposal_id: P_PLAIN.id });
  assert.equal(unconfirmed.status, 409);
  assert.match(unconfirmed.body.error, /Confirm that you reviewed/);
  const ok = await act("approve", { proposal_id: P_PLAIN.id, confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(get(P_PLAIN.id).review_confirmed_by_name, "Manager User");
  assert.equal((await act("reject", { proposal_id: P_NEG.id, reason: "Made up" })).status, 400, "reason must be from the list");
  assert.equal((await act("reject", { proposal_id: P_NEG.id, reason: "Not testable", note: "No role model yet" })).status, 200);
  assert.equal(get(P_NEG.id).rejection_reason, "Not testable");
  assert.equal((await act("reopen", { proposal_id: P_COVER.id })).status, 409, "only a rejected proposal can be reopened");
  assert.equal((await act("reopen", { proposal_id: P_NEG.id })).status, 200);
  assert.equal(get(P_NEG.id).review_status, "Needs Review");
  assert.ok(db.acceptance_criterion_proposals.includes(P_NEG), "kept");
});

// ── Needs Review reasons A–D ───────────────────────────────────────────────

await run("A: a Blocking question prevents approval until Resolved / Not Applicable (with a note); Accepted does not resolve it", async () => {
  as("Manager");
  const blocked = await act("approve", { proposal_id: P_BLOCKED.id, confirm: true });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Which users can configure the dashboard\?/);
  assert.equal((await issue(G_BLOCK, "Resolved", null)).status, 400, "resolution needs a note");
  assert.equal((await issue(G_BLOCK, "Accepted", "Known gap")).status, 200);
  assert.equal((await act("approve", { proposal_id: P_BLOCKED.id, confirm: true })).status, 409, "Accepted keeps it blocking");
  assert.equal((await issue(G_BLOCK, "Resolved", "Only Support Users configure it.")).status, 200);
  assert.equal((await act("approve", { proposal_id: P_BLOCKED.id, confirm: true })).status, 200);
  assert.ok(db.audit_log.some((x) => x.entity_type === "ac_generation_issues" && x.entity_id === G_BLOCK && /Resolved — Only Support Users/.test(x.new_value)));
});

await run("Additional Coverage and Informational issues stay open without blocking approval", async () => {
  as("Manager");
  assert.equal(db.ac_generation_issues.find((i) => i.id === G_COVER).status, "Open");
  assert.equal((await act("approve", { proposal_id: P_COVER.id })).status, 200);
  assert.equal((await issue(G_INFO, "Not Applicable", "Informational only")).status, 200);
});

await run("C: vague-but-grounded wording needs a recorded Human Clarification, then can be approved", async () => {
  as("Manager");
  const r = await act("approve", { proposal_id: P_VAGUE.id, confirm: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Human Clarification/);
  const c = await clarify(P_VAGUE.id, "Correctly means the dashboard shows the Support User's open picks within the page.", { reason: P_VAGUE.needs_review_reasons[0], generation_issue_id: G_INFO });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const saved = db.ac_human_clarifications.find((x) => x.proposal_id === P_VAGUE.id);
  assert.equal(saved.created_by_name, "Manager User");
  assert.ok(db.audit_log.some((x) => x.entity_type === "ac_human_clarifications" && x.action_type === "Create"));
  assert.equal((await act("approve", { proposal_id: P_VAGUE.id, confirm: true })).status, 200);
  // Revising the clarification of an Approved proposal returns it to Needs Review.
  assert.equal((await clarify(P_VAGUE.id, "Correctly means the open picks are listed.", { clarification_id: saved.id })).status, 200);
  assert.equal(get(P_VAGUE.id).review_status, "Needs Review");
  assert.ok(db.audit_log.some((x) => x.entity_type === "ac_human_clarifications" && x.action_type === "Update" && x.old_value?.startsWith("Correctly means the dashboard")));
  assert.equal((await act("approve", { proposal_id: P_VAGUE.id, confirm: true })).status, 200);
});

await run("B: an unsupported interpretation must be corrected (or supported by a clarification); D: a dropped condition must be restored", async () => {
  as("Manager");
  assert.match((await act("approve", { proposal_id: P_INVENTED.id, confirm: true })).body.error, /Correct the unsupported wording/);
  assert.equal((await act("edit", { proposal_id: P_INVENTED.id, criterion: "The dashboard loads." })).status, 200);
  assert.equal((await act("approve", { proposal_id: P_INVENTED.id, confirm: true })).status, 200);
  const d = await act("approve", { proposal_id: P_DROPPED.id, confirm: true });
  assert.match(d.body.error, /Restore "Support User"/);
  assert.equal((await act("edit", { proposal_id: P_DROPPED.id, criterion: "The dashboard is available to the Support User." })).status, 200);
  assert.equal((await act("approve", { proposal_id: P_DROPPED.id, confirm: true })).status, 200);
});

// ── Split, merge, manual ───────────────────────────────────────────────────

await run("split: subset provenance only, never zero, same Requirement, children Needs Review with lineage; parent Superseded", async () => {
  as("Manager");
  const child = (criterion, f) => ({ criterion, criterion_type: "Positive", source_fragment_ids: f, scope_note_ids: [], clarification_issue_ids: [], open_issue_ids: [] });
  assert.equal((await act("split", { proposal_id: P_SPAN.id, children: [child("A", [F1]), child("B", [F_OTHER])] })).status, 400, "foreign provenance");
  assert.equal((await act("split", { proposal_id: P_SPAN.id, children: [child("A", [F1]), child("B", [])] })).status, 400, "zero provenance");
  assert.equal((await act("split", { proposal_id: P_SPAN.id, children: [child("A", [F1])] })).status, 400, "at least two");
  const r = await act("split", { proposal_id: P_SPAN.id, children: [child("Pick Dashboard shows the picker name.", [F1]), child("Pallet Console shows the picker name.", [F2]), child("Despatch Monitor shows the picker name.", [F3])] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(get(P_SPAN.id).review_status, "Superseded");
  assert.equal(r.body.children.length, 3);
  for (const k of r.body.children.map((c) => get(c.id))) {
    assert.deepEqual([k.review_status, k.origin, k.human_authored, k.requirement_id, k.generation_run_id], ["Needs Review", "split", true, REQ, RUN]);
    assert.deepEqual(k.parent_proposal_ids, [P_SPAN.id]);
    assert.ok(k.source_fragment_ids.length === 1 && P_SPAN.source_fragment_ids.includes(k.source_fragment_ids[0]));
    assert.ok(k.needs_review_reasons.some((x) => /^Split from #7/.test(x)));
  }
  ids.splitChild = r.body.children[0].id;
  assert.equal((await act("approve", { proposal_id: P_SPAN.id })).status, 409, "Superseded is final");
});

await run("merge: same run and type only; lossless union of provenance and wording; members Superseded", async () => {
  as("Manager");
  assert.equal((await act("merge", { proposal_ids: [P_M1.id, P_OLD.id], criterion: "x" })).status, 400, "different runs");
  assert.equal((await act("merge", { proposal_ids: [P_M1.id, P_REG.id], criterion: "x" })).status, 400, "different types");
  const r = await act("merge", { proposal_ids: [P_M1.id, P_M2.id], criterion: "Pick totals are shown and refreshed." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = get(r.body.proposal.id);
  assert.deepEqual([m.review_status, m.origin, m.consolidation.member_count], ["Needs Review", "merge", 2]);
  assert.deepEqual(new Set(m.source_fragment_ids), new Set([F1, F2]));
  assert.deepEqual(m.consolidation.members.map((x) => x.criterion), ["Pick totals are shown.", "Pick totals are refreshed."]);
  assert.deepEqual([get(P_M1.id).review_status, get(P_M2.id).review_status], ["Superseded", "Superseded"]);
});

await run("manual proposal: completed run, same Requirement, provenance required (from the run's input only), human-authored, Needs Review, no ref", async () => {
  as("Manager");
  assert.equal((await act("create_manual", { run_id: RUN, criterion: "x", source_fragment_ids: [] })).status, 400, "provenance required");
  assert.equal((await act("create_manual", { run_id: RUN, criterion: "x", source_fragment_ids: [F_OTHER] })).status, 400, "only fragments the run was given");
  const r = await act("create_manual", { run_id: RUN, criterion: "MONO picks still show the picker name.", criterion_type: "Regression", source_fragment_ids: [F1], scope_note_ids: [N_MONO] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = get(r.body.proposal.id);
  assert.deepEqual([p.review_status, p.origin, p.human_authored, p.requirement_id, p.criterion_type, p.promoted_ac_ref], ["Needs Review", "manual", true, REQ, "Regression", null]);
  ids.manual = p.id;
});

// ── Scope / regression notes ───────────────────────────────────────────────

await run("scope notes: an acknowledged note can be associated with a Requirement from the same analysis; unassociated stays change-level", async () => {
  as("Manager");
  assert.equal((await associate(N_UNACK, REQ)).status, 409, "must be acknowledged first");
  assert.equal((await associate(N_MONO, REQ_MANUAL)).status, 400, "manual Requirement is not from this analysis");
  const r = await associate(N_MONO, REQ_OTHER_RUN);
  assert.deepEqual([r.status, r.body.changed], [200, true]);
  assert.equal((await associate(N_MONO, REQ_OTHER_RUN)).body.changed, false, "idempotent");
  assert.ok(db.audit_log.some((x) => x.entity_type === "analysis_scope_notes" && x.field_name === "requirement_association" && x.new_value.startsWith("REP-003")));
  assert.equal(db.requirements.length, 4, "never becomes a Requirement");
  assert.equal((await associate(N_MONO, REQ_OTHER_RUN, "unassociate")).body.changed, true);
  assert.equal(db.ac_scope_note_requirements.length, 0, "change-level again");
  assert.equal((await associate(N_MONO, REQ_OTHER_RUN)).status, 200);
});

// ── Promotion ──────────────────────────────────────────────────────────────

await run("promote: Approved only; one canonical AC with the next ref, Not Started, reviewed wording, type and Given/When/Then; audited", async () => {
  as("Manager");
  assert.equal((await act("promote", { proposal_id: ids.manual })).status, 409, "Needs Review cannot be promoted");
  const r = await act("promote", { proposal_id: P_PLAIN.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ac = r.body.acceptance_criterion;
  assert.deepEqual([ac.ac_ref, ac.status, ac.requirement_id, ac.project_id], ["AC-045", "Not Started", REQ, P], "next ref after the 44 manual ACs");
  assert.equal(ac.criterion, "The dashboard loads for the Support User after login.", "reviewed wording");
  assert.deepEqual([ac.criterion_type, ac.given_text, ac.when_text, ac.then_text], ["Positive", "a Support User", "they log in", "the dashboard loads"]);
  assert.deepEqual([get(P_PLAIN.id).review_status, get(P_PLAIN.id).promoted_ac_id, get(P_PLAIN.id).promoted_ac_ref], ["Promoted", ac.id, "AC-045"]);
  assert.ok(db.audit_log.some((x) => x.entity_type === "acceptance_criteria" && x.entity_id === ac.id && x.action_type === "Create" && x.entity_name === "AC-045"));
  assert.ok(db.audit_log.some((x) => x.entity_id === P_PLAIN.id && x.new_value === "Promoted → AC-045"));
  const v = await act("promote", { proposal_id: P_VAGUE.id });
  assert.equal(v.body.acceptance_criterion.ac_ref, "AC-046");
  assert.match(v.body.acceptance_criterion.notes, /Relies on 1 Human Clarification\./);
});

await run("promote twice (or concurrently) creates exactly one AC; a failure leaves the proposal Approved", async () => {
  as("Admin");
  const before = promotedAcs().length;
  const [a, b] = await Promise.all([act("promote", { proposal_id: P_PLAIN.id }), act("promote", { proposal_id: P_PLAIN.id })]);
  assert.deepEqual([a.body.already_promoted, b.body.already_promoted], [true, true]);
  assert.equal(promotedAcs().length, before, "no second AC");
  failPromotionOnce.armed = true;
  const f = await act("promote", { proposal_id: P_COVER.id });
  assert.equal(f.status, 500);
  assert.equal(get(P_COVER.id).review_status, "Approved", "unchanged after a failed promotion");
  assert.equal(promotedAcs().length, before);
  const ok = await act("promote", { proposal_id: P_COVER.id });
  assert.equal(ok.body.acceptance_criterion.ac_ref, "AC-047");
  const s = await act("promote", { proposal_id: P_SIGNED.id });
  assert.equal(s.status, 409);
  assert.match(s.body.error, /signed off/);
  assert.equal(get(P_SIGNED.id).review_status, "Approved");
});

await run("bulk: approve applies to Proposed only (Needs Review skipped), reject any open; bulk never promotes", async () => {
  as("Manager");
  const p1 = proposal({ sequence: 40, criterion: "Bulk one." }), p2 = proposal({ sequence: 41, criterion: "Bulk two." });
  db.acceptance_criterion_proposals.push(p1, p2);
  const before = promotedAcs().length;
  const r = await act("bulk_review", { decision: "approve", proposal_ids: [p1.id, p2.id, ids.manual] });
  assert.equal(r.status, 200);
  assert.deepEqual(new Set(r.body.done), new Set([p1.id, p2.id]));
  assert.match(r.body.skipped[0].reason, /approve individually/);
  assert.equal(get(ids.manual).review_status, "Needs Review");
  assert.equal(promotedAcs().length, before, "no promotion");
  assert.equal((await act("bulk_review", { decision: "promote", proposal_ids: [p1.id] })).status, 400);
  const rj = await act("bulk_review", { decision: "reject", proposal_ids: [p2.id], reason: "Duplicate" });
  assert.deepEqual(rj.body.done, [p2.id]);
});

await run("regeneration: adopting the newer run supersedes older unpromoted proposals only; runs themselves are unchanged", async () => {
  as("Manager");
  const runsBefore = JSON.stringify(db.ac_generation_runs);
  const r = await act("supersede_older", { run_id: RUN });
  assert.deepEqual([r.status, r.body.superseded], [200, 1]);
  assert.equal(get(P_OLD.id).review_status, "Superseded");
  assert.equal(get(P_PLAIN.id).review_status, "Promoted", "the adopted run's own proposals are untouched");
  assert.equal(JSON.stringify(db.ac_generation_runs), runsBefore, "runs are immutable");
});

// ── Provenance, integrity ──────────────────────────────────────────────────

await run("provenance: a Viewer sees the promoted AC's source chain (no working AI content); manual ACs have none", async () => {
  as("Viewer");
  const ac = promotedAcs().find((a) => a.ac_ref === "AC-046");
  const r = await provenance(ac.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pv = r.body.provenance;
  assert.equal(pv.requirement.requirement_ref, "REP-001");
  assert.equal(pv.proposal.sequence, 4);
  assert.deepEqual(pv.fragments.map((f) => f.id), [F1]);
  assert.equal(pv.human_clarifications.length, 1);
  assert.equal(pv.requirement_provenance.document.document_name, "SOMCR038 Spec");
  const blob = JSON.stringify(pv);
  assert.doesNotMatch(blob, /rationale|reviewed_criterion|needs_review_reasons|obligations/, "no working AI content");
  const blocked = promotedAcs().find((a) => a.criterion === P_BLOCKED.criterion);
  assert.equal(blocked, undefined, "P_BLOCKED not promoted yet");
  assert.equal((await provenance(MANUAL_ACS[0].id)).body.provenance, null);
  as(null);
  assert.equal((await provenance(ac.id)).status, 401);
});

await run("AI originals, the 44 manual ACs, evidence and sign-offs are unchanged; no direct table writes", () => {
  const now = JSON.stringify(db.acceptance_criterion_proposals.slice(0, 13).map((p) => [p.criterion, p.criterion_type, p.given_text, p.when_text, p.then_text, p.basis, p.source_fragment_ids]));
  assert.equal(now, aiOriginal, "AI originals immutable");
  assert.equal(JSON.stringify(db.acceptance_criteria.slice(0, 44)), manualSnapshot, "44 manual ACs untouched (no backfill)");
  assert.equal(db.evidence.length, 1);
  assert.equal(db.requirement_signoffs.length, 1);
});

// ── Migration 046 (validated live in rolled-back transactions) ────────────

const m046 = code(read("supabase/migrations/046_ac_review_promotion.sql"));
await run("046: nullable AC structure, no backfill; promotion link immutable and delete-protected; whole-project delete still works", () => {
  assert.match(m046, /ADD COLUMN criterion_type text CHECK \(criterion_type IS NULL OR criterion_type IN \('Positive', 'Negative', 'Regression'\)\)/);
  for (const c of ["given_text", "when_text", "then_text"]) assert.match(m046, new RegExp(`ADD COLUMN ${c} text CHECK \\(length\\(${c}\\) <= 1000\\)`));
  const topLevel = m046.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/\$mig\$[\s\S]*?\$mig\$/g, "");
  assert.doesNotMatch(topLevel, /\bUPDATE public\.acceptance_criteria\b|\bDELETE FROM public\.acceptance_criteria\b/, "no existing AC rewritten");
  assert.match(m046, /promoted_ac_fkey FOREIGN KEY \(promoted_ac_id\) REFERENCES public\.acceptance_criteria \(id\)\s+ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED/);
  assert.match(m046, /CREATE UNIQUE INDEX[^;]*promoted_ac_id/);
  assert.match(m046, /acceptance_criteria_promoted_delete_guard/);
  assert.match(m046, /cannot be deleted because its promotion history must be preserved\. Change its status instead\./);
  assert.match(m046, /EXISTS \(SELECT 1 FROM public\.projects pr WHERE pr\.id = OLD\.project_id\)/, "guard yields to whole-project deletion");
  assert.match(m046, /IF OLD\.promoted_ac_id IS NOT NULL AND NEW\.promoted_ac_id IS DISTINCT FROM OLD\.promoted_ac_id THEN/);
});

await run("046: DB-enforced transitions, final states, atomic idempotent promotion, functions service-role only", () => {
  assert.match(m046, /\(OLD\.review_status = 'Proposed' AND NEW\.review_status IN \('Approved', 'Needs Review', 'Rejected', 'Superseded'\)\)/);
  assert.match(m046, /pg_advisory_xact_lock\(hashtext\('ac-ref:' \|\| p_project_id::text\)\)/);
  assert.match(m046, /'Not Started'/);
  assert.match(m046, /IF v\.review_status = 'Promoted' THEN\s+ac_id := v\.promoted_ac_id;/);
  assert.match(m046, /IF v\.review_status <> 'Approved' THEN/);
  assert.match(m046, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(m046, /CREATE TABLE public\.ac_human_clarifications \(/);
  assert.match(m046, /CREATE TABLE public\.ac_scope_note_requirements \(/);
  assert.match(m046, /'Open', 'Resolved', 'Accepted', 'Not Applicable'/);
  assert.ok(req("../lib/schema.ts").allMigrations.includes("046_ac_review_promotion"));
});

await run("UI and calculations: no direct canonical write from the workspace; ProjectState / Go-Live / test status do not read proposals", () => {
  const page = read("components/ac-generation-review-page.tsx") + read("components/ac-review-dialogs.tsx");
  assert.doesNotMatch(page, /saveRecord|createRecord|deleteRecord/);
  assert.match(page, /if \(!mayView\) return <AppShell><EmptyState title="Manager or Admin access required"/);
  for (const t of ["Overview", "Source", "AC Proposals", "Generation Issues", "Scope / Regression", "History"]) assert.ok(page.includes(`"${t}"`), t);
  for (const f of ["lib/project-state.ts", "lib/go-live-readiness.ts", "lib/lifecycle/test-verification.ts", "lib/lifecycle/requirement.ts", "lib/test-report-format.ts"]) {
    assert.doesNotMatch(read(f), /acceptance_criterion_proposals|ac_human_clarifications|criterion_type/, f);
  }
  const panel = read("components/acceptance-criteria-panel.tsx");
  assert.match(panel, /<AcProvenancePanel projectId=\{projectId\} acId=\{ac\.id\} \/>/);
  assert.match(read("lib/supabase/data-store.ts"), /PROMOTED_AC_DELETE_MESSAGE/);
});

console.log("\nAll Phase 1F acceptance criteria review tests passed.\n");
