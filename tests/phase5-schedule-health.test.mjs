// Phase 5 — schedule-health unification and the Manager Exception Report
// compound RED rule.
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
const { calculateSchedule } = req("../lib/schedule.ts");
const { calculateProjectHealth, calculateProgress } = req("../lib/control-tower.ts");
const { buildManagerExceptionReport } = req("../lib/manager-summary.ts");
const { buildDeliveryDiagnostics } = req("../lib/recommendations.ts");
const { materialTestFailures } = req("../lib/delivery-materiality.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "phase5-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// A healthy CR028-shaped baseline: three complete phases + UAT in progress,
// no risks/blocked deliverables/failed tests — Green schedule, Green Manager RAG.
// Each scenario test clones this and adds exactly one signal, to prove that
// signal in isolation.
function baseFixture(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Phase 5 Test Project",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-15",
    go_live_date: null,
    ...overrides.project,
  };
  const timeline_items = overrides.timeline_items ?? [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Functional Analysis", start_date: "2026-06-01", end_date: "2026-06-15", owner: "Andy", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-15T00:00:00.000Z" },
    { id: "ph-2", project_id: PROJECT_ID, phase_ref: "PH-002", phase_name: "Development", start_date: "2026-06-16", end_date: "2026-07-10", owner: "Development", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-16T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" },
    { id: "ph-3", project_id: PROJECT_ID, phase_ref: "PH-003", phase_name: "System Integration Testing", start_date: "2026-07-11", end_date: "2026-07-20", owner: "QA Lead", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z" },
    { id: "ph-4", project_id: PROJECT_ID, phase_ref: "PH-004", phase_name: "Customer UAT", start_date: "2026-07-21", end_date: "2026-10-10", owner: "Sysco", status: "In Progress", progress_percent: 25, notes: null, created_at: "2026-07-21T00:00:00.000Z", updated_at: now.toISOString() },
  ];
  return {
    ...data,
    projects: [project],
    timeline_items,
    milestones: overrides.milestones ?? [],
    risks: overrides.risks ?? [],
    decisions: [],
    actions: [],
    dependencies: [],
    discovery_questions: [],
    test_cases: overrides.test_cases ?? [],
    project_snapshots: [],
    requirements: overrides.requirements ?? [],
    acceptance_criteria: overrides.acceptance_criteria ?? [],
    deliverables: overrides.deliverables ?? [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    go_live_checklists: [],
    cutover_plan: [],
    activity_log: [],
    documents: [],
    meetings: [],
  };
}

function managerStatusFor(data) {
  const report = buildManagerExceptionReport(data, now);
  return report.projects.find((p) => p.project.id === PROJECT_ID);
}

// ── 1. Control Tower and Manager Summary consume schedule.health ───────────

run("calculateProjectHealth and calculateProgress consume a RagStatus (schedule.health), not a raw variance number", () => {
  const data = baseFixture();
  const project = data.projects[0];
  const schedule = calculateSchedule(project, data.timeline_items, now);
  assert.equal(typeof schedule.health, "string");
  // Passing the health value directly (not schedule.variance) must work and
  // produce a sensible result — this is the actual call shape every consumer uses now.
  const health = calculateProjectHealth(0, 0, schedule.health);
  assert.equal(health, schedule.health === "Red" ? "Red" : schedule.health === "Amber" ? "Amber" : "Green");
  const progress = calculateProgress(data, schedule.health);
  assert.ok(["down", "flat", "up"].includes(progress.trend.direction));
});

run("Manager Summary's dateConfidence is derived from schedule.health, not an independent variance threshold", () => {
  const data = baseFixture();
  const summary = managerStatusFor(data);
  assert.equal(summary.dateConfidence, "On Track");
});

// ── 2. Stale/past planned_end_date does not create RED when go-live is >30 days away ──

run("a project whose planned_end_date has already passed (schedule.health Red via isPastEnd) does NOT go Red when the authoritative go-live date is more than 30 days away", () => {
  const data = baseFixture({
    project: { planned_end_date: "2026-07-01", go_live_date: "2026-10-15" }, // past end date, but go-live is ~79 days out
  });
  const project = data.projects[0];
  const schedule = calculateSchedule(project, data.timeline_items, now);
  assert.equal(schedule.health, "Red", "sanity check: the stale end date must make schedule.health Red");
  const summary = managerStatusFor(data);
  assert.notEqual(summary.status, "Red", "Manager RAG must not go Red on a stale schedule alone when go-live is far away");
});

// ── 3. Red schedule health within 30 days of go-live creates RED ───────────

run("Red schedule health with the authoritative go-live within 30 days creates Manager RED", () => {
  // Single timeline item spanning the whole project, sized to land in the -10% to -15% variance band.
  const timeline_items = [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Development", start_date: "2026-01-01", end_date: "2026-06-30", owner: "Dev", status: "In Progress", progress_percent: 37, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: now.toISOString() },
  ];
  const data = baseFixture({
    project: { planned_start_date: "2026-01-01", planned_end_date: "2026-06-30", go_live_date: "2026-04-20" }, // ~19 days from "now" (2026-04-01, set below)
    timeline_items,
  });
  const project = data.projects[0];
  const nearNow = new Date("2026-04-01T12:00:00Z");
  const schedule = calculateSchedule(project, data.timeline_items, nearNow);
  assert.ok(schedule.variance <= -10 && schedule.variance >= -15, `expected variance in the -10 to -15 band, got ${schedule.variance}`);
  assert.equal(schedule.health, "Red", "sanity check: this variance must be Red under the central schedule health definition");

  const report = buildManagerExceptionReport(data, nearNow);
  const summary = report.projects.find((p) => p.project.id === PROJECT_ID);
  assert.equal(summary.status, "Red", "Red schedule health within 30 days of the authoritative go-live must create Manager RED");
});

run("the SAME Red schedule health with go-live MORE than 30 days away does not by itself create Manager RED", () => {
  const timeline_items = [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Development", start_date: "2026-01-01", end_date: "2026-06-30", owner: "Dev", status: "In Progress", progress_percent: 37, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: now.toISOString() },
  ];
  const data = baseFixture({
    project: { planned_start_date: "2026-01-01", planned_end_date: "2026-06-30", go_live_date: null }, // no milestone, no go_live_date → falls back to planned_end_date, ~90 days from nearNow
    timeline_items,
  });
  const project = data.projects[0];
  const nearNow = new Date("2026-04-01T12:00:00Z");
  const schedule = calculateSchedule(project, data.timeline_items, nearNow);
  assert.equal(schedule.health, "Red", "sanity check: same Red schedule health as the previous test");

  const report = buildManagerExceptionReport(data, nearNow);
  const summary = report.projects.find((p) => p.project.id === PROJECT_ID);
  assert.notEqual(summary.status, "Red", "Red schedule health alone, with go-live far away, must not create Manager RED");
});

// ── 4. Unmitigated Critical risk creates RED ────────────────────────────────

run("an unmitigated Critical risk creates Manager RED even with an otherwise healthy schedule", () => {
  const data = baseFixture({
    risks: [{ id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "Unmitigated critical risk", impact: "Critical", probability: "High", mitigation: "", owner: "PM", status: "Open", trend: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const summary = managerStatusFor(data);
  assert.equal(summary.status, "Red");
});

// ── 5. Blocked High/Critical deliverable creates RED; low-priority does not ─

run("a blocked Critical-priority deliverable creates Manager RED", () => {
  const data = baseFixture({
    deliverables: [{ id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "Blocked critical deliverable", description: null, workstream: "Backend", owner: "Dev", priority: "Critical", status: "Blocked", planned_completion_date: "2026-08-01", actual_completion_date: null, development_status: "Blocked", sit_status: "Not Started", uat_status: "Not Started", deployment_status: "Not Started", notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const summary = managerStatusFor(data);
  assert.equal(summary.status, "Red");
});

run("a blocked LOW-priority deliverable does not by itself create Manager RED (Amber at most)", () => {
  const data = baseFixture({
    deliverables: [{ id: "del-2", project_id: PROJECT_ID, deliverable_ref: "DEL-002", title: "Blocked low-priority deliverable", description: null, workstream: "Backend", owner: "Dev", priority: "Low", status: "Blocked", planned_completion_date: "2026-08-01", actual_completion_date: null, development_status: "Blocked", sit_status: "Not Started", uat_status: "Not Started", deployment_status: "Not Started", notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const summary = managerStatusFor(data);
  assert.notEqual(summary.status, "Red");
  assert.equal(summary.status, "Amber", "a blocked deliverable of any priority should still raise Amber");
});

// ── 6. Failed test materiality is phase-gated ───────────────────────────────

run("a Failed test during UAT creates Manager RED", () => {
  const data = baseFixture({
    test_cases: [{ id: "test-1", project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "Customer UAT regression", expected_result: "Pass", actual_result: "Fail", status: "Failed", owner: "QA", created_at: "2026-07-21T00:00:00.000Z", updated_at: "2026-07-22T00:00:00.000Z" }],
  });
  const project = data.projects[0];
  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  assert.equal(diagnostics.phase.phase, "UAT", "sanity check: this fixture's derived phase must be UAT");
  const summary = managerStatusFor(data);
  assert.equal(summary.status, "Red");
});

run("a Failed test during Development does not automatically create Manager RED", () => {
  const timeline_items = [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Development", start_date: "2026-06-01", end_date: "2026-08-01", owner: "Dev", status: "In Progress", progress_percent: 50, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString() },
  ];
  const data = baseFixture({
    timeline_items,
    test_cases: [{ id: "test-2", project_id: PROJECT_ID, test_ref: "TEST-002", scenario: "Unit test", expected_result: "Pass", actual_result: "Fail", status: "Failed", owner: "Dev", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const project = data.projects[0];
  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  assert.equal(diagnostics.phase.phase, "Development", "sanity check: this fixture's derived phase must be Development");
  assert.equal(materialTestFailures(data.test_cases, diagnostics.phase.phase).length, 0, "a failed test in Development is not material by the shared helper");
  const summary = managerStatusFor(data);
  assert.notEqual(summary.status, "Red", "a failed test outside SIT/UAT/Deployment must not automatically create Manager RED");
});

// ── 7. Failed AC linked to a High/Critical requirement creates RED ─────────

run("a failed acceptance criterion linked to a Critical-priority requirement creates Manager RED", () => {
  const data = baseFixture({
    requirements: [{ id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "Critical requirement", description: "desc", priority: "Critical", category: "Business Rule", status: "Approved", owner: "PM", source: "workshop", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    acceptance_criteria: [{ id: "ac-1", project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001", criterion: "Failed criterion on critical requirement", description: null, status: "Failed", owner: "QA", evidence: null, notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const summary = managerStatusFor(data);
  assert.equal(summary.status, "Red");
});

run("a failed acceptance criterion linked to a Low-priority requirement does not automatically create Manager RED", () => {
  const data = baseFixture({
    requirements: [{ id: "req-2", project_id: PROJECT_ID, requirement_ref: "REQ-002", title: "Low priority requirement", description: "desc", priority: "Low", category: "Business Rule", status: "Approved", owner: "PM", source: "workshop", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    acceptance_criteria: [{ id: "ac-2", project_id: PROJECT_ID, requirement_id: "req-2", ac_ref: "AC-002", criterion: "Failed criterion on low-priority requirement", description: null, status: "Failed", owner: "QA", evidence: null, notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const summary = managerStatusFor(data);
  assert.notEqual(summary.status, "Red");
});

// ── 8. Blocked test: warning vs material distinction ────────────────────────

run("a Blocked test outside the material phase window still surfaces as a diagnostic warning, but does not drive Manager RED", () => {
  const timeline_items = [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Development", start_date: "2026-06-01", end_date: "2026-08-01", owner: "Dev", status: "In Progress", progress_percent: 50, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString() },
  ];
  const data = baseFixture({
    timeline_items,
    test_cases: [{ id: "test-3", project_id: PROJECT_ID, test_ref: "TEST-003", scenario: "Blocked during development", expected_result: null, actual_result: null, status: "Blocked", owner: "Dev", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" }],
  });
  const project = data.projects[0];
  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  assert.equal(diagnostics.insights.some((i) => i.source.includes("TEST-003")), true, "the blocked test must still surface as a warning/insight");
  assert.equal(materialTestFailures(data.test_cases, diagnostics.phase.phase).length, 0, "not material outside SIT/UAT/Deployment");
  const summary = managerStatusFor(data);
  assert.notEqual(summary.status, "Red");
});

// ── 9. Normal UAT-stage project remains non-Red ─────────────────────────────

run("a normal, healthy UAT-stage project (no risks/blockers/failures) remains non-Red", () => {
  const data = baseFixture();
  const summary = managerStatusFor(data);
  assert.notEqual(summary.status, "Red");
  assert.equal(summary.status, "Green");
});

// ── 10. Structural: no direct schedule-variance thresholds remain in consumers ──

run("structural: no raw schedule-variance threshold literals remain in lib/control-tower.ts or lib/manager-summary.ts", () => {
  for (const file of ["lib/control-tower.ts", "lib/manager-summary.ts"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /<=\s*-1[015]\b/, `${file} still contains a raw -10/-11/-15 variance threshold`);
    assert.doesNotMatch(source, /variance\s*<\s*-5/, `${file} still contains a raw -5 variance threshold`);
  }
});

run("structural: the dead daysRemaining < 0 branch is removed from lib/manager-summary.ts", () => {
  const source = fs.readFileSync(path.join(root, "lib/manager-summary.ts"), "utf8");
  assert.doesNotMatch(source, /daysRemaining\s*<\s*0/, "the unreachable daysRemaining < 0 branch should have been removed");
});

console.log("\nAll Phase 5 schedule-health tests passed.\n");
