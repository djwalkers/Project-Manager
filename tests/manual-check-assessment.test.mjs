// Manual Go-Live Readiness checks (Customer Approval, Deployment / Cutover
// Approval, Rollback Plan Approved, Hypercare Owner Assigned, Support Rota
// Confirmed) previously had no edit action at all — they were displayed but
// could never be maintained through the UI. This fix lets an authorised
// user (Admin/Manager) record an assessment for each, persisted through the
// same go_live_readiness_overrides table/API the 7 Auto checks already use
// (see lib/go-live-readiness.ts), with Viewer read-only.
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
const {
  buildGoLiveDashboard,
  GO_LIVE_MANUAL_CHECK_KEYS,
  GO_LIVE_MANUAL_CHECK_STATUSES,
  GO_LIVE_OVERRIDABLE_CHECK_KEYS,
  GO_LIVE_OVERRIDE_STATUSES,
} = req("../lib/go-live-readiness.ts");
const { canAssessManualChecks } = req("../lib/permissions.ts");
const { seedData } = req("../lib/seed-data.ts");
const overridesRoute = req("../app/api/go-live/overrides/route.ts");
const { NextRequest } = req("next/server");

const now = new Date("2026-09-10T12:00:00Z");
const PROJECT_ID = "manual-check-project";
const OTHER_PROJECT_ID = "manual-check-sibling-project";

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

function timelineFor(projectId, phaseName) {
  return [{
    id: `tl-${projectId}`, project_id: projectId, phase_ref: "PH-1", phase_name: phaseName,
    start_date: "2026-01-01", end_date: "2026-12-01", owner: null, status: "In Progress",
    progress_percent: 50, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: now.toISOString(),
  }];
}

