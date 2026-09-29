// ── Requirement analysis (Phase 1C) — shared types and rules ──────────────
//
// Importable from client components and server routes. Analysis output is
// NON-AUTHORITATIVE: proposals and issues live in their own tables
// (migration 038) and never touch canonical Requirements, Actions, Risks,
// Decisions, Discovery Questions, ProjectState or Go-Live Readiness.

export type AnalysisRunStatus = "Queued" | "Running" | "Completed" | "Completed with warnings" | "Failed";
export type AnalysisErrorCategory = "ollama_unreachable" | "model_unavailable" | "invalid_model_output" | "validation_failed" | "context_too_large" | "model_timeout" | "worker_timeout" | "upload_failed" | "internal_error";

export const ANALYSIS_STAGES = ["classification", "requirements", "coverage", "ambiguities", "consolidation", "source_check"] as const;
/** Why an issue is worth asking (prompts ≥ 2.0.0): what its answer could change. */
export const ISSUE_IMPACTS = ["implementation", "test_design", "acceptance_criteria", "data_migration", "integration", "scope", "operational"] as const;
export const EVIDENCE_BASES = ["Explicit", "Inferred"] as const;
export const CONFIDENCES = ["High", "Medium", "Low"] as const;
export const SEVERITIES = ["High", "Medium", "Low"] as const;
export const PROPOSAL_REVIEW_STATUSES = ["Proposed", "Needs Review", "Approved", "Rejected", "Promoted", "Superseded"] as const;
export const ISSUE_STATUSES = ["Open", "Resolved", "Accepted", "Not Applicable"] as const;
export const ISSUE_TYPES = [
  "Ambiguity", "Missing Information", "Contradiction", "Untestable Statement", "Assumption Required",
  "Duplicate / Repeated Requirement", "Out of Scope / Administrative Content",
] as const;
export const PROPOSAL_CATEGORIES = ["Business Rule", "Database", "Backend", "UI", "Performance", "Testing"] as const;
export const PROPOSAL_PRIORITIES = ["Low", "Medium", "High", "Critical"] as const;

/** Used when no analysis model is configured (Admin can change it in System Health). */
export const DEFAULT_ANALYSIS_MODEL = "qwen3:8b";
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export type AnalysisRun = {
  id: string;
  project_id: string;
  document_id: string;
  document_version_id: string;
  extraction_job_id: string;
  status: AnalysisRunStatus;
  trigger: "manual" | "retry";
  retry_of_run_id: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  worker_name: string | null;
  worker_version: string | null;
  model: string;
  model_digest: string | null;
  prompt_version: string | null;
  prompt_sha256: string | null;
  analysis_schema_version: string | null;
  proposal_count: number | null;
  issue_count: number | null;
  /** Migration 039; null on runs completed before it. */
  scope_note_count?: number | null;
  warnings_count: number | null;
  diagnostics: AnalysisDiagnostics | null;
  error_category: AnalysisErrorCategory | null;
  error_message: string | null;
};

export type AnalysisDiagnostics = {
  prompt_version?: string;
  analysis_schema_version?: string;
  fragment_count?: number;
  chunk_count?: number;
  section_count?: number;
  classifications?: Record<string, number>;
  fragment_classifications?: Record<string, string>;
  candidates_before_consolidation?: number;
  issues_before_consolidation?: number;
  consolidation_overrides?: { kind: string; proposed: string[]; kept_separate?: string[][]; kept?: string[][] }[];
  suppressed_issues?: { question: string; reason: string; answered_by?: string; answer_quote?: string; source_fragment_ids?: string[] }[];
  uncaptured_statements?: { fragment_id: string; text: string }[];
  excluded_plan_statements?: { fragment_id: string; text: string }[];
  scope_note_count?: number;
  stage_calls?: { stage: string; chunk: string; attempts: number; reused: boolean; duration_ms?: number; dropped?: number }[];
  warnings?: string[];
};

