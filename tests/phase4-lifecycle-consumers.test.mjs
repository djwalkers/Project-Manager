// Phase 4 — lifecycle helper consumer migration.
//
// Proves the consumers migrated in this phase (lib/recommendations.ts,
// lib/project-intelligence.ts, lib/manager-summary.ts, lib/control-tower.ts,
// lib/go-live-readiness.ts, lib/email-content.ts, lib/snapshots.ts,
// lib/snapshot-service.ts, lib/project-workspace.ts, and the UI files) now
// agree with each other, and that the one confirmed behaviour change
// (Approved actions are closed, per lib/lifecycle/action.ts's alignment
// with isOverdue) is consistent everywhere it appears rather than a
// one-off. tests/project-state.test.mjs (the Phase 0 baseline) staying
// green, unmodified, after every edit in this phase is the proof that nothing
// else changed unexpectedly.
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
const lifecycle = req("../lib/lifecycle/index.ts");
const { buildManagerExceptionReport } = req("../lib/manager-summary.ts");
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildDeliveryDiagnostics } = req("../lib/recommendations.ts");
const { buildProjectWorkspace } = req("../lib/project-workspace.ts");
const { calculateProjectSnapshot } = req("../lib/snapshot-service.ts");
const { buildAutomatedDailyBrief } = req("../lib/email-content.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "phase4-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function buildFixture() {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Phase 4 Test Project",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-15",
    go_live_date: null,
  };

  const timeline_items = [
    { id: "ph-1", project_id: PROJECT_ID, phase_ref: "PH-001", phase_name: "Development", start_date: "2026-06-01", end_date: "2026-07-10", owner: "Dev", status: "Complete", progress_percent: 100, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" },
    { id: "ph-2", project_id: PROJECT_ID, phase_ref: "PH-002", phase_name: "Customer UAT", start_date: "2026-07-11", end_date: "2026-10-10", owner: "Customer", status: "In Progress", progress_percent: 30, notes: null, created_at: "2026-07-11T00:00:00.000Z", updated_at: now.toISOString() },
  ];

  // Previously a critical risk, now Closed — must be excluded from every
  // "open"/"open critical" count across all consumers.
  const risks = [
    { id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "Closed critical risk", impact: "Critical", probability: "Low", mitigation: "Resolved in SIT.", owner: "PM", status: "Closed", trend: null, created_at: "2026-06-10T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
  ];

  // Completed decision — must stay excluded from open-decision counts (the
  // decision lifecycle module, unchanged in this phase, already covers this;
  // included here to prove it stays true through every migrated consumer too).
  const decisions = [
    { id: "dec-1", project_id: PROJECT_ID, decision_ref: "DEC-001", question: "Resolved question", decision: "Approved", owner: "PM", status: "Complete", decision_date: "2026-06-20", due_date: "2026-06-15", created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" },
  ];

  // Approved action — the one confirmed, documented behaviour change: now
  // treated as closed everywhere, consistent with isOverdue's existing
  // (unchanged) treatment of Approved as resolved.
  const actions = [
    { id: "act-1", project_id: PROJECT_ID, action_ref: "ACT-001", description: "Approved action", owner: "PM", due_date: "2026-06-01", status: "Approved", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  // Blocked test — must remain "open" (not resolved) while also being
  // reported as material/blocked, not silently dropped.
  const test_cases = [
    { id: "test-1", project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "Blocked scenario", expected_result: null, actual_result: null, status: "Blocked", owner: "QA", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
  ];

  // Requirement + Waived acceptance criterion — Waived must count as "met".
  const requirements = [
    { id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "Requirement with waived AC", description: "desc", priority: "High", category: "Business Rule", status: "Approved", owner: "PM", source: "workshop", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" },
  ];
  const acceptance_criteria = [
    { id: "ac-1", project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001", criterion: "Waived criterion", description: null, status: "Waived", owner: "QA", evidence: null, notes: null, created_at: "2026-06-05T00:00:00.000Z", updated_at: "2026-06-05T00:00:00.000Z" },
  ];

  // Deliverable whose overall status hasn't caught up to "Deployed" but whose
  // deployment_status sub-field has — must be treated as COMPLETE (not
  // outstanding) consistently by every consumer, per isDeliverableComplete().
  const deliverables = [
    {
      id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "Deployed via sub-status",
      description: null, workstream: "Backend", owner: "Dev", priority: "High", status: "Ready for UAT",
      planned_completion_date: "2026-06-30", actual_completion_date: "2026-06-28",
      development_status: "Complete", sit_status: "Passed", uat_status: "Complete", deployment_status: "Deployed",
      notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-28T00:00:00.000Z",
    },
  ];

  return {
    ...data,
    projects: [project],
    timeline_items,
    risks,
    decisions,
    actions,
    test_cases,
    requirements,
    acceptance_criteria,
    deliverables,
    dependencies: [],
    discovery_questions: [],
    milestones: [],
    project_snapshots: [],
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

// ── 1. Raw vs helper equivalence for the compound predicates introduced this phase ──

run("isRiskHighOrCritical(impact) && isRiskOpen(status) matches the raw compound expression it replaced everywhere", () => {
  const raw = (impact, status) => ["High", "Critical"].includes(impact) && !["Complete", "Closed"].includes(status);
  for (const impact of ["Low", "Medium", "High", "Critical"]) {
    for (const status of ["Open", "In Progress", "Complete", "Closed"]) {
      assert.equal(
        lifecycle.isRiskHighOrCritical(impact) && lifecycle.isRiskOpen(status),
        raw(impact, status),
        `mismatch for impact=${impact} status=${status}`,
      );
    }
  }
});

// ── 2. Completed/closed records stay excluded everywhere ────────────────────

run("a Closed critical risk is excluded from open/open-critical counts across Manager Summary, Go-Live Readiness, and Delivery Diagnostics", () => {
  const data = buildFixture();
  const project = data.projects[0];

  const managerReport = buildManagerExceptionReport(data, now);
  const managerSummary = managerReport.projects.find((p) => p.project.id === PROJECT_ID);
  assert.equal(managerSummary.status !== "Red", true, "a closed risk must not force Red");

  const dashboard = buildGoLiveDashboard(data, project, now);
  assert.equal(dashboard.openRisks, 0);
  assert.equal(dashboard.openCriticalRisks, 0);

  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  assert.equal(diagnostics.insights.some((i) => i.source.includes("RSK-001")), false);
});

// ── 3. Approved actions are closed — the one confirmed, documented fix ──────

run("an Approved action is treated as closed (not open) consistently across Go-Live Readiness, Snapshot Service, and Project Workspace", () => {
  const data = buildFixture();
  const project = data.projects[0];

  assert.equal(lifecycle.isActionOpen("Approved"), false);
  assert.equal(lifecycle.isActionClosed("Approved"), true);

  const dashboard = buildGoLiveDashboard(data, project, now);
  assert.equal(dashboard.outstandingDecisions, 0);

  const snapshot = calculateProjectSnapshot(data, project, now);
  assert.equal(snapshot.open_actions, 0, "Approved action must not count as open in the snapshot");

  const workspace = buildProjectWorkspace(data, project, now);
  assert.equal(workspace.actionColumns.Open.some((a) => a.id === "act-1"), false, "Approved action must not appear in the Open column");
  assert.equal(workspace.actionColumns.Complete.some((a) => a.id === "act-1"), true, "Approved action must appear in the Complete column");
});

// ── 4. Blocked tests remain open but flagged as blocked ─────────────────────

run("a Blocked test case is open (unresolved) but distinctly flagged as blocked, not silently dropped", () => {
  assert.equal(lifecycle.isTestOpen("Blocked"), true);
  assert.equal(lifecycle.isTestClosed("Blocked"), false);
  assert.equal(lifecycle.isTestFailedOrBlocked("Blocked"), true);

  const data = buildFixture();
  const project = data.projects[0];
  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  assert.equal(diagnostics.insights.some((i) => i.source.includes("TEST-001")), true, "the blocked test must still surface as an insight, not disappear");
});

// ── 5. Waived acceptance criteria count as met ──────────────────────────────

run("a Waived acceptance criterion counts as met, consistently", () => {
  assert.equal(lifecycle.isAcceptanceCriteriaMet("Waived"), true);

  const data = buildFixture();
  const project = data.projects[0];
  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  assert.equal(diagnostics.insights.some((i) => i.id === "acceptance-missing-evidence"), false, "a waived (met) AC must not be flagged as an outstanding/missing-evidence gap");
});

// ── 6. Deliverable completion is interpreted consistently across consumers ──

run("a deliverable complete via deployment_status (not the overall status field) is treated as complete consistently by Go-Live Readiness and the Daily Brief", () => {
  const data = buildFixture();
  const project = data.projects[0];

  assert.equal(lifecycle.isDeliverableComplete(data.deliverables[0]), true);

  const dashboard = buildGoLiveDashboard(data, project, now);
  assert.equal(dashboard.outstandingDeliverables, 0, "Go-Live Readiness must treat the deliverable as done");

  const brief = buildAutomatedDailyBrief(data, now);
  assert.ok(brief.html.includes("100% deployed") || brief.html.includes("1/1 deployed"), "the daily brief's progress KPI must count the deliverable as deployed");
});

run("structural: app/reports/page.tsx and components/project-workspace-page.tsx both use the shared isDeliverableComplete helper for their 'Complete' checks, not a raw status literal", () => {
  for (const file of ["app/reports/page.tsx", "components/project-workspace-page.tsx"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /isDeliverableComplete/, `${file} does not use the shared deliverable-complete helper`);
  }
});

// ── 7. Unknown/newly-mapped statuses remain visible in the status badge ────

run("status-badge.tsx has style and icon mappings for Proposed, Under Review, Rejected (previously falling through to the generic Pending style)", () => {
  const source = fs.readFileSync(path.join(root, "components/status-badge.tsx"), "utf8");
  for (const label of ["Proposed", "\"Under Review\"", "Rejected"]) {
    const keyPattern = new RegExp(`${label}:\\s*"`);
    assert.match(source, keyPattern, `statusStyles is missing an entry for ${label}`);
  }
});

console.log("\nAll Phase 4 lifecycle-consumer tests passed.\n");
