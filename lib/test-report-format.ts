import { isTestClosed, isTestPassed } from "@/lib/lifecycle/test-case";
import { REF_COLLATOR } from "@/lib/ref-sort";
import type { RequirementVerification, TestVerificationResult, VerificationState } from "@/lib/lifecycle/test-verification";
import type { TestCase } from "@/lib/types";

// ── Display-only formatting for the Test Status report ─────────────────────
//
// Nothing here reads or writes stored data beyond what it is handed, and
// nothing here derives a lifecycle outcome: grouping re-indexes the
// canonical computeTestVerification() output (lib/lifecycle/
// test-verification.ts) purely for layout. test_cases.scenario is never
// modified — parseTestScenario() only produces a display view of it.

export type ParsedScenario = {
  /** Concise single-line title for the main status list. */
  title: string;
  /** The objective text (the whole scenario when it has no "Objective:" prefix). */
  objective: string;
  /** The "Steps:" portion, or null when the scenario carries no steps. */
  steps: string | null;
};

export const TEST_TITLE_MAX_LENGTH = 120;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function capitaliseFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Splits a stored scenario into a display title, objective and steps.
 *
 * Supports both the older combined format ("Objective: … Steps: 1) … 2) …")
 * and concise free-text titles. Only a leading "Objective:" (any case) is
 * treated as structure; a scenario without it is used as-is for the title.
 */
export function parseTestScenario(scenario: string | null | undefined): ParsedScenario {
  const raw = collapseWhitespace(scenario ?? "");
  if (!raw) return { title: "—", objective: "—", steps: null };

  const structured = /^objective\s*:\s*(.*?)(?:\s*\bsteps\s*:\s*(.*))?$/i.exec(raw);
  let objective = raw;
  let steps: string | null = null;
  if (structured) {
    objective = structured[1].trim() || raw;
    steps = structured[2]?.trim() || null;
  } else {
    const stepsOnly = /^(.*?)\s*\bsteps\s*:\s*(.+)$/i.exec(raw);
    if (stepsOnly && stepsOnly[1].trim()) {
      objective = stepsOnly[1].trim();
      steps = stepsOnly[2].trim();
    }
  }

  const title = truncate(capitaliseFirst(objective.replace(/[.\s]+$/, "")), TEST_TITLE_MAX_LENGTH);
  return { title, objective, steps };
}

/** Splits "1) Do x. 2) Do y." into ["Do x.", "Do y."]; returns [steps] when unnumbered. */
export function splitSteps(steps: string | null): string[] {
  if (!steps) return [];
  const parts = steps.split(/\s*(?:^|\s)\d{1,2}[).]\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [steps];
}

export type ReportTestRow = {
  test: TestCase;
  /** AC refs this test is linked through under THIS requirement. */
  acRefs: string[];
  /** Other requirement refs the same test is also listed under. */
  alsoUnder: string[];
};

export type RequirementTestGroup = {
  requirementId: string;
  requirementRef: string;
  requirementTitle: string;
  state: VerificationState;
  passed: number;
  testCount: number;
  rows: ReportTestRow[];
};

export type GroupedTestReport = {
  groups: RequirementTestGroup[];
  /** Requirements with no linked tests (state "No Tests Linked"). */
  untestedRequirements: { requirementRef: string; requirementTitle: string }[];
  /** Tests not linked to any requirement or AC in this project. */
  unlinkedTests: TestCase[];
  /** requirement refs per test id, in ref order. */
  requirementRefsByTest: Map<string, string[]>;
};

/**
 * Groups project tests under each requirement using the canonical
 * verification result. A test linked under several requirements appears in
 * each group; tests with no requirement link are returned separately.
 */
export function groupTestsByRequirement(
  requirements: { id: string; requirement_ref: string; title: string }[],
  tests: TestCase[],
  verification: TestVerificationResult,
): GroupedTestReport {
  const testsById = new Map(tests.map((t) => [t.id, t] as const));
  const sortedRequirements = [...requirements].sort((a, b) => REF_COLLATOR.compare(a.requirement_ref, b.requirement_ref));

  const requirementRefsByTest = new Map<string, string[]>();
  for (const req of sortedRequirements) {
    const rv: RequirementVerification | undefined = verification.byRequirement[req.id];
    for (const t of rv?.tests ?? []) {
      if (!testsById.has(t.testId)) continue;
      const list = requirementRefsByTest.get(t.testId) ?? [];
      if (!list.includes(req.requirement_ref)) list.push(req.requirement_ref);
      requirementRefsByTest.set(t.testId, list);
    }
  }

  const groups: RequirementTestGroup[] = [];
  const untestedRequirements: GroupedTestReport["untestedRequirements"] = [];
  for (const req of sortedRequirements) {
    const rv = verification.byRequirement[req.id];
    const rows: ReportTestRow[] = [];
    for (const t of rv?.tests ?? []) {
      const test = testsById.get(t.testId);
      if (!test) continue;
      rows.push({
        test,
        acRefs: t.acceptanceCriteriaRefs,
        alsoUnder: (requirementRefsByTest.get(t.testId) ?? []).filter((ref) => ref !== req.requirement_ref),
      });
    }
    if (!rv || rows.length === 0) {
      untestedRequirements.push({ requirementRef: req.requirement_ref, requirementTitle: req.title });
      continue;
    }
    groups.push({
      requirementId: req.id,
      requirementRef: req.requirement_ref,
      requirementTitle: req.title,
      state: rv.state,
      passed: rv.passed,
      testCount: rv.testCount,
      rows,
    });
  }

  const unlinkedTests = tests
    .filter((t) => !requirementRefsByTest.has(t.id))
    .sort((a, b) => REF_COLLATOR.compare(a.test_ref, b.test_ref));

  return { groups, untestedRequirements, unlinkedTests, requirementRefsByTest };
}

