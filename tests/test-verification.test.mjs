// Canonical derived test-verification rollup (lib/lifecycle/test-verification.ts).
//
// Business rule under test: Requirement -> Acceptance Criteria -> linked Test
// Cases (plus direct Requirement -> Test Case links) should automatically
// derive a verification state, WITHOUT ever touching requirement.status,
// acceptance_criteria.status, or requirement_sign_offs — those stay
// deliberate, human-controlled fields. See docs discussion: PL10/F20 audit.
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const target = path.join(root, request.slice(2));
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts"), target]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

Module._extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

const req = Module.createRequire(import.meta.url);
const { computeTestVerification, formatVerificationLabel, formatTestCountsLabel, summarizeVerificationStates } = req("../lib/lifecycle/test-verification.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const PROJECT = "proj-1";

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function requirement(overrides = {}) {
  const id = overrides.id ?? uid("req");
  return {
    id, project_id: PROJECT, requirement_ref: `REQ-${id}`, title: "Requirement",
    description: null, priority: "Medium", category: "Business Rule", status: "Approved",
    owner: "Owner", source: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}

function ac(requirementId, overrides = {}) {
  const id = overrides.id ?? uid("ac");
  return {
    id, project_id: PROJECT, requirement_id: requirementId, ac_ref: `AC-${id}`,
    criterion: "Criterion", description: null, status: "Not Started", owner: null,
    evidence: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}

function test(status, overrides = {}) {
  const id = overrides.id ?? uid("test");
  return {
    id, project_id: PROJECT, test_ref: `TST-${id}`, scenario: "Scenario",
    expected_result: null, actual_result: null, status, owner: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}

function link(sourceEntity, sourceId, targetEntity, targetId, overrides = {}) {
  return {
    id: uid("link"), project_id: PROJECT,
    source_entity: sourceEntity, source_id: sourceId,
    target_entity: targetEntity, target_id: targetId,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function scope({ requirements = [], acceptance_criteria = [], test_cases = [], artefact_links = [] }) {
  return { requirements, acceptance_criteria, test_cases, artefact_links };
}

// ── Derived state precedence ─────────────────────────────────────────────────

run("all linked tests Passed -> Verified", () => {
  const r = requirement();
  const a = ac(r.id);
  const t1 = test("Passed");
  const t2 = test("Passed");
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: [t1, t2],
    artefact_links: [link("acceptance_criteria", a.id, "test_cases", t1.id), link("acceptance_criteria", a.id, "test_cases", t2.id)],
  }));
  assert.equal(result.byRequirement[r.id].state, "Verified");
  assert.equal(result.byRequirement[r.id].passed, 2);
  assert.equal(result.byRequirement[r.id].testCount, 2);
  assert.equal(result.byAcceptanceCriteria[a.id].state, "Verified");
});

run("partially executed tests (some Pending) -> Testing, reported as Testing X/Y", () => {
  const r = requirement();
  const a = ac(r.id);
  const tests = [test("Passed"), test("Passed"), test("Passed"), test("Passed"), test("Passed"), test("Pending")];
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: tests,
    artefact_links: tests.map((t) => link("acceptance_criteria", a.id, "test_cases", t.id)),
  }));
  const rv = result.byRequirement[r.id];
  assert.equal(rv.state, "Testing");
  assert.equal(rv.passed, 5);
  assert.equal(rv.testCount, 6);
  assert.equal(rv.pending, 1);
  assert.equal(formatVerificationLabel(rv), "Testing 5/6");
});

run("any Failed test takes precedence over Passed/Blocked/Pending siblings -> Test Failure", () => {
  const r = requirement();
  const a = ac(r.id);
  const tests = [test("Passed"), test("Blocked"), test("Pending"), test("Failed")];
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: tests,
    artefact_links: tests.map((t) => link("acceptance_criteria", a.id, "test_cases", t.id)),
  }));
  assert.equal(result.byRequirement[r.id].state, "Test Failure");
  assert.equal(result.byAcceptanceCriteria[a.id].state, "Test Failure");
});

run("any Blocked test (no Failed) takes precedence over Passed/Pending -> Testing Blocked", () => {
  const r = requirement();
  const a = ac(r.id);
  const tests = [test("Passed"), test("Pending"), test("Blocked")];
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: tests,
    artefact_links: tests.map((t) => link("acceptance_criteria", a.id, "test_cases", t.id)),
  }));
  assert.equal(result.byRequirement[r.id].state, "Testing Blocked");
});

