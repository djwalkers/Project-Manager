import { REF_COLLATOR } from "@/lib/ref-sort";
import type { AcceptanceCriteria, ArtefactLink, Requirement, TestCase, TestStatus } from "@/lib/types";

// ── Canonical derived test-verification rollup ──────────────────────────────
//
// Business rule (PL10/F20 audit): testing should drive verification
// AUTOMATICALLY — Requirement -> Acceptance Criteria -> linked Test Cases
// (plus a Requirement linked directly to a Test Case, where that genuinely
// exists) — but this is a purely DERIVED, read-only view. It intentionally
// never reads or writes:
//   - requirements.status        (deliberate human lifecycle state)
//   - acceptance_criteria.status (deliberate human judgement, incl. Waived)
//   - requirement_sign_offs      (deliberate formal sign-off record)
// Those three stay exactly as manually-controlled as they are today. This
// module is the ONE place this calculation happens — every consumer
// (Requirements page, requirement/AC detail panels, ProjectState, and any
// future consumer such as the Test Status email) reads the same result
// instead of re-deriving it.
//
// Inputs are expected to already be scoped to a single project (e.g. via
// lib/project-scope.ts's scopeProjectData()) — this module does no
// project-id filtering itself. A link that points at a test id not present
// in the provided test_cases array (a foreign/cross-project id, or simply a
// stale link) is silently dropped rather than counted — this is what keeps
// another project's tests (or another requirement's tests) from leaking in.

export type VerificationState = "No Tests Linked" | "Testing" | "Test Failure" | "Testing Blocked" | "Verified";

export type VerificationCounts = {
  testCount: number;
  passed: number;
  failed: number;
  blocked: number;
  /** Pending or In Progress — not yet a resolved outcome either way. */
  pending: number;
};

export type LinkedTestSummary = {
  testId: string;
  testRef: string;
  scenario: string;
  status: TestStatus;
  /** ac_ref(s) this test is linked through, under this requirement. Empty when only linked directly to the requirement. */
  acceptanceCriteriaRefs: string[];
};

export type AcceptanceCriteriaVerification = VerificationCounts & {
  acceptanceCriteriaId: string;
  state: VerificationState;
  tests: LinkedTestSummary[];
};

export type RequirementVerification = VerificationCounts & {
  requirementId: string;
  acCount: number;
  state: VerificationState;
  tests: LinkedTestSummary[];
  acceptanceCriteria: AcceptanceCriteriaVerification[];
};

export type TestVerificationScope = {
  requirements: Requirement[];
  acceptance_criteria: AcceptanceCriteria[];
  test_cases: TestCase[];
  artefact_links: ArtefactLink[];
};

export type TestVerificationResult = {
  byRequirement: Record<string, RequirementVerification>;
  byAcceptanceCriteria: Record<string, AcceptanceCriteriaVerification>;
};

function deriveState(counts: VerificationCounts): VerificationState {
  if (counts.failed > 0) return "Test Failure";
  if (counts.blocked > 0) return "Testing Blocked";
  if (counts.testCount === 0) return "No Tests Linked";
  if (counts.passed < counts.testCount) return "Testing";
  return "Verified";
}

function countStatuses(tests: TestCase[]): VerificationCounts {
  let passed = 0, failed = 0, blocked = 0, pending = 0;
  for (const t of tests) {
    if (t.status === "Passed") passed += 1;
    else if (t.status === "Failed") failed += 1;
    else if (t.status === "Blocked") blocked += 1;
    else pending += 1; // Pending, In Progress
  }
  return { testCount: tests.length, passed, failed, blocked, pending };
}

// Builds a fromId -> Set<toId> index of every artefact_links row connecting
// entityA to entityB, in either source/target direction (a link can be
// saved from either side — see components/artefact-linker.tsx).
function indexLinkedIds(links: ArtefactLink[], entityA: string, entityB: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (fromId: string, toId: string) => {
    if (!map.has(fromId)) map.set(fromId, new Set());
    map.get(fromId)!.add(toId);
  };
  for (const link of links) {
    if (link.source_entity === entityA && link.target_entity === entityB) add(link.source_id, link.target_id);
    else if (link.target_entity === entityA && link.source_entity === entityB) add(link.target_id, link.source_id);
  }
  return map;
}

