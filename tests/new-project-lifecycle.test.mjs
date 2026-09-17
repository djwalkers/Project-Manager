// New feature — "Create New Project" workflow, downstream behaviour. A
// freshly created project has zero rows in every child table. This proves
// the audit findings from the pre-implementation review: scopeProjectData/
// selectCanonicalProjects/selectProjectById handle a genuinely empty
// project without throwing or leaking CR028's data, and buildProjectState/
// buildProjectWorkspace report the empty project as "not yet assessed" —
// never as falsely 100% complete/ready/Green — for every calculation that
// already guards against vacuous truth (see the pre-implementation audit
// for the two computeDeliveryConfidence/classifyProject false positives
// that were reported, not fixed, in this phase).
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
const { buildProjectState } = req("../lib/project-state.ts");
const { buildProjectWorkspace } = req("../lib/project-workspace.ts");
const { scopeProjectData, selectCanonicalProjects, selectProjectById } = req("../lib/project-scope.ts");
const { seedData, projectId: CR028_ID } = req("../lib/seed-data.ts");

const now = new Date("2026-09-17T09:00:00Z");
const NEW_PROJECT_ID = "new-project-pl10";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// A brand-new, just-created project, sitting alongside CR028 in the same
// DataStore — every child collection is empty, and every lifecycle date is
// null (exactly what lib/project-creation.ts's buildNewProjectRecord
// produces for an initial creation with no dates supplied).
function newEmptyProject(overrides = {}) {
  return {
    id: NEW_PROJECT_ID,
    project_ref: "PL10",
    name: "PL10 Testing / Replenishment Go-Live — Week of 21 Sept",
    customer: "Sysco",
    workstream: "Replenishment",
    owner: "Andy Walker",
    status: "Discovery",
    health: "Amber",
    schedule_variance: 0,
    planned_start_date: null,
    planned_end_date: null,
    go_live_date: null,
    uat_complete_date: null,
    hypercare_start_date: null,
    hypercare_end_date: null,
    description: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function buildFixture() {
  const data = structuredClone(seedData);
  const newProject = newEmptyProject();
  return { ...data, projects: [...data.projects, newProject] };
}

// ── Scoping: an empty project never sees CR028's data, and vice versa ──────

run("scopeProjectData returns every child collection empty for a brand-new project with zero records", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const scoped = scopeProjectData(data, newProject);

  assert.equal(scoped.requirements.length, 0);
  assert.equal(scoped.milestones.length, 0);
  assert.equal(scoped.actions.length, 0);
  assert.equal(scoped.risks.length, 0);
  assert.equal(scoped.decisions.length, 0);
  assert.equal(scoped.dependencies.length, 0);
  assert.equal(scoped.test_cases.length, 0);
  assert.equal(scoped.deliverables.length, 0);
  assert.equal(scoped.timeline_items.length, 0);
});

run("scopeProjectData for the new project never includes any of CR028's seeded child records", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const scoped = scopeProjectData(data, newProject);

  // REP-001 is a real CR028 seed requirement (lib/seed-data.ts) — it must
  // never appear against the new project.
  assert.equal(scoped.requirements.some((r) => r.requirement_ref === "REP-001"), false);
  assert.ok(data.requirements.some((r) => r.project_id === CR028_ID), "sanity check: CR028's own seed requirements still exist in the full dataset");
});

run("scopeProjectData for CR028 is completely unchanged by the new project's presence", () => {
  const before = scopeProjectData(seedData, seedData.projects[0]);
  const after = scopeProjectData(buildFixture(), buildFixture().projects.find((p) => p.id === CR028_ID));
  assert.equal(after.requirements.length, before.requirements.length);
  assert.deepEqual(after.requirements.map((r) => r.requirement_ref).sort(), before.requirements.map((r) => r.requirement_ref).sort());
});

// ── Selection: the new project is immediately selectable ───────────────────

run("selectCanonicalProjects includes both CR028 and the newly created project", () => {
  const data = buildFixture();
  const names = selectCanonicalProjects(data).map((p) => p.name);
  assert.ok(names.includes("PL10 Testing / Replenishment Go-Live — Week of 21 Sept"));
  assert.ok(names.some((n) => n.includes("CR")));
});

run("selectProjectById resolves the new project by its own id, not CR028", () => {
  const data = buildFixture();
  const resolved = selectProjectById(data, NEW_PROJECT_ID);
  assert.equal(resolved.id, NEW_PROJECT_ID);
});

// ── ProjectState: an empty project reads as "not yet assessed", not falsely complete ──

run("buildProjectState does not throw for a project with zero records of every type", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  assert.doesNotThrow(() => buildProjectState(data, newProject, now));
});

run("an empty project's progress is 0%, not 100% — every component's denominator is zero", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const state = buildProjectState(data, newProject, now);
  assert.equal(state.progress.overall, 0);
});

run("an empty project's schedule is invalid (unset dates), not falsely Green", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const state = buildProjectState(data, newProject, now);
  assert.equal(state.schedule.valid, false);
  assert.equal(state.schedule.health, null);
});

run("an empty project's derived phase falls back to Discovery, not a late/complete phase", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const state = buildProjectState(data, newProject, now);
  assert.equal(state.phase.phase, "Discovery");
});

run("an empty project's Go-Live readiness is Not Assessed at 0%, not falsely Complete/Green", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const state = buildProjectState(data, newProject, now);
  assert.equal(state.goLive.status, "Not Assessed");
  assert.equal(state.goLive.readinessPercent, 0);
});

run("an empty project's lifecycle rollups report zero everywhere, with allPassed/allMet both false (not vacuously true)", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const state = buildProjectState(data, newProject, now);
  assert.equal(state.rollups.tests.allPassed, false);
  assert.equal(state.rollups.acceptanceCriteria.allMet, false);
  assert.equal(state.rollups.requirements.signedOff, 0);
});

// ── Workspace: renders safely for a genuinely empty project ─────────────────

run("buildProjectWorkspace does not throw for a project with zero records of every type", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  assert.doesNotThrow(() => buildProjectWorkspace(data, newProject, now));
});

run("an empty project's Workspace reports no active phase and 0% progress, and warns about every missing collection", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const workspace = buildProjectWorkspace(data, newProject, now);
  assert.equal(workspace.activePhase, "No active phase");
  assert.equal(workspace.progress, 0);
  assert.equal(workspace.nextMilestone, null);
  assert.ok(workspace.warnings.includes("No milestones"));
  assert.ok(workspace.warnings.includes("No requirements"));
});

// ── Lifecycle dates: null is handled, not required ──────────────────────────

run("a new project with every lifecycle date null does not crash schedule/go-live date resolution", () => {
  const data = buildFixture();
  const newProject = data.projects.find((p) => p.id === NEW_PROJECT_ID);
  const state = buildProjectState(data, newProject, now);
  assert.equal(state.goLiveDate.date, null);
  assert.equal(state.goLiveDate.source, "none");
  assert.equal(state.hypercare.start, null);
  assert.equal(state.hypercare.end, null);
});

console.log("\nAll new-project-lifecycle tests passed.\n");
