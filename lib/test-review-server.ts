// ── Test Case review and promotion (Phase 1H) — server orchestration ────────
//
// Server-only; the calling route applies the Manager/Admin guard (the
// provenance read needs only a valid role). Every state change goes through
// migration 048's SQL functions, which enforce the review state machine,
// immutable AI originals, approval preconditions (unsupported detail, vague
// results, omitted conditions, changed ACs), split/merge provenance, and
// atomic, idempotent promotion with its test_cases → acceptance_criteria
// links. This module adds request validation, the canonical inputs
// promotion needs (the module's TST prefix), the advisory similar-test check
// and the audit rows (canonical audit_log, same shape as the rest of the app).

import type { SupabaseClient } from "@supabase/supabase-js";
import { acProvenance } from "@/lib/ac-review-server";
import { moduleByKey } from "@/lib/modules";
import { requirementProvenance } from "@/lib/requirement-review-server";
import type { Actor, ServiceResult } from "@/lib/source-documents-server";
import { TEST_TYPES, type TestStep } from "@/lib/test-generation";
import { TEST_REJECTION_REASONS, effectiveTest, similarTests, type CanonicalTestLite, type ReviewedTestProposal, type SimilarTest } from "@/lib/test-review";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string): ServiceResult => ({ status, body: { error } });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const optional = (value: unknown) => (value === undefined || value === null || text(value) === "" ? null : text(value));
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(text).filter((x) => UUID.test(x)))] : []);

function mapDbError(error: { code?: string; message?: string }): ServiceResult {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "P0002": return fail(404, message);
    case "55000": return fail(409, message);
    case "23505": return fail(409, message);
    case "22023": return fail(400, message);
    case "23514": return fail(400, message);
    case "P0001": return fail(409, message);
    default: return fail(500, message);
  }
}

/** The module configuration's reference prefix for canonical tests (lib/modules.ts refPrefix: TST). */
export function testRefPrefix(): string {
  const prefix = moduleByKey.get("test_cases")?.fields.find((f) => f.refPrefix)?.refPrefix;
  if (!prefix) throw new Error("No reference prefix configured for test_cases");
  return prefix;
}

type AuditRow = { project_id: string; entity_type: string; entity_id: string; entity_name: string; action_type: "Create" | "Update" | "Status Change"; field_name?: string | null; old_value?: string | null; new_value?: string | null };
async function audit(db: SupabaseClient, actor: Actor, rows: AuditRow[]): Promise<string | null> {
  if (!rows.length) return null;
  const { error } = await db.from("audit_log").insert(rows.map((r) => ({ field_name: null, old_value: null, new_value: null, ...r, changed_by: actor.userId, changed_by_name: actor.displayName })));
  if (error) console.error("[test-review] audit write failed:", error.message);
  return error?.message ?? null;
}
const withWarning = (body: Record<string, unknown>, warning: string | null) => (warning ? { ...body, audit_warning: warning } : body);
const one = <T>(data: unknown) => (Array.isArray(data) ? data[0] : data) as T;

async function loadProposal(db: SupabaseClient, projectId: string, id: string) {
  const { data } = await db.from("test_case_proposals").select("*").eq("id", id).eq("project_id", projectId).maybeSingle();
  return data as ReviewedTestProposal | null;
}
async function requirementRefOf(db: SupabaseClient, requirementId: string) {
  const { data } = await db.from("requirements").select("requirement_ref").eq("id", requirementId).maybeSingle();
  return (data as { requirement_ref?: string } | null)?.requirement_ref ?? "Requirement";
}
const proposalName = (ref: string, p: Pick<ReviewedTestProposal, "sequence">) => `${ref} — test proposal #${p.sequence}`;

// ── Request validation ──────────────────────────────────────────────────────

type Fields = { title: string | null; objective: string | null; expected_result: string | null; test_type: string | null; preconditions: string[]; steps: { action: string; expected: string | null }[] };

