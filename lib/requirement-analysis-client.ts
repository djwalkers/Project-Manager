"use client";

// ── Requirement analysis (Phase 1C) — browser helpers ──────────────────────
// Manager/Admin only: every call goes through a role-guarded server route
// (the analysis tables are not part of the DataStore, so Viewers never load
// proposal content).

import type { AnalysisIssue, AnalysisRun, AnalysisScopeNote, RequirementProposal } from "@/lib/requirement-analysis";
import type { SourceFragment } from "@/lib/types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export type AnalysisRunSummary = AnalysisRun & { open_issue_count: number };

export function loadAnalysisRuns(projectId: string) {
  return call<{ runs: AnalysisRunSummary[]; configured_model: string }>(`/api/source-documents/analysis?project_id=${encodeURIComponent(projectId)}`);
}

/** Analyse a version's newest completed extraction. */
export function queueDocumentAnalysis(projectId: string, versionId: string) {
  return call<{ run: AnalysisRun }>("/api/source-documents/analysis", { method: "POST", body: JSON.stringify({ project_id: projectId, version_id: versionId }) });
}

/** Retry a failed run (same extraction run; completed stages are reused). */
export function retryDocumentAnalysis(projectId: string, runId: string) {
  return call<{ run: AnalysisRun }>("/api/source-documents/analysis", { method: "POST", body: JSON.stringify({ project_id: projectId, retry_of_run_id: runId }) });
}

export type AnalysisFragment = Pick<SourceFragment, "id" | "sequence" | "fragment_type" | "section_heading" | "section_number" | "section_path" | "page_start" | "page_end" | "text" | "metadata">;

export type AnalysisRunDetail = {
  run: AnalysisRun;
  proposals: RequirementProposal[];
  issues: AnalysisIssue[];
  /** Absent/empty for runs before migration 039. */
  scope_notes?: AnalysisScopeNote[];
  fragments: AnalysisFragment[];
  version: { id: string; version_number: number; original_filename: string; content_type: string; uploaded_at: string } | null;
  document: { id: string; document_name: string; document_type: string | null; current_version_id: string } | null;
  extraction_job: { id: string; extractor_version: string | null; completed_at: string | null; fragment_count: number | null } | null;
};

export function loadAnalysisRun(projectId: string, runId: string) {
  return call<AnalysisRunDetail>(`/api/analysis/runs?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}`);
}

/** Admin: set the Ollama model used for analysis (null = default). */
export function saveAnalysisModel(model: string | null) {
  return call<{ analysis_model: string; is_default: boolean }>("/api/analysis/settings", { method: "PATCH", body: JSON.stringify({ model }) });
}

// ── Phase 1D: review and promotion (Manager/Admin) ──────────────────────────

/** Proposal review: edit / approve / needs_review / reject / reopen / bulk_review / split / merge / promote. */
export function proposalReview(body: Record<string, unknown> & { project_id: string; action: string }) {
  return call<Record<string, unknown>>("/api/analysis/proposals", { method: "POST", body: JSON.stringify(body) });
}

/** Issue review (Resolved / Accepted / Not Applicable / Open) or promotion to a governance record. */
export function issueReview(body: Record<string, unknown> & { project_id: string; issue_id: string; action: "review" | "promote" }) {
  return call<Record<string, unknown>>("/api/analysis/issues", { method: "POST", body: JSON.stringify(body) });
}

export function acknowledgeScopeNote(projectId: string, noteId: string, note: string | null) {
  return call<Record<string, unknown>>("/api/analysis/scope-notes", { method: "POST", body: JSON.stringify({ project_id: projectId, note_id: noteId, action: "acknowledge", note }) });
}

export type RequirementProvenance = {
  proposal: { sequence: number; origin: string; promoted_at: string; promoted_by_name: string | null };
  document: { id: string; document_name: string; document_type: string | null } | null;
  version: { id: string; version_number: number; original_filename: string; content_type: string } | null;
  extraction_job: { id: string; extractor_version: string | null; completed_at: string | null } | null;
  fragments: { id: string; sequence: number; section_heading: string | null; section_path: string[]; page_start: number | null; page_end: number | null; text: string }[];
};

/** Source provenance of a promoted canonical Requirement (any valid role); null when it was not promoted from analysis. */
export function loadRequirementProvenance(projectId: string, requirementId: string) {
  return call<{ provenance: RequirementProvenance | null }>(`/api/requirements/provenance?project_id=${encodeURIComponent(projectId)}&requirement_id=${encodeURIComponent(requirementId)}`);
}
