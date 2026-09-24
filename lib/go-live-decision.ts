import type { GoLiveDecision } from "@/lib/types";

// ── Current deployment status (Go / No-Go) ──────────────────────────────────
//
// Two different things, deliberately kept apart:
//   - the RECORDED decision: what an authorised user decided, stored as an
//     append-only history in go_live_decisions (migration 028). Never
//     inferred from readiness, tests, ProjectState, RAG or AI.
//   - the CURRENT deployment status: derived here, at read time, from the
//     latest recorded decision plus the live readiness position. It is
//     never written back, so a recorded GO survives a later hard stop.
//
// Precedence (deterministic):
//   1. a current hard stop                 → NO GO
//   2. latest recorded decision is NO_GO   → NO GO
//   3. no recorded decision                → NO DECISION (never NO GO)
//   4. GO + Customer Approval outstanding  → GO – PENDING CUSTOMER APPROVAL
//   5. GO + other readiness outstanding    → GO – PENDING READINESS ITEMS
//   6. GO + everything satisfactory        → GO
// An outstanding (Incomplete / unanswered) item is never a hard stop.

export type DeploymentState = "NO_DECISION" | "GO_PENDING_CUSTOMER_APPROVAL" | "GO_PENDING_READINESS_ITEMS" | "GO" | "NO_GO";
export type DeploymentTone = "neutral" | "amber" | "green" | "red";

export const DEPLOYMENT_STATE_LABEL: Record<DeploymentState, string> = {
  NO_DECISION: "No Decision",
  GO_PENDING_CUSTOMER_APPROVAL: "GO – Pending Customer Approval",
  GO_PENDING_READINESS_ITEMS: "GO – Pending Readiness Items",
  GO: "GO",
  NO_GO: "NO GO",
};

export const DEPLOYMENT_STATE_TONE: Record<DeploymentState, DeploymentTone> = {
  NO_DECISION: "neutral",
  GO_PENDING_CUSTOMER_APPROVAL: "amber",
  GO_PENDING_READINESS_ITEMS: "amber",
  GO: "green",
  NO_GO: "red",
};

export const CUSTOMER_APPROVAL_KEY = "customer_approval";

export type DecisionCheck = {
  key: string;
  label: string;
  source: "Auto" | "Manual";
  derived: string;
  effective: string;
};

export type CustomerApprovalPosition = "Not Applicable" | "Outstanding" | "Complete" | "Waived" | "Rejected";

export type DeploymentStatus = {
  state: DeploymentState;
  label: string;
  tone: DeploymentTone;
  /** Why the state is what it is (hard stops for NO GO, the recorded NO GO, …). */
  reasons: string[];
  /** Genuine hard stops only: rejected controls, blocked checklist items, open Critical risks. */
  blockingItems: string[];
  /** Prominent but non-blocking: open High risks. Never an automatic NO GO. */
  warnings: string[];
  /** Applicable checks still to be done — outstanding, not rejected. */
  outstandingItems: string[];
  customerApproval: CustomerApprovalPosition;
  /** Outstanding readiness items other than Customer Approval. */
  otherOutstandingCount: number;
  summary: string;
};

/** Latest recorded decision: newest decided_at, then created_at, then id (deterministic). */
export function latestGoLiveDecision(decisions: GoLiveDecision[]): GoLiveDecision | null {
  return sortDecisionHistory(decisions)[0] ?? null;
}

