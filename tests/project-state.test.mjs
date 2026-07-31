// Phase 0 baseline — captures TODAY's output from the five independent
// "is this project okay" engines against one CR028-shaped fixture:
//   development complete, SIT passed, UAT active, risks closed, tests passed,
//   acceptance criteria met, customer approval outstanding, production
//   deployment scheduled for October.
//
// This file intentionally has NO opinion about what the "right" answer should
// be — it locks in current behaviour so later phases of the Project State
// Engine consolidation can show their changes as reviewed diffs against this
// file, not silent regressions. See /Users/andrewwalker/.claude/plans/tingly-hopping-moonbeam.md.
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
const { buildManagerExceptionReport } = req("../lib/manager-summary.ts");
const { calculateProjectHealth, calculateScheduleHealth } = req("../lib/control-tower.ts");
const { computeDeliveryConfidence } = req("../lib/delivery-confidence.ts");
const { buildProjectIntelligence } = req("../lib/project-intelligence.ts");
const { calculateSchedule } = req("../lib/schedule.ts");
const { isDecisionOpen, isDecisionOverdue } = req("../lib/lifecycle/index.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "project-cr028";

// ── The CR028-shaped fixture ────────────────────────────────────────────────
// Timeline: Analysis/Development/SIT complete, Customer UAT in progress.
// Go-live target (both the milestone and planned_end_date, deliberately
// aligned in this fixture — the *disagreement* between them is a separate,
// Phase 3 concern) is in October, ~11 weeks after `now`.
function buildFixture() {
  const data = structuredClone(seedData);

  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "CR028 - Delivery Date Range",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-15",
  };

  const timeline_items = [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Functional Analysis", start_date: "2026-06-01", end_date: "2026-06-15", owner: "Andy", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-15T00:00:00.000Z" },
    { id: "ph-2", project_id: PROJECT_ID, phase_ref: "PH-002", phase_name: "Development", start_date: "2026-06-16", end_date: "2026-07-10", owner: "Development", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-16T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" },
    { id: "ph-3", project_id: PROJECT_ID, phase_ref: "PH-003", phase_name: "System Integration Testing", start_date: "2026-07-11", end_date: "2026-07-20", owner: "QA Lead", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z" },
    { id: "ph-4", project_id: PROJECT_ID, phase_ref: "PH-004", phase_name: "Customer UAT", start_date: "2026-07-21", end_date: "2026-10-10", owner: "Sysco", status: "In Progress", progress_percent: 25, notes: null, created_at: "2026-07-21T00:00:00.000Z", updated_at: now.toISOString() },
  ];

  const milestones = [
    { id: "m-go-live", milestone_ref: "M006", project_id: PROJECT_ID, title: "Go Live", target_date: "2026-10-15", status: "Not Started", owner: "Project Team", notes: "", created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const requirements = [
    { id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "Delivery date range on order confirmation", description: "Show earliest/latest delivery date on confirmation screen.", priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew Walker", source: "CR028 Replenishment discovery", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" },
  ];

  const acceptance_criteria = [
    { id: "ac-1", project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001", criterion: "Delivery date range displays correctly for all warehouse zones", description: null, status: "Met", owner: "QA Lead", evidence: "Verified in SIT run 2026-07-18", notes: null, created_at: "2026-06-05T00:00:00.000Z", updated_at: "2026-07-18T00:00:00.000Z" },
  ];

  const deliverables = [
    {
      id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "Delivery date range calculation service",
      description: null, workstream: "Backend", owner: "Development", priority: "Critical", status: "Ready for UAT",
      planned_completion_date: "2026-07-20", actual_completion_date: "2026-07-18",
      development_status: "Complete", sit_status: "Passed", uat_status: "In Progress", deployment_status: "Not Started",
      notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-07-21T00:00:00.000Z",
    },
  ];

  const risks = [
    // Previously a critical risk, now fully closed — must not read as open/unmitigated anywhere.
    { id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "Replenishment calculation performance under peak load", impact: "Critical", probability: "Low", mitigation: "Load-tested in SIT; no further action required.", owner: "Andrew Walker", status: "Closed", trend: null, created_at: "2026-06-10T00:00:00.000Z", updated_at: "2026-07-19T00:00:00.000Z" },
  ];

  const decisions = [
    // Previously open, now Complete — the exact shape of the historically-confirmed
    // "completed decisions counted as open" bug this suite guards against.
    { id: "dec-1", project_id: PROJECT_ID, decision_ref: "DEC-001", question: "Should delivery date range apply to backorders?", decision: "Yes, with a distinct message.", owner: "Andrew Walker", status: "Complete", decision_date: "2026-06-25", due_date: "2026-06-20", created_at: "2026-06-15T00:00:00.000Z", updated_at: "2026-06-25T00:00:00.000Z" },
  ];

  const test_cases = [
    { id: "test-1", project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "Delivery range shown for standard order", expected_result: "Range shown", actual_result: "Range shown", status: "Passed", owner: "QA Lead", created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-15T00:00:00.000Z" },
    { id: "test-2", project_id: PROJECT_ID, test_ref: "TEST-002", scenario: "Delivery range shown for split shipment", expected_result: "Range shown per shipment", actual_result: "Range shown per shipment", status: "Passed", owner: "QA Lead", created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" },
  ];

  // Exactly one outstanding manual go-live item: Customer Approval.
  // No rows at all for Requirements/Development/SIT/UAT/Training/Deployment/
  // Rollback/Hypercare/Support — reproducing today's "empty checklist ⇒ 0%"
  // defect even though the project is materially in good shape.
  const go_live_checklists = [
    { id: "glc-1", project_id: PROJECT_ID, category: "Customer Approval", item: "Customer sign-off on delivery date range UAT", owner: "Sysco", status: "Not Started", due_date: "2026-10-01", completed_date: null, notes: null, created_at: "2026-07-21T00:00:00.000Z", updated_at: "2026-07-21T00:00:00.000Z" },
  ];

  return {
    ...data,
    projects: [project],
    timeline_items,
    milestones,
    requirements,
    acceptance_criteria,
    deliverables,
    risks,
    decisions,
    actions: [],
    dependencies: [],
    discovery_questions: [],
    test_cases,
    project_snapshots: [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    go_live_checklists,
    cutover_plan: [],
    activity_log: [],
    documents: [],
    meetings: [],
  };
}

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// ── Baseline capture ─────────────────────────────────────────────────────────
const data = buildFixture();
const project = data.projects[0];
const schedule = calculateSchedule(project, data.timeline_items, now);
const goLive = buildGoLiveDashboard(data, project, now);
const managerReport = buildManagerExceptionReport(data, now);
const managerSummary = managerReport.projects.find((p) => p.project.id === PROJECT_ID);
const controlTowerHealth = calculateProjectHealth(0, 0, schedule.variance ?? 0);
const scheduleHealthOnly = calculateScheduleHealth(schedule.variance ?? 0);
const confidence = computeDeliveryConfidence(data);
const intelligence = buildProjectIntelligence(data, project, now);

const baseline = {
  schedule: { health: schedule.health, variance: schedule.variance, daysRemaining: schedule.daysRemaining, projectEnd: schedule.projectEnd },
  goLive: { status: goLive.status, readinessPercent: goLive.readinessPercent, completedItems: goLive.completedItems, totalItems: goLive.totalItems, daysToGoLive: goLive.daysToGoLive },
  managerSummary: { status: managerSummary?.status, dateConfidence: managerSummary?.dateConfidence, managementAction: managerSummary?.managementAction },
  controlTowerHealth,
  scheduleHealthOnly,
  confidence: { score: confidence.score, rag: confidence.rag },
  intelligence: {
    criticalCount: intelligence.critical.length,
    warningCount: intelligence.warnings.length,
    critical: intelligence.critical.map((f) => ({ ruleId: f.ruleId, title: f.title })),
    warnings: intelligence.warnings.map((f) => ({ ruleId: f.ruleId, title: f.title })),
  },
};

console.log("\n=== Phase 0 baseline — CR028-shaped fixture ===");
console.log(JSON.stringify(baseline, null, 2));
console.log("================================================\n");

// ── Assertions locking in today's behaviour ─────────────────────────────────

run("schedule: variance and health reflect three complete phases + UAT in progress, not a stale end date", () => {
  assert.equal(schedule.projectEnd, "2026-10-15");
  assert.ok(schedule.daysRemaining > 60, `expected >60 days remaining, got ${schedule.daysRemaining}`);
  // Locking in today's actual computed health/variance for this fixture (captured, not asserted a priori).
  assert.equal(schedule.health, "Green");
  assert.ok(schedule.variance >= 0, `expected non-negative variance, got ${schedule.variance}`);
});

run("decisions: a Complete decision is correctly excluded from open/overdue everywhere (the historically-fixed bug stays fixed)", () => {
  assert.equal(isDecisionOpen(data.decisions[0].status), false);
  assert.equal(isDecisionOverdue(data.decisions[0].due_date, data.decisions[0].status, now), false);
  assert.equal(managerReport.projects.find((p) => p.project.id === PROJECT_ID).status, managerSummary.status);
  // GOV-001 (open decisions not reviewed recently) must not fire for a Complete decision.
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GOV-001"), false);
});

run("risks: a Closed critical risk is correctly excluded from unmitigated/open-critical checks everywhere", () => {
  assert.equal(managerSummary.status !== "Red" || managerSummary.summary.includes("critical risk") === false, true);
  assert.equal(intelligence.findings.some((f) => f.ruleId === "RSK-001"), false);
});

run("BASELINE (defect, not a fix): Go-Live Readiness reads near-zero and Red despite dev/SIT complete, UAT active, tests passed, AC met — because go_live_checklists has only one manual row", () => {
  assert.equal(goLive.totalItems, 1);
  assert.equal(goLive.completedItems, 0);
  assert.equal(goLive.readinessPercent, 0);
  assert.equal(goLive.status, "Red");
});

run("BASELINE: Manager Exception Report does not falsely go Red purely from a distant (October) go-live date", () => {
  assert.notEqual(managerSummary.status, "Red");
});

run("BASELINE: Delivery Confidence score is high (no unresolved risk/test/decision penalties) for this healthy fixture", () => {
  assert.ok(confidence.score >= 90, `expected high confidence, got ${confidence.score}`);
  assert.equal(confidence.rag, "Green");
});

run("BASELINE: Control Tower health and standalone schedule health agree with calculateSchedule().health for this fixture", () => {
  assert.equal(controlTowerHealth, "Green");
  assert.equal(scheduleHealthOnly, "Green");
});

console.log("\nAll Phase 0 baseline assertions passed against current (pre-refactor) code.\n");
