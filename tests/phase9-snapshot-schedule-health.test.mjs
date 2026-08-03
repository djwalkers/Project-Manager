// Phase 9 — snapshot schedule-health defect fix. lib/snapshots.ts's
// captureSnapshot() used to hard-code schedule_health: "Green" regardless
// of the project's actual schedule position. This suite proves the fix:
// snapshots now read the same schedule health ProjectState, Workspace, and
// Control Tower already read, for Green/Amber/Red projects alike.
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

function compileTypeScript(module, filename) {
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
}
Module._extensions[".ts"] = compileTypeScript;
// lib/snapshots.ts transitively imports components/requirement-readiness.tsx
// (computeReadiness) — .tsx needs the same shim as .ts, unlike every prior
// suite in this repo, which never imported a .tsx file transitively.
Module._extensions[".tsx"] = compileTypeScript;

const req = Module.createRequire(import.meta.url);
const { buildSnapshotPayload } = req("../lib/snapshots.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { buildProjectWorkspace } = req("../lib/project-workspace.ts");
const { calculateSchedule } = req("../lib/schedule.ts");
const { seedData } = req("../lib/seed-data.ts");

const PROJECT_ID = "phase9-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// No timeline items ⇒ actualProgress is always 0, so variance is purely
// -(plannedProgress) — chosen via `now`'s distance from planned_start_date
// against a 365-day project. This isolates the Green/Amber/Red bucket
// deterministically without needing timeline fixtures.
function scheduleFixture(nowIso, overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "CR028 - Delivery Date Range",
    status: "In Progress",
    planned_start_date: "2026-01-01",
    planned_end_date: "2026-12-31",
    go_live_date: null,
    ...overrides,
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
  };
}

// Boundaries verified directly against calculateSchedule() for this
// zero-timeline-items fixture (durationDays is inclusive, so plannedProgress
// is 0, and variance therefore 0/Green, only when `now` is before
// planned_start_date).
const GREEN_NOW = new Date("2025-12-15T12:00:00Z"); // before planned_start_date ⇒ plannedProgress 0 ⇒ variance 0 ⇒ Green
const AMBER_NOW = new Date("2026-01-20T12:00:00Z"); // elapsed ~5.5% ⇒ variance ~-5.5 ⇒ Amber
const RED_NOW = new Date("2026-03-01T12:00:00Z"); // elapsed ~16.4% ⇒ variance ~-16.4 ⇒ Red

// ── 1. Snapshot schedule health matches ProjectState / Workspace ───────────

for (const [label, fixtureNow] of [["Green", GREEN_NOW], ["Amber", AMBER_NOW], ["Red", RED_NOW]]) {
  run(`snapshot schedule_health equals ProjectState.scheduleHealth for a ${label} project`, () => {
    const data = scheduleFixture(fixtureNow);
    const project = data.projects[0];
    const state = buildProjectState(data, project, fixtureNow);
    const payload = buildSnapshotPayload(data, project, fixtureNow);
    assert.equal(state.scheduleHealth, label, `fixture sanity check: expected this fixture to be ${label}`);
    assert.equal(payload.schedule_health, state.scheduleHealth ?? "Review");
  });

  run(`snapshot schedule_health equals Workspace scheduleHealth for a ${label} project`, () => {
    const data = scheduleFixture(fixtureNow);
    const project = data.projects[0];
    const workspace = buildProjectWorkspace(data, project, fixtureNow);
    const payload = buildSnapshotPayload(data, project, fixtureNow);
    assert.equal(payload.schedule_health, workspace.scheduleHealth);
  });
}

// ── 2. Red/Amber/Green projects remain Red/Amber/Green in the snapshot ─────

run("a Red project's snapshot reads schedule_health Red, not the old hard-coded Green", () => {
  const data = scheduleFixture(RED_NOW);
  const project = data.projects[0];
  const payload = buildSnapshotPayload(data, project, RED_NOW);
  assert.equal(payload.schedule_health, "Red");
  // Independently confirm against calculateSchedule() directly, not just ProjectState's projection of it.
  assert.equal(calculateSchedule(project, [], RED_NOW).health, "Red");
});

run("an Amber project's snapshot reads schedule_health Amber", () => {
  const data = scheduleFixture(AMBER_NOW);
  const project = data.projects[0];
  const payload = buildSnapshotPayload(data, project, AMBER_NOW);
  assert.equal(payload.schedule_health, "Amber");
  assert.equal(calculateSchedule(project, [], AMBER_NOW).health, "Amber");
});