/** Full history, newest first. */
export function sortDecisionHistory(decisions: GoLiveDecision[]): GoLiveDecision[] {
  return [...decisions].sort((a, b) =>
    b.decided_at.localeCompare(a.decided_at) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

/** Not applicable = phase-gated (derived Not Yet Required) or explicitly assessed Not Yet Required. */
export function isCheckApplicable(check: Pick<DecisionCheck, "derived" | "effective">): boolean {
  return check.derived !== "Not Yet Required" && check.effective !== "Not Yet Required";
}

/**
 * Outstanding = applicable and not yet satisfied, without being rejected.
 * An Auto check that is "Not Yet Assessed" has no evidence to grade yet and
 * is excluded (same as the readiness denominator); a Manual check left or
 * set "Not Yet Assessed" is a control nobody has answered — outstanding.
 */
export function isCheckOutstanding(check: DecisionCheck): boolean {
  if (!isCheckApplicable(check)) return false;
  if (check.effective === "Incomplete") return true;
  return check.source === "Manual" && check.effective === "Not Yet Assessed";
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function deriveDeploymentStatus(input: {
  checks: DecisionCheck[];
  /** Labels of checks whose (unassessed) checklist item is Blocked — an existing hard stop. */
  blockedChecklistLabels: string[];
  /** Open risks with Critical impact only — High risks are NOT a hard stop. */
  openCriticalRisks: number;
  /** Refs of open High-impact risks, surfaced as warnings. */
  openHighRisks?: string[];
  latestDecision: GoLiveDecision | null;
}): DeploymentStatus {
  const { checks, blockedChecklistLabels, openCriticalRisks, latestDecision } = input;
  const openHighRisks = input.openHighRisks ?? [];
  const warnings = openHighRisks.length ? [`${plural(openHighRisks.length, "open High risk", "open High risks")}: ${openHighRisks.join(", ")}`] : [];

  const rejected = checks.filter((c) => c.source === "Manual" && isCheckApplicable(c) && c.effective === "Rejected");
  const blockingItems = [
    ...rejected.map((c) => `${c.label} rejected`),
    ...blockedChecklistLabels.map((l) => `${l} blocked`),
    ...(openCriticalRisks > 0 ? [plural(openCriticalRisks, "open Critical risk", "open Critical risks")] : []),
  ];

  const outstanding = checks.filter(isCheckOutstanding);
  const outstandingItems = outstanding.map((c) => c.label);
  const customer = checks.find((c) => c.key === CUSTOMER_APPROVAL_KEY);
  const customerApproval: CustomerApprovalPosition = !customer || !isCheckApplicable(customer)
    ? "Not Applicable"
    : customer.effective === "Rejected" ? "Rejected"
      : customer.effective === "Complete" ? "Complete"
        : customer.effective === "Waived" ? "Waived"
          : "Outstanding";
  const customerOutstanding = customerApproval === "Outstanding";
  const otherOutstandingCount = outstanding.filter((c) => c.key !== CUSTOMER_APPROVAL_KEY).length;
  const providerEvidence = checks.some((c) => c.source === "Auto" && c.effective !== "Not Yet Assessed" && c.effective !== "Not Yet Required");

  const build = (state: DeploymentState, reasons: string[], summary: string): DeploymentStatus => ({
    state, label: DEPLOYMENT_STATE_LABEL[state], tone: DEPLOYMENT_STATE_TONE[state],
    reasons, blockingItems, warnings, outstandingItems, customerApproval, otherOutstandingCount, summary,
  });

  const outstandingSummary = [
    customerOutstanding ? "Customer approval" : "",
    otherOutstandingCount > 0 ? plural(otherOutstandingCount, "pre-deployment readiness item", "pre-deployment readiness items") : "",
  ].filter(Boolean).join(" + ");

  // 1–2. NO GO: hard stops first, then an explicit recorded NO GO.
  if (blockingItems.length > 0) {
    const reasons = [...blockingItems];
    if (latestDecision?.decision === "NO_GO") reasons.push("Recorded decision: NO GO");
    return build("NO_GO", reasons, `Deployment cannot proceed: ${blockingItems.join(", ")}`);
  }
  if (latestDecision?.decision === "NO_GO") {
    return build("NO_GO", ["Recorded decision: NO GO"], "The recorded Go/No-Go decision is NO GO");
  }

  // 3. No decision recorded yet — outstanding work is shown, but not as NO GO.
  if (!latestDecision) {
    return build("NO_DECISION", ["No Go/No-Go decision recorded"], outstandingSummary ? `${outstandingSummary} outstanding` : "No Go/No-Go decision recorded");
  }

  // 4–6. Recorded GO.
  if (customerOutstanding) {
    return build("GO_PENDING_CUSTOMER_APPROVAL", ["Recorded decision: GO", "Customer approval outstanding"], `${outstandingSummary} outstanding`);
  }
  if (otherOutstandingCount > 0 || !providerEvidence) {
    return build("GO_PENDING_READINESS_ITEMS", ["Recorded decision: GO"],
      !providerEvidence ? "No provider readiness evidence recorded yet" : `${outstandingSummary} outstanding`);
  }
  return build("GO", ["Recorded decision: GO"], "All applicable readiness controls satisfactory");
}

// ── Request validation (shared by the API route and its tests) ─────────────

export const GO_LIVE_DECISION_VALUES = ["GO", "NO_GO"] as const;
export const GO_LIVE_DECISION_REASON_MAX = 2000;

export function validateDecisionBody(body: Record<string, unknown>): string | null {
  if (typeof body.project_id !== "string" || !body.project_id.trim()) return "project_id is required";
  if (typeof body.decision !== "string" || !(GO_LIVE_DECISION_VALUES as readonly string[]).includes(body.decision)) return `decision must be one of: ${GO_LIVE_DECISION_VALUES.join(", ")}`;
  if (typeof body.reason !== "string" || !body.reason.trim()) return "A reason / rationale is required";
  if (body.reason.trim().length > GO_LIVE_DECISION_REASON_MAX) return `reason must be ${GO_LIVE_DECISION_REASON_MAX} characters or fewer`;
  return null;
}
