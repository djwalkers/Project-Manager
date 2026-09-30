// ── Requirement review and promotion (Phase 1D) — shared rules ─────────────
//
// Importable from client components and server routes. The database is the
// authority (migration 040 triggers and functions); these helpers mirror it
// so the UI offers only actions valid for the current state.
//
//   Proposed     → Approve | Needs Review | Reject | Edit | Split | Merge
//   Needs Review → Approve | Reject | Edit | Split | Merge
//   Approved     → Promote | Needs Review | Reject | Edit (→ Needs Review) | Split | Merge
//   Rejected     → Reopen (→ Needs Review)
//   Promoted, Superseded → view only

import type { AnalysisIssue, RequirementProposal } from "@/lib/requirement-analysis";

export const REJECTION_REASONS = ["Duplicate", "Out of scope", "Incorrect interpretation", "Too granular", "Covered elsewhere", "Other"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type ProposalAction = "edit" | "approve" | "needs_review" | "reject" | "reopen" | "split" | "merge" | "promote";
export type IssueTarget = "discovery_questions" | "actions" | "risks" | "decisions";
export const ISSUE_TARGETS: { value: IssueTarget; label: string }[] = [
  { value: "discovery_questions", label: "Discovery Question" },
  { value: "actions", label: "Action" },
  { value: "risks", label: "Risk" },
  { value: "decisions", label: "Decision" },
];

/** Non-final canonical status given to a promoted Requirement (not signed off; see lib/lifecycle/requirement.ts). */
export const PROMOTED_REQUIREMENT_STATUS = "Discovery";

export type ReviewedProposal = RequirementProposal & {
  origin: "ai" | "split" | "merge";
  parent_proposal_ids: string[];
  reviewed_title: string | null;
  reviewed_description: string | null;
  reviewed_category: RequirementProposal["proposed_category"];
  reviewed_priority: RequirementProposal["proposed_priority"];
  review_note: string | null;
  rejection_reason: RejectionReason | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  inferred_acknowledged_by_name: string | null;
  inferred_acknowledged_at: string | null;
  promoted_record_id: string | null;
  promoted_ref: string | null;
  promoted_at: string | null;
  promoted_by_name: string | null;
};

export type ReviewedIssue = AnalysisIssue & {
  resolution_note: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  promoted_target_type: IssueTarget | null;
  promoted_record_id: string | null;
  promoted_ref: string | null;
};

/** The version a reviewer sees and promotion uses: reviewed_* when set, otherwise the AI's proposed_*. */
export function effectiveProposal(p: Pick<ReviewedProposal, "proposed_title" | "proposed_description" | "proposed_category" | "proposed_priority" | "reviewed_title" | "reviewed_description" | "reviewed_category" | "reviewed_priority">) {
  return {
    title: p.reviewed_title ?? p.proposed_title,
    description: p.reviewed_description ?? p.proposed_description,
    category: p.reviewed_category ?? p.proposed_category,
    priority: p.reviewed_priority ?? p.proposed_priority,
  };
}

/** True when a reviewer changed anything the AI proposed. */
export function isEdited(p: Pick<ReviewedProposal, "reviewed_title" | "reviewed_description" | "reviewed_category" | "reviewed_priority">): boolean {
  return p.reviewed_title != null || p.reviewed_description != null || p.reviewed_category != null || p.reviewed_priority != null;
}

/** Actions valid for a proposal in its current state. */
export function allowedProposalActions(p: Pick<ReviewedProposal, "review_status">): ProposalAction[] {
  switch (p.review_status) {
    case "Proposed": return ["edit", "approve", "needs_review", "reject", "split", "merge"];
    case "Needs Review": return ["edit", "approve", "reject", "split", "merge"];
    case "Approved": return ["promote", "edit", "needs_review", "reject", "split", "merge"];
    case "Rejected": return ["reopen"];
    default: return [];
  }
}

/** Why a proposal cannot be promoted yet (null when it can). Mirrors promote_requirement_proposal. */
export function promotionBlocker(p: ReviewedProposal): string | null {
  if (p.review_status === "Promoted") return "Already promoted";
  if (p.review_status !== "Approved") return "Approve the proposal first";
  if (p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at) return "Acknowledge the inferred interpretation first";
  const e = effectiveProposal(p);
  if (!e.category || !e.priority) return "Set the category and priority first — they are not chosen automatically";
  return null;
}

/** A human-readable provenance note written on the canonical Requirement at promotion. */
export function provenanceNote(input: {
  proposalSequence: number; documentName: string; versionNumber: number; runId: string; model: string; promptVersion: string | null;
  sections: string[]; pages: string[];
}): string {
  return [
    `Promoted from AI analysis proposal #${input.proposalSequence} of "${input.documentName}" v${input.versionNumber} (analysis run ${input.runId.slice(0, 8)}, model ${input.model}, prompts ${input.promptVersion ?? "?"}).`,
    input.sections.length ? `Source: ${input.sections.join("; ")}${input.pages.length ? ` (${input.pages.join(", ")})` : ""}.` : null,
    "Status Discovery until confirmed.",
  ].filter(Boolean).join(" ");
}
