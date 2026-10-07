// ── Test Case generation (Phase 1G) — shared types and server re-validation ──
//
// Importable from client components and server routes. Generated test cases
// are non-authoritative proposals for later human review: they carry no
// test_ref and never touch canonical test_cases or artefact_links.

import type { AnalysisErrorCategory } from "@/lib/requirement-analysis";

export type TestGenerationStatus = "Queued" | "Running" | "Completed" | "Completed with warnings" | "Failed";
export const TEST_GENERATION_STAGES = ["behaviours", "tests", "coverage"] as const;
export const TEST_TYPES = ["Positive", "Negative", "Regression"] as const;
export type TestType = (typeof TEST_TYPES)[number];
export const TEST_GENERATION_ISSUE_TYPES = [
  "Uncovered Acceptance Criterion", "Uncovered Behaviour", "Missing Test Detail", "Additional Coverage Question",
  "Unresolved Question", "Insufficient Source Support", "Ambiguous Expected Result", "Conflicting Context",
] as const;

export type TestGenerationAc = {
  id: string; ref: string; criterion: string; description: string | null; status: string | null;
  criterion_type: string | null; given_text: string | null; when_text: string | null; then_text: string | null;
  origin: "ai" | "manual"; proposal_id: string | null; source_quote: string | null;
  fragment_ids: string[]; human_clarification_ids: string[]; analysis_clarification_ids: string[]; scope_note_ids: string[]; resolved_issue_ids: string[]; open_issue_ids: string[];
};
export type TestGenerationInput = {
  requirement: { id: string; ref: string | null; title: string; description: string | null; category: string | null; priority: string | null; status: string | null; promoted: boolean; source_quote: string | null; fragment_ids: string[] };
  acceptance_criteria: TestGenerationAc[];
  fragment_ids: string[];
  human_clarifications: { id: string; proposal_id: string; clarification: string; reason: string | null; created_by_name: string; created_at: string }[];
  analysis_clarifications: { id: string; question: string | null; description: string; resolution_note: string; reviewed_by_name: string | null }[];
  scope_notes: { id: string; area: string | null; description: string; source_quote: string | null; associated: boolean }[];
  resolved_questions: { id: string; description: string; question: string | null; status: string; resolution_note: string | null; reviewed_by_name: string | null }[];
  open_questions: { id: string; description: string; question: string | null; relation: string | null; status: string }[];
};

export type TestGenerationRun = {
  id: string; project_id: string; requirement_id: string; ac_ids: string[];
  status: TestGenerationStatus; trigger: "manual" | "retry"; retry_of_run_id: string | null; requested_by_name: string | null;
  queued_at: string; started_at: string | null; completed_at: string | null; attempt_count: number;
  worker_name: string | null; worker_version: string | null; model: string; model_digest: string | null;
  prompt_version: string | null; prompt_sha256: string | null; schema_version: string | null;
  input_snapshot: TestGenerationInput; input_sha256: string;
  proposal_count: number | null; issue_count: number | null; needs_review_count: number | null; warnings_count: number | null;
  diagnostics: Record<string, unknown> | null; error_category: AnalysisErrorCategory | null; error_message: string | null;
};

export type TestStep = { step: number; action: string; expected: string | null };
export type TestCaseProposal = {
  id: string; generation_run_id: string; requirement_id: string; sequence: number;
  title: string; objective: string; preconditions: string[]; steps: TestStep[]; expected_result: string;
  test_type: TestType; variation: string | null; basis: "Explicit" | "Inferred"; confidence: "High" | "Medium" | "Low";
  review_status: "Proposed" | "Needs Review" | "Approved" | "Rejected" | "Promoted" | "Superseded";
  needs_review_reasons: string[]; source_ac_ids: string[]; source_fragment_ids: string[]; human_clarification_ids: string[];
  analysis_clarification_ids: string[]; scope_note_ids: string[]; resolved_issue_ids: string[]; rationale: string;
  behaviours: { key: string; statement: string; kind: string; variation: string | null }[];
  consolidation: { merged?: boolean; member_count?: number; members?: { title: string; expected_result: string }[] };
};
export type TestGenerationIssue = {
  id: string; generation_run_id: string; sequence: number; issue_type: (typeof TEST_GENERATION_ISSUE_TYPES)[number]; severity: "High" | "Medium" | "Low";
  description: string; behaviour: string | null; suggested_question: string | null; ac_ids: string[]; source_fragment_ids: string[]; source_issue_ids: string[]; status: string;
  /** Migration 049 review fields. */
  resolution_note?: string | null; reviewed_by_name?: string | null; reviewed_at?: string | null;
};

