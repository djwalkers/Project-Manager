// Phase 7 — ProjectState assembly and consumer migration.
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
const projectStateModule = req("../lib/project-state.ts");
const { buildProjectState } = projectStateModule;
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildDailyBrief } = req("../lib/daily-brief.ts");
const { buildAutomatedDailyBrief, buildManagerSummaryEmail } = req("../lib/email-content.ts");
const { buildManagerExceptionReport } = req("../lib/manager-summary.ts");
const { buildProjectWorkspace } = req("../lib/project-workspace.ts");
const { buildRecommendations } = req("../lib/recommendations.ts");
const { calculateSchedule } = req("../lib/schedule.ts");
const { isRiskOpen, isActionOpen, isDecisionOpen } = req("../lib/lifecycle/index.ts");
const { scopeProjectData } = req("../lib/project-scope.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_A_ID = "project-cr028";
const PROJECT_B_ID = "project-cr028-phase-2";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// ── A two-project fixture: "CR028" and "CR028 Phase 2" ──────────────────────
// Deliberately similarly named (the exact failure mode substring/heuristic
// selection is prone to) with disjoint entities, so any accidental mixing
// between the two projects is immediately visible in the assertions below.
function buildTwoProjectFixture() {
  const data = structuredClone(seedData);

  const projectA = { ...data.projects[0], id: PROJECT_A_ID, name: "CR028", status: "In Progress", planned_start_date: "2026-06-01", planned_end_date: "2026-10-15", go_live_date: null };
  const projectB = { ...data.projects[0], id: PROJECT_B_ID, name: "CR028 Phase 2", status: "In Progress", planned_start_date: "2026-06-01", planned_end_date: "2026-11-15", go_live_date: null };

  const timeline_items = [
    { id: "tl-a", project_id: PROJECT_A_ID, phase_ref: "PH-A1", phase_name: "Customer UAT", start_date: "2026-06-01", end_date: "2026-10-10", owner: null, status: "In Progress", progress_percent: 40, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString() },
    { id: "tl-b", project_id: PROJECT_B_ID, phase_ref: "PH-B1", phase_name: "Development Phase", start_date: "2026-06-01", end_date: "2026-11-10", owner: null, status: "In Progress", progress_percent: 40, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString() },
  ];

  const risks = [
    { id: "risk-a", project_id: PROJECT_A_ID, risk_ref: "RSK-A001", description: "Project A's own risk", impact: "Critical", probability: "Medium", mitigation: null, owner: "Andrew Walker", status: "Open", trend: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    { id: "risk-b", project_id: PROJECT_B_ID, risk_ref: "RSK-B001", description: "Project B's own risk", impact: "Low", probability: "Low", mitigation: "Handled", owner: "Andrew Walker", status: "Closed", trend: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const actions = [
    { id: "act-a", project_id: PROJECT_A_ID, action_ref: "ACT-A001", description: "Project A's overdue action", owner: "Andrew Walker", due_date: "2026-07-01", status: "Open", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    { id: "act-b", project_id: PROJECT_B_ID, action_ref: "ACT-B001", description: "Project B's action, not overdue", owner: "Andrew Walker", due_date: "2026-12-01", status: "Open", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const decisions = [
    { id: "dec-a", project_id: PROJECT_A_ID, decision_ref: "DEC-A001", question: "Project A's decision", decision: null, owner: "Andrew Walker", status: "Open", decision_date: null, due_date: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const requirements = [
    { id: "req-a", project_id: PROJECT_A_ID, requirement_ref: "REQ-A001", title: "Project A requirement", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew Walker", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const deliverables = [
    { id: "del-a", project_id: PROJECT_A_ID, deliverable_ref: "DEL-A001", title: "Project A deliverable", description: null, workstream: "Backend", owner: null, priority: "High", status: "Ready for UAT", planned_completion_date: null, actual_completion_date: null, development_status: "Complete", sit_status: "Passed", uat_status: "In Progress", deployment_status: "Not Started", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const test_cases = [
    { id: "test-a", project_id: PROJECT_A_ID, test_ref: "TEST-A001", scenario: "Project A test", expected_result: "Pass", actual_result: "Pass", status: "Passed", owner: "QA", created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const acceptance_criteria = [
    { id: "ac-a", project_id: PROJECT_A_ID, requirement_id: "req-a", ac_ref: "AC-A001", criterion: "Project A AC", description: null, status: "Met", owner: "QA", evidence: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  return {
    ...data,
    projects: [projectA, projectB],
    timeline_items,
    milestones: [],
    risks,
    actions,
    decisions,
    requirements,
    deliverables,
    dependencies: [],
    discovery_questions: [],
    test_cases,
    acceptance_criteria,
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
  };
}

// ── 1. Exact-project scoping with similarly named projects ─────────────────

run("buildProjectState never selects a project internally — no selectActiveProject/selectCanonicalProjects/name-substring logic in lib/project-state.ts", () => {
  const source = fs.readFileSync(path.join(root, "lib/project-state.ts"), "utf8");
  assert.doesNotMatch(source, /selectActiveProject\s*\(/, "buildProjectState must not call selectActiveProject internally");
  assert.doesNotMatch(source, /selectCanonicalProjects\s*\(/, "buildProjectState must not call selectCanonicalProjects internally");
  assert.doesNotMatch(source, /\.includes\(["']cr028["']\)/i, "buildProjectState must not contain name-substring project matching");
});

run("buildProjectState for one exact project ID never includes entities from a similarly-named sibling project", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const projectB = data.projects.find((p) => p.id === PROJECT_B_ID);

  const stateA = buildProjectState(data, projectA, now);
  const stateB = buildProjectState(data, projectB, now);

  assert.equal(stateA.scoped.risks.length, 1);
  assert.equal(stateA.scoped.risks[0].risk_ref, "RSK-A001");
  assert.equal(stateA.scoped.actions.length, 1);
  assert.equal(stateA.scoped.actions[0].action_ref, "ACT-A001");
  assert.equal(stateA.rollups.risks.open, 1, "A's own open risk");
  assert.equal(stateA.rollups.actions.overdue, 1, "A's own overdue action");

  assert.equal(stateB.scoped.risks.length, 1);
  assert.equal(stateB.scoped.risks[0].risk_ref, "RSK-B001");
  assert.equal(stateB.rollups.risks.open, 0, "B's risk is Closed, not open");
  assert.equal(stateB.rollups.actions.overdue, 0, "B's action is not overdue");
  assert.equal(stateB.rollups.requirements.signedOff + stateB.rollups.requirements.outstanding, 0, "B has no requirements of its own");
});

// ── 2. Lifecycle roll-ups match existing helper outputs ─────────────────────

run("lifecycle roll-ups match direct isXOpen/isXClosed helper output over the same scoped data", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);
  const scoped = scopeProjectData(data, projectA);

  assert.equal(state.rollups.risks.open, scoped.risks.filter((r) => isRiskOpen(r.status)).length);
  assert.equal(state.rollups.actions.open, scoped.actions.filter((a) => isActionOpen(a.status)).length);
  assert.equal(state.rollups.decisions.open, scoped.decisions.filter((d) => isDecisionOpen(d.status)).length);
  assert.equal(state.rollups.deliverables.total, scoped.deliverables.length);
  assert.equal(state.rollups.tests.total, scoped.test_cases.length);
  assert.equal(state.rollups.acceptanceCriteria.total, (scoped.acceptance_criteria ?? []).length);
});

// ── 3. Health, confidence, and readiness remain separate values ────────────

run("project health, schedule health, delivery confidence, and Go-Live readiness read the same facts but are never collapsed into a single score", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);

  // Concrete, verified divergence for this fixture: Go-Live is Red (an open
  // Critical risk is a go-live blocker) while Delivery Confidence is Green
  // (that same risk is only a modest phase-aware penalty, not disqualifying)
  // — proving these two lenses on the same underlying risk fact legitimately
  // disagree, by design, rather than being reconciled into one verdict.
  assert.equal(state.scheduleHealth, "Amber");
  assert.equal(state.projectHealth, "Amber");
  assert.equal(state.goLive.status, "Red");
  assert.equal(state.confidence.rag, "Green");
});

// ── 4. Workbench and Notification Bell receive the same recommendation set ──

run("Workbench's top-5 recommendations are the first 5 of the same ranked list Notification Bell reads in full (maxCount 10)", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);
  const legacyTop5 = buildRecommendations(data, 5, projectA);

  assert.deepEqual(state.recommendations.slice(0, 5).map((r) => r.id), legacyTop5.map((r) => r.id));
});

// ── 5. Control Tower and Manager Summary use the same schedule/lifecycle facts ──

run("Control Tower's project health and Manager Summary's classification both derive from the same schedule.health, not independent thresholds", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);
  const directSchedule = calculateSchedule(projectA, scopeProjectData(data, projectA).timeline_items, now);

  assert.equal(state.schedule.health, directSchedule.health);
  assert.equal(state.scheduleHealth, directSchedule.health);
  // Manager Summary's dateConfidence is a direct projection of schedule.health
  // (see lib/manager-summary.ts's classifyProject) — same source as
  // Control Tower's projectHealth input, not a second computation of it.
  if (directSchedule.health === "Red") assert.equal(state.managerSummary.dateConfidence, "Delayed");
  else if (directSchedule.health === "Amber") assert.equal(state.managerSummary.dateConfidence, "At Risk");
  else assert.equal(state.managerSummary.dateConfidence, "On Track");
});

// ── 6. Go-Live page uses ProjectState readiness ─────────────────────────────

run("ProjectState.goLive is exactly buildGoLiveDashboard's own output for the same project — the Go-Live page reads the same computation", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);
  const direct = buildGoLiveDashboard(data, projectA, now);

  assert.deepEqual(state.goLive, direct);
});

// ── 7. Reports use the same open-risk/open-decision/test counts ────────────

run("two independent consumers reading ProjectState (a report-style view and a workspace view) agree on open-risk/open-decision/test counts", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);
  const workspace = buildProjectWorkspace(data, projectA, now);

  assert.equal(state.rollups.risks.open, workspace.highRisks.length + workspace.scoped.risks.filter((r) => isRiskOpen(r.status) && !(r.impact === "High" || r.impact === "Critical")).length);
  assert.equal(state.rollups.decisions.open, workspace.openDecisions.length);
  assert.equal(state.rollups.tests.total, workspace.scoped.test_cases.length);
});

// ── 8. Daily brief and email content use the same project state ────────────

run("lib/daily-brief.ts and lib/email-content.ts's Go-Live alerts both reflect the same ProjectState facts for the same project", () => {
  const data = buildTwoProjectFixture();
  const projectA = data.projects.find((p) => p.id === PROJECT_A_ID);
  const state = buildProjectState(data, projectA, now);

  const brief = buildDailyBrief(data, now);
  const briefProjectA = brief.projects.find((p) => p.project.id === PROJECT_A_ID);
  assert.equal(briefProjectA.health, state.projectHealth);
  assert.equal(briefProjectA.scheduleHealth, state.scheduleHealth ?? "Review");
  assert.equal(briefProjectA.progress, state.progress.overall);

  const automatedBrief = buildAutomatedDailyBrief(data, now);
  assert.ok(automatedBrief.html.includes("CR028"), "automated daily brief includes the project by name");

  const managerEmail = buildManagerSummaryEmail(data, now);
  if (state.goLive.status === "Red") {
    assert.ok(managerEmail.text.includes("Go-live readiness is RED"), "manager email surfaces the same Red go-live status ProjectState computed");
  }
});

// ── 9. No duplicate build of project state within one tested request path ──

run("buildDailyBrief calls buildProjectState exactly once per canonical project, not once per figure", () => {
  const data = buildTwoProjectFixture();
  const original = projectStateModule.buildProjectState;
  let callCount = 0;
  projectStateModule.buildProjectState = (...args) => { callCount += 1; return original(...args); };
  try {
    buildDailyBrief(data, now);
    // Two canonical projects in this fixture ⇒ exactly two buildProjectState calls.
    assert.equal(callCount, 2, `expected exactly one buildProjectState call per project, got ${callCount}`);
  } finally {
    projectStateModule.buildProjectState = original;
  }
});

run("buildManagerExceptionReport does not build a full ProjectState per project (classifyProject is called directly, keeping the report lightweight)", () => {
  const data = buildTwoProjectFixture();
  const original = projectStateModule.buildProjectState;
  let callCount = 0;
  projectStateModule.buildProjectState = (...args) => { callCount += 1; return original(...args); };
  try {
    buildManagerExceptionReport(data, now);
    assert.equal(callCount, 0, "buildManagerExceptionReport should classify directly via classifyProject, not via buildProjectState");
  } finally {
    projectStateModule.buildProjectState = original;
  }
});

// ── 10. Phase 0 / Phase 6 CR028 fixture remains internally consistent ───────

run("the CR028-shaped fixture's ProjectState is internally consistent with the standalone Phase 0/6 baselines", () => {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0], id: "project-cr028-phase7", name: "CR028 - Delivery Date Range", status: "In Progress",
    planned_start_date: "2026-06-01", planned_end_date: "2026-10-15", go_live_date: null,
  };
  const fixture = {
    ...data,
    projects: [project],
    timeline_items: [
      { id: "ph-1", project_id: project.id, phase_ref: "PH-001", phase_name: "Functional Analysis", start_date: "2026-06-01", end_date: "2026-06-15", owner: "Andy", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-15T00:00:00.000Z" },
      { id: "ph-2", project_id: project.id, phase_ref: "PH-002", phase_name: "Development", start_date: "2026-06-16", end_date: "2026-07-10", owner: "Development", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-16T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" },
      { id: "ph-3", project_id: project.id, phase_ref: "PH-003", phase_name: "System Integration Testing", start_date: "2026-07-11", end_date: "2026-07-20", owner: "QA Lead", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z" },
      { id: "ph-4", project_id: project.id, phase_ref: "PH-004", phase_name: "Customer UAT", start_date: "2026-07-21", end_date: "2026-10-10", owner: "Sysco", status: "In Progress", progress_percent: 25, notes: null, created_at: "2026-07-21T00:00:00.000Z", updated_at: now.toISOString() },
    ],
    milestones: [{ id: "m-go-live", milestone_ref: "M006", project_id: project.id, title: "Go Live", target_date: "2026-10-15", status: "Not Started", owner: "Project Team", notes: "", created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    requirements: [{ id: "req-1", project_id: project.id, requirement_ref: "REQ-001", title: "Delivery date range on order confirmation", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew Walker", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" }],
    acceptance_criteria: [{ id: "ac-1", project_id: project.id, requirement_id: "req-1", ac_ref: "AC-001", criterion: "Delivery date range displays correctly", description: null, status: "Met", owner: "QA Lead", evidence: null, notes: null, created_at: "2026-06-05T00:00:00.000Z", updated_at: "2026-07-18T00:00:00.000Z" }],
    deliverables: [{ id: "del-1", project_id: project.id, deliverable_ref: "DEL-001", title: "Delivery date range calculation service", description: null, workstream: "Backend", owner: "Development", priority: "Critical", status: "Ready for UAT", planned_completion_date: "2026-07-20", actual_completion_date: "2026-07-18", development_status: "Complete", sit_status: "Passed", uat_status: "In Progress", deployment_status: "Not Started", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-07-21T00:00:00.000Z" }],
    risks: [{ id: "risk-1", project_id: project.id, risk_ref: "RSK-001", description: "Replenishment calculation performance under peak load", impact: "Critical", probability: "Low", mitigation: "Load-tested in SIT; no further action required.", owner: "Andrew Walker", status: "Closed", trend: null, created_at: "2026-06-10T00:00:00.000Z", updated_at: "2026-07-19T00:00:00.000Z" }],
    decisions: [{ id: "dec-1", project_id: project.id, decision_ref: "DEC-001", question: "Should delivery date range apply to backorders?", decision: "Yes, with a distinct message.", owner: "Andrew Walker", status: "Complete", decision_date: "2026-06-25", due_date: "2026-06-20", created_at: "2026-06-15T00:00:00.000Z", updated_at: "2026-06-25T00:00:00.000Z" }],
    actions: [],
    dependencies: [],
    discovery_questions: [],
    test_cases: [
      { id: "test-1", project_id: project.id, test_ref: "TEST-001", scenario: "Delivery range shown for standard order", expected_result: "Range shown", actual_result: "Range shown", status: "Passed", owner: "QA Lead", created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-15T00:00:00.000Z" },
      { id: "test-2", project_id: project.id, test_ref: "TEST-002", scenario: "Delivery range shown for split shipment", expected_result: "Range shown per shipment", actual_result: "Range shown per shipment", status: "Passed", owner: "QA Lead", created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" },
    ],
    go_live_checklists: [{ id: "glc-1", project_id: project.id, category: "Customer Approval", item: "Customer sign-off on delivery date range UAT", owner: "Sysco", status: "Not Started", due_date: "2026-10-01", completed_date: null, notes: null, created_at: "2026-07-21T00:00:00.000Z", updated_at: "2026-07-21T00:00:00.000Z" }],
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
  };

  const state = buildProjectState(fixture, project, now);

  assert.equal(state.schedule.health, "Green");
  // 75% (was 67% pre-Phase-1): Warehouse Training's removal from the
  // 13-check model dropped the denominator from 9 to 8 assessed checks —
  // see tests/phase-1-provider-scope.test.mjs for the dedicated regression
  // coverage proving a historical Training checklist row stays inert.
  assert.equal(state.goLive.readinessPercent, 75);
  assert.equal(state.goLive.status, "Amber");
  assert.notEqual(state.managerSummary.status, "Red");
  assert.equal(state.confidence.rag, "Green");
  assert.equal(state.rollups.risks.open, 0, "the closed critical risk is not counted as open");
  assert.equal(state.rollups.tests.allPassed, true);
});

console.log("\nAll Phase 7 ProjectState tests passed.\n");