// ── Test position (shared by the email and print presentations) ────────────

export type TestCounts = {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  inProgress: number;
  pending: number;
  /** Not yet executed and not blocked: Pending + In Progress. */
  remaining: number;
  /** Passed + Failed (lib/lifecycle/test-case.ts RESOLVED_TEST_STATUSES). */
  executed: number;
  executionPct: number;
};

/**
 * Counts tests by their stored status. Executed follows the canonical
 * isTestClosed() rule (Passed + Failed); total = passed + failed + blocked +
 * remaining, so every test is counted exactly once.
 */
export function countTests(tests: { status: string }[]): TestCounts {
  const total = tests.length;
  const passed = tests.filter((t) => isTestPassed(t.status)).length;
  const failed = tests.filter((t) => t.status === "Failed").length;
  const blocked = tests.filter((t) => t.status === "Blocked").length;
  const inProgress = tests.filter((t) => t.status === "In Progress").length;
  const pending = tests.filter((t) => t.status === "Pending").length;
  const executed = tests.filter((t) => isTestClosed(t.status)).length;
  return {
    total, passed, failed, blocked, inProgress, pending,
    remaining: total - executed - blocked,
    executed,
    executionPct: total > 0 ? Math.round((executed / total) * 100) : 0,
  };
}

export type AreaPosition = "Complete" | "Testing" | "In Progress" | "Pending" | "Failed" | "Blocked";

/**
 * Presentation-only position for a set of tests. Complete only when every
 * test has passed; a failure or block always takes precedence.
 */
export function areaPosition(c: TestCounts): AreaPosition {
  if (c.failed > 0) return "Failed";
  if (c.blocked > 0) return "Blocked";
  if (c.total > 0 && c.passed === c.total) return "Complete";
  if (c.passed > 0) return "Testing";
  if (c.inProgress > 0) return "In Progress";
  return "Pending";
}

export type AreaSummary = {
  /** Requirement ref, or null for tests not linked to any requirement. */
  ref: string | null;
  title: string;
  counts: TestCounts;
  position: AreaPosition;
};

/**
 * One area per requirement that has linked tests (in requirement-ref
 * order), plus a final "Not linked to a requirement" area when needed.
 * Areas are the project's own requirements — nothing is merged or renamed.
 */
export function summariseAreas(grouped: GroupedTestReport): AreaSummary[] {
  const areas: AreaSummary[] = grouped.groups.map((g) => {
    const counts = countTests(g.rows.map((r) => r.test));
    return { ref: g.requirementRef, title: g.requirementTitle, counts, position: areaPosition(counts) };
  });
  if (grouped.unlinkedTests.length > 0) {
    const counts = countTests(grouped.unlinkedTests);
    areas.push({ ref: null, title: "Not linked to a requirement", counts, position: areaPosition(counts) });
  }
  return areas;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Factual one-line status statement built only from the counts. */
export function testPositionMessage(c: TestCounts): string {
  if (c.total === 0) return "No test cases recorded for this project.";
  const remainingSentence = c.remaining > 0
    ? `${plural(c.remaining, "test remains", "tests remain")} to be executed${c.inProgress > 0 ? ` (${c.inProgress} in progress)` : ""}.`
    : "";
  if (c.failed > 0 || c.blocked > 0) {
    const parts: string[] = [];
    if (c.failed > 0) parts.push(`${plural(c.failed, "test", "tests")} failed`);
    if (c.blocked > 0) parts.push(c.failed > 0 ? `${c.blocked} ${c.blocked === 1 ? "is" : "are"} blocked` : `${plural(c.blocked, "test is", "tests are")} blocked`);
    return [`${parts.join(" and ")}.`, remainingSentence, "See attention items below."].filter(Boolean).join(" ");
  }
  if (c.remaining > 0) return `No failures or blockers. ${remainingSentence}`;
  return `No failures or blockers. All ${plural(c.total, "test has", "tests have")} passed.`;
}
