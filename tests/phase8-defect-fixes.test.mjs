// Phase 8 — post-Phase-7 defect fixes: manual-check applicability
// (phase-derivation keyword ordering) and the SIT Complete auto-check.
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
const { deriveProjectPhase } = req("../lib/project-phase.ts");
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "phase8-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function baseData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "CR028 - Delivery Date Range",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-15",
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

function timelineItem(overrides = {}) {
  return {
    id: `tl-${overrides.phase_ref ?? "1"}`, project_id: PROJECT_ID, phase_ref: "PH-1", phase_name: "Phase",
    start_date: "2026-06-01", end_date: "2026-10-01", owner: null, status: "Complete", progress_percent: 100,
    notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString(),
    ...overrides,
  };
}

function deliverable(overrides = {}) {
  return {
    id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "Deliverable",
    description: null, workstream: "Backend", owner: null, priority: "Medium", status: "Ready for UAT",
    planned_completion_date: null, actual_completion_date: null,
    development_status: "Complete", sit_status: "Passed", uat_status: "Not Started", deployment_status: "Not Started",
    notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
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

function checklistItem(overrides = {}) {
  return {
    id: "glc-1", project_id: PROJECT_ID, category: "Customer Approval", item: "item", owner: null,
    status: "Not Started", due_date: null, completed_date: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function checkByKey(dashboard, key) {
  return dashboard.checks.find((c) => c.key === key);
}

// ── Defect 1: manual applicability — phase-derivation keyword ordering ─────

run("root cause reproduced: a combined 'Customer UAT & Cutover Planning' timeline phase used to derive Deployment (deploy/cutover keyword checked before uat), now derives UAT", () => {
  const data = baseData({
    timeline_items: [
      timelineItem({ phase_ref: "PH-1", phase_name: "Functional Analysis", status: "Complete" }),
      timelineItem({ phase_ref: "PH-2", phase_name: "Customer UAT & Cutover Planning", status: "In Progress" }),
    ],
  });
  const project = data.projects[0];
  const evidence = deriveProjectPhase(data, project, now);
  assert.equal(evidence.phase, "UAT", "a combined UAT+cutover phase name must resolve to UAT, not Deployment");
});

run("fix confirmed end-to-end: Deployment-gated manual checks read Not Yet Required (not Incomplete) once the combined-name UAT phase is derived correctly", () => {
  const data = baseData({
    timeline_items: [
      timelineItem({ phase_ref: "PH-1", phase_name: "Functional Analysis", status: "Complete" }),
      timelineItem({ phase_ref: "PH-2", phase_name: "Customer UAT & Cutover Planning", status: "In Progress" }),
    ],
    // No go_live_checklists rows at all — reproduces the reported live state.
  });
  const project = data.projects[0];
  const dashboard = buildGoLiveDashboard(data, project, now);

  for (const key of ["deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"]) {
    assert.equal(checkByKey(dashboard, key).effective, "Not Yet Required", `${key} must be Not Yet Required during UAT, not Incomplete`);
  }
  // UAT-gated manual checks are correctly applicable and Incomplete (no
  // record yet) — this is expected, not a defect (see defect 3 below).
  assert.equal(checkByKey(dashboard, "customer_approval").effective, "Incomplete");
  assert.equal(checkByKey(dashboard, "warehouse_training").effective, "Incomplete");
});

run("regression guard: text naming only deployment/cutover concepts (no UAT mention) still derives Deployment", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_ref: "PH-1", phase_name: "Go-Live Cutover Weekend", status: "In Progress" })],
  });
  const project = data.projects[0];
  assert.equal(deriveProjectPhase(data, project, now).phase, "Deployment");
});

// ── Defect 2: SIT Complete auto-check ───────────────────────────────────────

run("root cause reproduced and fixed: SIT Complete now reads Complete once the project has genuinely reached UAT, even though the deliverable's own sit_status sub-field was never updated past 'In Progress'", () => {
  const data = baseData({
    timeline_items: [
      timelineItem({ phase_ref: "PH-SIT", phase_name: "System Integration Testing", status: "Complete" }),
      timelineItem({ phase_ref: "PH-UAT", phase_name: "Customer UAT", status: "In Progress" }),
    ],
    milestones: [{ id: "m-sit", milestone_ref: "M-SIT", project_id: PROJECT_ID, title: "SIT Complete", target_date: "2026-07-20", status: "Complete", owner: null, notes: "", created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z" }],
    test_cases: [testCase({ status: "Passed" }), testCase({ id: "test-2", test_ref: "TEST-002", status: "Passed" })],
    // The defect: this deliverable's own status/sit_status were left behind
    // at "In Development"/"In Progress" (never updated once the team moved
    // on) even though SIT has genuinely finished per the timeline,
    // milestone, and test cases above. Neither field independently
    // satisfies isSitComplete() here — proving the fix, not a status field
    // that already happened to pass on its own.
    deliverables: [deliverable({ sit_status: "In Progress", uat_status: "Not Started", status: "In Development" })],
  });
  const project = data.projects[0];
  const dashboard = buildGoLiveDashboard(data, project, now);
  assert.equal(checkByKey(dashboard, "sit_complete").effective, "Complete");
});

run("regression guard: SIT Complete still reads Incomplete for a project genuinely still in SIT (phase has not reached UAT) with the same stale-looking deliverable data", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_ref: "PH-SIT", phase_name: "System Integration Testing", status: "In Progress" })],
    deliverables: [deliverable({ sit_status: "In Progress", uat_status: "Not Started", status: "In Development" })],
  });
  const project = data.projects[0];
  assert.equal(deriveProjectPhase(data, project, now).phase, "SIT");
  const dashboard = buildGoLiveDashboard(data, project, now);
  assert.equal(checkByKey(dashboard, "sit_complete").effective, "Incomplete", "the phase override must not mask genuine SIT incompleteness before UAT is reached");
});