run("zero linked tests -> No Tests Linked", () => {
  const r = requirement();
  const a = ac(r.id);
  const result = computeTestVerification(scope({ requirements: [r], acceptance_criteria: [a], test_cases: [], artefact_links: [] }));
  assert.equal(result.byRequirement[r.id].state, "No Tests Linked");
  assert.equal(result.byRequirement[r.id].testCount, 0);
  assert.equal(result.byAcceptanceCriteria[a.id].state, "No Tests Linked");
});

// ── Structural aggregation ───────────────────────────────────────────────────

run("multiple tests against one AC are all counted", () => {
  const r = requirement();
  const a = ac(r.id);
  const tests = [test("Passed"), test("Passed"), test("Failed")];
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: tests,
    artefact_links: tests.map((t) => link("test_cases", t.id, "acceptance_criteria", a.id)), // reversed source/target on purpose
  }));
  const acv = result.byAcceptanceCriteria[a.id];
  assert.equal(acv.testCount, 3);
  assert.equal(acv.passed, 2);
  assert.equal(acv.failed, 1);
});

run("multiple ACs under one requirement roll up into the requirement's counts and expose a per-AC breakdown", () => {
  const r = requirement();
  const a1 = ac(r.id);
  const a2 = ac(r.id);
  const t1 = test("Passed");
  const t2 = test("Pending");
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a1, a2], test_cases: [t1, t2],
    artefact_links: [link("acceptance_criteria", a1.id, "test_cases", t1.id), link("acceptance_criteria", a2.id, "test_cases", t2.id)],
  }));
  const rv = result.byRequirement[r.id];
  assert.equal(rv.acCount, 2);
  assert.equal(rv.testCount, 2);
  assert.equal(rv.passed, 1);
  assert.equal(rv.pending, 1);
  assert.equal(rv.state, "Testing");
  assert.equal(rv.acceptanceCriteria.length, 2);
  assert.deepEqual(rv.acceptanceCriteria.map((v) => v.acceptanceCriteriaId).sort(), [a1.id, a2.id].sort());
});

run("a test linked directly to a requirement (no AC) is counted in the requirement's rollup", () => {
  const r = requirement();
  const t = test("Passed");
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [], test_cases: [t],
    artefact_links: [link("requirements", r.id, "test_cases", t.id)],
  }));
  const rv = result.byRequirement[r.id];
  assert.equal(rv.acCount, 0);
  assert.equal(rv.testCount, 1);
  assert.equal(rv.state, "Verified");
  assert.equal(rv.tests[0].testId, t.id);
  assert.deepEqual(rv.tests[0].acceptanceCriteriaRefs, []);
});

run("a test linked via BOTH its AC and directly to the same requirement is counted once, not twice", () => {
  const r = requirement();
  const a = ac(r.id);
  const t = test("Passed");
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: [t],
    artefact_links: [
      link("acceptance_criteria", a.id, "test_cases", t.id),
      link("requirements", r.id, "test_cases", t.id),
    ],
  }));
  const rv = result.byRequirement[r.id];
  assert.equal(rv.testCount, 1, "the same test linked two ways must only be counted once");
  assert.equal(rv.tests.length, 1);
  assert.deepEqual(rv.tests[0].acceptanceCriteriaRefs, [a.ac_ref]);
});

run("a duplicate artefact_links row for the same AC<->test pair does not double-count the test", () => {
  const r = requirement();
  const a = ac(r.id);
  const t = test("Passed");
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: [t],
    artefact_links: [
      link("acceptance_criteria", a.id, "test_cases", t.id),
      link("acceptance_criteria", a.id, "test_cases", t.id), // duplicate row
    ],
  }));
  assert.equal(result.byAcceptanceCriteria[a.id].testCount, 1);
});

run("a test linked only to a different requirement's AC does not leak into this requirement", () => {
  const r1 = requirement();
  const r2 = requirement();
  const a1 = ac(r1.id);
  const a2 = ac(r2.id);
  const t1 = test("Passed");
  const t2 = test("Failed");
  const result = computeTestVerification(scope({
    requirements: [r1, r2], acceptance_criteria: [a1, a2], test_cases: [t1, t2],
    artefact_links: [link("acceptance_criteria", a1.id, "test_cases", t1.id), link("acceptance_criteria", a2.id, "test_cases", t2.id)],
  }));
  assert.equal(result.byRequirement[r1.id].testCount, 1);
  assert.equal(result.byRequirement[r1.id].state, "Verified");
  assert.equal(result.byRequirement[r2.id].testCount, 1);
  assert.equal(result.byRequirement[r2.id].state, "Test Failure");
});

