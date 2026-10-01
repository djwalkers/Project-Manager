// ── Acceptance Criteria generation (Phase 1E) — shared types and rules ─────
//
// Importable from client components and server routes. GENERATION ONLY:
// generated criteria live in acceptance_criterion_proposals (migration 043)
// and never touch canonical acceptance_criteria, evidence, sign-offs,
// artefact links, ProjectState, Test Status or Go-Live Readiness. They
// carry no AC reference; review and promotion come in a later phase.

import type { AnalysisErrorCategory } from "@/lib/requirement-analysis";

export type AcGenerationStatus = "Queued" | "Running" | "Completed" | "Completed with warnings" | "Failed";
export const AC_GENERATION_STAGES = ["obligations", "criteria", "coverage", "repair"] as const;
export const CRITERION_TYPES = ["Positive", "Negative", "Regression"] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];
export const AC_GENERATION_ISSUE_TYPES = [
  "Missing Testable Outcome", "Missing Preconditions", "Ambiguous Expected Result",
  "Unresolved Existing Analysis Issue", "Conflicting Source/Resolution", "Insufficient Source Support",
] as const;

export type AcGenerationInput = {
  requirement: { id: string; ref: string | null; title: string; description: string | null; category: string | null; priority: string | null; status: string | null };
  proposal: { id: string; sequence: number; origin: string; title: string; description: string; original_title: string; original_description: string; edited: boolean; source_quote: string | null; source_quotes?: string[] };
  document: { id: string; name: string; type: string | null } | null;
  version: { id: string; version_number: number; original_filename: string } | null;
  extraction_job: { id: string; extractor_version: string | null } | null;
  fragment_ids: string[];
  clarifications: { id: string; sequence: number; issue_type: string; question: string | null; description: string; status: string; resolution_note: string; reviewed_by_name: string | null; reviewed_at: string | null }[];
  open_questions: { id: string; sequence: number; issue_type: string; question: string | null; description: string; status: string }[];
  scope_notes: { id: string; sequence: number; note_type: string; area: string; description: string; source_quote: string | null; acknowledgement_note: string | null; acknowledged_by_name: string | null }[];
};

export type AcGenerationRun = {
  id: string; project_id: string; requirement_id: string; requirement_proposal_id: string; analysis_run_id: string; extraction_job_id: string;
  status: AcGenerationStatus; trigger: "manual" | "retry"; retry_of_run_id: string | null; requested_by_name: string | null;
  queued_at: string; started_at: string | null; completed_at: string | null; attempt_count: number;
  worker_name: string | null; worker_version: string | null; model: string; model_digest: string | null;
  prompt_version: string | null; prompt_sha256: string | null; schema_version: string | null;
  input_snapshot: AcGenerationInput; input_sha256: string;
  proposal_count: number | null; issue_count: number | null; needs_review_count: number | null; warnings_count: number | null;
  diagnostics: Record<string, unknown> | null; error_category: AnalysisErrorCategory | null; error_message: string | null;
};

export type AcceptanceCriterionProposal = {
  id: string; generation_run_id: string; requirement_id: string; sequence: number;
  criterion: string; given_text: string | null; when_text: string | null; then_text: string | null;
  criterion_type: CriterionType; basis: "Explicit" | "Inferred"; confidence: "High" | "Medium" | "Low";
  review_status: "Proposed" | "Needs Review" | "Approved" | "Rejected" | "Promoted" | "Superseded";
  needs_review_reasons: string[]; source_fragment_ids: string[]; scope_note_ids: string[]; clarification_issue_ids: string[]; open_issue_ids: string[];
  source_quote: string | null; rationale: string; obligations: { key: string; statement: string; kind: string }[];
  consolidation: { merged?: boolean; member_count?: number; members?: { criterion: string }[] };
};

export type AcGenerationIssue = {
  id: string; generation_run_id: string; sequence: number; issue_type: (typeof AC_GENERATION_ISSUE_TYPES)[number]; severity: "High" | "Medium" | "Low";
  description: string; obligation: string | null; suggested_question: string | null; source_fragment_ids: string[]; analysis_issue_ids: string[]; status: string;
  relation: AcIssueRelation | null;
};

