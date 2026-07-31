export const OPEN_DECISION_STATUSES = [
  "Proposed",
  "Under Review",
  "Pending",
  "Open",
] as const;

export const CLOSED_DECISION_STATUSES = [
  "Complete",
  "Approved",
  "Rejected",
  "Superseded",
  "Closed",
  "Resolved",
] as const;

const OPEN_STATUS_LOOKUP = new Set(OPEN_DECISION_STATUSES.map(normaliseDecisionStatus));
const CLOSED_STATUS_LOOKUP = new Set(CLOSED_DECISION_STATUSES.map(normaliseDecisionStatus));

function normaliseDecisionStatus(status: string | null | undefined): string {
  return String(status ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function isDecisionClosed(status: string | null | undefined): boolean {
  return CLOSED_STATUS_LOOKUP.has(normaliseDecisionStatus(status));
}

export function isDecisionOpen(status: string | null | undefined): boolean {
  const normalised = normaliseDecisionStatus(status);
  if (CLOSED_STATUS_LOOKUP.has(normalised)) return false;
  if (OPEN_STATUS_LOOKUP.has(normalised)) return true;

  // Unknown legacy/custom values stay open by default so governance gaps are not
  // accidentally hidden. Add future closed statuses above when they are agreed.
  return true;
}

export function isDecisionOverdue(
  dueDate: string | null | undefined,
  status: string | null | undefined,
  now = new Date(),
): boolean {
  if (!dueDate || !isDecisionOpen(status)) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00`);
  return !Number.isNaN(due.getTime()) && due < today;
}
