"use client";

// ── Test Case generation (Phase 1G) — browser helpers ──────────────────────
// Manager/Admin only: every call goes through a role-guarded server route.
// Proposed test cases are not part of the DataStore, so Viewers never load them.
// The canonical test provenance read (Phase 1H) is available to every role.

import type { TestGenerationEligibility, TestGenerationIssue, TestGenerationRun, TestStep } from "@/lib/test-generation";
import type { AcSnapshot, ReviewedTestProposal, SimilarTest } from "@/lib/test-review";
import type { AcProvenance } from "@/lib/ac-generation-client";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export type TestGenerationRunSummary = Pick<TestGenerationRun, "id" | "status" | "trigger" | "retry_of_run_id" | "ac_ids" | "requested_by_name" | "queued_at" | "started_at" | "completed_at"
  | "attempt_count" | "model" | "prompt_version" | "proposal_count" | "issue_count" | "needs_review_count" | "warnings_count" | "error_category" | "error_message">;

export type RequirementTestGeneration = {
  eligibility: TestGenerationEligibility;
  acceptance_criteria: { id: string; ref: string; criterion: string; origin: "ai" | "manual"; criterion_type: string | null }[];
  runs: TestGenerationRunSummary[];
  configured_model: string;
};

export function loadRequirementTestGeneration(projectId: string, requirementId: string) {
  return call<RequirementTestGeneration>(`/api/requirements/test-generation?project_id=${encodeURIComponent(projectId)}&requirement_id=${encodeURIComponent(requirementId)}`);
}

/** Queue test generation for a Requirement (optionally a subset of its ACs), or retry a failed run. */
export function queueTestGeneration(projectId: string, requirementId: string, opts: { acIds?: string[] | null; retryOfRunId?: string } = {}) {
  return call<{ run: TestGenerationRun }>("/api/requirements/test-generation", {
    method: "POST",
    body: JSON.stringify({ project_id: projectId, requirement_id: requirementId, ...(opts.acIds ? { ac_ids: opts.acIds } : {}), ...(opts.retryOfRunId ? { retry_of_run_id: opts.retryOfRunId } : {}) }),
  });
}

export type CurrentAc = { id: string; ac_ref: string; criterion: string; description: string | null; criterion_type: string | null; given_text: string | null; when_text: string | null; then_text: string | null; status: string | null };
export type TestReviewHistoryRow = { id: string; entity_type: string; entity_name: string; action_type: string; field_name: string | null; old_value: string | null; new_value: string | null; changed_by_name: string | null; changed_at: string };
export type TestGenerationRunDetail = {
  run: TestGenerationRun; proposals: ReviewedTestProposal[]; issues: TestGenerationIssue[]; fragments: AnalysisFragment[];
  sibling_runs: { id: string; status: string; queued_at: string; prompt_version: string | null; proposal_count: number | null }[]; latest_run_id: string;
  requirement: { id: string; requirement_ref: string | null; title: string; status: string | null } | null;
  current_acceptance_criteria: CurrentAc[];
  approval_blockers: Record<string, string[]>;
  similar_tests: Record<string, SimilarTest[]>;
  history: TestReviewHistoryRow[];
};

export function loadTestGenerationRun(projectId: string, runId: string) {
  return call<TestGenerationRunDetail>(`/api/requirements/test-generation?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`);
}

// ── Review and promotion (Phase 1H) ─────────────────────────────────────────

type Result = Record<string, unknown> & { audit_warning?: string };
export const testProposalAction = (projectId: string, action: string, body: Record<string, unknown>) =>
  call<Result>("/api/test-cases/proposals", { method: "POST", body: JSON.stringify({ project_id: projectId, action, ...body }) });

export const reviewTestIssue = (projectId: string, issueId: string, status: string, note: string | null) =>
  call<Result>("/api/test-cases/generation-issues", { method: "POST", body: JSON.stringify({ project_id: projectId, issue_id: issueId, status, note }) });

export type TestSourceChange = { test_id: string; test_ref: string; ac_id: string; ac_ref: string; change: "Changed" | "Deleted"; approved_criterion: string | null; current_criterion: string | null };
export type TestCaseProvenance = {
  structure: { objective: string | null; preconditions: string[] | null; steps: TestStep[] | null; test_type: string | null };
  provenance: {
    proposal: { sequence: number; origin: string; human_authored: boolean; basis: string; promoted_at: string; promoted_by_name: string | null; confirmed_by_name: string | null };
    accepted_inferences: string[]; inference_reason: string | null;
    generation_run: { id: string; model: string; prompt_version: string | null; completed_at: string | null } | null;
    requirement: { id: string; requirement_ref: string | null; title: string } | null;
    approved_acceptance_criteria: AcSnapshot[];
    ac_provenance: Record<string, AcProvenance | null>;
    fragments: { id: string; sequence: number; section_heading: string | null; section_path: string[] | null; page_start: number | null; page_end: number | null; text: string }[];
    requirement_provenance: { document?: { document_name: string } | null; version?: { id: string; version_number: number; original_filename: string; content_type: string | null } | null } | null;
  } | null;
  source_changes: TestSourceChange[];
};
export function loadTestCaseProvenance(projectId: string, testId: string) {
  return call<TestCaseProvenance>(`/api/test-cases/provenance?project_id=${encodeURIComponent(projectId)}&test_id=${encodeURIComponent(testId)}`);
}
