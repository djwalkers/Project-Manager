import { normaliseStatus } from "@/lib/lifecycle/shared";

export const MET_ACCEPTANCE_CRITERIA_STATUSES = ["Met", "Waived"] as const;

const MET_STATUS_LOOKUP = new Set(MET_ACCEPTANCE_CRITERIA_STATUSES.map(normaliseStatus));

export function isAcceptanceCriteriaMet(status: string | null | undefined): boolean {
  return MET_STATUS_LOOKUP.has(normaliseStatus(status));
}

export function isAcceptanceCriteriaOutstanding(status: string | null | undefined): boolean {
  return !isAcceptanceCriteriaMet(status);
}

export function isAcceptanceCriteriaFailed(status: string | null | undefined): boolean {
  return normaliseStatus(status) === "failed";
}
