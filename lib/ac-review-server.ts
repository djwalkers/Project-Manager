// ── Acceptance Criteria review and promotion (Phase 1F) — server orchestration ─
//
// Server-only; the calling route applies the Manager/Admin guard (the
// provenance read needs only a valid role). Every state change goes through
// migration 046's SQL functions, which enforce the review state machine,
// immutable AI originals, approval preconditions, split/merge provenance,
// and atomic, idempotent promotion. This module adds request validation, the
// canonical inputs promotion needs (the module's AC reference prefix), and
// the audit rows (canonical audit_log, same shape as the rest of the app).

import type { SupabaseClient } from "@supabase/supabase-js";
import { CRITERION_TYPES } from "@/lib/ac-generation";
import { AC_ISSUE_REVIEW_STATUSES, AC_REJECTION_REASONS, bulkApprovable, bulkRejectable, effectiveAc, type ReviewedAcProposal } from "@/lib/ac-review";
import { moduleByKey } from "@/lib/modules";
import { requirementProvenance } from "@/lib/requirement-review-server";
import type { Actor, ServiceResult } from "@/lib/source-documents-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string): ServiceResult => ({ status, body: { error } });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const optional = (value: unknown) => (value === undefined || value === null || text(value) === "" ? null : text(value));
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(text).filter((x) => UUID.test(x)))] : []);
export const MAX_AC_BULK = 100;

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

/** The module configuration's reference prefix for canonical ACs (lib/modules.ts refPrefix). */
export function acRefPrefix(): string {
  const prefix = moduleByKey.get("acceptance_criteria")?.fields.find((f) => f.refPrefix)?.refPrefix;
  if (!prefix) throw new Error("No reference prefix configured for acceptance_criteria");
  return prefix;
}

type AuditRow = { project_id: string; entity_type: string; entity_id: string; entity_name: string; action_type: "Create" | "Update" | "Status Change"; field_name?: string | null; old_value?: string | null; new_value?: string | null };
async function audit(db: SupabaseClient, actor: Actor, rows: AuditRow[]): Promise<string | null> {
  if (!rows.length) return null;
  const { error } = await db.from("audit_log").insert(rows.map((r) => ({ field_name: null, old_value: null, new_value: null, ...r, changed_by: actor.userId, changed_by_name: actor.displayName })));
  if (error) console.error("[ac-review] audit write failed:", error.message);
  return error?.message ?? null;
}
const withWarning = (body: Record<string, unknown>, warning: string | null) => (warning ? { ...body, audit_warning: warning } : body);
const one = <T>(data: unknown) => (Array.isArray(data) ? data[0] : data) as T;

async function loadProposal(db: SupabaseClient, projectId: string, id: string) {
  const { data } = await db.from("acceptance_criterion_proposals").select("*").eq("id", id).eq("project_id", projectId).maybeSingle();
  return data as ReviewedAcProposal | null;
}
async function requirementRefOf(db: SupabaseClient, requirementId: string) {
  const { data } = await db.from("requirements").select("requirement_ref").eq("id", requirementId).maybeSingle();
  return (data as { requirement_ref?: string } | null)?.requirement_ref ?? "Requirement";
}
const proposalName = (ref: string, p: Pick<ReviewedAcProposal, "sequence">) => `${ref} — AC proposal #${p.sequence}`;

function validFields(body: Record<string, unknown>): string | null {
  const type = optional(body.criterion_type);
  if (type !== null && !(CRITERION_TYPES as readonly string[]).includes(type)) return `criterion_type must be one of ${CRITERION_TYPES.join(", ")}`;
  const criterion = optional(body.criterion);
  if (criterion !== null && criterion.length > 2000) return "The criterion must be at most 2000 characters";
  for (const k of ["given_text", "when_text", "then_text"]) if ((optional(body[k]) ?? "").length > 1000) return `${k} must be at most 1000 characters`;
  if ((optional(body.description) ?? "").length > 4000) return "The description must be at most 4000 characters";
  return null;
}
const fieldsOf = (body: Record<string, unknown>) => ({
  criterion: optional(body.criterion), description: optional(body.description), criterion_type: optional(body.criterion_type),
  given_text: optional(body.given_text), when_text: optional(body.when_text), then_text: optional(body.then_text),
});

