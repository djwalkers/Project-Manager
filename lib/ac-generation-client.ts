"use client";

// ── Acceptance Criteria generation (Phase 1E) — browser helpers ────────────
// Manager/Admin only: every call goes through a role-guarded server route.
// Generated criteria are not part of the DataStore, so Viewers never load them.

import type { AcceptanceCriterionProposal, AcGenerationEligibility, AcGenerationIssue, AcGenerationRun } from "@/lib/ac-generation";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";
import type { AcClarification, ReviewedAcIssue, ReviewedAcProposal, ScopeNoteAssociation } from "@/lib/ac-review";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export type AcGenerationRunSummary = Pick<AcGenerationRun, "id" | "status" | "trigger" | "retry_of_run_id" | "requested_by_name" | "queued_at" | "started_at" | "completed_at"
  | "attempt_count" | "model" | "prompt_version" | "proposal_count" | "issue_count" | "needs_review_count" | "warnings_count" | "error_category" | "error_message">;

export type RequirementAcGeneration = {
  eligibility: AcGenerationEligibility;
  context: { clarifications: number; open_questions: number; scope_notes: number } | null;
  runs: AcGenerationRunSummary[];
  configured_model: string;
};

export function loadRequirementAcGeneration(projectId: string, requirementId: string) {
  return call<RequirementAcGeneration>(`/api/requirements/ac-generation?project_id=${encodeURIComponent(projectId)}&requirement_id=${encodeURIComponent(requirementId)}`);
}

/** Queue generation for an eligible promoted Requirement, or retry a failed run. */
export function queueAcGeneration(projectId: string, requirementId: string, retryOfRunId?: string) {
  return call<{ run: AcGenerationRun }>("/api/requirements/ac-generation", {
    method: "POST", body: JSON.stringify({ project_id: projectId, requirement_id: requirementId, ...(retryOfRunId ? { retry_of_run_id: retryOfRunId } : {}) }),
  });
}

export type AcGenerationRunDetail = { run: AcGenerationRun; proposals: AcceptanceCriterionProposal[]; issues: AcGenerationIssue[]; fragments: AnalysisFragment[] };

export function loadAcGenerationRun(projectId: string, runId: string) {
  return call<AcGenerationRunDetail>(`/api/requirements/ac-generation?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`);
}

// ── Review and promotion (Phase 1F) ─────────────────────────────────────────

export type AcReviewScopeNote = { id: string; sequence: number; area: string | null; description: string; source_quote: string | null; source_fragment_ids: string[]; acknowledged_at: string | null; acknowledged_by_name: string | null; acknowledgement_note: string | null };
export type AcReviewRunDetail = Omit<AcGenerationRunDetail, "proposals" | "issues"> & {
  proposals: ReviewedAcProposal[]; issues: ReviewedAcIssue[]; clarifications: AcClarification[];
  approval_blockers: Record<string, string[]>;
  scope_notes: AcReviewScopeNote[]; scope_note_associations: ScopeNoteAssociation[];
  analysis_requirements: { id: string; requirement_ref: string | null; title: string }[];
  sibling_runs: { id: string; status: string; queued_at: string; completed_at: string | null; prompt_version: string | null; proposal_count: number | null }[];
  latest_run_id: string;
  requirement: { id: string; requirement_ref: string | null; title: string; status: string | null } | null;
  canonical_acceptance_criteria: { id: string; ac_ref: string | null; criterion: string; status: string | null; criterion_type: string | null }[];
  older_open_proposals: number;
  history: { id: string; entity_type: string; entity_name: string; action_type: string; field_name: string | null; old_value: string | null; new_value: string | null; changed_by_name: string | null; changed_at: string }[];
};

export function loadAcReviewRun(projectId: string, runId: string) {
  return call<AcReviewRunDetail>(`/api/requirements/ac-generation?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`);
}

type Result = Record<string, unknown> & { audit_warning?: string };
const post = (path: string, body: Record<string, unknown>) => call<Result>(path, { method: "POST", body: JSON.stringify(body) });

export const acProposalAction = (projectId: string, action: string, body: Record<string, unknown>) => post("/api/acceptance-criteria/proposals", { project_id: projectId, action, ...body });
export const reviewAcIssue = (projectId: string, issueId: string, status: string, note: string | null) => post("/api/acceptance-criteria/generation-issues", { project_id: projectId, issue_id: issueId, status, note });
export const saveAcClarification = (projectId: string, body: Record<string, unknown>) => post("/api/acceptance-criteria/clarifications", { project_id: projectId, ...body });
export const setScopeNoteAssociation = (projectId: string, scopeNoteId: string, requirementId: string, associate: boolean, note?: string | null) =>
  post("/api/acceptance-criteria/scope-notes", { project_id: projectId, scope_note_id: scopeNoteId, requirement_id: requirementId, action: associate ? "associate" : "unassociate", note: note ?? null });

export type AcProvenance = {
  proposal: { sequence: number; origin: string; human_authored: boolean; promoted_at: string; promoted_by_name: string | null; confirmed_by_name: string | null };
  generation_run: { id: string; model: string; prompt_version: string | null; completed_at: string | null } | null;
  requirement: { requirement_ref: string | null; title: string } | null;
  fragments: { id: string; sequence: number; section_heading: string | null; section_path: string[] | null; page_start: number | null; page_end: number | null; text: string }[];
  scope_notes: { id: string; area: string | null; description: string }[];
  human_clarifications: { id: string; clarification: string; reason: string | null; created_by_name: string; created_at: string }[];
  resolved_issues: { id: string; issue_type: string; relation: string | null; status: string; resolution_note: string | null; reviewed_by_name: string | null }[];
  requirement_provenance: { document?: { document_name: string } | null; version?: { id: string; version_number: number; original_filename: string; content_type: string | null } | null } | null;
};
export function loadAcProvenance(projectId: string, acId: string) {
  return call<{ provenance: AcProvenance | null }>(`/api/acceptance-criteria/provenance?project_id=${encodeURIComponent(projectId)}&ac_id=${encodeURIComponent(acId)}`);
}