function fieldsOf(body: Record<string, unknown>): Fields | string {
  const f: Fields = {
    title: optional(body.title), objective: optional(body.objective), expected_result: optional(body.expected_result), test_type: optional(body.test_type),
    preconditions: (Array.isArray(body.preconditions) ? body.preconditions : []).map(text).filter(Boolean),
    steps: (Array.isArray(body.steps) ? body.steps : []).map((s) => { const x = (s ?? {}) as Record<string, unknown>; return { action: text(x.action), expected: optional(x.expected) }; }),
  };
  if (f.title !== null && f.title.length > 300) return "The title must be at most 300 characters";
  if (f.objective !== null && f.objective.length > 2000) return "The objective must be at most 2000 characters";
  if (f.expected_result !== null && f.expected_result.length > 2000) return "The expected result must be at most 2000 characters";
  if (f.test_type !== null && !(TEST_TYPES as readonly string[]).includes(f.test_type)) return `test_type must be one of ${TEST_TYPES.join(", ")}`;
  if (f.preconditions.length > 20 || f.preconditions.some((c) => c.length > 1000)) return "At most 20 preconditions of at most 1000 characters";
  if (f.steps.length < 1 || f.steps.length > 30) return "A test needs between 1 and 30 steps";
  if (f.steps.some((s) => !s.action || s.action.length > 1000 || (s.expected ?? "").length > 1000)) return "Every step needs an action (steps and expectations at most 1000 characters)";
  return f;
}
const complete = (f: Fields) => (f.title && f.objective && f.expected_result ? null : "Every test needs a title, an objective and an expected result");

// ── Proposal actions ───────────────────────────────────────────────────────

export async function testProposalAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), action = text(body.action);
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  switch (action) {
    case "edit": return editTest(db, actor, projectId, body);
    case "approve": case "needs_review": case "reject": case "reopen": return reviewTest(db, actor, projectId, action, body);
    case "split": return splitTest(db, actor, projectId, body);
    case "merge": return mergeTests(db, actor, projectId, body);
    case "create_manual": return createManualTest(db, actor, projectId, body);
    case "promote": return promoteTest(db, actor, projectId, body);
    default: return fail(400, "action must be edit, approve, needs_review, reject, reopen, split, merge, create_manual or promote");
  }
}

const stepsText = (steps: TestStep[]) => steps.map((s, i) => `${i + 1}) ${s.action}${s.expected ? ` → ${s.expected}` : ""}`).join(" ");