function toSummaries(
  testIds: Iterable<string>,
  testsById: Map<string, TestCase>,
  acRefsByTestId: Map<string, Set<string>>,
): LinkedTestSummary[] {
  const list: LinkedTestSummary[] = [];
  for (const id of testIds) {
    const t = testsById.get(id);
    if (!t) continue; // dangling / foreign-project link — drop, never count
    list.push({
      testId: t.id,
      testRef: t.test_ref,
      scenario: t.scenario,
      status: t.status,
      acceptanceCriteriaRefs: [...(acRefsByTestId.get(id) ?? new Set<string>())].sort((a, b) => REF_COLLATOR.compare(a, b)),
    });
  }
  return list.sort((a, b) => REF_COLLATOR.compare(a.testRef, b.testRef));
}

export function computeTestVerification(scoped: TestVerificationScope): TestVerificationResult {
  const testsById = new Map(scoped.test_cases.map((t) => [t.id, t] as const));
  const testsByAc = indexLinkedIds(scoped.artefact_links, "acceptance_criteria", "test_cases");
  const testsByRequirement = indexLinkedIds(scoped.artefact_links, "requirements", "test_cases");
  const noRefs = new Map<string, Set<string>>();

  const byAcceptanceCriteria: Record<string, AcceptanceCriteriaVerification> = {};
  for (const ac of scoped.acceptance_criteria) {
    const testIds = testsByAc.get(ac.id) ?? new Set<string>();
    const tests = [...testIds].map((id) => testsById.get(id)).filter((t): t is TestCase => Boolean(t));
    const counts = countStatuses(tests);
    byAcceptanceCriteria[ac.id] = {
      acceptanceCriteriaId: ac.id,
      ...counts,
      state: deriveState(counts),
      tests: toSummaries(testIds, testsById, noRefs),
    };
  }

  const byRequirement: Record<string, RequirementVerification> = {};
  for (const req of scoped.requirements) {
    const acsForReq = scoped.acceptance_criteria.filter((ac) => ac.requirement_id === req.id);
    const acVerifications = acsForReq.map((ac) => byAcceptanceCriteria[ac.id]).filter(Boolean);

    const unionTestIds = new Set<string>();
    const acRefsByTestId = new Map<string, Set<string>>();
    for (const ac of acsForReq) {
      const ids = testsByAc.get(ac.id) ?? new Set<string>();
      for (const id of ids) {
        unionTestIds.add(id);
        if (!acRefsByTestId.has(id)) acRefsByTestId.set(id, new Set());
        acRefsByTestId.get(id)!.add(ac.ac_ref);
      }
    }
    const directIds = testsByRequirement.get(req.id) ?? new Set<string>();
    for (const id of directIds) unionTestIds.add(id);

    const tests = [...unionTestIds].map((id) => testsById.get(id)).filter((t): t is TestCase => Boolean(t));
    const counts = countStatuses(tests);

    byRequirement[req.id] = {
      requirementId: req.id,
      acCount: acsForReq.length,
      ...counts,
      state: deriveState(counts),
      tests: toSummaries(unionTestIds, testsById, acRefsByTestId),
      acceptanceCriteria: acVerifications,
    };
  }

  return { byRequirement, byAcceptanceCriteria };
}

/** "Verified" / "Test Failure" / "Testing Blocked" / "No Tests Linked" as-is; "Testing" expands to "Testing X/Y". */
export function formatVerificationLabel(v: VerificationCounts & { state: VerificationState }): string {
  if (v.state === "Testing") return `Testing ${v.passed}/${v.testCount}`;
  return v.state;
}

/** Compact "5/6 · 1 failed, 2 blocked" style summary for a table cell. */
export function formatTestCountsLabel(v: VerificationCounts): string {
  if (v.testCount === 0) return "—";
  const parts = [`${v.passed}/${v.testCount}`];
  if (v.failed > 0) parts.push(`${v.failed} failed`);
  if (v.blocked > 0) parts.push(`${v.blocked} blocked`);
  return parts.join(" · ");
}

/**
 * Project-wide requirement counts by derived verification state — e.g. for
 * the "Requirement Verification Summary" section of a Test Status report.
 * Always returns all five state keys (zero-filled), never a partial object,
 * so a consumer can render a fixed-shape summary without existence checks.
 */
export function summarizeVerificationStates(result: TestVerificationResult): Record<VerificationState, number> {
  const summary: Record<VerificationState, number> = {
    "No Tests Linked": 0,
    "Testing": 0,
    "Test Failure": 0,
    "Testing Blocked": 0,
    "Verified": 0,
  };
  for (const rv of Object.values(result.byRequirement)) {
    summary[rv.state] += 1;
  }
  return summary;
}
