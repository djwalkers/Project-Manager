// Phase 6 — 12-check Go-Live Readiness model, phase-aware manual
// applicability, and audited overrides. (Originally 13 checks; the
// Warehouse Training check was removed in the post-audit Phase 1 fix — see
// tests/phase-1-provider-scope.test.mjs — since it assessed customer
// operational readiness, not software delivery.)
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
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildProjectIntelligence } = req("../lib/project-intelligence.ts");
const { seedData } = req("../lib/seed-data.ts");
const overridesRoute = req("../app/api/go-live/overrides/route.ts");
const { NextRequest } = req("next/server");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "phase6-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

// phaseName is matched by lib/project-phase.ts's phaseFromText against the
// timeline item's phase_ref/phase_name/owner — an In Progress item is the
// highest-confidence signal deriveProjectPhase consults.
function timelineFor(phaseName) {
  return [{
    id: "tl-1", project_id: PROJECT_ID, phase_ref: "PH-1", phase_name: phaseName,
    start_date: "2026-01-01", end_date: "2026-12-01", owner: null, status: "In Progress",
    progress_percent: 50, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: now.toISOString(),
  }];
}

function buildData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Phase 6 Test Project",
    status: "In Progress",
    planned_start_date: "2026-01-01",
    planned_end_date: "2026-12-01",
    go_live_date: null,
  };
  return {
    ...data,
    projects: [project],
    timeline_items: [],
    milestones: [],
    requirements: [],
    deliverables: [],
    risks: [],
    decisions: [],
    actions: [],
    dependencies: [],
    discovery_questions: [],
    test_cases: [],
    acceptance_criteria: [],
    go_live_checklists: [],
    cutover_plan: [],
    go_live_readiness_overrides: [],
    project_snapshots: [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    activity_log: [],
    documents: [],
    meetings: [],
    ...overrides,
  };
}