run("regression guard: SIT Complete is still Not Yet Assessed with zero deliverables and no phase evidence of having reached UAT", () => {
  const data = baseData({ timeline_items: [timelineItem({ phase_ref: "PH-1", phase_name: "Discovery Phase", status: "In Progress" })] });
  const project = data.projects[0];
  const dashboard = buildGoLiveDashboard(data, project, now);
  assert.equal(checkByKey(dashboard, "sit_complete").effective, "Not Yet Assessed");
});

// ── Defect 3: Warehouse Training — confirm the Waived path is safe ─────────

run("Warehouse Training can be recorded as Waived (customer-owned, out of delivery scope), counts as passed, and stays visibly distinct from a genuine Complete", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_ref: "PH-UAT", phase_name: "Customer UAT", status: "In Progress" })],
    go_live_checklists: [
      checklistItem({
        id: "glc-training", category: "Training", item: "Warehouse training",
        owner: "Sysco (Customer)", status: "Waived",
        notes: "Customer-owned activity outside Bluestonex delivery scope.",
      }),
    ],
  });
  const project = data.projects[0];
  const dashboard = buildGoLiveDashboard(data, project, now);
  const check = checkByKey(dashboard, "warehouse_training");

  assert.equal(check.effective, "Waived");
  assert.notEqual(check.effective, "Complete", "Waived must remain visibly distinct from a genuine pass");
  assert.ok(dashboard.checks.filter((c) => c.effective === "Complete" || c.effective === "Waived").includes(check), "a Waived check counts toward the passed/completed set");
  assert.equal(dashboard.incompleteCount, dashboard.checks.filter((c) => c.effective === "Incomplete").length);
  assert.ok(!dashboard.checks.filter((c) => c.effective === "Incomplete").includes(check), "a Waived check must not appear in the incomplete/blocking set");
});

// ── Defect 4: cross-surface consistency for the corrected CR028 scenario ───

run("cross-surface: ProjectState phase, Go-Live readiness, and Manager Summary agree the project is in UAT with no contradictory Red/blocked signal", () => {
  const data = baseData({
    timeline_items: [
      timelineItem({ phase_ref: "PH-1", phase_name: "Functional Analysis", status: "Complete" }),
      timelineItem({ phase_ref: "PH-2", phase_name: "Development", status: "Complete" }),
      timelineItem({ phase_ref: "PH-3", phase_name: "System Integration Testing", status: "Complete" }),
      timelineItem({ phase_ref: "PH-4", phase_name: "Customer UAT & Cutover Planning", status: "In Progress" }),
    ],
    requirements: [{ id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "t", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew Walker", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    deliverables: [deliverable({ sit_status: "In Progress", uat_status: "Not Started", status: "In Development" })],
    test_cases: [testCase({ status: "Passed" }), testCase({ id: "test-2", test_ref: "TEST-002", status: "Passed" })],
    acceptance_criteria: [{ id: "ac-1", project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001", criterion: "c", description: null, status: "Met", owner: "QA", evidence: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    risks: [{ id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "d", impact: "Low", probability: "Low", mitigation: "m", owner: "Andrew Walker", status: "Closed", trend: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    go_live_checklists: [checklistItem({ id: "glc-training", category: "Training", item: "Warehouse training", owner: "Sysco (Customer)", status: "Waived", notes: "Customer-owned activity outside Bluestonex delivery scope." })],
  });
  const project = data.projects[0];
  const state = buildProjectState(data, project, now);

  assert.equal(state.phase.phase, "UAT");
  assert.equal(checkByKey(state.goLive, "sit_complete").effective, "Complete");
  for (const key of ["deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"]) {
    assert.equal(checkByKey(state.goLive, key).effective, "Not Yet Required");
  }
  assert.equal(checkByKey(state.goLive, "warehouse_training").effective, "Waived");
  assert.notEqual(state.goLive.status, "Red", "no genuine blocker exists in this fixture");
  assert.notEqual(state.managerSummary.status, "Red", "Manager Summary must not disagree by inventing a Red the other views don't see");
});

run("the Reports page's separate 5-gate Go-Live model does not reference project phase or the applicability map, so it could not itself reproduce or mask either defect", () => {
  const source = fs.readFileSync(path.join(root, "app/reports/page.tsx"), "utf8");
  const goLiveReportSection = source.slice(source.indexOf("function GoLiveReadinessReport"), source.indexOf("function GoLiveReadinessReport") + 2500);
  assert.doesNotMatch(goLiveReportSection, /deriveProjectPhase|MANUAL_CHECK_APPLICABLE_FROM|isPhaseAtOrAfter/, "the 5-gate report must remain phase-agnostic, a separately-scoped, pre-existing divergence from the 13-check model");
});

console.log("\nAll Phase 8 defect-fix tests passed.\n");
