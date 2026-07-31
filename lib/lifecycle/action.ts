import { normaliseStatus } from "@/lib/lifecycle/shared";
import { isOverdue } from "@/lib/utils";

// Matches lib/utils.ts's isOverdue() closed-status list exactly, so
// isActionOpen/isActionClosed and the overdue check never disagree about
// what counts as a resolved action.
export const CLOSED_ACTION_STATUSES = ["Complete", "Approved", "Closed"] as const;

const CLOSED_STATUS_LOOKUP = new Set(CLOSED_ACTION_STATUSES.map(normaliseStatus));

export function isActionClosed(status: string | null | undefined): boolean {
  return CLOSED_STATUS_LOOKUP.has(normaliseStatus(status));
}

export function isActionOpen(status: string | null | undefined): boolean {
  return !isActionClosed(status);
}

export function isActionBlocked(status: string | null | undefined): boolean {
  return normaliseStatus(status) === "blocked";
}

// The one canonical overdue check for actions — never reimplement this.
export const isActionOverdue = isOverdue;
