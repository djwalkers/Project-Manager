// ── Requirement review and promotion (Phase 1D) — server orchestration ─────
//
// Server-only; the calling route has applied the Manager/Admin guard (the
// provenance read needs only a valid role). Every state change goes through
// migration 040's SQL functions, which enforce the review state machine,
// immutable AI originals, split/merge provenance, inferred acknowledgement,
// and atomic, idempotent promotion. This module adds request validation,
// the canonical inputs promotion needs (reference prefix from the module
// configuration, source, provenance note), and the audit rows (canonical
// audit_log, same shape as the rest of the app).
//
// Promotion uses a server route rather than the browser create path
// (lib/supabase/data-store.ts createRecord) because promotion must be
// atomic with the proposal update and safe against retries/double clicks;
// it reuses that path's rules instead: the module config's reference
// prefix and nextRef numbering (in SQL, under a per-project lock), the
// Requirement field options, project scoping, and the audit 'Create' row.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getEntityName } from "@/lib/audit";
import { moduleByKey } from "@/lib/modules";
import { PROPOSAL_CATEGORIES, PROPOSAL_PRIORITIES } from "@/lib/requirement-analysis";
import { REJECTION_REASONS, effectiveProposal, provenanceNote, type IssueTarget, type ReviewedIssue, type ReviewedProposal } from "@/lib/requirement-review";
import type { Actor, ServiceResult } from "@/lib/source-documents-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string): ServiceResult => ({ status, body: { error } });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const optional = (value: unknown) => (value === undefined || value === null || text(value) === "" ? null : text(value));
const oneOf = (list: readonly string[], v: unknown) => v == null || list.includes(v as string);
export const MAX_BULK = 100;

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

/** The reference prefix the app uses for a module's records (lib/modules.ts refPrefix). */
export function refPrefixFor(module: "requirements" | IssueTarget): string {
  const prefix = moduleByKey.get(module)?.fields.find((f) => f.refPrefix)?.refPrefix;
  if (!prefix) throw new Error(`No reference prefix configured for ${module}`);
  return prefix;
}

type AuditRow = { project_id: string; entity_type: string; entity_id: string; entity_name: string; action_type: "Create" | "Update" | "Status Change"; field_name?: string | null; old_value?: string | null; new_value?: string | null };

async function audit(db: SupabaseClient, actor: Actor, rows: AuditRow[]): Promise<string | null> {
  if (!rows.length) return null;
  const { error } = await db.from("audit_log").insert(rows.map((r) => ({ field_name: null, old_value: null, new_value: null, ...r, changed_by: actor.userId, changed_by_name: actor.displayName })));
  if (error) console.error("[requirement-review] audit write failed:", error.message);
  return error?.message ?? null;
}

const proposalName = (p: Pick<ReviewedProposal, "sequence" | "proposed_title" | "reviewed_title">) => `Proposal #${p.sequence} — ${p.reviewed_title ?? p.proposed_title}`.slice(0, 300);
const issueName = (i: Pick<ReviewedIssue, "sequence" | "issue_type">) => `Analysis issue #${i.sequence} — ${i.issue_type}`;

async function loadProposal(db: SupabaseClient, projectId: string, id: string): Promise<ReviewedProposal | null> {
  const { data } = await db.from("requirement_proposals").select("*").eq("id", id).eq("project_id", projectId).maybeSingle();
  return (data as ReviewedProposal | null) ?? null;
}

function validReviewedFields(body: Record<string, unknown>): string | null {
  const title = optional(body.title), description = optional(body.description);
  if (title !== null && title.length > 300) return "Title must be at most 300 characters";
  if (description !== null && description.length > 4000) return "Description must be at most 4000 characters";
  if (!oneOf(PROPOSAL_CATEGORIES, optional(body.category))) return `Category must be one of ${PROPOSAL_CATEGORIES.join(", ")}`;
  if (!oneOf(PROPOSAL_PRIORITIES, optional(body.priority))) return `Priority must be one of ${PROPOSAL_PRIORITIES.join(", ")}`;
  return null;
}

// ── Proposal actions ────────────────────────────────────────────────────────