run("a test id referenced by a link but absent from the provided (project-scoped) test_cases array is dropped, never counted or leaked", () => {
  // Simulates the caller having already scoped test_cases to one project via
  // scopeProjectData() — a link pointing at another project's test id must
  // resolve to nothing here, not throw and not silently count as linked.
  const r = requirement();
  const a = ac(r.id);
  const result = computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: [],
    artefact_links: [link("acceptance_criteria", a.id, "test_cases", "other-project-test-id")],
  }));
  assert.equal(result.byRequirement[r.id].testCount, 0);
  assert.equal(result.byRequirement[r.id].state, "No Tests Linked");
});

// ── Purity / non-mutation guarantees ─────────────────────────────────────────

run("computeTestVerification never mutates requirement.status", () => {
  const r = requirement({ status: "Open" });
  const a = ac(r.id, { status: "Not Started" });
  const t = test("Passed");
  computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: [t],
    artefact_links: [link("acceptance_criteria", a.id, "test_cases", t.id)],
  }));
  assert.equal(r.status, "Open", "requirement.status must never be written by derived verification");
});

run("computeTestVerification never mutates acceptance_criteria.status, including Waived", () => {
  const r = requirement();
  const a = ac(r.id, { status: "Waived" });
  const t = test("Failed"); // would otherwise flip a naive sync to Test Failure
  computeTestVerification(scope({
    requirements: [r], acceptance_criteria: [a], test_cases: [t],
    artefact_links: [link("acceptance_criteria", a.id, "test_cases", t.id)],
  }));
  assert.equal(a.status, "Waived", "a manually Waived AC's persisted status must never be overwritten");
});

run("computeTestVerification's input type has no requirement_sign_offs field — it cannot read or write sign-off records", () => {
  const source = fs.readFileSync(path.join(root, "lib/lifecycle/test-verification.ts"), "utf8");
  const match = source.match(/export type TestVerificationScope = \{[\s\S]*?\};/);
  assert.ok(match, "expected an exported TestVerificationScope type");
  assert.doesNotMatch(match[0], /requirement_sign_offs/, "the verification input scope must never carry requirement_sign_offs");
});

// ── Display formatting helpers ───────────────────────────────────────────────

run("formatTestCountsLabel renders a compact ratio, with failed/blocked counts appended only when > 0", () => {
  assert.equal(formatTestCountsLabel({ testCount: 0, passed: 0, failed: 0, blocked: 0, pending: 0 }), "—");
  assert.equal(formatTestCountsLabel({ testCount: 6, passed: 5, failed: 0, blocked: 0, pending: 1 }), "5/6");
  assert.equal(formatTestCountsLabel({ testCount: 6, passed: 4, failed: 1, blocked: 1, pending: 0 }), "4/6 · 1 failed · 1 blocked");
});

// ── Project-wide state summary (for consumers like the Test Status email) ───

run("summarizeVerificationStates counts every requirement's derived state exactly once, all five buckets present", () => {
  const r1 = requirement(); // no AC -> No Tests Linked
  const r2 = requirement();
  const a2 = ac(r2.id);
  const t2 = test("Passed");
  const r3 = requirement();
  const a3 = ac(r3.id);
  const t3a = test("Passed");
  const t3b = test("Pending");
  const r4 = requirement();
  const a4 = ac(r4.id);
  const t4 = test("Failed");
  const r5 = requirement();
  const a5 = ac(r5.id);
  const t5 = test("Blocked");

  const result = computeTestVerification(scope({
    requirements: [r1, r2, r3, r4, r5],
    acceptance_criteria: [a2, a3, a4, a5],
    test_cases: [t2, t3a, t3b, t4, t5],
    artefact_links: [
      link("acceptance_criteria", a2.id, "test_cases", t2.id),
      link("acceptance_criteria", a3.id, "test_cases", t3a.id),
      link("acceptance_criteria", a3.id, "test_cases", t3b.id),
      link("acceptance_criteria", a4.id, "test_cases", t4.id),
      link("acceptance_criteria", a5.id, "test_cases", t5.id),
    ],
  }));

  const summary = summarizeVerificationStates(result);
  assert.deepEqual(summary, {
    "No Tests Linked": 1,
    "Testing": 1,
    "Test Failure": 1,
    "Testing Blocked": 1,
    "Verified": 1,
  });
});

run("summarizeVerificationStates on zero requirements returns all-zero buckets, not missing keys", () => {
  const result = computeTestVerification(scope({}));
  const summary = summarizeVerificationStates(result);
  assert.deepEqual(summary, {
    "No Tests Linked": 0,
    "Testing": 0,
    "Test Failure": 0,
    "Testing Blocked": 0,
    "Verified": 0,
  });
});

console.log("\nAll test-verification module tests passed.\n");
