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
