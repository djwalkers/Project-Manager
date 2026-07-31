import { normaliseStatus } from "@/lib/lifecycle/shared";

// Passed/Failed are the only terminal outcomes — Pending, In Progress, and
// Blocked are all still open (a blocked test has not reached a resolved
// pass/fail outcome).
export const RESOLVED_TEST_STATUSES = ["Passed", "Failed"] as const;

const RESOLVED_STATUS_LOOKUP = new Set(RESOLVED_TEST_STATUSES.map(normaliseStatus));

export function isTestClosed(status: string | null | undefined): boolean {
  return RESOLVED_STATUS_LOOKUP.has(normaliseStatus(status));
}

export function isTestOpen(status: string | null | undefined): boolean {
  return !isTestClosed(status);
}

export function isTestPassed(status: string | null | undefined): boolean {
  return normaliseStatus(status) === "passed";
}

export function isTestFailedOrBlocked(status: string | null | undefined): boolean {
  return ["failed", "blocked"].includes(normaliseStatus(status));
}