// ── Proposal actions ───────────────────────────────────────────────────────

export async function acProposalAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), action = text(body.action);
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  switch (action) {
    case "edit": return editAc(db, actor, projectId, body);
    case "approve": case "needs_review": case "reject": case "reopen": return reviewAc(db, actor, projectId, action, body);
    case "bulk_review": return bulkReviewAc(db, actor, projectId, body);
    case "split": return splitAc(db, actor, projectId, body);
    case "merge": return mergeAc(db, actor, projectId, body);
    case "create_manual": return createManualAc(db, actor, projectId, body);
    case "promote": return promoteAc(db, actor, projectId, body);
    case "supersede_older": return supersedeOlder(db, actor, projectId, body);
    default: return fail(400, "action must be edit, approve, needs_review, reject, reopen, bulk_review, split, merge, create_manual, promote or supersede_older");
  }
}

async function editAc(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const invalid = validFields(body);
  if (invalid) return fail(400, invalid);
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Acceptance criterion proposal not found in this project");
  const f = fieldsOf(body);
  const { data, error } = await db.rpc("edit_ac_proposal", {
    p_proposal_id: id, p_project_id: projectId, p_criterion: f.criterion, p_description: f.description, p_type: f.criterion_type,
    p_given: f.given_text, p_when: f.when_text, p_then: f.then_text, p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const after = one<ReviewedAcProposal>(data);
  const ref = await requirementRefOf(db, after.requirement_id);
  const b = effectiveAc(before), a = effectiveAc(after);
  const rows: AuditRow[] = (["criterion", "description", "criterion_type", "given_text", "when_text", "then_text"] as const)
    .filter((k) => (b[k] ?? null) !== (a[k] ?? null))
    .map((k) => ({ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: id, entity_name: proposalName(ref, after), action_type: "Update", field_name: k, old_value: b[k] ?? null, new_value: a[k] ?? null }));
  if (before.review_status !== after.review_status) rows.push({ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: id, entity_name: proposalName(ref, after), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: `${after.review_status} (edited after approval)` });
  return { status: 200, body: withWarning({ proposal: after }, await audit(db, actor, rows)) };
}

async function reviewAc(db: SupabaseClient, actor: Actor, projectId: string, action: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const reason = optional(body.reason);
  if (action === "reject" && reason !== null && !(AC_REJECTION_REASONS as readonly string[]).includes(reason)) return fail(400, `Reason must be one of ${AC_REJECTION_REASONS.join(", ")}`);
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "Review note must be at most 2000 characters");
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Acceptance criterion proposal not found in this project");
  const { data, error } = await db.rpc("review_ac_proposal", {
    p_proposal_id: id, p_project_id: projectId, p_action: action, p_note: note, p_reason: action === "reject" ? reason : null,
    p_confirm: body.confirm === true, p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const after = one<ReviewedAcProposal>(data);
  let warning: string | null = null;
  if (before.review_status !== after.review_status) {
    const ref = await requirementRefOf(db, after.requirement_id);
    const detail = [after.review_status, after.rejection_reason ? `(${after.rejection_reason})` : null, action === "reopen" ? "[reopened]" : null,
      after.review_confirmed_at && before.review_status === "Needs Review" ? "[reviewer confirmed]" : null, note ? `— ${note}` : null].filter(Boolean).join(" ");
    warning = await audit(db, actor, [{ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: id, entity_name: proposalName(ref, after), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: detail.slice(0, 1000) }]);
  }
  return { status: 200, body: withWarning({ proposal: after }, warning) };
}

/** Bulk approve (Proposed only — Needs Review needs individual attention) or bulk reject. Never promotes. */
async function bulkReviewAc(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const decision = text(body.decision);
  if (decision !== "approve" && decision !== "reject") return fail(400, "decision must be approve or reject");
  const list = ids(body.proposal_ids);
  if (!list.length || list.length > MAX_AC_BULK) return fail(400, `Select between 1 and ${MAX_AC_BULK} proposals`);
  const done: string[] = [], skipped: { id: string; reason: string }[] = [];
  for (const id of list) {
    const p = await loadProposal(db, projectId, id);
    if (!p) { skipped.push({ id, reason: "not found" }); continue; }
    if (decision === "approve" ? !bulkApprovable(p) : !bulkRejectable(p)) { skipped.push({ id, reason: decision === "approve" ? `${p.review_status} — approve individually` : p.review_status }); continue; }
    const res = await reviewAc(db, actor, projectId, decision, { proposal_id: id, reason: body.reason, note: body.note });
    if (res.status === 200) done.push(id); else skipped.push({ id, reason: String(res.body.error ?? "refused") });
  }
  return { status: 200, body: { done, skipped } };
}

async function splitAc(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const raw = Array.isArray(body.children) ? body.children : [];
  if (raw.length < 2 || raw.length > 20) return fail(400, "A split needs between 2 and 20 acceptance criteria");
  const children = [];
  for (const c of raw as Record<string, unknown>[]) {
    const invalid = validFields(c);
    if (invalid) return fail(400, invalid);
    const f = fieldsOf(c);
    if (!f.criterion) return fail(400, "Every split acceptance criterion needs its wording");
    children.push({ ...f, source_fragment_ids: ids(c.source_fragment_ids), scope_note_ids: ids(c.scope_note_ids), clarification_issue_ids: ids(c.clarification_issue_ids), open_issue_ids: ids(c.open_issue_ids) });
  }
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Acceptance criterion proposal not found in this project");
  const { data, error } = await db.rpc("split_ac_proposal", { p_proposal_id: id, p_project_id: projectId, p_children: children, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const kids = (data ?? []) as ReviewedAcProposal[];
  const ref = await requirementRefOf(db, before.requirement_id);
  const warning = await audit(db, actor, [
    { project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: id, entity_name: proposalName(ref, before), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: `Superseded — split into ${kids.map((k) => `#${k.sequence}`).join(", ")}` },
    ...kids.map((k) => ({ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: k.id, entity_name: proposalName(ref, k), action_type: "Create" as const, new_value: `Split from #${before.sequence}` })),
  ]);
  return { status: 200, body: withWarning({ children: kids }, warning) };
}

async function mergeAc(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const list = ids(body.proposal_ids);
  if (list.length < 2 || list.length > 20) return fail(400, "A merge needs between 2 and 20 proposals");
  const invalid = validFields(body);
  if (invalid) return fail(400, invalid);
  const f = fieldsOf(body);
  if (!f.criterion) return fail(400, "The merged acceptance criterion needs its wording");
  const members = await Promise.all(list.map((id) => loadProposal(db, projectId, id)));
  if (members.some((m) => !m)) return fail(404, "Acceptance criterion proposal not found in this project");
  const { data, error } = await db.rpc("merge_ac_proposals", {
    p_proposal_ids: list, p_project_id: projectId,
    p_fields: { criterion: f.criterion, description: f.description, given_text: f.given_text, when_text: f.when_text, then_text: f.then_text },
    p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const merged = one<ReviewedAcProposal>(data);
  const ref = await requirementRefOf(db, merged.requirement_id);
  const warning = await audit(db, actor, [
    { project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: merged.id, entity_name: proposalName(ref, merged), action_type: "Create", new_value: `Merged from ${members.map((m) => `#${m!.sequence}`).join(", ")}` },
    ...members.map((m) => ({ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: m!.id, entity_name: proposalName(ref, m!), action_type: "Status Change" as const, field_name: "review_status", old_value: m!.review_status, new_value: `Superseded — merged into #${merged.sequence}` })),
  ]);
  return { status: 200, body: withWarning({ proposal: merged }, warning) };
}

async function createManualAc(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const invalid = validFields(body);
  if (invalid) return fail(400, invalid);
  const f = fieldsOf(body);
  if (!f.criterion) return fail(400, "The acceptance criterion needs its wording");
  const rationale = optional(body.rationale);
  if (rationale && rationale.length > 2000) return fail(400, "The rationale must be at most 2000 characters");
  const { data, error } = await db.rpc("create_manual_ac_proposal", {
    p_run_id: runId, p_project_id: projectId,
    p_fields: { ...f, criterion_type: f.criterion_type ?? "Positive", rationale, source_fragment_ids: ids(body.source_fragment_ids), scope_note_ids: ids(body.scope_note_ids), clarification_issue_ids: ids(body.clarification_issue_ids), open_issue_ids: ids(body.open_issue_ids) },
    p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const p = one<ReviewedAcProposal>(data);
  const warning = await audit(db, actor, [{ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: p.id, entity_name: proposalName(await requirementRefOf(db, p.requirement_id), p), action_type: "Create", new_value: "Manual (human-authored) acceptance criterion proposal — Needs Review" }]);
  return { status: 200, body: withWarning({ proposal: p }, warning) };
}

/** Promote ONE Approved proposal into ONE canonical AC (atomic, idempotent; ac_ref by the module's prefix). */
async function promoteAc(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Acceptance criterion proposal not found in this project");
  const { data, error } = await db.rpc("promote_ac_proposal", { p_proposal_id: id, p_project_id: projectId, p_ref_prefix: acRefPrefix(), p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const row = one<{ ac_id: string; ac_ref: string; already_promoted: boolean; criterion: string }>(data);
  const { data: ac } = await db.from("acceptance_criteria").select("*").eq("id", row.ac_id).maybeSingle();
  if (row.already_promoted) return { status: 200, body: { acceptance_criterion: ac, already_promoted: true } };
  const ref = await requirementRefOf(db, before.requirement_id);
  const warning = await audit(db, actor, [
    { project_id: projectId, entity_type: "acceptance_criteria", entity_id: row.ac_id, entity_name: row.ac_ref, action_type: "Create", new_value: `Promoted from ${proposalName(ref, before)}` },
    { project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: id, entity_name: proposalName(ref, before), action_type: "Status Change", field_name: "review_status", old_value: "Approved", new_value: `Promoted → ${row.ac_ref}` },
  ]);
  return { status: 200, body: withWarning({ acceptance_criterion: ac, already_promoted: false }, warning) };
}

async function supersedeOlder(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const { data, error } = await db.rpc("supersede_older_ac_proposals", { p_run_id: runId, p_project_id: projectId, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const count = Number(data ?? 0);
  const warning = count ? await audit(db, actor, [{ project_id: projectId, entity_type: "ac_generation_runs", entity_id: runId, entity_name: "AC generation run adopted", action_type: "Status Change", field_name: "adopted", new_value: `${count} unpromoted proposal${count === 1 ? "" : "s"} of older runs superseded` }]) : null;
  return { status: 200, body: withWarning({ superseded: count }, warning) };
}

// ── Generation issues, clarifications, scope notes ─────────────────────────

export async function acIssueAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), id = text(body.issue_id), status = text(body.status);
  if (!UUID.test(projectId) || !UUID.test(id)) return fail(400, "project_id and issue_id are required");
  if (!(AC_ISSUE_REVIEW_STATUSES as readonly string[]).includes(status)) return fail(400, `status must be one of ${AC_ISSUE_REVIEW_STATUSES.join(", ")}`);
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "The note must be at most 2000 characters");
  const { data: before } = await db.from("ac_generation_issues").select("*").eq("id", id).eq("project_id", projectId).maybeSingle();
  if (!before) return fail(404, "Generation issue not found in this project");
  const { data, error } = await db.rpc("review_ac_generation_issue", { p_issue_id: id, p_project_id: projectId, p_status: status, p_note: note, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const after = one<{ id: string; status: string; issue_type: string; sequence: number; requirement_id: string; relation: string | null }>(data);
  const b = before as { status: string };
  const warning = b.status !== after.status ? await audit(db, actor, [{ project_id: projectId, entity_type: "ac_generation_issues", entity_id: id, entity_name: `${await requirementRefOf(db, after.requirement_id)} — generation issue #${after.sequence}${after.relation ? ` (${after.relation})` : ""}`, action_type: "Status Change", field_name: "status", old_value: b.status, new_value: [after.status, note ? `— ${note}` : null].filter(Boolean).join(" ").slice(0, 1000) }]) : null;
  return { status: 200, body: withWarning({ issue: after }, warning) };
}

export async function acClarificationAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), proposalId = text(body.proposal_id), clarificationId = optional(body.clarification_id);
  if (!UUID.test(projectId) || !UUID.test(proposalId)) return fail(400, "project_id and proposal_id are required");
  if (clarificationId && !UUID.test(clarificationId)) return fail(400, "clarification_id is invalid");
  const clarification = optional(body.clarification), reason = optional(body.reason);
  if (!clarification || clarification.length > 2000) return fail(400, "The clarification is required (≤ 2000 characters)");
  if (reason && reason.length > 1000) return fail(400, "The reason must be at most 1000 characters");
  const analysisIssue = optional(body.analysis_issue_id), generationIssue = optional(body.generation_issue_id);
  if ((analysisIssue && !UUID.test(analysisIssue)) || (generationIssue && !UUID.test(generationIssue))) return fail(400, "Related issue ids are invalid");
  const proposal = await loadProposal(db, projectId, proposalId);
  if (!proposal) return fail(404, "Acceptance criterion proposal not found in this project");
  let previous: string | null = null;
  if (clarificationId) {
    const { data: prev } = await db.from("ac_human_clarifications").select("clarification").eq("id", clarificationId).maybeSingle();
    previous = (prev as { clarification?: string } | null)?.clarification ?? null;
  }
  const { data, error } = await db.rpc("save_ac_clarification", {
    p_clarification_id: clarificationId, p_proposal_id: proposalId, p_project_id: projectId, p_text: clarification, p_reason: reason,
    p_analysis_issue_id: analysisIssue, p_generation_issue_id: generationIssue, p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const saved = one<{ id: string }>(data);
  const ref = await requirementRefOf(db, proposal.requirement_id);
  const rows: AuditRow[] = [{ project_id: projectId, entity_type: "ac_human_clarifications", entity_id: saved.id, entity_name: `${proposalName(ref, proposal)} — Human Clarification`,
    action_type: clarificationId ? "Update" : "Create", field_name: clarificationId ? "clarification" : null, old_value: previous, new_value: `${clarification}${reason ? ` (reason: ${reason})` : ""}`.slice(0, 1000) }];
  if (proposal.review_status === "Approved") rows.push({ project_id: projectId, entity_type: "acceptance_criterion_proposals", entity_id: proposalId, entity_name: proposalName(ref, proposal), action_type: "Status Change", field_name: "review_status", old_value: "Approved", new_value: "Needs Review (clarification changed)" });
  return { status: 200, body: withWarning({ clarification: saved }, await audit(db, actor, rows)) };
}

export async function scopeNoteAssociationAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), noteId = text(body.scope_note_id), requirementId = text(body.requirement_id), action = text(body.action);
  if (!UUID.test(projectId) || !UUID.test(noteId) || !UUID.test(requirementId)) return fail(400, "project_id, scope_note_id and requirement_id are required");
  if (action !== "associate" && action !== "unassociate") return fail(400, "action must be associate or unassociate");
  const note = optional(body.note);
  if (note && note.length > 1000) return fail(400, "The note must be at most 1000 characters");
  const { data, error } = await db.rpc("set_scope_note_association", { p_note_id: noteId, p_requirement_id: requirementId, p_project_id: projectId, p_associate: action === "associate", p_note: note, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const changed = data === true;
  let warning: string | null = null;
  if (changed) {
    const { data: n } = await db.from("analysis_scope_notes").select("area").eq("id", noteId).maybeSingle();
    warning = await audit(db, actor, [{ project_id: projectId, entity_type: "analysis_scope_notes", entity_id: noteId, entity_name: `Scope note — ${(n as { area?: string } | null)?.area ?? "change-level"}`,
      action_type: "Update", field_name: "requirement_association", old_value: action === "associate" ? "change-level" : await requirementRefOf(db, requirementId), new_value: action === "associate" ? `${await requirementRefOf(db, requirementId)}${note ? ` — ${note}` : ""}` : "change-level" }]);
  }
  return { status: 200, body: withWarning({ changed }, warning) };
}

// ── Canonical AC provenance (any valid role) ───────────────────────────────

/**
 * Canonical AC → AC proposal → generation run → promoted Requirement →
 * Requirement proposal → fragments → version → document, plus the Human
 * Clarifications, scope notes and resolved generation issues it relies on.
 * Only promoted (canonical) wording and authoritative source facts — never
 * the working AI proposal content (rationale, original AI wording).
 */
export async function acProvenance(db: SupabaseClient, projectId: string, acId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId) || !UUID.test(acId)) return fail(400, "project_id and ac_id are required");
  const { data: prop } = await db.from("acceptance_criterion_proposals")
    .select("id, sequence, origin, human_authored, generation_run_id, requirement_id, source_fragment_ids, scope_note_ids, clarification_issue_ids, open_issue_ids, promoted_at, promoted_by_name, promoted_ac_ref, review_confirmed_by_name")
    .eq("promoted_ac_id", acId).eq("project_id", projectId).maybeSingle();
  if (!prop) return { status: 200, body: { provenance: null } };
  const p = prop as { id: string; sequence: number; origin: string; human_authored: boolean; generation_run_id: string; requirement_id: string; source_fragment_ids: string[]; scope_note_ids: string[]; clarification_issue_ids: string[]; open_issue_ids: string[]; promoted_at: string; promoted_by_name: string | null; promoted_ac_ref: string; review_confirmed_by_name: string | null };
  const [run, fragments, notes, clarifications, issues, requirement] = await Promise.all([
    db.from("ac_generation_runs").select("id, model, prompt_version, completed_at").eq("id", p.generation_run_id).maybeSingle(),
    p.source_fragment_ids.length ? db.from("source_fragments").select("id, sequence, section_heading, section_path, page_start, page_end, text").in("id", p.source_fragment_ids) : Promise.resolve({ data: [] }),
    p.scope_note_ids.length ? db.from("analysis_scope_notes").select("id, area, description").in("id", p.scope_note_ids) : Promise.resolve({ data: [] }),
    db.from("ac_human_clarifications").select("id, clarification, reason, created_by_name, created_at").eq("proposal_id", p.id),
    // Only the resolved questions this AC depended on.
    p.open_issue_ids.length
      ? db.from("ac_generation_issues").select("id, issue_type, relation, status, resolution_note, reviewed_by_name").eq("generation_run_id", p.generation_run_id).in("status", ["Resolved", "Not Applicable"]).overlaps("analysis_issue_ids", p.open_issue_ids)
      : Promise.resolve({ data: [] }),
    requirementProvenance(db, projectId, p.requirement_id),
  ]);
  const { data: req } = await db.from("requirements").select("requirement_ref, title").eq("id", p.requirement_id).maybeSingle();
  return {
    status: 200,
    body: {
      provenance: {
        proposal: { sequence: p.sequence, origin: p.origin, human_authored: p.human_authored, promoted_at: p.promoted_at, promoted_by_name: p.promoted_by_name, confirmed_by_name: p.review_confirmed_by_name },
        generation_run: run.data, requirement: req,
        fragments: ((fragments.data ?? []) as { sequence: number }[]).sort((a, b) => a.sequence - b.sequence),
        scope_notes: notes.data ?? [], human_clarifications: clarifications.data ?? [], resolved_issues: issues.data ?? [],
        requirement_provenance: (requirement.body as { provenance?: unknown }).provenance ?? null,
      },
    },
  };
}