export type TestGenerationEligibility = { eligible: boolean; reason: string | null };

export const isActiveTestGeneration = (run: Pick<TestGenerationRun, "status"> | null | undefined) => run?.status === "Queued" || run?.status === "Running";
export const isCompletedTestGeneration = (run: Pick<TestGenerationRun, "status"> | null | undefined) => run?.status === "Completed" || run?.status === "Completed with warnings";

/** "X proposed test cases · Y items need review" (Y = tests needing review + test-design issues). */
export function testGenerationSummary(run: Pick<TestGenerationRun, "proposal_count" | "needs_review_count" | "issue_count">): string {
  const n = run.proposal_count ?? 0;
  const review = (run.needs_review_count ?? 0) + (run.issue_count ?? 0);
  return `${n} proposed test case${n === 1 ? "" : "s"} · ${review} item${review === 1 ? "" : "s"} need${review === 1 ? "s" : ""} review`;
}

/** How a proposed test will map onto the canonical test_cases model when promoted later (no promotion yet). */
export function canonicalScenarioPreview(p: Pick<TestCaseProposal, "title" | "objective" | "preconditions" | "steps">): string {
  return [p.title, p.objective, p.preconditions.length ? `Preconditions: ${p.preconditions.join("; ")}` : null,
    ...p.steps.map((s) => `${s.step}. ${s.action}${s.expected ? ` → ${s.expected}` : ""}`)].filter(Boolean).join("\n");
}

// ── Server-side re-validation of worker output (mirror of the worker's Stage 5) ──

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const oneOf = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);
const idList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))] : []);
const optional = (v: unknown, max: number) => (str(v) ? str(v).slice(0, max) : null);

export type TestProposalInput = Omit<TestCaseProposal, "id" | "generation_run_id" | "requirement_id" | "review_status">;
export type TestIssueInput = Omit<TestGenerationIssue, "id" | "generation_run_id" | "status">;
export type AllowedTestInput = { acs: Set<string>; fragments: Set<string>; human: Set<string>; clarifications: Set<string>; resolved: Set<string>; scopeNotes: Set<string>; openQuestions: Set<string> };

