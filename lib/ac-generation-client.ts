"use client";

// ── Acceptance Criteria generation (Phase 1E) — browser helpers ────────────
// Manager/Admin only: every call goes through a role-guarded server route.
// Generated criteria are not part of the DataStore, so Viewers never load them.

import type { AcceptanceCriterionProposal, AcGenerationEligibility, AcGenerationIssue, AcGenerationRun } from "@/lib/ac-generation";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";

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