async function editTest(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const f = fieldsOf(body);
  if (typeof f === "string") return fail(400, f);
  const missing = complete(f);
  if (missing) return fail(400, missing);
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Test case proposal not found in this project");
  const { data, error } = await db.rpc("edit_test_proposal", { p_proposal_id: id, p_project_id: projectId, p_fields: f, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const after = one<ReviewedTestProposal>(data);
  const ref = await requirementRefOf(db, after.requirement_id);
  const b = effectiveTest(before), a = effectiveTest(after);
  const show = { title: (x: typeof b) => x.title, objective: (x: typeof b) => x.objective, expected_result: (x: typeof b) => x.expected_result, test_type: (x: typeof b) => x.test_type,
    preconditions: (x: typeof b) => x.preconditions.join("; "), steps: (x: typeof b) => stepsText(x.steps) };
  const rows: AuditRow[] = (Object.keys(show) as (keyof typeof show)[])
    .filter((k) => show[k](b) !== show[k](a))
    .map((k) => ({ project_id: projectId, entity_type: "test_case_proposals", entity_id: id, entity_name: proposalName(ref, after), action_type: "Update", field_name: k, old_value: show[k](b).slice(0, 1000), new_value: show[k](a).slice(0, 1000) }));
  if (before.review_status !== after.review_status) rows.push({ project_id: projectId, entity_type: "test_case_proposals", entity_id: id, entity_name: proposalName(ref, after), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: `${after.review_status} (edited after approval)` });
  return { status: 200, body: withWarning({ proposal: after }, await audit(db, actor, rows)) };
}

async function reviewTest(db: SupabaseClient, actor: Actor, projectId: string, action: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const reason = optional(body.reason);
  if (action === "reject" && reason !== null && !(TEST_REJECTION_REASONS as readonly string[]).includes(reason)) return fail(400, `Reason must be one of ${TEST_REJECTION_REASONS.join(", ")}`);
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "Review note must be at most 2000 characters");
  const accept = action === "approve" && body.accept_inferences === true;
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Test case proposal not found in this project");
  const { data, error } = await db.rpc("review_test_proposal", {
    p_proposal_id: id, p_project_id: projectId, p_action: action, p_note: note, p_reason: action === "reject" ? reason : null,
    p_confirm: body.confirm === true, p_accept_inferences: accept, p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const after = one<ReviewedTestProposal>(data);
  let warning: string | null = null;
  if (before.review_status !== after.review_status) {
    const ref = await requirementRefOf(db, after.requirement_id);
    const detail = [after.review_status, after.rejection_reason ? `(${after.rejection_reason})` : null, action === "reopen" ? "[reopened]" : null,
      after.review_confirmed_at ? "[reviewer confirmed]" : null, after.accepted_inferences.length ? `[accepted as Inferred: ${after.accepted_inferences.map((t) => `"${t}"`).join(", ")}]` : null,
      note ? `— ${note}` : null].filter(Boolean).join(" ");
    warning = await audit(db, actor, [{ project_id: projectId, entity_type: "test_case_proposals", entity_id: id, entity_name: proposalName(ref, after), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: detail.slice(0, 1000) }]);
  }
  return { status: 200, body: withWarning({ proposal: after }, warning) };
}

async function splitTest(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const raw = Array.isArray(body.children) ? body.children : [];
  if (raw.length < 2 || raw.length > 20) return fail(400, "A split needs between 2 and 20 tests");
  const children = [];
  for (const c of raw as Record<string, unknown>[]) {
    const f = fieldsOf(c);
    if (typeof f === "string") return fail(400, f);
    const missing = complete(f);
    if (missing) return fail(400, missing);
    const acs = ids(c.source_ac_ids);
    children.push({ ...f, ...(acs.length ? { source_ac_ids: acs } : {}) });
  }
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Test case proposal not found in this project");
  const { data, error } = await db.rpc("split_test_proposal", { p_proposal_id: id, p_project_id: projectId, p_children: children, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const kids = (data ?? []) as ReviewedTestProposal[];
  const ref = await requirementRefOf(db, before.requirement_id);
  const warning = await audit(db, actor, [
    { project_id: projectId, entity_type: "test_case_proposals", entity_id: id, entity_name: proposalName(ref, before), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: `Superseded — split into ${kids.map((k) => `#${k.sequence}`).join(", ")}` },
    ...kids.map((k) => ({ project_id: projectId, entity_type: "test_case_proposals", entity_id: k.id, entity_name: proposalName(ref, k), action_type: "Create" as const, new_value: `Split from #${before.sequence}` })),
  ]);
  return { status: 200, body: withWarning({ children: kids }, warning) };
}

async function mergeTests(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const list = ids(body.proposal_ids);
  if (list.length < 2 || list.length > 20) return fail(400, "A merge needs between 2 and 20 proposals");
  const f = fieldsOf(body);
  if (typeof f === "string") return fail(400, f);
  const missing = complete(f);
  if (missing) return fail(400, missing);
  const members = await Promise.all(list.map((id) => loadProposal(db, projectId, id)));
  if (members.some((m) => !m)) return fail(404, "Test case proposal not found in this project");
  // Merged tests keep their shared type (merge_test_proposals overrides test_type).
  const { data, error } = await db.rpc("merge_test_proposals", { p_proposal_ids: list, p_project_id: projectId, p_fields: f, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const merged = one<ReviewedTestProposal>(data);
  const ref = await requirementRefOf(db, merged.requirement_id);
  const warning = await audit(db, actor, [
    { project_id: projectId, entity_type: "test_case_proposals", entity_id: merged.id, entity_name: proposalName(ref, merged), action_type: "Create", new_value: `Merged from ${members.map((m) => `#${m!.sequence}`).join(", ")}` },
    ...members.map((m) => ({ project_id: projectId, entity_type: "test_case_proposals", entity_id: m!.id, entity_name: proposalName(ref, m!), action_type: "Status Change" as const, field_name: "review_status", old_value: m!.review_status, new_value: `Superseded — merged into #${merged.sequence}` })),
  ]);
  return { status: 200, body: withWarning({ proposal: merged }, warning) };
}

async function createManualTest(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const f = fieldsOf(body);
  if (typeof f === "string") return fail(400, f);
  const missing = complete(f);
  if (missing) return fail(400, missing);
  const acs = ids(body.source_ac_ids);
  if (!acs.length) return fail(400, "Choose at least one of the run's acceptance criteria for the test");
  const rationale = optional(body.rationale);
  if (rationale && rationale.length > 2000) return fail(400, "The rationale must be at most 2000 characters");
  const { data, error } = await db.rpc("create_manual_test_proposal", {
    p_run_id: runId, p_project_id: projectId, p_fields: { ...f, test_type: f.test_type ?? "Positive", source_ac_ids: acs, rationale }, p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const p = one<ReviewedTestProposal>(data);
  const warning = await audit(db, actor, [{ project_id: projectId, entity_type: "test_case_proposals", entity_id: p.id, entity_name: proposalName(await requirementRefOf(db, p.requirement_id), p), action_type: "Create", new_value: "Manual (human-authored) test proposal — Needs Review" }]);
  return { status: 200, body: withWarning({ proposal: p }, warning) };
}

/** Promote ONE Approved proposal into ONE canonical test (atomic, idempotent; test_ref by the module's prefix; linked to its ACs). */
async function promoteTest(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Test case proposal not found in this project");
  // Advisory only: recorded in the audit so the decision shows what the reviewer was told.
  const similar = before.review_status === "Approved" ? (await similarExistingTests(db, projectId, [before])).get(before.id) ?? [] : [];
  const { data, error } = await db.rpc("promote_test_proposal", { p_proposal_id: id, p_project_id: projectId, p_ref_prefix: testRefPrefix(), p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const row = one<{ test_id: string; test_ref: string; already_promoted: boolean; link_count: number }>(data);
  const [{ data: test }, { data: links }] = await Promise.all([
    db.from("test_cases").select("*").eq("id", row.test_id).maybeSingle(),
    db.from("artefact_links").select("*").eq("source_entity", "test_cases").eq("source_id", row.test_id),
  ]);
  if (row.already_promoted) return { status: 200, body: { test_case: test, links: links ?? [], already_promoted: true } };
  const ref = await requirementRefOf(db, before.requirement_id);
  const acRefs = ((test as { source_ac_snapshot?: { ref: string }[] } | null)?.source_ac_snapshot ?? []).map((a) => a.ref);
  const warning = await audit(db, actor, [
    { project_id: projectId, entity_type: "test_cases", entity_id: row.test_id, entity_name: row.test_ref, action_type: "Create",
      new_value: [`Promoted from ${proposalName(ref, before)}; linked to ${acRefs.join(", ")}`, before.accepted_inferences.length ? `accepted as Inferred: ${before.accepted_inferences.map((t) => `"${t}"`).join(", ")}` : null,
        similar.length ? `similar existing: ${similar.map((s) => s.test_ref).join(", ")}` : null].filter(Boolean).join(" · ").slice(0, 1000) },
    { project_id: projectId, entity_type: "test_case_proposals", entity_id: id, entity_name: proposalName(ref, before), action_type: "Status Change", field_name: "review_status", old_value: "Approved", new_value: `Promoted → ${row.test_ref}` },
  ]);
  return { status: 200, body: withWarning({ test_case: test, links: links ?? [], already_promoted: false }, warning) };
}

// ── Test-design issue review (migration 049; 046 pattern) ──────────────────

export const TEST_ISSUE_REVIEW_STATUSES = ["Open", "Resolved", "Accepted", "Not Applicable"] as const;

export async function testIssueAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), id = text(body.issue_id), status = text(body.status);
  if (!UUID.test(projectId) || !UUID.test(id)) return fail(400, "project_id and issue_id are required");
  if (!(TEST_ISSUE_REVIEW_STATUSES as readonly string[]).includes(status)) return fail(400, `status must be one of ${TEST_ISSUE_REVIEW_STATUSES.join(", ")}`);
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "The note must be at most 2000 characters");
  const { data: before } = await db.from("test_generation_issues").select("*").eq("id", id).eq("project_id", projectId).maybeSingle();
  if (!before) return fail(404, "Test-design issue not found in this project");
  const { data, error } = await db.rpc("review_test_generation_issue", { p_issue_id: id, p_project_id: projectId, p_status: status, p_note: note, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const after = one<{ id: string; status: string; sequence: number; issue_type: string; requirement_id: string }>(data);
  const b = before as { status: string };
  const warning = b.status !== after.status ? await audit(db, actor, [{ project_id: projectId, entity_type: "test_generation_issues", entity_id: id, entity_name: `${await requirementRefOf(db, after.requirement_id)} — test-design issue #${after.sequence} (${after.issue_type})`,
    action_type: "Status Change", field_name: "status", old_value: b.status, new_value: [after.status, note ? `— ${note}` : null].filter(Boolean).join(" ").slice(0, 1000) }]) : null;
  return { status: 200, body: withWarning({ issue: after }, warning) };
}

// ── Similar existing tests (server-side; never part of any model input) ────

export async function similarExistingTests(db: SupabaseClient, projectId: string, proposals: ReviewedTestProposal[]): Promise<Map<string, SimilarTest[]>> {
  const out = new Map<string, SimilarTest[]>();
  const open = proposals.filter((p) => ["Proposed", "Needs Review", "Approved"].includes(p.review_status));
  if (!open.length) return out;
  const [{ data: tests }, { data: links }, { data: acs }] = await Promise.all([
    db.from("test_cases").select("id, test_ref, scenario, expected_result, objective, steps").eq("project_id", projectId),
    db.from("artefact_links").select("source_entity, source_id, target_entity, target_id").eq("project_id", projectId),
    db.from("acceptance_criteria").select("id, ac_ref").eq("project_id", projectId),
  ]);
  const acsByTest = new Map<string, Set<string>>();
  for (const l of (links ?? []) as { source_entity: string; source_id: string; target_entity: string; target_id: string }[]) {
    const [t, a] = l.source_entity === "test_cases" && l.target_entity === "acceptance_criteria" ? [l.source_id, l.target_id]
      : l.target_entity === "test_cases" && l.source_entity === "acceptance_criteria" ? [l.target_id, l.source_id] : [null, null];
    if (t && a) { if (!acsByTest.has(t)) acsByTest.set(t, new Set()); acsByTest.get(t)!.add(a); }
  }
  const acRefs = new Map(((acs ?? []) as { id: string; ac_ref: string }[]).map((a) => [a.id, a.ac_ref] as const));
  for (const p of open) out.set(p.id, similarTests(p, (tests ?? []) as CanonicalTestLite[], acsByTest, acRefs));
  return out;
}

// ── Canonical test provenance (any valid role) ─────────────────────────────

/**
 * A canonical test's structure, where it came from, and whether its source
 * ACs have changed since promotion: test → proposal → generation run → the
 * ACs as approved (snapshot) → each AC's own provenance → Requirement →
 * source document. Only promoted (canonical) values and authoritative facts —
 * never the working AI proposal content (original wording, rationale).
 */
export async function testCaseProvenance(db: SupabaseClient, projectId: string, testId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId) || !UUID.test(testId)) return fail(400, "project_id and test_id are required");
  const { data: t } = await db.from("test_cases").select("id, test_ref, objective, preconditions, steps, test_type, source_ac_snapshot").eq("id", testId).eq("project_id", projectId).maybeSingle();
  if (!t) return fail(404, "Test case not found in this project");
  const test = t as { id: string; test_ref: string; objective: string | null; preconditions: string[] | null; steps: TestStep[] | null; test_type: string | null; source_ac_snapshot: { id: string; ref: string; criterion: string; status: string | null }[] | null };
  const { data: prop } = await db.from("test_case_proposals")
    .select("id, sequence, origin, human_authored, basis, generation_run_id, requirement_id, source_ac_ids, source_fragment_ids, accepted_inferences, review_note, review_confirmed_by_name, promoted_at, promoted_by_name")
    .eq("promoted_test_id", testId).eq("project_id", projectId).maybeSingle();
  const structure = { objective: test.objective, preconditions: test.preconditions, steps: test.steps, test_type: test.test_type };
  if (!prop) return { status: 200, body: { structure, provenance: null, source_changes: [] } };
  const p = prop as { id: string; sequence: number; origin: string; human_authored: boolean; basis: string; generation_run_id: string; requirement_id: string; source_ac_ids: string[]; source_fragment_ids: string[]; accepted_inferences: string[]; review_note: string | null; review_confirmed_by_name: string | null; promoted_at: string; promoted_by_name: string | null };
  const [run, req, fragments, changes, reqProv, ...acProv] = await Promise.all([
    db.from("test_generation_runs").select("id, model, prompt_version, completed_at").eq("id", p.generation_run_id).maybeSingle(),
    db.from("requirements").select("id, requirement_ref, title").eq("id", p.requirement_id).maybeSingle(),
    p.source_fragment_ids.length ? db.from("source_fragments").select("id, sequence, section_heading, section_path, page_start, page_end, text").in("id", p.source_fragment_ids) : Promise.resolve({ data: [] }),
    db.rpc("test_case_source_changes", { p_project_id: projectId, p_test_id: testId }),
    requirementProvenance(db, projectId, p.requirement_id),
    ...p.source_ac_ids.map((acId) => acProvenance(db, projectId, acId)),
  ]);
  const acceptedInferred = p.accepted_inferences.length > 0;
  return {
    status: 200,
    body: {
      structure,
      provenance: {
        proposal: { sequence: p.sequence, origin: p.origin, human_authored: p.human_authored, basis: acceptedInferred ? "Inferred" : p.basis, promoted_at: p.promoted_at, promoted_by_name: p.promoted_by_name, confirmed_by_name: p.review_confirmed_by_name },
        accepted_inferences: p.accepted_inferences, inference_reason: acceptedInferred ? p.review_note : null,
        generation_run: run.data, requirement: req.data,
        approved_acceptance_criteria: test.source_ac_snapshot ?? [],
        ac_provenance: Object.fromEntries(p.source_ac_ids.map((acId, i) => [acId, ((acProv[i] as ServiceResult).body as { provenance?: unknown }).provenance ?? null])),
        fragments: ((fragments.data ?? []) as { sequence: number }[]).sort((a, b) => a.sequence - b.sequence),
        requirement_provenance: (reqProv.body as { provenance?: unknown }).provenance ?? null,
      },
      source_changes: changes.data ?? [],
    },
  };
}