export async function proposalAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), action = text(body.action);
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  switch (action) {
    case "edit": return editProposal(db, actor, projectId, body);
    case "approve": case "needs_review": case "reject": case "reopen": return reviewProposal(db, actor, projectId, action, body);
    case "bulk_review": return bulkReview(db, actor, projectId, body);
    case "split": return splitProposal(db, actor, projectId, body);
    case "merge": return mergeProposals(db, actor, projectId, body);
    case "promote": return promoteProposal(db, actor, projectId, body);
    default: return fail(400, "action must be edit, approve, needs_review, reject, reopen, bulk_review, split, merge or promote");
  }
}

async function editProposal(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const invalid = validReviewedFields(body);
  if (invalid) return fail(400, invalid);
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Proposal not found in this project");
  const { data, error } = await db.rpc("edit_requirement_proposal", {
    p_proposal_id: id, p_project_id: projectId, p_title: optional(body.title), p_description: optional(body.description),
    p_category: optional(body.category), p_priority: optional(body.priority), p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const after = (Array.isArray(data) ? data[0] : data) as ReviewedProposal;
  const b = effectiveProposal(before), a = effectiveProposal(after);
  const rows: AuditRow[] = (["title", "description", "category", "priority"] as const)
    .filter((f) => (b[f] ?? null) !== (a[f] ?? null))
    .map((f) => ({ project_id: projectId, entity_type: "requirement_proposals", entity_id: id, entity_name: proposalName(after), action_type: "Update", field_name: f, old_value: b[f] ?? null, new_value: a[f] ?? null }));
  if (before.review_status !== after.review_status) rows.push({ project_id: projectId, entity_type: "requirement_proposals", entity_id: id, entity_name: proposalName(after), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: `${after.review_status} (edited after approval)` });
  const auditWarning = await audit(db, actor, rows);
  return { status: 200, body: { proposal: after, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

async function reviewProposal(db: SupabaseClient, actor: Actor, projectId: string, action: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const reason = optional(body.reason);
  if (action === "reject" && reason !== null && !(REJECTION_REASONS as readonly string[]).includes(reason)) return fail(400, `Reason must be one of ${REJECTION_REASONS.join(", ")}`);
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "Review note must be at most 2000 characters");
  const before = await loadProposal(db, projectId, id);
  if (!before) return fail(404, "Proposal not found in this project");
  const { data, error } = await db.rpc("review_requirement_proposal", {
    p_proposal_id: id, p_project_id: projectId, p_action: action, p_note: note, p_reason: action === "reject" ? reason : null,
    p_acknowledge_inferred: body.acknowledge_inferred === true, p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const after = (Array.isArray(data) ? data[0] : data) as ReviewedProposal;
  let auditWarning: string | null = null;
  if (before.review_status !== after.review_status) {
    const detail = [after.review_status, after.rejection_reason ? `(${after.rejection_reason})` : null, note ? `— ${note}` : null,
      after.inferred_acknowledged_at && !before.inferred_acknowledged_at ? "[inferred interpretation acknowledged]" : null].filter(Boolean).join(" ");
    auditWarning = await audit(db, actor, [{ project_id: projectId, entity_type: "requirement_proposals", entity_id: id, entity_name: proposalName(after), action_type: "Status Change", field_name: "review_status", old_value: before.review_status, new_value: detail.slice(0, 1000) }]);
  }
  return { status: 200, body: { proposal: after, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

/**
 * Bulk Approve / Reject. Never promotes. Inferred proposals are only approved
 * when the caller explicitly acknowledged inferred interpretations for this
 * bulk action; otherwise they are skipped and reported.
 */
async function bulkReview(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const decision = text(body.decision);
  if (decision !== "approve" && decision !== "reject") return fail(400, "decision must be approve or reject");
  const ids = Array.isArray(body.proposal_ids) ? [...new Set(body.proposal_ids.map(text))] : [];
  if (ids.length === 0 || ids.length > MAX_BULK || !ids.every((id) => UUID.test(id))) return fail(400, `proposal_ids must be 1–${MAX_BULK} ids`);
  if (Number(body.confirmed_count) !== ids.length) return fail(400, "Confirm the number of proposals this bulk action applies to");
  const done: string[] = [], skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const p = await loadProposal(db, projectId, id);
    if (!p) { skipped.push({ id, reason: "not found in this project" }); continue; }
    if (decision === "approve" && p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at && body.acknowledge_inferred !== true) {
      skipped.push({ id, reason: "Inferred — needs an explicit acknowledgement" }); continue;
    }
    const res = await reviewProposal(db, actor, projectId, decision, { proposal_id: id, note: body.note, reason: body.reason, acknowledge_inferred: body.acknowledge_inferred });
    if (res.status === 200) done.push(id); else skipped.push({ id, reason: String(res.body.error) });
  }
  return { status: 200, body: { updated: done, skipped } };
}

async function splitProposal(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const children = Array.isArray(body.children) ? body.children : [];
  if (children.length < 2 || children.length > 20) return fail(400, "A split needs 2–20 child proposals");
  const clean = [];
  for (const [n, raw] of children.entries()) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const title = text(c.title), description = text(c.description);
    const ids = Array.isArray(c.source_fragment_ids) ? [...new Set(c.source_fragment_ids.map(text))] : [];
    if (!title || title.length > 300 || !description || description.length > 4000) return fail(400, `Child ${n + 1}: a title (≤ 300) and description (≤ 4000) are required`);
    if (ids.length === 0 || !ids.every((x) => UUID.test(x))) return fail(400, `Child ${n + 1}: select at least one source fragment — a proposal cannot lose its provenance`);
    const invalid = validReviewedFields(c);
    if (invalid) return fail(400, `Child ${n + 1}: ${invalid}`);
    clean.push({ title, description, category: optional(c.category), priority: optional(c.priority), source_fragment_ids: ids });
  }
  const parent = await loadProposal(db, projectId, id);
  if (!parent) return fail(404, "Proposal not found in this project");
  const { data, error } = await db.rpc("split_requirement_proposal", { p_proposal_id: id, p_project_id: projectId, p_children: clean, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const created = (data ?? []) as ReviewedProposal[];
  const auditWarning = await audit(db, actor, [
    { project_id: projectId, entity_type: "requirement_proposals", entity_id: id, entity_name: proposalName(parent), action_type: "Status Change", field_name: "review_status", old_value: parent.review_status, new_value: `Superseded — split into ${created.map((c) => `#${c.sequence}`).join(", ")}` },
    ...created.map((c): AuditRow => ({ project_id: projectId, entity_type: "requirement_proposals", entity_id: c.id, entity_name: proposalName(c), action_type: "Create", field_name: "origin", new_value: `Split from proposal #${parent.sequence}` })),
  ]);
  return { status: 200, body: { parent_id: id, children: created, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

async function mergeProposals(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const ids = Array.isArray(body.proposal_ids) ? [...new Set(body.proposal_ids.map(text))] : [];
  if (ids.length < 2 || ids.length > 20 || !ids.every((x) => UUID.test(x))) return fail(400, "Select 2–20 proposals to merge");
  const title = text(body.title), description = text(body.description);
  if (!title || title.length > 300 || !description || description.length > 4000) return fail(400, "A title (≤ 300) and description (≤ 4000) are required");
  const invalid = validReviewedFields(body);
  if (invalid) return fail(400, invalid);
  const { data, error } = await db.rpc("merge_requirement_proposals", {
    p_proposal_ids: ids, p_project_id: projectId, p_title: title, p_description: description,
    p_category: optional(body.category), p_priority: optional(body.priority), p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const merged = (Array.isArray(data) ? data[0] : data) as ReviewedProposal;
  const { data: members } = await db.from("requirement_proposals").select("*").in("id", ids);
  const auditWarning = await audit(db, actor, [
    { project_id: projectId, entity_type: "requirement_proposals", entity_id: merged.id, entity_name: proposalName(merged), action_type: "Create", field_name: "origin", new_value: `Merged from ${((members ?? []) as ReviewedProposal[]).map((m) => `#${m.sequence}`).join(", ")}` },
    ...((members ?? []) as ReviewedProposal[]).map((m): AuditRow => ({ project_id: projectId, entity_type: "requirement_proposals", entity_id: m.id, entity_name: proposalName(m), action_type: "Status Change", field_name: "review_status", new_value: `Superseded — merged into #${merged.sequence}` })),
  ]);
  return { status: 200, body: { proposal: merged, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

/** Source section / page summary of a set of fragments, for the provenance note. */
async function fragmentSummary(db: SupabaseClient, ids: string[]) {
  const { data } = await db.from("source_fragments").select("id, sequence, section_path, section_heading, page_start, page_end").in("id", ids);
  const rows = ((data ?? []) as { sequence: number; section_path: string[]; section_heading: string | null; page_start: number | null; page_end: number | null }[]).sort((a, b) => a.sequence - b.sequence);
  const sections = [...new Set(rows.map((f) => (f.section_path.length ? f.section_path.join(" › ") : f.section_heading ?? "Document start")))];
  const pages = [...new Set(rows.filter((f) => f.page_start != null).map((f) => (f.page_end && f.page_end !== f.page_start ? `pp. ${f.page_start}–${f.page_end}` : `p. ${f.page_start}`)))];
  return { sections, pages };
}

async function promoteProposal(db: SupabaseClient, actor: Actor, projectId: string, body: Record<string, unknown>): Promise<ServiceResult> {
  const id = text(body.proposal_id);
  if (!UUID.test(id)) return fail(400, "proposal_id is required");
  const p = await loadProposal(db, projectId, id);
  if (!p) return fail(404, "Proposal not found in this project");
  const { data: run } = await db.from("analysis_runs").select("id, document_id, document_version_id, model, prompt_version").eq("id", p.analysis_run_id).maybeSingle();
  const r = run as { id: string; document_id: string; document_version_id: string; model: string; prompt_version: string | null } | null;
  if (!r) return fail(404, "The proposal's analysis run was not found");
  const [{ data: doc }, { data: version }, summary] = await Promise.all([
    db.from("documents").select("document_name, document_type").eq("id", r.document_id).maybeSingle(),
    db.from("document_versions").select("version_number").eq("id", r.document_version_id).maybeSingle(),
    fragmentSummary(db, p.source_fragment_ids),
  ]);
  const d = doc as { document_name: string; document_type: string | null } | null;
  // Requirement "source" only when the document's recorded type is one of the Requirement source options — never guessed.
  const sourceOptions = moduleByKey.get("requirements")?.fields.find((f) => f.key === "source")?.options ?? [];
  const source = d?.document_type && sourceOptions.includes(d.document_type) ? d.document_type : null;
  const notes = provenanceNote({
    proposalSequence: p.sequence, documentName: d?.document_name ?? "Source document", versionNumber: (version as { version_number?: number } | null)?.version_number ?? 0,
    runId: r.id, model: r.model, promptVersion: r.prompt_version, sections: summary.sections, pages: summary.pages,
  });
  const { data, error } = await db.rpc("promote_requirement_proposal", {
    p_proposal_id: id, p_project_id: projectId, p_ref_prefix: refPrefixFor("requirements"), p_source: source, p_notes: notes.slice(0, 4000),
    p_user_id: actor.userId, p_user_name: actor.displayName,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { requirement_id: string; requirement_ref: string; already_promoted: boolean; title: string };
  let auditWarning: string | null = null;
  if (!row.already_promoted) {
    auditWarning = await audit(db, actor, [
      { project_id: projectId, entity_type: "requirements", entity_id: row.requirement_id, entity_name: getEntityName("requirements", { requirement_ref: row.requirement_ref, title: row.title, id: row.requirement_id }), action_type: "Create", field_name: "source", new_value: `Promoted from analysis proposal #${p.sequence}` },
      { project_id: projectId, entity_type: "requirement_proposals", entity_id: id, entity_name: proposalName(p), action_type: "Status Change", field_name: "review_status", old_value: p.review_status, new_value: `Promoted → ${row.requirement_ref}` },
    ]);
  }
  const { data: requirement } = await db.from("requirements").select("*").eq("id", row.requirement_id).maybeSingle();
  const after = await loadProposal(db, projectId, id);
  return { status: 200, body: { requirement, proposal: after, already_promoted: row.already_promoted, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

// ── Issues ─────────────────────────────────────────────────────────────────

const RISK_LEVELS = ["Low", "Medium", "High", "Critical"];
const PROBABILITIES = ["Low", "Medium", "High"];

export async function issueAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), id = text(body.issue_id), action = text(body.action);
  if (!UUID.test(projectId) || !UUID.test(id)) return fail(400, "project_id and issue_id are required");
  const { data: current } = await db.from("analysis_issues").select("*").eq("id", id).eq("project_id", projectId).maybeSingle();
  const before = current as ReviewedIssue | null;
  if (!before) return fail(404, "Issue not found in this project");
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "Note must be at most 2000 characters");

  if (action === "review") {
    const status = text(body.status);
    if (!["Open", "Resolved", "Accepted", "Not Applicable"].includes(status)) return fail(400, "status must be Open, Resolved, Accepted or Not Applicable");
    const { data, error } = await db.rpc("review_analysis_issue", { p_issue_id: id, p_project_id: projectId, p_status: status, p_note: note, p_user_id: actor.userId, p_user_name: actor.displayName });
    if (error) return mapDbError(error);
    const after = (Array.isArray(data) ? data[0] : data) as ReviewedIssue;
    const auditWarning = before.status !== after.status || note
      ? await audit(db, actor, [{ project_id: projectId, entity_type: "analysis_issues", entity_id: id, entity_name: issueName(after), action_type: "Status Change", field_name: "status", old_value: before.status, new_value: [after.status, note ? `— ${note}` : null].filter(Boolean).join(" ").slice(0, 1000) }])
      : null;
    return { status: 200, body: { issue: after, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
  }

  if (action === "promote") {
    const target = text(body.target) as IssueTarget;
    if (!["discovery_questions", "actions", "risks", "decisions"].includes(target)) return fail(400, "target must be discovery_questions, actions, risks or decisions");
    const f = (body.fields ?? {}) as Record<string, unknown>;
    const main = text(f.text);
    if (!main || main.length > 4000) return fail(400, "The text of the new record is required (≤ 4000 characters)");
    const provenance = `From analysis issue #${before.sequence} (${before.issue_type}).`;
    let fields: Record<string, unknown>;
    if (target === "discovery_questions") {
      const categories = moduleByKey.get("discovery_questions")?.fields.find((x) => x.key === "category")?.options ?? [];
      const category = optional(f.category);
      if (category && !categories.includes(category)) return fail(400, `Category must be one of ${categories.join(", ")}`);
      fields = { question: main, category, notes: [before.description, provenance].join("\n\n") };
    } else if (target === "actions") {
      fields = { description: main, notes: provenance };
    } else if (target === "risks") {
      const impact = text(f.impact), probability = text(f.probability);
      if (!RISK_LEVELS.includes(impact) || !PROBABILITIES.includes(probability)) return fail(400, "A risk needs an impact (Low–Critical) and a probability (Low–High) chosen by the reviewer");
      fields = { description: main, impact, probability };
    } else {
      fields = { question: main };
    }
    const { data, error } = await db.rpc("promote_analysis_issue", {
      p_issue_id: id, p_project_id: projectId, p_target: target, p_ref_prefix: refPrefixFor(target), p_fields: fields, p_user_id: actor.userId, p_user_name: actor.displayName,
    });
    if (error) return mapDbError(error);
    const row = (Array.isArray(data) ? data[0] : data) as { record_id: string; record_ref: string; already_promoted: boolean; target: IssueTarget };
    let auditWarning: string | null = null;
    if (!row.already_promoted) {
      const entityName = getEntityName(target, { [refFieldFor(target)]: row.record_ref, question: main, description: main, id: row.record_id });
      auditWarning = await audit(db, actor, [
        { project_id: projectId, entity_type: target, entity_id: row.record_id, entity_name: entityName, action_type: "Create", field_name: "source", new_value: `Promoted from analysis issue #${before.sequence}` },
        { project_id: projectId, entity_type: "analysis_issues", entity_id: id, entity_name: issueName(before), action_type: "Status Change", field_name: "promoted_to", old_value: before.status, new_value: `Promoted → ${row.record_ref}` },
      ]);
    }
    const { data: after } = await db.from("analysis_issues").select("*").eq("id", id).maybeSingle();
    return { status: 200, body: { issue: after, record_id: row.record_id, record_ref: row.record_ref, target: row.target, already_promoted: row.already_promoted, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
  }
  return fail(400, "action must be review or promote");
}

const refFieldFor = (t: IssueTarget) => (t === "discovery_questions" ? "question_ref" : t === "actions" ? "action_ref" : t === "risks" ? "risk_ref" : "decision_ref");

// ── Scope notes ────────────────────────────────────────────────────────────

export async function scopeNoteAction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), id = text(body.note_id);
  if (!UUID.test(projectId) || !UUID.test(id)) return fail(400, "project_id and note_id are required");
  if (text(body.action) !== "acknowledge") return fail(400, "action must be acknowledge");
  const note = optional(body.note);
  if (note && note.length > 2000) return fail(400, "Note must be at most 2000 characters");
  const { data: current } = await db.from("analysis_scope_notes").select("acknowledged_at, sequence, area").eq("id", id).eq("project_id", projectId).maybeSingle();
  if (!current) return fail(404, "Scope note not found in this project");
  const { data, error } = await db.rpc("acknowledge_scope_note", { p_note_id: id, p_project_id: projectId, p_note: note, p_user_id: actor.userId, p_user_name: actor.displayName });
  if (error) return mapDbError(error);
  const c = current as { acknowledged_at: string | null; sequence: number; area: string | null };
  const auditWarning = c.acknowledged_at ? null : await audit(db, actor, [{ project_id: projectId, entity_type: "analysis_scope_notes", entity_id: id, entity_name: `Scope note #${c.sequence} — ${c.area ?? "area"}`, action_type: "Status Change", field_name: "acknowledged", old_value: null, new_value: ["Acknowledged", note ? `— ${note}` : null].filter(Boolean).join(" ") }]);
  return { status: 200, body: { scope_note: Array.isArray(data) ? data[0] : data, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

// ── Provenance of a canonical Requirement (any valid role) ─────────────────

/**
 * Requirement → promoted proposal → source fragments → extraction job →
 * document version → document. Returns authoritative provenance only (the
 * document, version, sections, pages and fragment text), never other
 * proposal content, so Viewers may read it.
 */
export async function requirementProvenance(db: SupabaseClient, projectId: string, requirementId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId) || !UUID.test(requirementId)) return fail(400, "project_id and requirement_id are required");
  const { data: prop } = await db.from("requirement_proposals")
    .select("id, sequence, analysis_run_id, source_fragment_ids, promoted_at, promoted_by_name, origin")
    .eq("promoted_record_id", requirementId).eq("project_id", projectId).maybeSingle();
  if (!prop) return { status: 200, body: { provenance: null } };
  const p = prop as { id: string; sequence: number; analysis_run_id: string; source_fragment_ids: string[]; promoted_at: string; promoted_by_name: string | null; origin: string };
  const { data: run } = await db.from("analysis_runs").select("document_id, document_version_id, extraction_job_id").eq("id", p.analysis_run_id).maybeSingle();
  const r = run as { document_id: string; document_version_id: string; extraction_job_id: string } | null;
  if (!r) return { status: 200, body: { provenance: null } };
  const [{ data: fragments }, { data: version }, { data: doc }, { data: job }] = await Promise.all([
    db.from("source_fragments").select("id, sequence, section_heading, section_path, page_start, page_end, text").in("id", p.source_fragment_ids),
    db.from("document_versions").select("id, version_number, original_filename, content_type").eq("id", r.document_version_id).maybeSingle(),
    db.from("documents").select("id, document_name, document_type").eq("id", r.document_id).maybeSingle(),
    db.from("extraction_jobs").select("id, extractor_version, completed_at").eq("id", r.extraction_job_id).maybeSingle(),
  ]);
  return {
    status: 200,
    body: {
      provenance: {
        proposal: { sequence: p.sequence, origin: p.origin, promoted_at: p.promoted_at, promoted_by_name: p.promoted_by_name },
        document: doc, version, extraction_job: job,
        fragments: ((fragments ?? []) as { sequence: number }[]).sort((a, b) => a.sequence - b.sequence),
      },
    },
  };
}