/** How an open analysis question relates to the generated criteria (migration 044; null on earlier runs). */
export const AC_ISSUE_RELATIONS = ["Blocking", "Additional Coverage", "Informational"] as const;
export type AcIssueRelation = (typeof AC_ISSUE_RELATIONS)[number];

export type AcGenerationEligibility = { eligible: boolean; reason: string | null; promoted: boolean };

export const isActiveAcGeneration = (run: Pick<AcGenerationRun, "status"> | null | undefined) => run?.status === "Queued" || run?.status === "Running";
export const isCompletedAcGeneration = (run: Pick<AcGenerationRun, "status"> | null | undefined) => run?.status === "Completed" || run?.status === "Completed with warnings";

/** "X proposed Acceptance Criteria · Y items need review" (Y = criteria needing review + generation issues). */
export function acGenerationSummary(run: Pick<AcGenerationRun, "proposal_count" | "needs_review_count" | "issue_count">): string {
  const n = run.proposal_count ?? 0;
  const review = (run.needs_review_count ?? 0) + (run.issue_count ?? 0);
  return `${n} proposed Acceptance Criteri${n === 1 ? "on" : "a"} · ${review} item${review === 1 ? "" : "s"} need${review === 1 ? "s" : ""} review`;
}

// ── Server-side re-validation of worker output (mirror of the worker's Stage 5) ──

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const oneOf = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);
const idList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))] : []);

export type CriterionInput = {
  sequence: number; criterion: string; given_text: string | null; when_text: string | null; then_text: string | null;
  criterion_type: string; basis: string; confidence: string; needs_review_reasons: string[];
  source_fragment_ids: string[]; scope_note_ids: string[]; clarification_issue_ids: string[]; open_issue_ids: string[];
  source_quote: string | null; rationale: string; obligations: unknown[]; consolidation: Record<string, unknown>;
};
export type GenerationIssueInput = {
  sequence: number; issue_type: string; severity: string; description: string; obligation: string | null; suggested_question: string | null;
  source_fragment_ids: string[]; analysis_issue_ids: string[]; related_proposal_sequences: number[]; relation: string | null;
};
export type AllowedAcInput = { fragments: Set<string>; scopeNotes: Set<string>; clarifications: Set<string>; openQuestions: Set<string> };