function buildData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Manual Check Test Project",
    status: "In Progress",
    planned_start_date: "2026-01-01",
    planned_end_date: "2026-12-01",
    go_live_date: "2026-09-16",
  };
  return {
    ...data,
    projects: [project],
    timeline_items: timelineFor(PROJECT_ID, "Deployment Phase"),
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

function checklistItem(overrides = {}) {
  return {
    id: "glc-1", project_id: PROJECT_ID, category: "Rollback", item: "Rollback plan", owner: null,
    status: "Not Started", due_date: null, completed_date: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function assessmentRow(overrides = {}) {
  return {
    id: "assess-1", project_id: PROJECT_ID, check_key: "hypercare_owner_assigned",
    override_status: "Complete", override_reason: "Confirmed with delivery lead", overridden_by: "Andrew Walker",
    overridden_at: "2026-09-01T09:00:00.000Z", created_at: "2026-09-01T09:00:00.000Z", updated_at: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

function checkByKey(dashboard, key) {
  return dashboard.checks.find((c) => c.key === key);
}

// ── Permission predicate (Admin/Manager can assess, Viewer read-only) ──────

run("Admin and Manager can assess manual checks; Viewer and unauthenticated cannot", () => {
  assert.equal(canAssessManualChecks("Admin"), true);
  assert.equal(canAssessManualChecks("Manager"), true);
  assert.equal(canAssessManualChecks("Viewer"), false);
  assert.equal(canAssessManualChecks(undefined), false);
  assert.equal(canAssessManualChecks(null), false);
});

// ── The core defect this fix addresses: manual checks are now settable ─────

run("every manual check key accepts a persisted assessment that becomes the effective status", () => {
  for (const key of GO_LIVE_MANUAL_CHECK_KEYS) {
    const data = buildData({
      go_live_readiness_overrides: [assessmentRow({ id: `assess-${key}`, check_key: key, override_status: "Complete" })],
    });
    const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
    assert.equal(checkByKey(dashboard, key).effective, "Complete", `expected ${key} to read Complete once assessed`);
  }
});

run("all supported readiness statuses are assignable to a manual check via assessment", () => {
  assert.deepEqual([...GO_LIVE_MANUAL_CHECK_STATUSES].sort(), ["Complete", "Incomplete", "Not Yet Assessed", "Not Yet Required", "Waived"].sort());
  for (const status of GO_LIVE_MANUAL_CHECK_STATUSES) {
    const data = buildData({
      go_live_readiness_overrides: [assessmentRow({ override_status: status })],
    });
    const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
    assert.equal(checkByKey(dashboard, "hypercare_owner_assigned").effective, status, `expected assessed status ${status} to be effective`);
  }
});

run("an assessment records full audit metadata (status, reason, by, at) alongside the check, and preserves the checklist-derived status separately", () => {
  const data = buildData({
    go_live_checklists: [checklistItem({ category: "Hypercare", item: "Hypercare owner", status: "Not Started" })],
    go_live_readiness_overrides: [assessmentRow({
      check_key: "hypercare_owner_assigned", override_status: "Complete",
      override_reason: "Owner confirmed in kickoff", overridden_by: "Priya Shah", overridden_at: "2026-09-02T10:00:00.000Z",
    })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  const check = checkByKey(dashboard, "hypercare_owner_assigned");
  assert.equal(check.derived, "Incomplete", "the checklist-derived value is preserved alongside the assessment");
  assert.equal(check.effective, "Complete");
  assert.deepEqual(check.override, { status: "Complete", reason: "Owner confirmed in kickoff", by: "Priya Shah", at: "2026-09-02T10:00:00.000Z" });
});

run("an explicit assessment wins over phase gating — a human can assess a not-yet-applicable manual check", () => {
  const data = buildData({
    timeline_items: timelineFor(PROJECT_ID, "Customer UAT"),
    go_live_readiness_overrides: [assessmentRow({ check_key: "rollback_plan_approved", override_status: "Complete" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  // Rollback is Deployment-gated; the project is still in UAT.
  assert.equal(checkByKey(dashboard, "rollback_plan_approved").effective, "Complete");
  // A sibling Deployment-gated check with no assessment is still correctly gated.
  assert.equal(checkByKey(dashboard, "support_rota_confirmed").effective, "Not Yet Required");
});

run("deleting the assessment row immediately restores the checklist-derived status", () => {
  const base = {
    go_live_checklists: [checklistItem({ category: "Support", item: "Support rota", status: "Not Started" })],
  };
  const withAssessment = buildData({ ...base, go_live_readiness_overrides: [assessmentRow({ check_key: "support_rota_confirmed", override_status: "Complete" })] });
  const withoutAssessment = buildData({ ...base, go_live_readiness_overrides: [] });

  const assessed = checkByKey(buildGoLiveDashboard(withAssessment, withAssessment.projects[0], now), "support_rota_confirmed");
  const restored = checkByKey(buildGoLiveDashboard(withoutAssessment, withoutAssessment.projects[0], now), "support_rota_confirmed");

  assert.equal(assessed.effective, "Complete");
  assert.equal(restored.effective, "Incomplete");
  assert.equal(restored.override, null);
});

run("a checklist item marked Blocked no longer counts toward blockerCount once explicitly assessed", () => {
  const withoutAssessment = buildData({
    go_live_checklists: [checklistItem({ category: "Rollback", item: "Rollback plan", status: "Blocked" })],
  });
  const withAssessment = buildData({
    go_live_checklists: [checklistItem({ category: "Rollback", item: "Rollback plan", status: "Blocked" })],
    go_live_readiness_overrides: [assessmentRow({ check_key: "rollback_plan_approved", override_status: "Incomplete", override_reason: "Being reworked, not yet a hard blocker" })],
  });

  const before = buildGoLiveDashboard(withoutAssessment, withoutAssessment.projects[0], now);
  const after = buildGoLiveDashboard(withAssessment, withAssessment.projects[0], now);

  assert.equal(before.blockerCount, 1, "an unassessed Blocked checklist match still counts as a blocker");
  assert.equal(after.blockerCount, 0, "an explicit assessment supersedes the stale Blocked flag");
});

// ── ProjectState/readiness calculation reflects the saved manual state ─────

run("readiness percentage and RAG status update naturally once manual checks are assessed Complete", () => {
  const data = buildData({
    go_live_readiness_overrides: GO_LIVE_MANUAL_CHECK_KEYS.map((key, i) => assessmentRow({ id: `assess-${i}`, check_key: key, override_status: "Complete" })),
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  for (const key of GO_LIVE_MANUAL_CHECK_KEYS) assert.equal(checkByKey(dashboard, key).effective, "Complete");
  // 6 auto checks are Not Yet Assessed (no lifecycle data) and excluded;
  // sit_complete auto-resolves Complete once the phase has reached UAT or
  // later (see lib/go-live-readiness.ts's resolveAutoCheck), regardless of
  // deliverable data — so it's included alongside the 5 now-assessed
  // manual checks.
  assert.equal(checkByKey(dashboard, "sit_complete").effective, "Complete");
  assert.equal(dashboard.totalItems, 6);
  assert.equal(dashboard.completedItems, 6);
  assert.equal(dashboard.readinessPercent, 100);
});

// ── Sibling-project isolation ───────────────────────────────────────────────

run("an assessment for one project's manual check never affects a sibling project's dashboard", () => {
  const data = buildData({
    projects: [
      { ...seedData.projects[0], id: PROJECT_ID, name: "Project A", status: "In Progress", planned_start_date: "2026-01-01", planned_end_date: "2026-12-01" },
      { ...seedData.projects[0], id: OTHER_PROJECT_ID, name: "Project B", status: "In Progress", planned_start_date: "2026-01-01", planned_end_date: "2026-12-01" },
    ],
    timeline_items: [...timelineFor(PROJECT_ID, "Deployment Phase"), ...timelineFor(OTHER_PROJECT_ID, "Deployment Phase")],
    go_live_readiness_overrides: [assessmentRow({ project_id: PROJECT_ID, check_key: "hypercare_owner_assigned", override_status: "Complete" })],
  });
  const projectA = data.projects.find((p) => p.id === PROJECT_ID);
  const projectB = data.projects.find((p) => p.id === OTHER_PROJECT_ID);

  const dashboardA = buildGoLiveDashboard(data, projectA, now);
  const dashboardB = buildGoLiveDashboard(data, projectB, now);

  assert.equal(checkByKey(dashboardA, "hypercare_owner_assigned").effective, "Complete");
  assert.equal(checkByKey(dashboardB, "hypercare_owner_assigned").effective, "Incomplete");
  assert.equal(checkByKey(dashboardB, "hypercare_owner_assigned").override, null);
});

// ── AUTO behaviour remains unchanged ────────────────────────────────────────

run("the Auto override status vocabulary is unchanged (still exactly Complete/Incomplete/Waived)", () => {
  assert.deepEqual([...GO_LIVE_OVERRIDE_STATUSES], ["Complete", "Incomplete", "Waived"]);
  assert.deepEqual([...GO_LIVE_OVERRIDABLE_CHECK_KEYS], [
    "requirements_signed_off", "development_complete", "sit_complete", "uat_signed_off",
    "acceptance_criteria_met", "risks_closed", "tests_passed",
  ]);
});

run("an Auto check override still behaves exactly as before (derived preserved, effective overridden)", () => {
  const data = buildData({
    test_cases: [{
      id: "test-1", project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "s", expected_result: "e",
      actual_result: "a", status: "Failed", owner: "QA",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }],
    go_live_readiness_overrides: [{
      id: "ovr-auto-1", project_id: PROJECT_ID, check_key: "tests_passed",
      override_status: "Waived", override_reason: "Known flaky env issue", overridden_by: "Andrew Walker",
      overridden_at: "2026-09-01T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    }],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  const check = checkByKey(dashboard, "tests_passed");
  assert.equal(check.derived, "Incomplete");
  assert.equal(check.effective, "Waived");
  assert.equal(check.source, "Auto");
});

// ── API route: manual checks are now valid targets, Auto validation intact ─

await runAsync("the API route now accepts a manual check_key (previously rejected) and validates its wider status vocabulary, reaching only the local database-not-configured stage", async () => {
  await withNodeEnv("test", async () => {
    for (const key of GO_LIVE_MANUAL_CHECK_KEYS) {
      const request = new NextRequest("http://localhost/api/go-live/overrides", {
        method: "POST",
        body: JSON.stringify({ project_id: PROJECT_ID, check_key: key, override_status: "Not Yet Required", override_reason: "Not applicable for this go-live" }),
      });
      const res = await overridesRoute.POST(request);
      // 500 "Database not configured" proves check_key + override_status
      // validation AND the Admin/Manager permission gate were already
      // passed — only the (unconfigured, in this offline test harness)
      // database layer stops it. A 400 here would mean the manual key or
      // its structural status were still being rejected as invalid.
      assert.equal(res.status, 500, `expected ${key} to pass validation and reach the DB layer`);
      const body = await res.json();
      assert.match(body.error, /Database not configured/);
    }
  });
});

await runAsync("an Auto check_key still rejects the structural statuses Manual checks are now allowed (400)", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/go-live/overrides", {
      method: "POST",
      body: JSON.stringify({ project_id: PROJECT_ID, check_key: "tests_passed", override_status: "Not Yet Required", override_reason: "x" }),
    });
    const res = await overridesRoute.POST(request);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /override_status must be one of: Complete, Incomplete, Waived/);
  });
});

await runAsync("an invalid check_key is still rejected, and the error now lists all 12 valid keys", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/go-live/overrides", {
      method: "POST",
      body: JSON.stringify({ project_id: PROJECT_ID, check_key: "not_a_real_check", override_status: "Complete", override_reason: "x" }),
    });
    const res = await overridesRoute.POST(request);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /check_key must be one of/);
    for (const key of GO_LIVE_MANUAL_CHECK_KEYS) assert.match(body.error, new RegExp(key));
  });
});

await runAsync("an invalid override_status for a manual check_key is rejected with 400 before reaching the database", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/go-live/overrides", {
      method: "POST",
      body: JSON.stringify({ project_id: PROJECT_ID, check_key: "customer_approval", override_status: "Bogus", override_reason: "x" }),
    });
    const res = await overridesRoute.POST(request);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /override_status must be one of/);
  });
});

await runAsync("anonymous production requests are still rejected with 401, even for a manual check_key", async () => {
  await withNodeEnv("production", async () => {
    const post = await overridesRoute.POST(new NextRequest("http://localhost/api/go-live/overrides", {
      method: "POST",
      body: JSON.stringify({ project_id: PROJECT_ID, check_key: "customer_approval", override_status: "Complete", override_reason: "x" }),
    }));
    assert.equal(post.status, 401);
    const del = await overridesRoute.DELETE(new NextRequest("http://localhost/api/go-live/overrides?id=x", { method: "DELETE" }));
    assert.equal(del.status, 401);
  });
});

console.log("\nAll manual check assessment tests passed.\n");