export function validateTestGenerationSubmission(proposalsRaw: unknown, issuesRaw: unknown, allowed: AllowedTestInput):
  { ok: true; proposals: TestProposalInput[]; issues: TestIssueInput[] } | { ok: false; problems: string[] } {
  if (!Array.isArray(proposalsRaw) || !Array.isArray(issuesRaw)) return { ok: false, problems: ["proposals and issues must be arrays"] };
  if (proposalsRaw.length > 100 || issuesRaw.length > 100) return { ok: false, problems: ["too many tests or issues"] };
  const problems: string[] = [];
  const within = (ids: string[], set: Set<string>) => ids.every((id) => set.has(id));
  const proposals: TestProposalInput[] = [];
  const seen = new Set<number>();
  proposalsRaw.forEach((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const where = `test ${i + 1}`;
    const seq = Number(p.sequence);
    if (!Number.isInteger(seq) || seq < 1 || seen.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    seen.add(seq);
    if ("review_status" in p || "test_ref" in p) problems.push(`${where}: review status and test references are not set by generation`);
    const title = str(p.title), objective = str(p.objective), expected = str(p.expected_result), rationale = str(p.rationale);
    if (!title || title.length > 300) problems.push(`${where}: title is required (≤ 300 characters)`);
    if (!objective || objective.length > 2000) problems.push(`${where}: objective is required (≤ 2000 characters)`);
    if (!expected || expected.length > 2000) problems.push(`${where}: expected result is required (≤ 2000 characters)`);
    if (!rationale || rationale.length > 2000) problems.push(`${where}: rationale is required (≤ 2000 characters)`);
    const stepsRaw = Array.isArray(p.steps) ? p.steps : [];
    const steps: TestStep[] = stepsRaw.map((s, n) => { const x = (s ?? {}) as Record<string, unknown>; return { step: n + 1, action: str(x.action).slice(0, 1000), expected: optional(x.expected, 1000) }; });
    if (steps.length < 1 || steps.length > 30 || steps.some((s) => !s.action)) problems.push(`${where}: 1–30 steps, each with an action`);
    if (!oneOf(TEST_TYPES, p.test_type)) problems.push(`${where}: test_type must be Positive, Negative or Regression`);
    if (!oneOf(["Explicit", "Inferred"], p.basis)) problems.push(`${where}: basis must be Explicit or Inferred`);
    if (!oneOf(["High", "Medium", "Low"], p.confidence)) problems.push(`${where}: confidence must be High, Medium or Low`);
    const acs = idList(p.source_ac_ids), fragments = idList(p.source_fragment_ids), human = idList(p.human_clarification_ids), clar = idList(p.analysis_clarification_ids);
    const notes = idList(p.scope_note_ids), resolved = idList(p.resolved_issue_ids);
    if (!acs.length || !within(acs, allowed.acs)) problems.push(`${where}: must trace to at least one of the run's acceptance criteria`);
    if (!within(fragments, allowed.fragments)) problems.push(`${where}: cites a source fragment outside the run's provenance`);
    if (!within(human, allowed.human) || !within(clar, allowed.clarifications) || !within(resolved, allowed.resolved)) problems.push(`${where}: cites a clarification that was not supplied`);
    if (!within(notes, allowed.scopeNotes)) problems.push(`${where}: cites a scope note that was not supplied`);
    const preconditions = (Array.isArray(p.preconditions) ? p.preconditions : []).map((x) => str(x).slice(0, 1000)).filter(Boolean).slice(0, 20);
    const behaviours = Array.isArray(p.behaviours) ? p.behaviours.slice(0, 20) : [];
    const consolidation = p.consolidation && typeof p.consolidation === "object" && !Array.isArray(p.consolidation) ? p.consolidation as TestCaseProposal["consolidation"] : {};
    if (JSON.stringify(consolidation).length > 20_000 || JSON.stringify(behaviours).length > 20_000) problems.push(`${where}: consolidation or behaviour evidence is too large`);
    proposals.push({
      sequence: seq, title, objective, preconditions, steps, expected_result: expected, test_type: p.test_type as TestType, variation: optional(p.variation, 300),
      basis: p.basis as "Explicit" | "Inferred", confidence: p.confidence as "High" | "Medium" | "Low",
      needs_review_reasons: (Array.isArray(p.needs_review_reasons) ? p.needs_review_reasons : []).map((r) => str(r).slice(0, 500)).filter(Boolean).slice(0, 12),
      source_ac_ids: acs, source_fragment_ids: fragments, human_clarification_ids: human, analysis_clarification_ids: clar, scope_note_ids: notes, resolved_issue_ids: resolved,
      rationale, behaviours: behaviours as TestCaseProposal["behaviours"], consolidation,
    });
  });
  const issues: TestIssueInput[] = [];
  const issueSeen = new Set<number>();
  const questions = new Set([...allowed.openQuestions, ...allowed.resolved]);
  issuesRaw.forEach((raw, i) => {
    const x = (raw ?? {}) as Record<string, unknown>;
    const where = `issue ${i + 1}`;
    const seq = Number(x.sequence);
    if (!Number.isInteger(seq) || seq < 1 || issueSeen.has(seq)) problems.push(`${where}: duplicate or invalid sequence`);
    issueSeen.add(seq);
    if (!oneOf(TEST_GENERATION_ISSUE_TYPES, x.issue_type)) problems.push(`${where}: invalid issue_type`);
    if (!oneOf(["High", "Medium", "Low"], x.severity)) problems.push(`${where}: invalid severity`);
    const description = str(x.description);
    if (!description || description.length > 2000) problems.push(`${where}: description is required (≤ 2000 characters)`);
    const acs = idList(x.ac_ids), fragments = idList(x.source_fragment_ids), linked = idList(x.source_issue_ids);
    if (!within(acs, allowed.acs)) problems.push(`${where}: cites an acceptance criterion outside the run`);
    if (!within(fragments, allowed.fragments)) problems.push(`${where}: cites a source fragment outside the run's provenance`);
    if (!within(linked, questions)) problems.push(`${where}: cites a question that was not supplied`);
    issues.push({
      sequence: seq, issue_type: x.issue_type as TestGenerationIssue["issue_type"], severity: x.severity as TestGenerationIssue["severity"], description,
      behaviour: optional(x.behaviour, 1000), suggested_question: optional(x.suggested_question, 1000), ac_ids: acs, source_fragment_ids: fragments, source_issue_ids: linked,
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, proposals, issues };
}
