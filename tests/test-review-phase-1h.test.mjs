// Phase 1H — human Test Case review and promotion. REAL route handlers, role
// guards, server orchestration, shared review rules and the canonical
// verification rollup; only the session lookup and the service-role client
// are stubbed, the latter mirroring migration 048's functions (state
// machine, approval blockers, split/merge provenance, atomic idempotent
// promotion with test_cases → acceptance_criteria links, source-change
// detection). The migration itself was validated against the live database
// inside rolled-back transactions (SOMCR038 REP-001 and PL10) — its SQL is
// also asserted below.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const browserClientModule = req("../lib/supabase/client.ts");
const linkLib = req("../lib/artefact-links.ts");
const rules = req("../lib/test-review.ts");
const { computeTestVerification } = req("../lib/lifecycle/test-verification.ts");
const proposalsRoute = req("../app/api/test-cases/proposals/route.ts");
const provenanceRoute = req("../app/api/test-cases/provenance/route.ts");
const runRoute = req("../app/api/requirements/test-generation/route.ts");
const issuesRoute = req("../app/api/test-cases/generation-issues/route.ts");
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const [REQ, AC1, AC2, AC3, RUN, F1] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
const MANUAL_TEST = uuid(), MANUAL_PASSED = uuid();

// ── In-memory service-role stand-in (mirrors migration 048) ────────────────
let session = null;
const norm = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const fingerprint = (a) => crypto.createHash("sha256").update(JSON.stringify([norm(a.criterion), norm(a.description), a.criterion_type ?? "", norm(a.given_text), norm(a.when_text), norm(a.then_text)])).digest("hex");
const ac = (id, ref, criterion, extra = {}) => ({ id, project_id: P, requirement_id: REQ, ac_ref: ref, criterion, description: null, status: "Not Started", criterion_type: null, given_text: null, when_text: null, then_text: null, ...extra });
const step = (action, expected = null) => ({ step: 0, action, expected });
const steps = (...xs) => xs.map((s, i) => ({ ...s, step: i + 1 }));
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  projects: [{ id: P }],
  requirements: [{ id: REQ, project_id: P, requirement_ref: "REP-001", title: "Picker name remains", description: "d", status: "Discovery" }],
  acceptance_criteria: [
    ac(AC1, "AC-001", "The picker user name remains on the dashboard after the multi pick task is palletised."),
    ac(AC2, "AC-002", "MONO picks are not affected.", { criterion_type: "Regression" }),
    ac(AC3, "AC-003", "The dashboard shows the pick task.", { status: "Met" }),
  ],
  test_cases: [
    { id: MANUAL_TEST, project_id: P, test_ref: "TST-007", scenario: "Objective: verify the picker user name remains on the dashboard after palletising a multi pick task. Steps: 1) Palletise the multi pick task. 2) Look at the dashboard.", expected_result: "The picker user name remains shown.", actual_result: null, status: "Pending", owner: null },
    { id: MANUAL_PASSED, project_id: P, test_ref: "TST-008", scenario: "Objective: dashboard lists pick tasks.", expected_result: "Listed.", actual_result: "ok", status: "Passed", owner: null },
  ],
  artefact_links: [{ id: uuid(), project_id: P, source_entity: "test_cases", source_id: MANUAL_PASSED, target_entity: "acceptance_criteria", target_id: AC3 }],
  requirement_proposals: [], acceptance_criterion_proposals: [], source_fragments: [{ id: F1, sequence: 1, section_heading: "S1", section_path: ["Spec"], page_start: 1, page_end: 1, text: "The picker name must remain." }],
  test_generation_runs: [], test_generation_issues: [], test_case_proposals: [], audit_log: [],
};
const snapAc = (a) => ({ id: a.id, ref: a.ac_ref, requirement_id: a.requirement_id, criterion: a.criterion, description: a.description, criterion_type: a.criterion_type, given_text: a.given_text, when_text: a.when_text, then_text: a.then_text, status: a.status });
db.test_generation_runs.push({ id: RUN, project_id: P, requirement_id: REQ, ac_ids: [AC1, AC2, AC3], status: "Completed", queued_at: "2026-10-07T10:00:00Z", model: "qwen3:8b", prompt_version: "1.0.0", schema_version: "1.0.0", input_sha256: "a".repeat(64),
  allowed_fragment_ids: [F1], human_clarification_ids: [], analysis_clarification_ids: [], scope_note_ids: [], resolved_issue_ids: [], open_issue_ids: [], trigger: "manual",
  input_snapshot: { requirement: { id: REQ, ref: "REP-001", title: "Picker name remains", description: "d" }, acceptance_criteria: db.acceptance_criteria.map((a) => ({ ...snapAc(a), ref: a.ac_ref, origin: "manual" })), fragment_ids: [F1], human_clarifications: [], analysis_clarifications: [], scope_notes: [], resolved_questions: [], open_questions: [] } });

const proposal = (o) => ({
  id: uuid(), generation_run_id: RUN, project_id: P, requirement_id: REQ, preconditions: [], variation: null, basis: "Explicit", confidence: "High", review_status: "Proposed", needs_review_reasons: [],
  source_ac_ids: [AC1], source_fragment_ids: [F1], human_clarification_ids: [], analysis_clarification_ids: [], scope_note_ids: [], resolved_issue_ids: [], rationale: "Stated.", behaviours: [], consolidation: {},
  test_type: "Positive", origin: "ai", parent_proposal_ids: [], human_authored: false, reviewed_title: null, reviewed_objective: null, reviewed_preconditions: null, reviewed_steps: null, reviewed_expected_result: null, reviewed_test_type: null,
  review_note: null, rejection_reason: null, accepted_inferences: [], approved_ac_snapshot: null, review_confirmed_at: null, review_confirmed_by_name: null, reviewed_by_name: null, reviewed_at: null,
  promoted_test_id: null, promoted_test_ref: null, promoted_at: null, promoted_by_name: null, ...o,
});
const T_PLAIN = proposal({ sequence: 1, title: "Picker name remains after palletisation", objective: "Verify the picker user name stays on the dashboard once the multi pick task is palletised.", preconditions: ["A multi pick task picked on a cage"],
  steps: steps(step("Open the Multi Pick dashboard", "The pick task is listed"), step("Palletise the pick task", "The picker user name remains shown")), expected_result: "The picker user name remains shown against the palletised task." });
