import { normaliseStatus } from "@/lib/lifecycle/shared";

export const CLOSED_DEPENDENCY_STATUSES = ["Complete", "Closed"] as const;

const CLOSED_STATUS_LOOKUP = new Set(CLOSED_DEPENDENCY_STATUSES.map(normaliseStatus));

export function isDependencyClosed(status: string | null | undefined): boolean {
  return CLOSED_STATUS_LOOKUP.has(normaliseStatus(status));
}

export function isDependencyOpen(status: string | null | undefined): boolean {
  return !isDependencyClosed(status);
}

export function isDependencyBlocked(status: string | null | undefined): boolean {
  return normaliseStatus(status) === "blocked";
}