export function validateAcGenerationSubmission(proposalsRaw: unknown, issuesRaw: unknown, allowed: AllowedAcInput):
  { ok: true; proposals: CriterionInput[]; issues: GenerationIssueInput[] } | { ok: false; problems: string[] } {
  if (!Array.isArray(proposalsRaw) || !Array.isArray(issuesRaw)) return { ok: false, problems: ["proposals and issues must be arrays"] };
  if (proposalsRaw.length > 100 || issuesRaw.length > 100) return { ok: false, problems: ["too many criteria or issues"] };
  const problems: string[] = [];
  const within = (ids: string[], set: Set<string>) => ids.every((id) => set.has(id));
  const optional = (v: unknown, max: number) => (str(v) ? str(v).slice(0, max) : null);
  const proposals: CriterionInput[] = [];
  const seen = new Set<number>();
  proposalsRaw.forEach((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const where = `criterion ${i + 1}`;
    const seq = Number(p.sequence);
    if (!Number.isInteger(seq) || seq < 1 || seen.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    seen.add(seq);
    if ("review_status" in p || "ac_ref" in p) problems.push(`${where}: review status and AC references are not set by generation`);
    const criterion = str(p.criterion), rationale = str(p.rationale);
    if (!criterion || criterion.length > 2000) problems.push(`${where}: criterion is required (≤ 2000 characters)`);
    if (!rationale || rationale.length > 2000) problems.push(`${where}: rationale is required (≤ 2000 characters)`);
    if (!oneOf(CRITERION_TYPES, p.criterion_type)) problems.push(`${where}: criterion_type must be Positive, Negative or Regression`);
    if (!oneOf(["Explicit", "Inferred"], p.basis)) problems.push(`${where}: basis must be Explicit or Inferred`);
    if (!oneOf(["High", "Medium", "Low"], p.confidence)) problems.push(`${where}: confidence must be High, Medium or Low`);
    const fragments = idList(p.source_fragment_ids), notes = idList(p.scope_note_ids), clarifications = idList(p.clarification_issue_ids), open = idList(p.open_issue_ids);
    if (!within(fragments, allowed.fragments)) problems.push(`${where}: cites a source fragment outside the Requirement's provenance`);
    if (!within(notes, allowed.scopeNotes)) problems.push(`${where}: cites a scope note that was not supplied`);
    if (!within(clarifications, allowed.clarifications)) problems.push(`${where}: cites a clarification that was not supplied`);
    if (!within(open, allowed.openQuestions)) problems.push(`${where}: cites an open question that was not supplied`);
    if (fragments.length + notes.length + clarifications.length === 0) problems.push(`${where}: no provenance (a source fragment, scope note or clarification is required)`);
    const consolidation = p.consolidation && typeof p.consolidation === "object" && !Array.isArray(p.consolidation) ? p.consolidation as Record<string, unknown> : {};
    const obligations = Array.isArray(p.obligations) ? p.obligations.slice(0, 20) : [];
    if (JSON.stringify(consolidation).length > 20_000 || JSON.stringify(obligations).length > 20_000) problems.push(`${where}: consolidation or obligation evidence is too large`);
    proposals.push({
      sequence: seq, criterion, given_text: optional(p.given_text, 1000), when_text: optional(p.when_text, 1000), then_text: optional(p.then_text, 1000),
      criterion_type: p.criterion_type as string, basis: p.basis as string, confidence: p.confidence as string,
      needs_review_reasons: (Array.isArray(p.needs_review_reasons) ? p.needs_review_reasons : []).map((r) => str(r).slice(0, 500)).filter(Boolean).slice(0, 10),
      source_fragment_ids: fragments, scope_note_ids: notes, clarification_issue_ids: clarifications, open_issue_ids: open,
      source_quote: optional(p.source_quote, 2000), rationale, obligations, consolidation,
    });
  });
  const issues: GenerationIssueInput[] = [];
  const issueSeen = new Set<number>();
  const analysisIssues = new Set([...allowed.openQuestions, ...allowed.clarifications]);
  issuesRaw.forEach((raw, i) => {
    const x = (raw ?? {}) as Record<string, unknown>;
    const where = `issue ${i + 1}`;
    const seq = Number(x.sequence);
    if (!Number.isInteger(seq) || seq < 1 || issueSeen.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    issueSeen.add(seq);
    if (!oneOf(AC_GENERATION_ISSUE_TYPES, x.issue_type)) problems.push(`${where}: invalid issue_type`);
    if (!oneOf(["High", "Medium", "Low"], x.severity)) problems.push(`${where}: invalid severity`);
    if (x.relation != null && !oneOf(AC_ISSUE_RELATIONS, x.relation)) problems.push(`${where}: relation must be Blocking, Additional Coverage or Informational`);
    const description = str(x.description);
    if (!description || description.length > 2000) problems.push(`${where}: description is required (≤ 2000 characters)`);
    const fragments = idList(x.source_fragment_ids), linked = idList(x.analysis_issue_ids);
    if (!within(fragments, allowed.fragments)) problems.push(`${where}: cites a source fragment outside the Requirement's provenance`);
    if (!within(linked, analysisIssues)) problems.push(`${where}: cites an analysis issue that was not supplied`);
    issues.push({
      sequence: seq, issue_type: x.issue_type as string, severity: x.severity as string, description,
      obligation: optional(x.obligation, 1000), suggested_question: optional(x.suggested_question, 1000),
      source_fragment_ids: fragments, analysis_issue_ids: linked, related_proposal_sequences: [], relation: (x.relation as string | null | undefined) ?? null,
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, proposals, issues };
}