export type ConsolidationMember = { key: string; title: string; section: string; evidence_basis: string; confidence: string; source_ids: string[]; description?: string; quote?: string | null; applies_to?: string; category?: string | null };

export type RequirementProposal = {
  id: string;
  analysis_run_id: string;
  project_id: string;
  sequence: number;
  proposal_type: "requirement";
  proposed_title: string;
  proposed_description: string;
  proposed_category: (typeof PROPOSAL_CATEGORIES)[number] | null;
  proposed_priority: (typeof PROPOSAL_PRIORITIES)[number] | null;
  source_fragment_ids: string[];
  primary_source_fragment_id: string;
  source_quote: string | null;
  rationale: string;
  evidence_basis: (typeof EVIDENCE_BASES)[number];
  confidence: (typeof CONFIDENCES)[number];
  review_status: (typeof PROPOSAL_REVIEW_STATUSES)[number];
  consolidation: { merged?: boolean; kind?: "duplicate" | "parts" | "single"; member_count?: number; reason?: string; representative?: string; sections?: string[]; priority_conflict?: string[]; members?: ConsolidationMember[] };
  created_at: string;
};

/** "No change required" statements (migration 039): scope/regression information, not requirements. */
export type AnalysisScopeNote = {
  id: string;
  analysis_run_id: string;
  project_id: string;
  sequence: number;
  note_type: "No Change";
  area: string | null;
  description: string;
  source_quote: string | null;
  source_fragment_ids: string[];
  created_at: string;
};

export type AnalysisIssue = {
  id: string;
  analysis_run_id: string;
  project_id: string;
  sequence: number;
  issue_type: (typeof ISSUE_TYPES)[number];
  severity: (typeof SEVERITIES)[number];
  description: string;
  suggested_question: string | null;
  source_fragment_ids: string[];
  related_proposal_sequences: number[];
  status: (typeof ISSUE_STATUSES)[number];
  /** Prompts ≥ 2.0.0; empty/null on earlier runs. */
  impact?: (typeof ISSUE_IMPACTS)[number][];
  trigger_quote?: string | null;
  consolidation?: { merged?: boolean; reason?: string; members?: { question: string; description: string; source_ids: string[]; impact: string[] }[] };
  created_at: string;
};

export const ANALYSIS_ERROR_LABELS: Record<string, string> = {
  ollama_unreachable: "Ollama was not reachable on the worker's Mac",
  model_unavailable: "The analysis model is not installed in Ollama",
  invalid_model_output: "The model did not produce valid output",
  validation_failed: "The output failed provenance/validation checks",
  context_too_large: "The document section was too large for the model",
  model_timeout: "The local model took too long to respond",
  worker_timeout: "The worker stopped responding",
  upload_failed: "Saving the analysis failed",
  internal_error: "Unexpected worker error",
};

export const isActiveAnalysis = (run: Pick<AnalysisRun, "status"> | null | undefined) => run?.status === "Queued" || run?.status === "Running";
export const isCompletedAnalysis = (run: Pick<AnalysisRun, "status"> | null | undefined) => run?.status === "Completed" || run?.status === "Completed with warnings";

/** Runs newest first. */
export function runsForVersion<T extends AnalysisRun>(versionId: string, runs: T[]): T[] {
  return runs.filter((r) => r.document_version_id === versionId).sort((a, b) => b.queued_at.localeCompare(a.queued_at) || b.id.localeCompare(a.id));
}

export function latestRunForExtraction<T extends AnalysisRun>(extractionJobId: string, runs: T[]): T | null {
  return runs.filter((r) => r.extraction_job_id === extractionJobId).sort((a, b) => b.queued_at.localeCompare(a.queued_at) || b.id.localeCompare(a.id))[0] ?? null;
}