const T_LOGS = proposal({ sequence: 2, title: "Picker name recorded", objective: "Verify the picker name is recorded.", steps: steps(step("Palletise the task"), step("Check the job logs for the picker name", "The job logs show the picker name")),
  expected_result: "The picker user name remains on the dashboard.", basis: "Inferred", confidence: "Medium", review_status: "Needs Review", needs_review_reasons: ['Unsupported procedure detail — not in the acceptance criteria or their context: "job logs".'] });
const T_MONO = proposal({ sequence: 3, title: "MONO picks unchanged", objective: "Verify MONO picks behave as before.", steps: steps(step("Complete a MONO pick", "Behaves as before")), expected_result: "Unchanged.", test_type: "Regression", source_ac_ids: [AC2] });
const T_COMBO = proposal({ sequence: 4, title: "Name and MONO", objective: "Combined.", steps: steps(step("Do both")), expected_result: "Both hold.", source_ac_ids: [AC1, AC2], review_status: "Needs Review", needs_review_reasons: ["Combines 2 independently testable variations (a; b) — a failure would not show which one; consider one test each."] });
const T_M1 = proposal({ sequence: 5, title: "MONO dashboard unchanged", objective: "o", steps: steps(step("Open a MONO pick")), expected_result: "Unchanged.", test_type: "Regression", source_ac_ids: [AC2] });
const T_M2 = proposal({ sequence: 6, title: "MONO palletising unchanged", objective: "o", steps: steps(step("Palletise a MONO pick")), expected_result: "Unchanged.", test_type: "Regression", source_ac_ids: [AC2] });
const T_VAGUE = proposal({ sequence: 7, title: "Dashboard ok", objective: "o", steps: steps(step("Open dashboard")), expected_result: "The dashboard works correctly.", review_status: "Needs Review", needs_review_reasons: ['Vague expected result ("works correctly") — make it specific.'], source_ac_ids: [AC3] });
const T_AC3 = proposal({ sequence: 8, title: "Dashboard lists the pick", objective: "Verify the dashboard lists the pick task.", steps: steps(step("Open the dashboard", "The pick task is listed")), expected_result: "The pick task is listed.", source_ac_ids: [AC3] });
db.test_case_proposals.push(T_PLAIN, T_LOGS, T_MONO, T_COMBO, T_M1, T_M2, T_VAGUE, T_AC3);
const ISSUE = uuid();
db.test_generation_issues.push({ id: ISSUE, generation_run_id: RUN, project_id: P, requirement_id: REQ, sequence: 1, issue_type: "Uncovered Behaviour", severity: "Medium", description: "No test for a second picker.", behaviour: null, suggested_question: null, ac_ids: [AC1], source_fragment_ids: [], source_issue_ids: [], status: "Open", resolution_note: null, reviewed_by_name: null, reviewed_at: null });
const aiOriginals = () => JSON.stringify(db.test_case_proposals.filter((p) => p.origin === "ai").map((p) => [p.title, p.objective, p.preconditions, p.steps, p.expected_result, p.test_type, p.basis, p.source_ac_ids]));
const aiSnapshot = aiOriginals();
const manualSnapshot = JSON.stringify(db.test_cases);

