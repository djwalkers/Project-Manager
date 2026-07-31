import { normaliseStatus } from "@/lib/lifecycle/shared";

export const SIGNED_OFF_REQUIREMENT_STATUSES = ["Approved", "Complete", "Closed"] as const;

const SIGNED_OFF_LOOKUP = new Set(SIGNED_OFF_REQUIREMENT_STATUSES.map(normaliseStatus));

export function isRequirementSignedOff(status: string | null | undefined): boolean {
  return SIGNED_OFF_LOOKUP.has(normaliseStatus(status));
}

export function isRequirementOpen(status: string | null | undefined): boolean {
  return !isRequirementSignedOff(status);
}
