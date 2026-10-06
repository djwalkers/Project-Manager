// ── Acceptance Criteria review and promotion (Phase 1F) — shared rules ─────
//
// Importable from client components and server routes. The database is the
// authority (migration 046 triggers and functions); these helpers mirror it
// so the UI offers only actions valid for the current state and explains
// what stands between a proposal and approval.
//
//   Proposed     → Approve | Needs Review | Reject | Edit | Split | Merge
//   Needs Review → Approve (when its reasons are resolved) | Reject | Edit | Split | Merge
//   Approved     → Promote | Needs Review | Reject | Edit (→ Needs Review) | Split | Merge
//   Rejected     → Reopen (→ Needs Review)
//   Promoted, Superseded → view only

import type { AcceptanceCriterionProposal, AcGenerationIssue, CriterionType } from "@/lib/ac-generation";

export const AC_REJECTION_REASONS = ["Duplicate", "Incorrect interpretation", "Too granular", "Covered by another AC", "Out of scope", "Not testable", "Other"] as const;
export type AcRejectionReason = (typeof AC_REJECTION_REASONS)[number];
export const AC_ISSUE_REVIEW_STATUSES = ["Open", "Resolved", "Accepted", "Not Applicable"] as const;
export type AcProposalAction = "edit" | "approve" | "needs_review" | "reject" | "reopen" | "split" | "merge" | "promote" | "clarify";

/** Canonical status of every promoted AC (never chosen by AI). */
export const PROMOTED_AC_STATUS = "Not Started";

export type ReviewedAcProposal = AcceptanceCriterionProposal & {
  origin: "ai" | "split" | "merge" | "manual";
  parent_proposal_ids: string[];
  human_authored: boolean;
  reviewed_criterion: string | null;
  reviewed_description: string | null;
  reviewed_criterion_type: CriterionType | null;
  reviewed_given_text: string | null;
  reviewed_when_text: string | null;
  reviewed_then_text: string | null;
  review_note: string | null;
  rejection_reason: AcRejectionReason | null;
  review_confirmed_at: string | null;
  review_confirmed_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  promoted_ac_id: string | null;
  promoted_ac_ref: string | null;
  promoted_at: string | null;
  promoted_by_name: string | null;
};

export type ReviewedAcIssue = AcGenerationIssue & { resolution_note: string | null; reviewed_by_name: string | null; reviewed_at: string | null };

export type AcClarification = {
  id: string; proposal_id: string; generation_run_id: string; analysis_issue_id: string | null; generation_issue_id: string | null;
  clarification: string; reason: string | null; created_by_name: string; created_at: string; updated_by_name: string | null; updated_at: string;
};

export type ScopeNoteAssociation = { id: string; scope_note_id: string; requirement_id: string; note: string | null; associated_by_name: string; associated_at: string };

/** The version a reviewer sees and promotion uses: reviewed_* when set, otherwise the AI's values. */
export function effectiveAc(p: Pick<ReviewedAcProposal, "criterion" | "criterion_type" | "given_text" | "when_text" | "then_text" | "reviewed_criterion" | "reviewed_description" | "reviewed_criterion_type" | "reviewed_given_text" | "reviewed_when_text" | "reviewed_then_text">) {
  return {
    criterion: p.reviewed_criterion ?? p.criterion,
    description: p.reviewed_description ?? null,
    criterion_type: p.reviewed_criterion_type ?? p.criterion_type,
    given_text: p.reviewed_given_text ?? p.given_text,
    when_text: p.reviewed_when_text ?? p.when_text,
    then_text: p.reviewed_then_text ?? p.then_text,
  };
}

export function isEditedAc(p: Pick<ReviewedAcProposal, "reviewed_criterion" | "reviewed_criterion_type" | "reviewed_given_text" | "reviewed_when_text" | "reviewed_then_text">): boolean {
  return [p.reviewed_criterion, p.reviewed_criterion_type, p.reviewed_given_text, p.reviewed_when_text, p.reviewed_then_text].some((v) => v != null);
}

export function allowedAcActions(p: Pick<ReviewedAcProposal, "review_status">): AcProposalAction[] {
  switch (p.review_status) {
    case "Proposed": return ["approve", "needs_review", "reject", "edit", "split", "merge", "clarify"];
    case "Needs Review": return ["approve", "reject", "edit", "split", "merge", "clarify"];
    case "Approved": return ["promote", "needs_review", "reject", "edit", "split", "merge", "clarify"];
    case "Rejected": return ["reopen"];
    default: return [];
  }
}

/**
 * How a Needs Review reason is satisfied (mirrors ac_approval_blockers).
 * blocking: resolve the source question · condition: restore the named
 * term · clarify: record a Human Clarification · correct: edit or clarify ·
 * confirm: explicit reviewer confirmation.
 */
export type ReasonKind = "blocking" | "condition" | "clarify" | "correct" | "confirm";
export function reasonKind(reason: string): ReasonKind {
  if (/^(Blocked by|Depends on) an open question/i.test(reason)) return "blocking";
  if (/^Omits /i.test(reason)) return "condition";
  if (/^(Expected result is source-grounded|Vague wording)/i.test(reason)) return "clarify";
  if (/^Expected result introduces an unsupported interpretation/i.test(reason)) return "correct";
  return "confirm";
}
export const REASON_GUIDANCE: Record<ReasonKind, string> = {
  blocking: "Resolve the blocking question (or set it Not Applicable) in Generation Issues before approving.",
  condition: "Restore the named condition in the wording before approving.",
  clarify: "Record a Human Clarification that defines the expected result, then approve.",
  correct: "Correct the unsupported wording, or record a Human Clarification that supports it, then approve.",
  confirm: "Review against the source and confirm when approving.",
};

/** Application-spanning wording (several capitalised application names joined by "and"/","): suggest a split. */
export function suggestsSplit(criterion: string): boolean {
  const names = String(criterion).match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g) ?? [];
  return new Set(names).size >= 3 && /,|\band\b|\bor\b/.test(criterion);
}

/** Bulk approval only ever applies to Proposed proposals (Needs Review needs individual attention). */
export const bulkApprovable = (p: Pick<ReviewedAcProposal, "review_status">) => p.review_status === "Proposed";
export const bulkRejectable = (p: Pick<ReviewedAcProposal, "review_status">) => ["Proposed", "Needs Review", "Approved"].includes(p.review_status);

/** Blocking generation issues gate approval; Additional Coverage / Informational do not. */
export const issueBlocksApproval = (i: Pick<ReviewedAcIssue, "relation" | "status">) => i.relation === "Blocking" && !["Resolved", "Not Applicable"].includes(i.status);
