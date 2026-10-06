"use client";

// ── Test Case generation (Phase 1G) — browser helpers ──────────────────────
// Manager/Admin only: every call goes through a role-guarded server route.
// Proposed test cases are not part of the DataStore, so Viewers never load them.

import type { TestCaseProposal, TestGenerationEligibility, TestGenerationIssue, TestGenerationRun } from "@/lib/test-generation";
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

export type TestGenerationRunDetail = {
  run: TestGenerationRun; proposals: TestCaseProposal[]; issues: TestGenerationIssue[]; fragments: AnalysisFragment[];
  sibling_runs: { id: string; status: string; queued_at: string; prompt_version: string | null; proposal_count: number | null }[]; latest_run_id: string;
};

export function loadTestGenerationRun(projectId: string, runId: string) {
  return call<TestGenerationRunDetail>(`/api/requirements/test-generation?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`);
}