function deliverable(overrides = {}) {
  return {
    id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "Deliverable",
    description: null, workstream: "Backend", owner: null, priority: "Medium", status: "Ready for UAT",
    planned_completion_date: null, actual_completion_date: null,
    development_status: "Complete", sit_status: "Passed", uat_status: "Not Started", deployment_status: "Not Started",
    notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function requirement(overrides = {}) {
  return {
    id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "Requirement", description: "d",
    priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew", source: "s", notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function risk(overrides = {}) {
  return {
    id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "d", impact: "Medium",
    probability: "Low", mitigation: "m", owner: "Andrew", status: "Closed", trend: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function testCase(overrides = {}) {
  return {
    id: "test-1", project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "s", expected_result: "e",
    actual_result: "a", status: "Passed", owner: "QA",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ac(overrides = {}) {
  return {
    id: "ac-1", project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001", criterion: "c",
    description: null, status: "Met", owner: "QA", evidence: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function checklistItem(overrides = {}) {
  return {
    id: "glc-1", project_id: PROJECT_ID, category: "Customer Approval", item: "item", owner: null,
    status: "Not Started", due_date: null, completed_date: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function overrideRow(overrides = {}) {
  return {
    id: "ovr-1", project_id: PROJECT_ID, check_key: "tests_passed",
    override_status: "Waived", override_reason: "Accepted by PM", overridden_by: "Andrew Walker",
    overridden_at: "2026-07-20T00:00:00.000Z", created_at: "2026-07-20T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function checkByKey(dashboard, key) {
  return dashboard.checks.find((c) => c.key === key);
}

// ── 1/2. The core defect this phase fixes ───────────────────────────────────

run("empty go_live_checklists no longer forces 0% readiness / Red — a healthy pre-UAT project is Green", () => {
  const data = buildData({
    timeline_items: timelineFor("Development Phase"),
    requirements: [requirement()],
    deliverables: [deliverable({ uat_status: "Not Started", status: "SIT Complete" })],
    risks: [risk()],
    test_cases: [testCase()],
    acceptance_criteria: [ac()],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.notEqual(dashboard.readinessPercent, 0);
  assert.notEqual(dashboard.status, "Red");
});

run("Phase 0-shaped UAT fixture (dev/SIT complete, UAT active, tests passed, AC met, risks closed, customer approval outstanding) produces non-zero, non-Red readiness", () => {
  const data = buildData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement()],
    deliverables: [deliverable({ uat_status: "In Progress", status: "Ready for UAT" })],
    risks: [risk()],
    test_cases: [testCase(), testCase({ id: "test-2", test_ref: "TEST-002" })],
    acceptance_criteria: [ac()],
    go_live_checklists: [checklistItem({ category: "Customer Approval", status: "Not Started" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.ok(dashboard.readinessPercent > 0, `expected non-zero readiness, got ${dashboard.readinessPercent}`);
  assert.notEqual(dashboard.status, "Red");
  assert.notEqual(dashboard.status, "Not Assessed");
});

// ── 3. Auto-derived checks reflect lifecycle data ───────────────────────────

run("auto-derived checks reflect lifecycle data for a fully healthy, fully-recorded project", () => {
  const data = buildData({
    timeline_items: timelineFor("Deployment Phase"),
    requirements: [requirement({ status: "Approved" })],
    deliverables: [deliverable({ development_status: "Complete", sit_status: "Passed", uat_status: "Complete", status: "Deployed", deployment_status: "Deployed" })],
    risks: [risk({ status: "Closed" })],
    test_cases: [testCase({ status: "Passed" })],
    acceptance_criteria: [ac({ status: "Met" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  for (const key of ["requirements_signed_off", "development_complete", "sit_complete", "uat_signed_off", "acceptance_criteria_met", "risks_closed", "tests_passed"]) {
    assert.equal(checkByKey(dashboard, key).effective, "Complete", `expected ${key} to be Complete`);
  }
});

// ── 4. Zero records ⇒ Not Yet Assessed ───────────────────────────────────────

run("zero records for each auto-derived source return Not Yet Assessed, not a pass or fail", () => {
  const data = buildData({ timeline_items: timelineFor("Discovery Phase") });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  for (const key of ["requirements_signed_off", "development_complete", "sit_complete", "uat_signed_off", "acceptance_criteria_met", "risks_closed", "tests_passed"]) {
    assert.equal(checkByKey(dashboard, key).effective, "Not Yet Assessed", `expected ${key} to be Not Yet Assessed`);
  }
});

// ── 5/10. Phase-aware manual applicability ──────────────────────────────────

run("Deployment-gated manual checks return Not Yet Required while the project is in UAT", () => {
  const data = buildData({ timeline_items: timelineFor("Customer UAT") });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  for (const key of ["deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"]) {
    assert.equal(checkByKey(dashboard, key).effective, "Not Yet Required", `expected ${key} to be Not Yet Required during UAT`);
  }
});

run("a manual check before its applicable phase returns Not Yet Required even when a checklist row already exists", () => {
  const data = buildData({
    timeline_items: timelineFor("Development Phase"),
    go_live_checklists: [checklistItem({ category: "Customer Approval", status: "Complete" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "customer_approval").effective, "Not Yet Required");
});

// ── 6/7/8. Auto-derived resolution details ──────────────────────────────────

run("UAT In Progress returns Incomplete, not Complete", () => {
  const data = buildData({
    timeline_items: timelineFor("Customer UAT"),
    deliverables: [deliverable({ uat_status: "In Progress", status: "Ready for UAT" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Incomplete");
});

run("all tests Passed returns Complete", () => {
  const data = buildData({
    timeline_items: timelineFor("SIT Phase"),
    test_cases: [testCase({ status: "Passed" }), testCase({ id: "test-2", test_ref: "TEST-002", status: "Passed" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "tests_passed").effective, "Complete");
});

run("a Blocked, Failed, or Pending test case each return Incomplete for Tests Passed", () => {
  for (const status of ["Blocked", "Failed", "Pending"]) {
    const data = buildData({
      timeline_items: timelineFor("SIT Phase"),
      test_cases: [testCase({ status: "Passed" }), testCase({ id: "test-2", test_ref: "TEST-002", status })],
    });
    const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
    assert.equal(checkByKey(dashboard, "tests_passed").effective, "Incomplete", `expected Incomplete for a ${status} test`);
  }
});

// ── 9. Waived manual check counts as passed ─────────────────────────────────

run("a Waived manual checklist item counts as passed (included in completedItems) while remaining visibly Waived", () => {
  const data = buildData({
    timeline_items: timelineFor("Deployment Phase"),
    go_live_checklists: [checklistItem({ category: "Rollback", status: "Waived" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  const check = checkByKey(dashboard, "rollback_plan_approved");
  assert.equal(check.effective, "Waived");
  assert.ok(dashboard.completedItems >= 1);
});

// ── 11/12/13. Overrides ──────────────────────────────────────────────────────

run("an override changes the effective status but preserves the derived status", () => {
  const data = buildData({
    timeline_items: timelineFor("SIT Phase"),
    test_cases: [testCase({ status: "Failed" })],
    go_live_readiness_overrides: [overrideRow({ check_key: "tests_passed", override_status: "Waived", override_reason: "Known flaky env issue", overridden_by: "Andrew Walker" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  const check = checkByKey(dashboard, "tests_passed");
  assert.equal(check.derived, "Incomplete");
  assert.equal(check.effective, "Waived");
});

run("override audit metadata (status, reason, by, at) is returned alongside the check", () => {
  const data = buildData({
    timeline_items: timelineFor("SIT Phase"),
    test_cases: [testCase({ status: "Failed" })],
    go_live_readiness_overrides: [overrideRow({ check_key: "tests_passed", override_status: "Waived", override_reason: "Known flaky env issue", overridden_by: "Andrew Walker", overridden_at: "2026-07-20T09:00:00.000Z" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  const check = checkByKey(dashboard, "tests_passed");
  assert.deepEqual(check.override, { status: "Waived", reason: "Known flaky env issue", by: "Andrew Walker", at: "2026-07-20T09:00:00.000Z" });
});

run("deleting the override row immediately restores the live-derived status", () => {
  const base = {
    timeline_items: timelineFor("SIT Phase"),
    test_cases: [testCase({ status: "Failed" })],
  };
  const withOverride = buildData({ ...base, go_live_readiness_overrides: [overrideRow({ check_key: "tests_passed" })] });
  const withoutOverride = buildData({ ...base, go_live_readiness_overrides: [] });

  const overridden = checkByKey(buildGoLiveDashboard(withOverride, withOverride.projects[0], now), "tests_passed");
  const restored = checkByKey(buildGoLiveDashboard(withoutOverride, withoutOverride.projects[0], now), "tests_passed");

  assert.equal(overridden.effective, "Waived");
  assert.equal(restored.effective, "Incomplete");
  assert.equal(restored.override, null);
});

// ── 14/15. Override API validation and production auth ─────────────────────

await runAsync("an invalid override_status is rejected by the API route with 400, before reaching the database layer", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/go-live/overrides", {
      method: "POST",
      body: JSON.stringify({ project_id: PROJECT_ID, check_key: "tests_passed", override_status: "Bogus", override_reason: "x" }),
    });
    const res = await overridesRoute.POST(request);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /override_status must be one of/);
  });
});

await runAsync("an invalid check_key is rejected by the API route with 400", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/go-live/overrides", {
      method: "POST",
      body: JSON.stringify({ project_id: PROJECT_ID, check_key: "not_a_real_check", override_status: "Complete", override_reason: "x" }),
    });
    const res = await overridesRoute.POST(request);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /check_key must be one of/);
  });
});

await runAsync("anonymous production override CRUD is rejected (GET/POST/DELETE all 401)", async () => {
  await withNodeEnv("production", async () => {
    assert.equal((await overridesRoute.GET()).status, 401);
    const post = await overridesRoute.POST(new NextRequest("http://localhost/api/go-live/overrides", { method: "POST", body: "{}" }));
    assert.equal(post.status, 401);
    const del = await overridesRoute.DELETE(new NextRequest("http://localhost/api/go-live/overrides?id=x", { method: "DELETE" }));
    assert.equal(del.status, 401);
  });
});

// ── 16/17. Project Intelligence phase-gating (shares the same applicability rules) ──

run("GLR-002 (Rollback) and GLR-003 (Hypercare) do not fire before Deployment, but GLR-004 (Customer Approval) still fires during UAT", () => {
  const data = buildData({
    timeline_items: timelineFor("Customer UAT"),
    go_live_checklists: [checklistItem({ category: "Data", item: "decoy so goLiveChecklists.length > 0", status: "Not Started" })],
  });
  const intelligence = buildProjectIntelligence(data, data.projects[0], now);
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-002"), false, "Rollback finding must not fire before Deployment");
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-003"), false, "Hypercare finding must not fire before Deployment");
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-004"), true, "Customer Approval finding must still fire during UAT");
});

run("GLR-002 (Rollback) and GLR-003 (Hypercare) do fire once the project reaches Deployment", () => {
  const data = buildData({
    timeline_items: timelineFor("Deployment Phase"),
    go_live_checklists: [checklistItem({ category: "Data", item: "decoy so goLiveChecklists.length > 0", status: "Not Started" })],
  });
  const intelligence = buildProjectIntelligence(data, data.projects[0], now);
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-002"), true, "Rollback finding must fire once Deployment is reached");
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-003"), true, "Hypercare finding must fire once Deployment is reached");
});

// ── 18/19. Percentage denominator and the all-excluded case ────────────────

run("the readiness percentage denominator excludes Not Yet Required and Not Yet Assessed checks", () => {
  const data = buildData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement()],
    deliverables: [deliverable({ uat_status: "Complete", status: "UAT Complete" })],
    // risks and test_cases and acceptance_criteria left empty ⇒ Not Yet Assessed (3 auto checks excluded)
    // The second checklist row uses a category with no matching check at all
    // (post-Phase-1: Training was removed as a concept) — it must be inert,
    // proving a historical/unmatched checklist row never inflates the denominator.
    go_live_checklists: [checklistItem({ category: "Customer Approval", status: "Complete" }), checklistItem({ id: "glc-2", category: "Data", item: "unrelated decoy row", status: "Complete" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  // Assessed: requirements_signed_off, development_complete, sit_complete, uat_signed_off (4 auto) + customer_approval (1 manual) = 5.
  // Excluded: acceptance_criteria_met, risks_closed, tests_passed (3 auto, Not Yet Assessed) + 4 Deployment-gated manual (Not Yet Required) = 7.
  assert.equal(dashboard.totalItems, 5);
  assert.equal(dashboard.excludedCount, 7);
  assert.equal(dashboard.completedItems, 5);
  assert.equal(dashboard.readinessPercent, 100);
});

run("when every check is Not Yet Assessed or Not Yet Required, the overall status is Not Assessed, not 0%/Red", () => {
  const data = buildData({ timeline_items: timelineFor("Discovery Phase") });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(dashboard.totalItems, 0);
  assert.equal(dashboard.readinessPercent, 0);
  assert.equal(dashboard.status, "Not Assessed");
  assert.notEqual(dashboard.status, "Red");
});

console.log("\nAll Phase 6 Go-Live Readiness tests passed.\n");