run("a Green project's snapshot reads schedule_health Green", () => {
  const data = scheduleFixture(GREEN_NOW);
  const project = data.projects[0];
  const payload = buildSnapshotPayload(data, project, GREEN_NOW);
  assert.equal(payload.schedule_health, "Green");
  assert.equal(calculateSchedule(project, [], GREEN_NOW).health, "Green");
});

// ── 3. Historical snapshots are preserved, not overwritten ────────────────

run("capturing today's snapshot targets today's date and does not touch a historical snapshot row's own captured values", () => {
  const data = scheduleFixture(RED_NOW, {});
  const project = data.projects[0];
  const historicalSnapshot = {
    id: "snap-yesterday", project_id: PROJECT_ID, snapshot_date: "2026-02-28",
    project_health: "Green", schedule_health: "Green", progress_percent: 40, schedule_variance: 2,
    open_risks: 0, open_actions: 0, overdue_actions: 0, open_decisions: 0, overdue_decisions: 0, open_questions: 0,
    active_milestone: null, active_phase: null, created_at: "2026-02-28T12:00:00.000Z",
    delivery_confidence: 90, project_readiness: 80, requirements_complete: 1, acceptance_complete: 1,
    evidence_complete: 1, sign_off_complete: 1, blocked_actions: 0, high_risks: 0, outstanding_dependencies: 0,
  };
  data.project_snapshots = [structuredClone(historicalSnapshot)];

  const payload = buildSnapshotPayload(data, project, RED_NOW);

  assert.equal(payload.snapshot_date, "2026-03-01", "the new payload targets today, not the historical date");
  assert.notEqual(payload.id, historicalSnapshot.id, "the new payload must not carry the historical row's id (it would overwrite it on save)");
  assert.deepEqual(data.project_snapshots[0], historicalSnapshot, "the historical row itself is untouched by building today's payload");
  assert.equal(payload.schedule_health, "Red", "today's payload reflects today's actual schedule health, independent of yesterday's captured value");
});

// ── 4. No duplicate schedule calculation remains ────────────────────────────

run("lib/snapshots.ts computes schedule health via buildProjectState only — no direct calculateSchedule/computeDeliveryConfidence call of its own", () => {
  const source = fs.readFileSync(path.join(root, "lib/snapshots.ts"), "utf8");
  assert.match(source, /from ["']@\/lib\/project-state["']/, "lib/snapshots.ts must read schedule health via lib/project-state");
  assert.doesNotMatch(source, /from ["']@\/lib\/schedule["']/, "lib/snapshots.ts must not import lib/schedule directly — that would be a second schedule calculation");
  assert.doesNotMatch(source, /from ["']@\/lib\/delivery-confidence["']/, "lib/snapshots.ts must not import lib/delivery-confidence directly — that would be a second, potentially differently-scoped confidence calculation");
  assert.doesNotMatch(source, /"Green"\s*as const/, "no hard-coded schedule_health literal remains");
});

// ── 5. Regression: all other snapshot fields remain populated ─────────────

run("the snapshot payload still includes project health, delivery confidence, readiness, and every count field, all populated", () => {
  const data = scheduleFixture(RED_NOW);
  data.requirements = [{ id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "t", description: null, priority: "High", category: "Business Rule", status: "Complete", owner: "Andrew Walker", source: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
  const project = data.projects[0];
  const payload = buildSnapshotPayload(data, project, RED_NOW);

  assert.equal(payload.project_health, project.health);
  assert.equal(typeof payload.schedule_health, "string");
  assert.equal(typeof payload.delivery_confidence, "number");
  assert.equal(typeof payload.project_readiness, "number");
  for (const field of ["open_risks", "open_actions", "overdue_actions", "open_decisions", "overdue_decisions", "open_questions", "requirements_complete", "acceptance_complete", "evidence_complete", "sign_off_complete", "blocked_actions", "high_risks", "outstanding_dependencies"]) {
    assert.equal(typeof payload[field], "number", `${field} must remain a populated number`);
  }
  assert.equal(payload.requirements_complete, 1);
});

// ── 6. Explicit project is honoured — no internal re-selection when one is given ──

run("passing an explicit project is honoured over whatever selectActiveProject(data) would otherwise pick", () => {
  const data = scheduleFixture(RED_NOW);
  const otherProject = { ...data.projects[0], id: "other-project", name: "Not CR028", planned_start_date: "2026-01-01", planned_end_date: "2026-12-31" };
  data.projects.push(otherProject);

  const payload = buildSnapshotPayload(data, otherProject, RED_NOW);
  assert.equal(payload.project_id, otherProject.id, "the explicitly-passed project must be the one snapshotted, regardless of which project selectActiveProject(data) would choose");
});

console.log("\nAll Phase 9 snapshot schedule-health tests passed.\n");
