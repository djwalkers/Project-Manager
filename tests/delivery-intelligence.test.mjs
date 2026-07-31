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

const {
  buildDeliveryDiagnostics,
  buildDeliveryInsightAnalysis,
  buildRecommendations,
  recommendationPenalty,
} = Module.createRequire(import.meta.url)("../lib/recommendations.ts");
const { computeDeliveryConfidence } = Module.createRequire(import.meta.url)("../lib/delivery-confidence.ts");
const { seedData } = Module.createRequire(import.meta.url)("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");

function baseData() {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: "project-1",
    name: "CR028 - Test Project",
    status: "In Progress",
    planned_start_date: "2026-07-01",
    planned_end_date: "2026-08-31",
  };
  return {
    ...data,
    projects: [project],
    deliverables: [],
    requirements: [],
    risks: [],
    decisions: [],
    actions: [],
    dependencies: [],
    discovery_questions: [],
    milestones: [],
    timeline_items: [],
    test_cases: [],
    project_snapshots: [],
    acceptance_criteria: [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    go_live_checklists: [],
    cutover_plan: [],
  };
}

function withUatPhase(data) {
  data.timeline_items.push({
    id: "phase-uat",
    project_id: "project-1",
    phase_ref: "PH-UAT",
    phase_name: "Customer UAT",
    start_date: "2026-07-20",
    end_date: "2026-08-05",
    owner: "Customer",
    status: "In Progress",
    progress_percent: 20,
    notes: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  });
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

run("derives UAT phase from active timeline", () => {
  const data = baseData();
  withUatPhase(data);
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.phase.phase, "UAT");
  assert.equal(diagnostics.phase.source, "timeline");
});

run("generated insights are explainable and traceable", () => {
  const data = baseData();
  withUatPhase(data);
  data.risks.push({
    id: "risk-4",
    project_id: "project-1",
    risk_ref: "RSK-004",
    description: "Customer UAT defect triage capacity may be insufficient",
    impact: "High",
    probability: "Medium",
    mitigation: "",
    owner: "Delivery Manager",
    status: "Open",
    trend: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  });

  const insight = buildDeliveryInsightAnalysis(data, 5, now).insights.find((item) => item.source.includes("RSK-004"));
  assert.ok(insight, "expected risk insight");
  assert.match(insight.explanation, /RSK-004|risk|UAT|source/i);
  assert.deepEqual(insight.source, ["RSK-004"]);
});

