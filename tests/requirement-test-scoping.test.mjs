// Regression coverage for the PL10/F20-audit defect: every requirement's
// detail panel (RequirementReadiness / ReadinessGates) previously received
// the ENTIRE PROJECT's test_cases array, not just the tests genuinely linked
// to that requirement (via its Acceptance Criteria, or directly). This file
// has no DOM/React renderer (see tests/local-ai-assistant.test.mjs's scope
// note), so — matching that established convention — it proves the fix two
// ways: (1) the pure logic the component is now wired to (already covered
// exhaustively in tests/test-verification.test.mjs), and (2) a structural
// source-scan proving components/app-client.tsx actually computes and passes
// requirement-scoped tests, not the raw project-wide array, into those two
// components.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const appClient = readSource("components/app-client.tsx");

run("structural: app-client.tsx computes the canonical verification rollup via computeTestVerification", () => {
  assert.match(appClient, /import\s*\{[^}]*computeTestVerification[^}]*\}\s*from\s*"@\/lib\/lifecycle\/test-verification"/, "must import the canonical verification function");
});

run("structural (regression): RequirementReadiness is no longer passed the raw project-wide test_cases array", () => {
  assert.doesNotMatch(
    appClient,
    /<RequirementReadiness[\s\S]{0,200}testCases=\{testCases\}/,
    "RequirementReadiness must not receive a variable named testCases that is a straight (pageData.test_cases ?? []) pass-through",
  );
});

run("structural (regression): ReadinessGates is no longer passed the raw project-wide test_cases array", () => {
  assert.doesNotMatch(
    appClient,
    /<ReadinessGates[\s\S]{0,200}testCases=\{testCases\}/,
    "ReadinessGates must not receive a variable named testCases that is a straight (pageData.test_cases ?? []) pass-through",
  );
});

run("structural: RequirementReadiness/ReadinessGates now receive a requirement-scoped test list derived from the verification rollup", () => {
  assert.match(
    appClient,
    /<RequirementReadiness[\s\S]{0,300}testCases=\{linkedTestCases\}/,
    "RequirementReadiness must receive the requirement-scoped linkedTestCases, not the whole project's tests",
  );
  assert.match(
    appClient,
    /<ReadinessGates[\s\S]{0,300}testCases=\{linkedTestCases\}/,
    "ReadinessGates must receive the requirement-scoped linkedTestCases, not the whole project's tests",
  );
});

run("structural: the requirement detail panel renders an expandable linked-test coverage view", () => {
  assert.match(appClient, /RequirementTestCoverage/, "the requirement branch of detailFooter must render the new coverage component");
});

run("structural: AcceptanceCriteriaPanel now receives the per-AC derived verification map", () => {
  assert.match(appClient, /<AcceptanceCriteriaPanel[\s\S]{0,600}verificationByAcId=/, "AcceptanceCriteriaPanel must receive verificationByAcId");
});

// ── Deliberately-unchanged project-level consumers ──────────────────────────
// computeReadiness() is also used for two genuine PROJECT-WIDE aggregates
// (Control Tower's "projectReadiness" tile, and the daily snapshot's
// project_readiness column) — both intentionally roll up every AC/test in
// the whole project, exactly like calculateProgress()'s existing "Testing"
// component, which the plan explicitly keeps unchanged this phase. These are
// NOT instances of the per-requirement leakage bug (there is no single
// requirement being described), so they must stay exactly as they are.

run("control-tower/page.tsx's project-wide computeReadiness call is untouched (a project aggregate, not a per-requirement leak)", () => {
  const source = readSource("app/control-tower/page.tsx");
  assert.match(
    source,
    /projectReadiness: computeReadiness\(\s*scoped\.acceptance_criteria \?\? \[\],\s*scoped\.evidence \?\? \[\],\s*scoped\.requirement_sign_offs \?\? \[\],\s*scoped\.test_cases \?\? \[\],?\s*\)/,
    "Control Tower's project-wide readiness tile must keep using every project AC/test — it is not per-requirement",
  );
});

run("lib/snapshots.ts's project-wide computeReadiness call is untouched (a project aggregate, not a per-requirement leak)", () => {
  const source = readSource("lib/snapshots.ts");
  assert.match(
    source,
    /computeReadiness\(allAC, allEvidence, allSignOffs, scoped\.test_cases\)/,
    "the daily snapshot's project_readiness must keep using every project AC/test — it is not per-requirement",
  );
});

run("lib/control-tower.ts's calculateProgress Testing component is untouched (explicitly out of scope this phase)", () => {
  const source = readSource("lib/control-tower.ts");
  assert.match(
    source,
    /label:\s*"Testing",\s*weight:\s*15,\s*score:\s*score\(data\.test_cases\.filter\(\(item\) => isTestPassed\(item\.status\)\)\.length, data\.test_cases\.length\)/,
    "Progress's project-wide Testing component must be untouched this phase",
  );
});

run("lib/go-live-readiness.ts's three flat auto-checks are untouched (explicitly out of scope this phase)", () => {
  const source = readSource("lib/go-live-readiness.ts");
  assert.match(source, /case "requirements_signed_off":/);
  assert.match(source, /case "acceptance_criteria_met":/);
  assert.match(source, /case "tests_passed":/);
  assert.doesNotMatch(source, /computeTestVerification/, "Go-Live Readiness must not consume the new verification model yet — deferred to a follow-up phase");
});

console.log("\nAll requirement-test-scoping regression tests passed.\n");
