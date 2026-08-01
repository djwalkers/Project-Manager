import { isAcceptanceCriteriaFailed, isTestFailedOrBlocked } from "@/lib/lifecycle";
import type { ProjectPhase } from "@/lib/project-phase";
import type { AcceptanceCriteria, Requirement, TestCase } from "@/lib/types";

// Phases where testing/deployment gates are actively in play — a Failed or
// Blocked test genuinely prevents progression here. Outside this window
// (Discovery/Analysis/Design/Development before testing starts, or
// Hypercare/Closed once live) a failed/blocked test is still worth a
// warning — lib/recommendations.ts's existing testing candidates already
// surface it unconditionally, unchanged — but it isn't material enough on
// its own to drive a Red exception-report verdict.
const TEST_MATERIAL_PHASES: ProjectPhase[] = ["SIT", "UAT", "Deployment"];

/**
 * Failed or Blocked test cases that are material to the project's current
 * delivery gate — i.e. actually prevent progression of the current phase,
 * not just a pending/aged item. Both outcomes share the same phase window:
 * a test blocked in SIT/UAT/Deployment stalls the gate exactly as a failed
 * one does.
 */
export function materialTestFailures(testCases: TestCase[], phase: ProjectPhase): TestCase[] {
  if (!TEST_MATERIAL_PHASES.includes(phase)) return [];
  return testCases.filter((test) => isTestFailedOrBlocked(test.status));
}

/**
 * Failed acceptance criteria linked to a High or Critical priority
 * requirement — material whenever discovered, not phase-gated (a failed
 * criterion on a critical requirement matters regardless of what phase the
 * project is currently in).
 */
export function materialAcceptanceCriteriaFailures(
  acceptanceCriteria: AcceptanceCriteria[],
  requirements: Requirement[],
): AcceptanceCriteria[] {
  const criticalRequirementIds = new Set(
    requirements.filter((r) => r.priority === "High" || r.priority === "Critical").map((r) => r.id),
  );
  return acceptanceCriteria.filter(
    (ac) => isAcceptanceCriteriaFailed(ac.status) && criticalRequirementIds.has(ac.requirement_id),
  );
}
