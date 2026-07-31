import { normaliseStatus } from "@/lib/lifecycle/shared";
import type { Impact, Risk } from "@/lib/types";

export const CLOSED_RISK_STATUSES = ["Complete", "Closed"] as const;

const CLOSED_STATUS_LOOKUP = new Set(CLOSED_RISK_STATUSES.map(normaliseStatus));

export function isRiskClosed(status: string | null | undefined): boolean {
  return CLOSED_STATUS_LOOKUP.has(normaliseStatus(status));
}

export function isRiskOpen(status: string | null | undefined): boolean {
  return !isRiskClosed(status);
}

export function isRiskHighOrCritical(impact: Impact | string | null | undefined): boolean {
  return ["High", "Critical"].includes(String(impact ?? ""));
}

export function isRiskUnmitigated(risk: Pick<Risk, "mitigation">): boolean {
  return !risk.mitigation?.trim();
}