run("completed decisions are suppressed by lifecycle before insight generation", () => {
  const data = baseData();
  withUatPhase(data);
  data.decisions.push({
    id: "decision-1",
    project_id: "project-1",
    decision_ref: "DEC-001",
    question: "Should development continue?",
    decision: "Approved",
    owner: "PM",
    status: "Complete",
    decision_date: "2026-07-01",
    due_date: "2026-07-10",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.insights.some((item) => item.source.includes("DEC-001")), false);
  assert.equal(diagnostics.suppressedInsights.some((item) => item.source.includes("DEC-001")), false);
});

run("low phase relevance non-critical insights are diagnostically suppressed", () => {
  const data = baseData();
  withUatPhase(data);
  data.requirements.push({
    id: "req-1",
    project_id: "project-1",
    requirement_ref: "REQ-001",
    title: "Legacy development-only requirement",
    description: null,
    priority: "High",
    category: "Business Rule",
    status: "In Progress",
    owner: "Dev",
    source: null,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.insights.some((item) => item.source.includes("REQ-001")), false);
  assert.equal(diagnostics.suppressedInsights.some((item) => item.source.includes("REQ-001")), true);
});

run("confidence deductions come from delivery insights", () => {
  const data = baseData();
  withUatPhase(data);
  data.test_cases.push({
    id: "test-6",
    project_id: "project-1",
    test_ref: "TEST-006",
    scenario: "Customer validates replenishment totals",
    expected_result: "Totals match",
    actual_result: "Mismatch",
    status: "Failed",
    owner: "QA",
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  });

  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  const deduction = diagnostics.confidenceDeductions.find((item) => item.source.includes("TEST-006"));
  assert.ok(deduction);
  assert.ok(deduction.impact > 0);
  assert.equal(recommendationPenalty(diagnostics.insights.find((item) => item.source.includes("TEST-006"))), deduction.impact);
  assert.ok(computeDeliveryConfidence(data).score < 100);
});

run("contradictory states produce diagnostic warnings without failing", () => {
  const data = baseData();
  withUatPhase(data);
  data.deliverables.push({
    id: "del-1",
    project_id: "project-1",
    deliverable_ref: "DEL-005",
    title: "_createTransferRequirement()",
    description: null,
    workstream: "Backend",
    owner: "Dev",
    priority: "High",
    status: "SIT Complete",
    planned_completion_date: "2026-07-10",
    actual_completion_date: null,
    development_status: "Complete",
    sit_status: "Passed",
    uat_status: "Not Started",
    deployment_status: "Not Started",
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  data.test_cases.push({
    id: "test-7",
    project_id: "project-1",
    test_ref: "TEST-007",
    scenario: "SIT regression",
    expected_result: null,
    actual_result: null,
    status: "Pending",
    owner: "QA",
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.ok(diagnostics.warnings.some((warning) => warning.id === "sit-complete-tests-not-started"));
  assert.ok(diagnostics.warnings.some((warning) => warning.id === "uat-active-no-deliverable-ready"));
});

run("recommendation adapter preserves existing public fields", () => {
  const data = baseData();
  withUatPhase(data);
  data.risks.push({
    id: "risk-adapter",
    project_id: "project-1",
    risk_ref: "RSK-010",
    description: "Customer sign-off risk",
    impact: "Critical",
    probability: "High",
    mitigation: "",
    owner: "PM",
    status: "Open",
    trend: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  });
  const recommendation = buildRecommendations(data, 1)[0];
  for (const field of ["id", "type", "urgency", "title", "reason", "href", "score"]) {
    assert.ok(field in recommendation, `missing ${field}`);
  }
});

run("SIT complete with passed tests derives UAT readiness from deliverables", () => {
  const data = baseData();
  data.deliverables.push({
    id: "del-uat-ready",
    project_id: "project-1",
    deliverable_ref: "DEL-010",
    title: "Customer UAT package",
    description: null,
    workstream: "Testing",
    owner: "PM",
    priority: "High",
    status: "Ready for UAT",
    planned_completion_date: "2026-08-01",
    actual_completion_date: null,
    development_status: "Complete",
    sit_status: "Passed",
    uat_status: "In Progress",
    deployment_status: "Ready",
    notes: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  });
  data.test_cases.push({
    id: "test-passed",
    project_id: "project-1",
    test_ref: "TEST-010",
    scenario: "SIT scenario",
    expected_result: "Pass",
    actual_result: "Pass",
    status: "Passed",
    owner: "QA",
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.phase.phase, "UAT");
  assert.equal(diagnostics.phase.source, "deliverables");
});

run("normal UAT readiness creates no critical recommendation and only low confidence impact", () => {
  const data = baseData();
  data.deliverables.push({
    id: "del-normal-uat",
    project_id: "project-1",
    deliverable_ref: "DEL-011",
    title: "UAT pack",
    description: null,
    workstream: "Testing",
    owner: "PM",
    priority: "High",
    status: "Ready for UAT",
    planned_completion_date: "2026-08-05",
    actual_completion_date: null,
    development_status: "Complete",
    sit_status: "Passed",
    uat_status: "In Progress",
    deployment_status: "Ready",
    notes: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.insights.some((item) => item.priority === "critical"), false);
  const totalImpact = diagnostics.confidenceDeductions.reduce((sum, item) => sum + item.impact, 0);
  assert.ok(totalImpact <= 3, `expected low impact, got ${totalImpact}`);
});

run("completed development artefacts do not dominate UAT recommendations", () => {
  const data = baseData();
  data.deliverables.push({
    id: "del-completed-dev",
    project_id: "project-1",
    deliverable_ref: "DEL-012",
    title: "Development complete package",
    description: null,
    workstream: "Backend",
    owner: "Dev",
    priority: "High",
    status: "Ready for UAT",
    planned_completion_date: "2026-07-01",
    actual_completion_date: null,
    development_status: "Complete",
    sit_status: "Passed",
    uat_status: "In Progress",
    deployment_status: "Ready",
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.insights.some((item) => /Replan overdue deliverable/.test(item.title) && item.source.includes("DEL-012")), false);
});

run("met acceptance criteria without evidence are not treated as missing evidence", () => {
  const data = baseData();
  withUatPhase(data);
  data.acceptance_criteria.push({
    id: "ac-met",
    project_id: "project-1",
    requirement_id: "req-x",
    ac_ref: "AC-100",
    criterion: "Customer can complete UAT",
    description: null,
    status: "Met",
    owner: "QA",
    evidence: null,
    notes: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.equal(diagnostics.insights.some((item) => item.id === "acceptance-missing-evidence"), false);
});

run("stale prior-phase dependencies become diagnostics instead of confidence deductions", () => {
  const data = baseData();
  withUatPhase(data);
  data.dependencies.push({
    id: "dep-stale",
    project_id: "project-1",
    name: "System Integration Test Environment",
    owner: "QA",
    status: "In Progress",
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  assert.ok(diagnostics.warnings.some((warning) => warning.id === "prior-phase-dependencies-still-open"));
  assert.equal(diagnostics.confidenceDeductions.some((item) => item.source.includes("System Integration Test Environment")), false);
  assert.equal(diagnostics.suppressedInsights.some((item) => item.source.includes("System Integration Test Environment")), true);
});

run("failed tests still produce material confidence impact during UAT", () => {
  const data = baseData();
  withUatPhase(data);
  data.test_cases.push({
    id: "test-failed-material",
    project_id: "project-1",
    test_ref: "TEST-020",
    scenario: "UAT regression",
    expected_result: "Pass",
    actual_result: "Fail",
    status: "Failed",
    owner: "QA",
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  const deduction = diagnostics.confidenceDeductions.find((item) => item.source.includes("TEST-020"));
  assert.ok(deduction);
  assert.ok(deduction.impact >= 6);
});

run("duplicate source artefacts do not produce duplicate generated insights", () => {
  const data = baseData();
  data.deliverables.push({
    id: "del-duplicate",
    project_id: "project-1",
    deliverable_ref: "DEL-020",
    title: "UAT duplicate source package",
    description: null,
    workstream: "Testing",
    owner: "PM",
    priority: "High",
    status: "Ready for UAT",
    planned_completion_date: "2026-07-01",
    actual_completion_date: null,
    development_status: "Complete",
    sit_status: "Passed",
    uat_status: "In Progress",
    deployment_status: "Ready",
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  const diagnostics = buildDeliveryDiagnostics(data, undefined, now);
  const count = diagnostics.insights.filter((item) => item.source.includes("DEL-020")).length;
  assert.equal(count, 1);
});