export type ProposalInput = {
  sequence: number; proposed_title: string; proposed_description: string; proposed_category: string | null; proposed_priority: string | null;
  source_fragment_ids: string[]; primary_source_fragment_id: string; source_quote: string | null; rationale: string;
  evidence_basis: string; confidence: string; consolidation: Record<string, unknown>;
};
export type IssueInput = {
  sequence: number; issue_type: string; severity: string; description: string; suggested_question: string | null;
  source_fragment_ids: string[]; related_proposal_sequences: number[];
  impact: string[]; trigger_quote: string | null; consolidation: Record<string, unknown>;
};
export type ScopeNoteInput = {
  sequence: number; note_type: "No Change"; area: string | null; description: string; source_quote: string | null; source_fragment_ids: string[];
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const oneOf = <T extends readonly string[]>(list: T, v: unknown) => (list as readonly string[]).includes(v as string);

/**
 * Stage 5 (server side): deterministic validation of a worker's analysis
 * output against the run's own fragment set. Returns the whitelisted rows
 * or the list of problems — nothing malformed ever reaches the database.
 * The model never supplies review_status or requirement references.
 */
export function validateAnalysisSubmission(proposalsRaw: unknown, issuesRaw: unknown, fragmentIds: Set<string>, scopeNotesRaw: unknown = []):
  { ok: true; proposals: ProposalInput[]; issues: IssueInput[]; scopeNotes: ScopeNoteInput[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(proposalsRaw) || !Array.isArray(issuesRaw) || !Array.isArray(scopeNotesRaw)) return { ok: false, problems: ["proposals, issues and scope notes must be arrays"] };
  if (proposalsRaw.length > 500 || issuesRaw.length > 500 || scopeNotesRaw.length > 500) return { ok: false, problems: ["too many proposals, issues or scope notes"] };
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);
  const proposals: ProposalInput[] = [];
  const sequences = new Set<number>();
  proposalsRaw.forEach((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const where = `proposal ${i + 1}`;
    const sourceIds = [...new Set(ids(p.source_fragment_ids))];
    const primary = str(p.primary_source_fragment_id);
    const seq = Number(p.sequence);
    if (!Number.isInteger(seq) || seq < 1 || sequences.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    sequences.add(seq);
    if (sourceIds.length === 0) problems.push(`${where}: no source fragments (provenance is required)`);
    if (sourceIds.some((id) => !fragmentIds.has(id))) problems.push(`${where}: cites a fragment that is not part of the analysed extraction run`);
    if (!sourceIds.includes(primary)) problems.push(`${where}: primary fragment must be one of its sources`);
    if ("review_status" in p || "requirement_ref" in p) problems.push(`${where}: review status and requirement references are not set by analysis`);
    const title = str(p.proposed_title), description = str(p.proposed_description), rationale = str(p.rationale);
    if (!title || title.length > 300) problems.push(`${where}: title is required (≤ 300 characters)`);
    if (!description || description.length > 4000) problems.push(`${where}: description is required (≤ 4000 characters)`);
    if (!rationale || rationale.length > 2000) problems.push(`${where}: rationale is required (≤ 2000 characters)`);
    if (!oneOf(EVIDENCE_BASES, p.evidence_basis)) problems.push(`${where}: evidence_basis must be Explicit or Inferred`);
    if (!oneOf(CONFIDENCES, p.confidence)) problems.push(`${where}: confidence must be High, Medium or Low`);
    if (p.proposed_category != null && !oneOf(PROPOSAL_CATEGORIES, p.proposed_category)) problems.push(`${where}: invalid category`);
    if (p.proposed_priority != null && !oneOf(PROPOSAL_PRIORITIES, p.proposed_priority)) problems.push(`${where}: invalid priority`);
    const quote = p.source_quote == null ? null : str(p.source_quote).slice(0, 2000) || null;
    const consolidation = p.consolidation && typeof p.consolidation === "object" && !Array.isArray(p.consolidation) ? p.consolidation as Record<string, unknown> : {};
    if (JSON.stringify(consolidation).length > 20_000) problems.push(`${where}: consolidation evidence is too large`);
    proposals.push({
      sequence: seq, proposed_title: title, proposed_description: description,
      proposed_category: (p.proposed_category as string | null) ?? null, proposed_priority: (p.proposed_priority as string | null) ?? null,
      source_fragment_ids: sourceIds, primary_source_fragment_id: primary, source_quote: quote, rationale,
      evidence_basis: p.evidence_basis as string, confidence: p.confidence as string, consolidation,
    });
  });
  const issues: IssueInput[] = [];
  const issueSequences = new Set<number>();
  issuesRaw.forEach((raw, i) => {
    const x = (raw ?? {}) as Record<string, unknown>;
    const where = `issue ${i + 1}`;
    const sourceIds = [...new Set(ids(x.source_fragment_ids))];
    const seq = Number(x.sequence);
    if (!Number.isInteger(seq) || seq < 1 || issueSequences.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    issueSequences.add(seq);
    if (sourceIds.length === 0) problems.push(`${where}: no source fragments`);
    if (sourceIds.some((id) => !fragmentIds.has(id))) problems.push(`${where}: cites a fragment that is not part of the analysed extraction run`);
    if (!oneOf(ISSUE_TYPES, x.issue_type)) problems.push(`${where}: invalid issue_type`);
    if (!oneOf(SEVERITIES, x.severity)) problems.push(`${where}: invalid severity`);
    const description = str(x.description);
    if (!description || description.length > 2000) problems.push(`${where}: description is required (≤ 2000 characters)`);
    const related = Array.isArray(x.related_proposal_sequences) ? [...new Set(x.related_proposal_sequences.map(Number))] : [];
    if (related.some((s) => !sequences.has(s))) problems.push(`${where}: refers to a proposal that does not exist`);
    const impact = Array.isArray(x.impact) ? [...new Set(x.impact.map(str))] : [];
    if (impact.some((m) => !oneOf(ISSUE_IMPACTS, m))) problems.push(`${where}: invalid impact`);
    const consolidation = x.consolidation && typeof x.consolidation === "object" && !Array.isArray(x.consolidation) ? x.consolidation as Record<string, unknown> : {};
    if (JSON.stringify(consolidation).length > 20_000) problems.push(`${where}: consolidation evidence is too large`);
    issues.push({
      sequence: seq, issue_type: x.issue_type as string, severity: x.severity as string, description,
      suggested_question: x.suggested_question == null ? null : str(x.suggested_question).slice(0, 1000) || null,
      source_fragment_ids: sourceIds, related_proposal_sequences: related,
      impact, trigger_quote: x.trigger_quote == null ? null : str(x.trigger_quote).slice(0, 400) || null, consolidation,
    });
  });
  const scopeNotes: ScopeNoteInput[] = [];
  const noteSequences = new Set<number>();
  scopeNotesRaw.forEach((raw, i) => {
    const n = (raw ?? {}) as Record<string, unknown>;
    const where = `scope note ${i + 1}`;
    const sourceIds = [...new Set(ids(n.source_fragment_ids))];
    const seq = Number(n.sequence);
    if (!Number.isInteger(seq) || seq < 1 || noteSequences.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    noteSequences.add(seq);
    if (sourceIds.length === 0) problems.push(`${where}: no source fragments`);
    if (sourceIds.some((id) => !fragmentIds.has(id))) problems.push(`${where}: cites a fragment that is not part of the analysed extraction run`);
    if ((n.note_type ?? "No Change") !== "No Change") problems.push(`${where}: invalid note_type`);
    const description = str(n.description);
    if (!description || description.length > 2000) problems.push(`${where}: description is required (≤ 2000 characters)`);
    scopeNotes.push({
      sequence: seq, note_type: "No Change", area: str(n.area).slice(0, 300) || null, description,
      source_quote: n.source_quote == null ? null : str(n.source_quote).slice(0, 2000) || null, source_fragment_ids: sourceIds,
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, proposals, issues, scopeNotes };
}
