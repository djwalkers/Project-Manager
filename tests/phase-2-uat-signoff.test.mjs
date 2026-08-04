// Post-audit Phase 2 — UAT Signed Off now driven by durable Customer
// sign-off evidence where it has been recorded, falling back to the
// original deliverable-based derivation only when no such evidence exists
// at all. See lib/go-live-readiness.ts's "uat_signed_off" case.
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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

const req = Module.createRequire(import.meta.url);
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { buildProjectAssistantDTO } = req("../lib/ai/project-assistant-dto.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "phase2-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function checkByKey(dashboard, key) {
  return dashboard.checks.find((c) => c.key === key);
}

function baseData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Phase 2 UAT Sign-off Test Project",
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

function timelineFor(phaseName) {
  return [{
    id: "tl-1", project_id: PROJECT_ID, phase_ref: "PH-1", phase_name: phaseName,
    start_date: "2026-01-01", end_date: "2026-12-01", owner: null, status: "In Progress",
    progress_percent: 50, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: now.toISOString(),
  }];
}

function requirement(overrides = {}) {
  return {
    id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "Requirement", description: "d",
    priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew", source: "s", notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function signOff(overrides = {}) {
  return {
    id: `signoff-${Math.random()}`, project_id: PROJECT_ID, requirement_id: "req-1", sign_off_type: "Customer",
    person: "Sysco Contact", sign_off_date: "2026-07-01", status: "Approved", notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
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

// ── All applicable requirements signed off ──────────────────────────────────

run("all applicable requirements' latest Customer sign-off Approved → Complete", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" }), requirement({ id: "req-2", requirement_ref: "REQ-002" })],
    requirement_sign_offs: [
      signOff({ requirement_id: "req-1", status: "Approved" }),
      signOff({ requirement_id: "req-2", status: "Approved" }),
    ],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Complete");
});

// ── Partial sign-off ─────────────────────────────────────────────────────────

run("partial sign-off (one requirement Approved, another still Pending) → Incomplete", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" }), requirement({ id: "req-2", requirement_ref: "REQ-002" })],
    requirement_sign_offs: [
      signOff({ requirement_id: "req-1", status: "Approved" }),
      signOff({ requirement_id: "req-2", status: "Pending" }),
    ],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Incomplete");
});

// ── Rejected sign-off ────────────────────────────────────────────────────────

run("a Rejected Customer sign-off → Incomplete, even if it is the only applicable requirement", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" })],
    requirement_sign_offs: [signOff({ requirement_id: "req-1", status: "Rejected" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Incomplete");
});

// ── Superseded / duplicate sign-off records ─────────────────────────────────

run("superseded sign-off: an older Rejected row is superseded by a newer Approved row for the same requirement → Complete", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" })],
    requirement_sign_offs: [
      signOff({ id: "so-old", requirement_id: "req-1", status: "Rejected", updated_at: "2026-06-01T00:00:00.000Z" }),
      signOff({ id: "so-new", requirement_id: "req-1", status: "Approved", updated_at: "2026-07-15T00:00:00.000Z" }),
    ],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Complete");
});

run("superseded sign-off: an older Approved row is superseded by a newer Rejected row for the same requirement → Incomplete", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" })],
    requirement_sign_offs: [
      signOff({ id: "so-old", requirement_id: "req-1", status: "Approved", updated_at: "2026-06-01T00:00:00.000Z" }),
      signOff({ id: "so-new", requirement_id: "req-1", status: "Rejected", updated_at: "2026-07-15T00:00:00.000Z" }),
    ],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Incomplete");
});

// ── No sign-off records at all — fallback preserved unchanged ──────────────

run("no sign-off records anywhere on the project → falls back to the original deliverable-based derivation (Not Yet Assessed with no evidence)", () => {
  const data = baseData({ timeline_items: timelineFor("Customer UAT"), requirements: [requirement()] });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Not Yet Assessed");
});

run("no sign-off records anywhere, but a deliverable is fully UAT-complete → fallback still reads Complete (unchanged legacy behaviour)", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement()],
    deliverables: [deliverable({ uat_status: "Complete", status: "UAT Complete" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Complete");
});

// ── Sign-off evidence is authoritative over deliverable status ─────────────

run("stale deliverable uat_status (Not Started) + an approved Customer sign-off → Complete (sign-off evidence wins)", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" })],
    deliverables: [deliverable({ uat_status: "Not Started", status: "In Development" })],
    requirement_sign_offs: [signOff({ requirement_id: "req-1", status: "Approved" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Complete");
});

run("a fully UAT-complete deliverable + a missing/Pending required sign-off → Incomplete (stale-looking deliverable status cannot override missing sign-off)", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" })],
    deliverables: [deliverable({ uat_status: "Complete", status: "UAT Complete" })],
    requirement_sign_offs: [signOff({ requirement_id: "req-1", status: "Pending" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Incomplete");
});

// ── Closed requirements are excluded (covers the "superseded requirement" case) ──

run("a Closed requirement's Rejected sign-off does not block UAT — it is excluded from applicability entirely", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1", status: "Closed" })],
    requirement_sign_offs: [signOff({ requirement_id: "req-1", status: "Rejected" })],
    deliverables: [deliverable({ uat_status: "Complete", status: "UAT Complete" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  // No applicable (non-Closed, sign-off-tracked) requirement exists, so this falls back
  // to the deliverable-based derivation, which reads Complete for this fixture.
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Complete");
});

run("no applicable requirements (none recorded at all) → Not Yet Assessed, exactly as before this phase", () => {
  const data = baseData({ timeline_items: timelineFor("Customer UAT") });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(checkByKey(dashboard, "uat_signed_off").effective, "Not Yet Assessed");
});

// ── Sibling-project isolation ────────────────────────────────────────────────

run("similarly-named sibling projects: Customer sign-offs never leak across projects", () => {
  const data = structuredClone(seedData);
  const projectA = { ...data.projects[0], id: "signoff-project-a", name: "CR028", planned_start_date: "2026-06-01", planned_end_date: "2026-10-15" };
  const projectB = { ...data.projects[0], id: "signoff-project-b", name: "CR028 Phase 2", planned_start_date: "2026-06-01", planned_end_date: "2026-11-15" };
  const fixture = {
    ...data,
    projects: [projectA, projectB],
    timeline_items: [
      { id: "tl-a", project_id: projectA.id, phase_ref: "PH-A", phase_name: "Customer UAT", start_date: "2026-06-01", end_date: "2026-10-10", owner: null, status: "In Progress", progress_percent: 40, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString() },
      { id: "tl-b", project_id: projectB.id, phase_ref: "PH-B", phase_name: "Customer UAT", start_date: "2026-06-01", end_date: "2026-11-10", owner: null, status: "In Progress", progress_percent: 40, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString() },
    ],
    requirements: [
      requirement({ id: "req-a", project_id: projectA.id, requirement_ref: "REQ-A001" }),
      requirement({ id: "req-b", project_id: projectB.id, requirement_ref: "REQ-B001" }),
    ],
    requirement_sign_offs: [
      signOff({ id: "so-a", project_id: projectA.id, requirement_id: "req-a", status: "Approved" }),
      signOff({ id: "so-b", project_id: projectB.id, requirement_id: "req-b", status: "Rejected" }),
    ],
    milestones: [], deliverables: [], risks: [], decisions: [], actions: [], dependencies: [], discovery_questions: [],
    test_cases: [], acceptance_criteria: [], go_live_checklists: [], cutover_plan: [], go_live_readiness_overrides: [],
    project_snapshots: [], evidence: [], meeting_intelligence: [], meeting_suggestions: [], activity_log: [], documents: [], meetings: [],
  };

  const dashboardA = buildGoLiveDashboard(fixture, projectA, now);
  const dashboardB = buildGoLiveDashboard(fixture, projectB, now);
  assert.equal(checkByKey(dashboardA, "uat_signed_off").effective, "Complete", "A's own Approved sign-off must not be affected by B's Rejected one");
  assert.equal(checkByKey(dashboardB, "uat_signed_off").effective, "Incomplete", "B's own Rejected sign-off must not be masked by A's Approved one");
});

// ── Propagation: ProjectState and ProjectAssistantDTO inherit the fix automatically ──

run("ProjectState.goLive and ProjectAssistantDTO.goLiveReadiness both reflect the new uat_signed_off derivation with no code of their own", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    requirements: [requirement({ id: "req-1" })],
    deliverables: [deliverable({ uat_status: "Complete", status: "UAT Complete" })],
    requirement_sign_offs: [signOff({ requirement_id: "req-1", status: "Pending" })],
  });
  const project = data.projects[0];
  const state = buildProjectState(data, project, now);
  assert.equal(checkByKey(state.goLive, "uat_signed_off").effective, "Incomplete");

  const dto = buildProjectAssistantDTO(data, project, now);
  const dtoCheck = dto.goLiveReadiness.checks.find((c) => c.key === "uat_signed_off");
  assert.equal(dtoCheck.effective, "Incomplete");
});

console.log("\nAll post-audit Phase 2 UAT sign-off tests passed.\n");