const touched = new Set();
function builder(table) {
  touched.add(table);
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table] ?? []);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), changed_at: new Date().toISOString(), ...r })); db[table].push(...list); return list; }
    if (q.op !== "select") throw new Error(`direct ${q.op} on ${table} — review writes must go through migration 048's functions`);
    return rows().filter(matches).map((r) => ({ ...r }));
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; },
    order() { return b; }, limit() { return b; }, overlaps() { return b; },
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
const lock = (id, project) => db.test_case_proposals.find((p) => p.id === id && p.project_id === project) ?? raise("P0002", "Test case proposal not found in this project");
const runOf = (p) => db.test_generation_runs.find((r) => r.id === p.generation_run_id);
const text = (p) => rules.proposalText(p);
const acSnapshot = (ids) => ids.map((id) => db.acceptance_criteria.find((a) => a.id === id && a.project_id === P)).filter(Boolean).map((a) => ({ ...snapAc(a), fingerprint: fingerprint(a) }));
const quoted = (r) => [...r.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const unsupportedNow = (v) => [...new Set(v.needs_review_reasons.filter((r) => rules.testReasonKind(r) === "unsupported").flatMap(quoted).filter((t) => text(v).includes(t.toLowerCase())))];
const blockersOf = (v, confirmed, accept) => {
  const out = [];
  for (const r of v.needs_review_reasons) {
    const kind = rules.testReasonKind(r);
    for (const t of quoted(r)) {
      if (kind === "unsupported" && text(v).includes(t.toLowerCase()) && !(accept || v.accepted_inferences.includes(t))) out.push(`"${t}" is not established by the acceptance criteria or their context — remove it, or accept it as Inferred with a reason.`);
      if (kind === "vague" && text(v).includes(t.toLowerCase())) out.push(`Make the expected result specific — "${t}" is not checkable.`);
      if (kind === "condition" && !text(v).includes(t.toLowerCase())) out.push(`Restore "${t}" in the test — it is named in its behaviour.`);
    }
  }
  const now = acSnapshot(v.source_ac_ids);
  for (const a of runOf(v).input_snapshot.acceptance_criteria.filter((x) => v.source_ac_ids.includes(x.id))) {
    const n = now.find((x) => x.id === a.id);
    if (!n) out.push(`${a.ref} no longer exists — this test cannot be approved.`);
    else if (n.fingerprint !== fingerprint(a) && !confirmed) out.push(`${a.ref} has changed since these tests were generated — check the test against its current wording and confirm.`);
  }
  if (v.review_status === "Needs Review" && !confirmed) out.push("Confirm that you reviewed this test against its acceptance criteria.");
  return out;
};
const normSteps = (s) => {
  if (!Array.isArray(s) || s.length < 1 || s.length > 30) raise("22023", "A test needs between 1 and 30 steps");
  if (s.some((x) => !String(x.action ?? "").trim())) raise("22023", "Every step needs an action");
  return s.map((x, i) => ({ step: i + 1, action: String(x.action).trim(), expected: String(x.expected ?? "").trim() || null }));
};
const nextSeq = (runId) => Math.max(0, ...db.test_case_proposals.filter((p) => p.generation_run_id === runId).map((p) => p.sequence)) + 1;
const insertReviewed = (runRow, c, origin, parents, basis, confidence, reasons, rationale, consolidation, a) => {
  if (!String(c.title ?? "").trim() || !String(c.objective ?? "").trim() || !String(c.expected_result ?? "").trim()) raise("22023", "Every test needs a title, an objective and an expected result");
  if (!(c.source_ac_ids ?? []).length) raise("22023", "Every test must trace to at least one acceptance criterion");
  if (!c.source_ac_ids.every((x) => runRow.ac_ids.includes(x))) raise("22023", "every source acceptance criterion must be one of the run's acceptance criteria");
  const row = proposal({ generation_run_id: runRow.id, sequence: nextSeq(runRow.id), title: c.title.trim(), objective: c.objective.trim(), preconditions: c.preconditions ?? [], steps: normSteps(c.steps), expected_result: c.expected_result.trim(),
    test_type: c.test_type || "Positive", basis, confidence, review_status: "Needs Review", needs_review_reasons: reasons, source_ac_ids: [...new Set(c.source_ac_ids)], source_fragment_ids: c.source_fragment_ids ?? [],
    rationale, consolidation: consolidation ?? {}, origin, parent_proposal_ids: parents, human_authored: true, reviewed_by_name: a.p_user_name });
  db.test_case_proposals.push(row);
  return row;
};
let failNextPromotion = false;
function rpc(name, a) {
  try {
    switch (name) {
      case "test_approval_blockers": return { data: blockersOf(db.test_case_proposals.find((p) => p.id === a.p_proposal_id), a.p_confirmed, a.p_accept), error: null };
      case "edit_test_proposal": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (!OPEN.includes(v.review_status)) raise("55000", `A ${v.review_status.toLowerCase()} proposal cannot be edited`);
        const f = a.p_fields, s = normSteps(f.steps), same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
        Object.assign(v, {
          reviewed_title: f.title === v.title ? null : f.title, reviewed_objective: f.objective === v.objective ? null : f.objective, reviewed_expected_result: f.expected_result === v.expected_result ? null : f.expected_result,
          reviewed_test_type: !f.test_type || f.test_type === v.test_type ? null : f.test_type, reviewed_preconditions: same(f.preconditions, v.preconditions) ? null : f.preconditions, reviewed_steps: same(s, normSteps(v.steps)) ? null : s,
          review_status: v.review_status === "Approved" ? "Needs Review" : v.review_status, review_confirmed_at: v.review_status === "Approved" ? null : v.review_confirmed_at, accepted_inferences: [], approved_ac_snapshot: null, reviewed_by_name: a.p_user_name,
        });
        return { data: { ...v }, error: null };
      }
      case "review_test_proposal": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        const target = { approve: "Approved", reject: "Rejected", needs_review: "Needs Review", reopen: "Needs Review" }[a.p_action];
        if (a.p_action === "reopen" && v.review_status !== "Rejected") raise("55000", "Only a rejected proposal can be reopened");
        if (v.review_status === target) return { data: { ...v }, error: null };
        const allowed = { Proposed: ["Approved", "Needs Review", "Rejected", "Superseded"], "Needs Review": ["Approved", "Rejected", "Superseded"], Approved: ["Promoted", "Needs Review", "Rejected", "Superseded"], Rejected: ["Needs Review"] };
        if (!(allowed[v.review_status] ?? []).includes(target)) raise("P0001", `a test case proposal cannot move from ${v.review_status} to ${target}`);
        let accepted = [];
        if (target === "Approved") {
          if (a.p_accept_inferences) { if (!String(a.p_note ?? "").trim()) raise("22023", "Record why the unsupported detail is acceptable before accepting it as Inferred"); accepted = unsupportedNow(v); }
          const b = blockersOf(v, a.p_confirm, a.p_accept_inferences);
          if (b.length) raise("55000", `This test cannot be approved yet: ${b.join(" ")}`);
        }
        Object.assign(v, { review_status: target, review_note: a.p_note ?? v.review_note, rejection_reason: target === "Rejected" ? a.p_reason : null, accepted_inferences: target === "Approved" ? accepted : [],
          approved_ac_snapshot: target === "Approved" ? acSnapshot(v.source_ac_ids) : null, review_confirmed_at: target === "Approved" && a.p_confirm ? "now" : null, review_confirmed_by_name: target === "Approved" && a.p_confirm ? a.p_user_name : null, reviewed_by_name: a.p_user_name });
        return { data: { ...v }, error: null };
      }
      case "split_test_proposal": {
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (!OPEN.includes(v.review_status)) raise("55000", `A ${v.review_status.toLowerCase()} proposal cannot be split`);
        if (a.p_children.length < 2) raise("22023", "A split needs at least two tests");
        const kids = a.p_children.map((c) => {
          const acs = c.source_ac_ids ?? v.source_ac_ids;
          if (!acs.length || !acs.every((x) => v.source_ac_ids.includes(x))) raise("22023", "A split test may only trace to acceptance criteria and sources of the test it was split from");
          return insertReviewed(runOf(v), { ...c, source_ac_ids: acs, source_fragment_ids: v.source_fragment_ids, test_type: c.test_type || v.reviewed_test_type || v.test_type }, "split", [v.id], v.basis, v.confidence,
            [...v.needs_review_reasons.filter((r) => !/^Combines /.test(r)), `Split from #${v.sequence} by ${a.p_user_name} — confirm before approval.`], `Split from proposal #${v.sequence}.`, {}, a);
        });
        Object.assign(v, { review_status: "Superseded" });
        return { data: kids, error: null };
      }
      case "merge_test_proposals": {
        const members = a.p_proposal_ids.map((id) => lock(id, a.p_project_id));
        for (const m of members) if (!OPEN.includes(m.review_status)) raise("55000", `Proposal #${m.sequence} is ${m.review_status.toLowerCase()} and cannot be merged`);
        if (new Set(members.map((m) => m.reviewed_test_type ?? m.test_type)).size > 1) raise("22023", "Only tests of the same type (Positive / Negative / Regression) can be merged");
        const union = (k) => [...new Set(members.flatMap((m) => m[k]))];
        const merged = insertReviewed(runOf(members[0]), { ...a.p_fields, test_type: members[0].reviewed_test_type ?? members[0].test_type, source_ac_ids: union("source_ac_ids"), source_fragment_ids: union("source_fragment_ids") }, "merge", members.map((m) => m.id),
          members.some((m) => m.basis === "Inferred") ? "Inferred" : "Explicit", "High", [...new Set(members.flatMap((m) => m.needs_review_reasons)), "Merged — confirm before approval."], "Merged.",
          { merged: true, member_count: members.length, members: members.map((m) => ({ proposal_id: m.id, title: m.reviewed_title ?? m.title, steps: m.reviewed_steps ?? m.steps })) }, a);
        members.forEach((m) => { m.review_status = "Superseded"; });
        return { data: merged, error: null };
      }
      case "create_manual_test_proposal": {
        const r = db.test_generation_runs.find((x) => x.id === a.p_run_id && x.project_id === a.p_project_id) ?? raise("P0002", "Test generation run not found in this project");
        if (!["Completed", "Completed with warnings"].includes(r.status)) raise("55000", "Manual tests can be added only to a completed generation run");
        return { data: insertReviewed(r, a.p_fields, "manual", [], "Inferred", "Medium", ["Human-authored test — confirm before approval."], a.p_fields.rationale ?? "Added.", {}, a), error: null };
      }
      case "promote_test_proposal": {
        if (!/^[A-Z]{2,6}$/.test(a.p_ref_prefix)) raise("22023", "Invalid reference prefix");
        const v = lock(a.p_proposal_id, a.p_project_id);
        if (v.review_status === "Promoted") return { data: [{ test_id: v.promoted_test_id, test_ref: v.promoted_test_ref, already_promoted: true, link_count: db.artefact_links.filter((l) => l.source_id === v.promoted_test_id).length }], error: null };
        if (v.review_status !== "Approved") raise("55000", `Only an Approved test case proposal can be promoted (this one is ${v.review_status})`);
        const b = blockersOf(v, true, false);
        if (b.length) raise("55000", `This test cannot be promoted: ${b.join(" ")}`);
        const now = acSnapshot(v.source_ac_ids);
        if (now.length !== v.source_ac_ids.length) raise("55000", "A source acceptance criterion no longer exists under REP-001, so this test cannot be promoted");
        const changed = now.filter((n) => !v.approved_ac_snapshot.some((s) => s.id === n.id && s.fingerprint === n.fingerprint)).map((n) => n.ref);
        if (changed.length) raise("55000", `${changed.join(", ")} changed after this test was approved — mark it Needs Review, check it against the current wording and approve again`);
        if (failNextPromotion) { failNextPromotion = false; raise("40001", "could not serialize access"); } // the whole transaction rolls back
        const n = Math.max(0, ...db.test_cases.filter((t) => t.project_id === a.p_project_id).map((t) => Number(new RegExp(`^${a.p_ref_prefix}-(\\d+)$`, "i").exec(t.test_ref)?.[1] ?? 0))) + 1;
        const ref = `${a.p_ref_prefix}-${String(n).padStart(3, "0")}`;
        const e = rules.effectiveTest(v);
        const test = { id: uuid(), project_id: a.p_project_id, test_ref: ref, scenario: rules.canonicalScenario(v), expected_result: e.expected_result, actual_result: null, status: "Pending", owner: null,
          objective: e.objective, preconditions: e.preconditions, steps: normSteps(e.steps), test_type: e.test_type, source_ac_snapshot: v.approved_ac_snapshot };
        db.test_cases.push(test);
        for (const acId of v.source_ac_ids) db.artefact_links.push({ id: uuid(), project_id: a.p_project_id, source_entity: "test_cases", source_id: test.id, target_entity: "acceptance_criteria", target_id: acId });
        Object.assign(v, { review_status: "Promoted", promoted_test_id: test.id, promoted_test_ref: ref, promoted_at: "now", promoted_by_name: a.p_user_name });
        return { data: [{ test_id: test.id, test_ref: ref, already_promoted: false, link_count: v.source_ac_ids.length }], error: null };
      }
      case "review_test_generation_issue": {
        if (!["Open", "Resolved", "Accepted", "Not Applicable"].includes(a.p_status)) raise("22023", `Unknown issue status ${a.p_status}`);
        const v = db.test_generation_issues.find((i) => i.id === a.p_issue_id && i.project_id === a.p_project_id) ?? raise("P0002", "Test-design issue not found in this project");
        if (["Resolved", "Not Applicable"].includes(a.p_status) && !String(a.p_note ?? v.resolution_note ?? "").trim()) raise("22023", "Record how the issue was resolved (or why it does not apply)");
        Object.assign(v, { status: a.p_status, resolution_note: a.p_note ?? v.resolution_note, reviewed_by_name: a.p_user_name, reviewed_at: "now" });
        return { data: { ...v }, error: null };
      }
      case "test_case_source_changes": {
        const out = [];
        for (const t of db.test_cases.filter((x) => x.project_id === a.p_project_id && x.source_ac_snapshot && (!a.p_test_id || x.id === a.p_test_id))) {
          for (const s of t.source_ac_snapshot) {
            const cur = db.acceptance_criteria.find((x) => x.id === s.id && x.project_id === t.project_id);
            if (!cur || fingerprint(cur) !== s.fingerprint) out.push({ test_id: t.id, test_ref: t.test_ref, ac_id: s.id, ac_ref: cur?.ac_ref ?? s.ref, change: cur ? "Changed" : "Deleted", approved_criterion: s.criterion, current_criterion: cur?.criterion ?? null });
          }
        }
        return { data: out, error: null };
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
const act = (action, body) => call(proposalsRoute.POST, "/api/test-cases/proposals", { body: { project_id: P, action, ...body } });
const workspace = () => call(runRoute.GET, `/api/requirements/test-generation?project_id=${P}&run_id=${RUN}`, { method: "GET" });
const provenance = (testId) => call(provenanceRoute.GET, `/api/test-cases/provenance?project_id=${P}&test_id=${testId}`, { method: "GET" });
const get = (id) => db.test_case_proposals.find((p) => p.id === id);
const fieldsOf = (p) => { const e = rules.effectiveTest(p); return { title: e.title, objective: e.objective, test_type: e.test_type, preconditions: e.preconditions, steps: e.steps.map((s) => ({ action: s.action, expected: s.expected })), expected_result: e.expected_result }; };
const promotedTests = () => db.test_cases.filter((t) => t.source_ac_snapshot);
const verification = () => computeTestVerification({ requirements: db.requirements, acceptance_criteria: db.acceptance_criteria, test_cases: db.test_cases, artefact_links: db.artefact_links });

// ── Permissions ─────────────────────────────────────────────────────────────

await run("anon and Viewer cannot review, promote or open the AI workspace; Viewer may read canonical provenance", async () => {
  for (const [role, status] of [[null, 401], ["Viewer", 403]]) {
    as(role);
    assert.equal((await act("approve", { proposal_id: T_PLAIN.id })).status, status, `${role ?? "anon"} approve`);
    assert.equal((await act("promote", { proposal_id: T_PLAIN.id })).status, status, `${role ?? "anon"} promote`);
    assert.equal((await act("create_manual", { run_id: RUN })).status, status, `${role ?? "anon"} manual`);
    assert.equal((await workspace()).status, status, "workspace");
  }
  as("Viewer");
  const pv = await provenance(MANUAL_TEST);
  assert.equal(pv.status, 200, "Viewer reads canonical provenance");
  assert.equal(pv.body.provenance, null, "a manual test has no AI provenance");
  assert.deepEqual(pv.body.source_changes, []);
  assert.equal(get(T_PLAIN.id).review_status, "Proposed");
});

// ── Workspace context: blockers and similar existing tests ─────────────────

await run("workspace: approval blockers per open proposal and advisory similar existing tests (server-side)", async () => {
  as("Manager");
  const ws = await workspace();
  assert.equal(ws.status, 200, JSON.stringify(ws.body));
  assert.match(ws.body.approval_blockers[T_LOGS.id].join(" "), /"job logs" is not established/);
  assert.match(ws.body.approval_blockers[T_VAGUE.id].join(" "), /"works correctly" is not checkable/);
  assert.deepEqual(ws.body.approval_blockers[T_PLAIN.id], []);
  const sim = ws.body.similar_tests[T_PLAIN.id];
  assert.equal(sim[0]?.test_ref, "TST-007", "the near-identical manual test is flagged");
  assert.ok(!(ws.body.similar_tests[T_MONO.id] ?? []).length, "unrelated tests are not flagged");
  assert.ok(ws.body.current_acceptance_criteria.length === 3);
});

// ── Review lifecycle ────────────────────────────────────────────────────────

await run("approve Proposed directly; Needs Review needs confirmation; unsupported \"job logs\" cannot be approved silently", async () => {
  as("Manager");
  assert.equal((await act("approve", { proposal_id: T_PLAIN.id })).status, 200);
  assert.equal(get(T_PLAIN.id).review_status, "Approved");
  assert.deepEqual(get(T_PLAIN.id).approved_ac_snapshot.map((a) => a.ref), ["AC-001"], "approval records the ACs as approved");

  const noConfirm = await act("approve", { proposal_id: T_LOGS.id });
  assert.equal(noConfirm.status, 409);
  const confirmed = await act("approve", { proposal_id: T_LOGS.id, confirm: true });
  assert.equal(confirmed.status, 409, "confirmation alone does not bypass unsupported behaviour");
  assert.match(confirmed.body.error, /"job logs" is not established by the acceptance criteria/);
  assert.equal((await act("approve", { proposal_id: T_LOGS.id, confirm: true, accept_inferences: true })).status, 400, "accepting needs a written reason");
  const accepted = await act("approve", { proposal_id: T_LOGS.id, confirm: true, accept_inferences: true, note: "Support confirmed job logs exist on the cage terminal." });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(get(T_LOGS.id).accepted_inferences, ["job logs"]);
  assert.ok(db.audit_log.some((x) => x.entity_id === T_LOGS.id && /\[reviewer confirmed\].*\[accepted as Inferred: "job logs"\]/.test(x.new_value)));

  // Correct it instead: editing an Approved test returns it to Needs Review and clears the acceptance.
  const edit = await act("edit", { proposal_id: T_LOGS.id, ...fieldsOf(T_LOGS), steps: [{ action: "Palletise the task" }, { action: "Look at the dashboard", expected: "The picker name is shown" }] });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(get(T_LOGS.id).review_status, "Needs Review");
  assert.deepEqual(get(T_LOGS.id).accepted_inferences, []);
  assert.deepEqual(rules.unsupportedTerms(get(T_LOGS.id)), [], "the unsupported step is gone from the reviewed version");
  assert.equal(get(T_LOGS.id).steps[1].action, "Check the job logs for the picker name", "AI original kept");
  assert.ok(db.audit_log.some((x) => x.entity_id === T_LOGS.id && x.field_name === "steps" && /job logs/.test(x.old_value) && !/job logs/.test(x.new_value)));
  assert.equal((await act("approve", { proposal_id: T_LOGS.id, confirm: true })).status, 200);

  // Vague result must be made specific (no acceptance route).
  assert.equal((await act("approve", { proposal_id: T_VAGUE.id, confirm: true, accept_inferences: true, note: "x" })).status, 409);
  assert.equal((await act("edit", { proposal_id: T_VAGUE.id, ...fieldsOf(T_VAGUE), expected_result: "The dashboard lists the pick task with its picker name." })).status, 200);
  assert.equal((await act("approve", { proposal_id: T_VAGUE.id, confirm: true })).status, 200);
});

await run("reject with a valid reason, reopen to Needs Review; invalid reasons and transitions refused", async () => {
  as("Admin");
  assert.equal((await act("reject", { proposal_id: T_AC3.id, reason: "Nonsense" })).status, 400);
  assert.equal((await act("reopen", { proposal_id: T_AC3.id })).status, 409, "only Rejected can be reopened");
  assert.equal((await act("reject", { proposal_id: T_AC3.id, reason: "Duplicate of an existing test", note: "TST-008" })).status, 200);
  assert.equal(get(T_AC3.id).rejection_reason, "Duplicate of an existing test");
  assert.equal((await act("reopen", { proposal_id: T_AC3.id })).status, 200);
  assert.equal(get(T_AC3.id).review_status, "Needs Review");
  assert.deepEqual(rules.allowedTestActions({ review_status: "Rejected" }), ["reopen"]);
  assert.deepEqual(rules.allowedTestActions({ review_status: "Promoted" }), []);
});

await run("split keeps a subset of the parent's ACs; merge only same-type tests; manual tests must trace to a run AC", async () => {
  as("Manager");
  const bad = await act("split", { proposal_id: T_COMBO.id, children: [{ ...fieldsOf(T_COMBO), source_ac_ids: [AC3] }, { ...fieldsOf(T_COMBO) }] });
  assert.equal(bad.status, 400, "a child cannot gain an AC");
  const split = await act("split", { proposal_id: T_COMBO.id, children: [{ ...fieldsOf(T_COMBO), title: "Name remains", source_ac_ids: [AC1] }, { ...fieldsOf(T_COMBO), title: "MONO part", test_type: "Regression", source_ac_ids: [AC2] }] });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  assert.equal(get(T_COMBO.id).review_status, "Superseded");
  assert.deepEqual(split.body.children.map((k) => [k.origin, k.review_status, k.source_ac_ids.length]), [["split", "Needs Review", 1], ["split", "Needs Review", 1]]);
  assert.ok(split.body.children.every((k) => !k.needs_review_reasons.some((r) => /^Combines /.test(r))), "the split resolves the combined-variation reason");

  assert.equal((await act("merge", { proposal_ids: [T_M1.id, T_PLAIN.id], ...fieldsOf(T_M1) })).status, 400, "Regression + Positive cannot merge");
  const merged = await act("merge", { proposal_ids: [T_M1.id, T_M2.id], ...fieldsOf(T_M1), title: "MONO dashboard and palletising unchanged", steps: [{ action: "Open a MONO pick" }, { action: "Palletise it" }] });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.deepEqual([merged.body.proposal.origin, merged.body.proposal.test_type, merged.body.proposal.consolidation.member_count], ["merge", "Regression", 2]);
  assert.deepEqual([get(T_M1.id).review_status, get(T_M2.id).review_status], ["Superseded", "Superseded"]);

  assert.equal((await act("create_manual", { run_id: RUN, ...fieldsOf(T_PLAIN) })).status, 400, "no AC chosen");
  const manual = await act("create_manual", { run_id: RUN, ...fieldsOf(T_PLAIN), title: "Second picker on the same cage", source_ac_ids: [AC1] });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.deepEqual([manual.body.proposal.origin, manual.body.proposal.review_status, manual.body.proposal.basis], ["manual", "Needs Review", "Inferred"]);
  assert.equal((await act("approve", { proposal_id: manual.body.proposal.id })).status, 409, "a human-authored test still needs confirmation");
  assert.equal(aiOriginals(), aiSnapshot, "AI originals never change");
});

// ── Promotion ───────────────────────────────────────────────────────────────

await run("promotion: one TST test per proposal, Pending, structured steps kept, linked to its AC; idempotent; atomic", async () => {
  as("Manager");
  assert.equal((await act("promote", { proposal_id: T_MONO.id })).status, 409, "only Approved proposals promote");
  failNextPromotion = true;
  assert.equal((await act("promote", { proposal_id: T_PLAIN.id })).status, 500);
  assert.equal(promotedTests().length, 0, "a failed promotion leaves nothing behind");
  assert.equal(get(T_PLAIN.id).review_status, "Approved");

  const first = await act("promote", { proposal_id: T_PLAIN.id });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const t = first.body.test_case;
  assert.deepEqual([t.test_ref, t.status, t.project_id, t.test_type], ["TST-009", "Pending", P, "Positive"], "next ref after TST-008");
  assert.deepEqual(t.steps, T_PLAIN.steps, "structured steps survive promotion");
  assert.deepEqual(t.preconditions, T_PLAIN.preconditions);
  assert.match(t.scenario, /^Picker name remains after palletisation\. Objective: .* Preconditions: A multi pick task picked on a cage\. Steps: 1\) Open the Multi Pick dashboard → The pick task is listed 2\) Palletise/);
  assert.deepEqual(first.body.links.map((l) => [l.source_entity, l.target_entity, l.target_id]), [["test_cases", "acceptance_criteria", AC1]]);
  const again = await act("promote", { proposal_id: T_PLAIN.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_promoted, true);
  assert.equal(again.body.test_case.id, t.id);
  assert.equal(promotedTests().length, 1, "double promotion produces one test only");
  assert.equal(db.artefact_links.filter((l) => l.source_id === t.id).length, 1, "and one link");
  const creates = db.audit_log.filter((x) => x.entity_type === "test_cases" && x.entity_id === t.id);
  assert.equal(creates.length, 1);
  assert.match(creates[0].new_value, /Promoted from REP-001 — test proposal #1; linked to AC-001 · similar existing: TST-007/);
});

await run("one AC can promote several tests; links drive AC verification and Test Status as expected", async () => {
  as("Manager");
  const before = verification();
  assert.equal(before.byAcceptanceCriteria[AC3].state, "Verified", "AC-003 is verified by its manual Passed test");
  assert.equal((await act("promote", { proposal_id: T_LOGS.id })).status, 200);
  const ac1 = verification().byAcceptanceCriteria[AC1];
  assert.deepEqual([ac1.testCount, ac1.pending, ac1.state], [2, 2, "Testing"], "two promoted tests prove AC-001");
  // A promoted test on an already-Verified AC moves it back to Testing until it is run.
  assert.equal((await act("promote", { proposal_id: T_VAGUE.id })).status, 200);
  const ac3 = verification().byAcceptanceCriteria[AC3];
  assert.deepEqual([ac3.testCount, ac3.passed, ac3.pending, ac3.state], [2, 1, 1, "Testing"]);
  assert.equal(verification().byRequirement[REQ].testCount, 4, "the Requirement rolls up through its ACs (3 promoted + the manual TST-008; no direct link needed)");
  assert.equal(JSON.stringify(db.test_cases.filter((x) => !x.source_ac_snapshot)), manualSnapshot, "existing manual tests unchanged");
});

// ── Stale governance and provenance ────────────────────────────────────────

await run("a changed AC never rewrites its tests: promotion after a change is refused; promoted tests are flagged possibly stale", async () => {
  as("Manager");
  const manual = db.test_case_proposals.find((p) => p.origin === "manual");
  assert.equal((await act("approve", { proposal_id: manual.id, confirm: true })).status, 200);
  const ac = db.acceptance_criteria.find((a) => a.id === AC1);
  const promoted = JSON.stringify(promotedTests());
  ac.status = "In Progress";
  assert.equal((await provenance(get(T_PLAIN.id).promoted_test_id)).body.source_changes.length, 0, "a status change is not material");
  ac.criterion = `${ac.criterion} The name is shown in bold.`;
  const refused = await act("promote", { proposal_id: manual.id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /AC-001 changed after this test was approved/);
  const pv = await provenance(get(T_PLAIN.id).promoted_test_id);
  assert.deepEqual(pv.body.source_changes.map((c) => [c.ac_ref, c.change]), [["AC-001", "Changed"]]);
  assert.equal(JSON.stringify(promotedTests()), promoted, "promoted tests keep their approved AC snapshot");
  // Re-review: back to Needs Review, the change must be confirmed, then promotion works.
  assert.equal((await act("needs_review", { proposal_id: manual.id })).status, 200);
  assert.match((await act("approve", { proposal_id: manual.id })).body.error, /AC-001 has changed since these tests were generated/);
  assert.equal((await act("approve", { proposal_id: manual.id, confirm: true })).status, 200);
  assert.equal((await act("promote", { proposal_id: manual.id })).status, 200);
});

await run("canonical provenance for every role: structure, ACs as approved, accepted inferences; no working AI content", async () => {
  as("Viewer");
  const pv = await provenance(get(T_PLAIN.id).promoted_test_id);
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.body.structure.steps, T_PLAIN.steps);
  assert.equal(pv.body.provenance.requirement.requirement_ref, "REP-001");
  assert.deepEqual(pv.body.provenance.approved_acceptance_criteria.map((a) => [a.ref, a.criterion]), [["AC-001", "The picker user name remains on the dashboard after the multi pick task is palletised."]]);
  assert.equal(pv.body.provenance.ac_provenance[AC1], null, "a manual AC has no AI provenance");
  assert.doesNotMatch(JSON.stringify(pv.body), /Stated\./, "no rationale");
  const server = read("lib/test-review-server.ts");
  const sel = /from\("test_case_proposals"\)\s+\.select\("([^"]+)"\)\s+\.eq\("promoted_test_id"/.exec(server)?.[1] ?? "";
  assert.ok(sel && !/\b(rationale|title|objective|steps|expected_result|behaviours|consolidation)\b/.test(sel), "provenance never selects working AI content");
  const logs = await provenance(get(T_LOGS.id).promoted_test_id);
  assert.equal(logs.body.provenance.proposal.basis, "Inferred");
  assert.deepEqual(logs.body.provenance.accepted_inferences, [], "the corrected test carries no accepted inference");
});

// ── Migration 048 ───────────────────────────────────────────────────────────

const m048 = code(read("supabase/migrations/048_test_review_promotion.sql"));
await run("048: additive nullable test structure; DB-enforced review; atomic idempotent promotion with links; stale detection; delete protection", () => {
  for (const col of ["objective text", "preconditions text\\[\\]", "steps jsonb", "test_type text", "source_ac_snapshot jsonb"]) assert.match(m048, new RegExp(`ALTER TABLE public\\.test_cases[\\s\\S]*ADD COLUMN ${col}`), col);
  assert.doesNotMatch(m048, /UPDATE public\.test_cases/, "existing tests are never backfilled or rewritten");
  assert.match(m048, /OR \(OLD\.review_status = 'Rejected' AND NEW\.review_status = 'Needs Review'\)\) THEN/);
  assert.match(m048, /RAISE EXCEPTION 'generated test cases are immutable; only their review fields may change'/);
  assert.match(m048, /RAISE EXCEPTION 'test-generation issues are immutable'/);
  const promote = m048.slice(m048.indexOf("FUNCTION public.promote_test_proposal"), m048.indexOf("FUNCTION public.test_case_source_changes"));
  assert.match(promote, /v := public\.lock_test_proposal\(p_proposal_id, p_project_id\);\s+IF v\.review_status = 'Promoted' THEN/, "row lock, then idempotent return");
  assert.match(promote, /pg_advisory_xact_lock\(hashtext\('test-ref:' \|\| p_project_id::text\)\)/);
  assert.match(promote, /'Pending',\s/, "normal initial Test status");
  assert.match(promote, /VALUES \(p_project_id, 'test_cases', v_id, 'acceptance_criteria', v_ac\)/, "existing link direction");
  assert.doesNotMatch(promote, /'requirements'/, "no redundant direct Requirement link");
  assert.match(promote, /changed after this test was approved/);
  assert.match(m048, /CONSTRAINT test_case_proposals_promoted_test_fkey FOREIGN KEY \(promoted_test_id\) REFERENCES public\.test_cases \(id\)\s+ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED/);
  assert.match(m048, /AND EXISTS \(SELECT 1 FROM public\.projects pr WHERE pr\.id = OLD\.project_id\) THEN/, "whole-project delete still cascades");
  assert.match(m048, /a test case''s approved acceptance criteria snapshot is fixed when it is promoted/);
  assert.match(m048, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.ok(req("../lib/schema.ts").latestMigration >= "048_test_review_promotion");
  const cols = req("../lib/schema.ts").writableColumns.test_cases;
  for (const c of ["objective", "preconditions", "steps", "test_type", "source_ac_snapshot"]) assert.ok(!cols.includes(c), `${c} is not written by the generic form`);
});

// ── Shared rules, UI and unaffected paths ──────────────────────────────────

await run("rules: reason kinds, similarity is advisory and server-side, scenario mirrors SQL", () => {
  assert.equal(rules.testReasonKind('Unsupported procedure detail — not in the acceptance criteria or their context: "job logs".'), "unsupported");
  assert.equal(rules.testReasonKind('Vague expected result ("correctly") — make it specific.'), "vague");
  assert.equal(rules.testReasonKind('Omits "Support User", named in its behaviour — check the condition is not lost.'), "condition");
  assert.equal(rules.testReasonKind("Combines 2 independently testable variations"), "confirm");
  assert.deepEqual(rules.similarTests(T_MONO, db.test_cases, new Map(), new Map()), []);
  const gen = read("lib/test-generation-server.ts");
  const claim = gen.slice(gen.indexOf("export async function workerTestGenerationClaim"), gen.indexOf("export async function workerTestGenerationStage"));
  assert.doesNotMatch(claim, /test_cases|similar/, "the worker never receives existing tests");
});

await run("UI: review workspace actions, similar-test advice, unsupported detail; provenance in the Testing drawer; delete message", () => {
  const page = read("components/test-generation-review-page.tsx"), dialogs = read("components/test-review-dialogs.tsx"), app = read("components/app-client.tsx");
  assert.match(page, /if \(!mayView\) return <AppShell><EmptyState title="Manager or Admin access required"/);
  for (const s of ["Similar existing test:", "Add manual test", "Unsupported detail", "Review history", "Merge {mergeSet.length} selected"]) assert.ok(page.includes(s), s);
  for (const s of ["Accept as Inferred", "Possible duplicates (advisory)", "Promote to Test Case", "Split into", "Why the unsupported detail is valid (required)"]) assert.ok(dialogs.includes(s), s);
  assert.match(app, /\{isTestCase && pid && recordId && <TestCaseProvenancePanel projectId=\{pid\} testId=\{recordId\} \/>\}/);
  assert.match(read("lib/supabase/data-store.ts"), /_promoted_test_fkey/);
  assert.ok(read("components/audit-trail-page.tsx").includes('test_case_proposals: "Test Proposal"'));
  for (const f of ["lib/project-state.ts", "lib/go-live-readiness.ts", "lib/lifecycle/test-verification.ts", "lib/test-report-format.ts"]) assert.doesNotMatch(read(f), /test_case_proposals|test-review/, f);
});

// ── Migration 049: protected promotion links; test-design issue review ─────

// Mirrors test_promotion_link_guard for the browser (RLS) client the generic link editor uses.
const linkGuard = (link) => {
  const pair = link.source_entity === "test_cases" && link.target_entity === "acceptance_criteria" ? [link.source_id, link.target_id]
    : link.source_entity === "acceptance_criteria" && link.target_entity === "test_cases" ? [link.target_id, link.source_id] : null;
  if (!pair) return null;
  const test = db.test_cases.find((t) => t.id === pair[0]), acRow = db.acceptance_criteria.find((x) => x.id === pair[1]);
  const governed = test && acRow && db.test_case_proposals.some((p) => p.promoted_test_id === pair[0] && p.source_ac_ids.includes(pair[1]));
  const other = db.artefact_links.some((l) => l.id !== link.id && ((l.source_id === pair[0] && l.target_id === pair[1]) || (l.source_id === pair[1] && l.target_id === pair[0])));
  return governed && !other ? `The link between ${test.test_ref} and ${acRow.ac_ref} was created through approved test promotion and forms part of the test's provenance, so it cannot be removed.` : null;
};
browserClientModule.supabase = {
  from: () => ({ delete: () => ({ eq: (_k, id) => ({ select: async () => {
    const link = db.artefact_links.find((l) => l.id === id);
    if (!link) return { data: [], error: null };
    const refused = linkGuard(link);
    if (refused) return { data: null, error: { code: "23503", message: refused } };
    db.artefact_links = db.artefact_links.filter((l) => l.id !== id);
    return { data: [{ id }], error: null };
  } }) }) }),
};

await run("049: a promoted test's originating AC link cannot be removed; link, snapshot and verification stay intact", async () => {
  const testId = get(T_PLAIN.id).promoted_test_id;
  const origin = db.artefact_links.find((l) => l.source_id === testId && l.target_id === AC1);
  const snapshot = JSON.stringify(db.test_cases.find((t) => t.id === testId).source_ac_snapshot);
  const before = JSON.stringify(verification());
  assert.equal(linkLib.isPromotionLink(origin, db.test_cases, db.artefact_links), true, "the linker hides unlink for it");
  await assert.rejects(linkLib.removeLink(origin.id), /created through approved test promotion and forms part of the test's provenance/);
  assert.ok(db.artefact_links.some((l) => l.id === origin.id), "link remains after the refused unlink");
  assert.equal(JSON.stringify(db.test_cases.find((t) => t.id === testId).source_ac_snapshot), snapshot, "source AC snapshot unchanged");
  assert.equal(JSON.stringify(verification()), before, "verification / Test Status unchanged");
  assert.equal(get(T_PLAIN.id).review_status, "Promoted", "the proposal is not demoted");
  // Manual and non-origin links keep their existing behaviour.
  const manual = db.artefact_links.find((l) => l.source_id === MANUAL_PASSED);
  assert.equal(linkLib.isPromotionLink(manual, db.test_cases, db.artefact_links), false);
  const extra = { id: uuid(), project_id: P, source_entity: "test_cases", source_id: testId, target_entity: "acceptance_criteria", target_id: AC2 };
  db.artefact_links.push(extra);
  assert.equal(linkLib.isPromotionLink(extra, db.test_cases, db.artefact_links), false, "a non-origin link on a promoted test is normal");
  await linkLib.removeLink(extra.id);
  await linkLib.removeLink(manual.id);
  assert.ok(!db.artefact_links.some((l) => l.id === extra.id || l.id === manual.id));
  // A duplicate row of the governed pair may go while the relationship survives.
  const dup = { id: uuid(), project_id: P, source_entity: "acceptance_criteria", source_id: AC1, target_entity: "test_cases", target_id: testId };
  db.artefact_links.push(dup);
  assert.equal(linkLib.isPromotionLink(dup, db.test_cases, db.artefact_links), false);
  await linkLib.removeLink(dup.id);
  assert.equal(linkLib.isPromotionLink(origin, db.test_cases, db.artefact_links), true);
  // Viewer provenance still readable.
  as("Viewer");
  const pv = await provenance(testId);
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.body.provenance.approved_acceptance_criteria.map((a) => a.ref), ["AC-001"]);
});

await run("049: test-design issues are reviewable (Open / Resolved / Accepted / Not Applicable) by Manager/Admin only, audited", async () => {
  const review = (status, note) => call(issuesRoute.POST, "/api/test-cases/generation-issues", { body: { project_id: P, issue_id: ISSUE, status, note } });
  for (const [role, code] of [[null, 401], ["Viewer", 403]]) { as(role); assert.equal((await review("Accepted")).status, code); }
  as("Manager");
  assert.equal((await review("Done")).status, 400);
  assert.equal((await review("Resolved")).status, 400, "a resolution note is required");
  const ok = await review("Resolved", "Covered by the manual test for a second picker.");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const i = db.test_generation_issues[0];
  assert.deepEqual([i.status, i.resolution_note, i.reviewed_by_name], ["Resolved", "Covered by the manual test for a second picker.", "Manager User"]);
  assert.ok(db.audit_log.some((x) => x.entity_type === "test_generation_issues" && x.old_value === "Open" && /^Resolved — Covered/.test(x.new_value)));
  assert.equal((await review("Open")).status, 200, "reopen");
});

await run("049 SQL: database-enforced link guard for every path; cascades still work; issue review fields only", () => {
  const m = code(read("supabase/migrations/049_test_promotion_link_protection.sql"));
  assert.match(m, /CREATE TRIGGER artefact_links_test_promotion_guard BEFORE UPDATE OR DELETE ON public\.artefact_links/);
  assert.match(m, /RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/);
  assert.match(m, /p\.promoted_test_id = v_test AND v_ac = ANY \(p\.source_ac_ids\)/, "only origin links of a promoted test");
  assert.match(m, /EXISTS \(SELECT 1 FROM public\.projects pr WHERE pr\.id = t\.project_id\)/, "whole-project delete still cascades");
  assert.match(m, /created through approved test promotion and forms part of the test''s provenance/);
  assert.doesNotMatch(m, /UPDATE public\.(test_cases|test_case_proposals)|DELETE FROM public\.(test_cases|artefact_links)/, "no snapshot, proposal or test change");
  assert.match(m, /v_cols := ARRAY\['status', 'resolution_note', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'updated_at'\]/);
  assert.equal(req("../lib/schema.ts").latestMigration, "049_test_promotion_link_protection");
  const linker = read("components/artefact-linker.tsx");
  assert.match(linker, /locked=\{Boolean\(linkById\.get\(linkId\) && isPromotionLink\(/);
  assert.ok(read("components/audit-trail-page.tsx").includes('test_generation_issues: "Test-Design Issue"'));
});

console.log("\nAll Phase 1H test review and promotion tests passed.\n");
