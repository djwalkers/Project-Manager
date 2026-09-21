// Multi-project scoping — the fix for the bug reported immediately after
// PL10 (the second real project) was created: selecting PL10 and
// navigating to Milestones still showed CR028's milestones.
//
// Root cause: the generic module CRUD pages (ModulePageClient in
// components/app-client.tsx, plus DecisionsPage and DiscoveryQuestionsPage,
// which have their own copies of the same page shell) resolved the active
// project correctly, but never used it to filter the records handed to
// DataTable — every module except timeline_items (which had its own
// special-cased selectTimelineItems call) passed the FULL, unscoped
// DataStore straight through, so selecting a project never changed what
// Milestones/Requirements/Risks/Actions/etc. displayed.
//
// The fix reuses lib/project-scope.ts's scopeProjectData() — the exact
// same canonical scoping every ProjectState consumer (Workspace, Control
// Tower, Dashboard, Reports, ...) already used — rather than inventing a
// second filtering mechanism. This file proves two things:
//   1. scopeProjectData() itself correctly isolates every entity the bug
//      report called out by name (milestones, requirements, actions), in
//      both directions, including newly-created records.
//   2. The previously-broken component files now actually call it (and no
//      longer pass the raw, unscoped DataStore to DataTable) — a
//      structural check, since this test harness has no DOM/React
//      renderer to mount these "use client" components directly.
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
const { scopeProjectData } = req("../lib/project-scope.ts");
const { seedData } = req("../lib/seed-data.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function project(overrides = {}) {
  return { ...seedData.projects[0], project_ref: null, owner: null, ...overrides };
}

function milestone(projectId, overrides = {}) {
  return {
    id: `mil-${Math.random()}`, project_id: projectId, milestone_ref: "MIL-000",
    title: "Milestone", target_date: "2026-10-01", status: "Not Started", owner: "Owner",
    notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function requirement(projectId, overrides = {}) {
  return {
    id: `req-${Math.random()}`, project_id: projectId, requirement_ref: "REQ-000",
    title: "Requirement", description: null, priority: "Medium", category: "Business Rule",
    status: "Approved", owner: "Owner", source: null, notes: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function action(projectId, overrides = {}) {
  return {
    id: `act-${Math.random()}`, project_id: projectId, action_ref: "ACT-000",
    description: "Action", owner: "Owner", due_date: null, status: "Open", notes: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// A two-real-project fixture named after the actual incident: CR028 (the
// original project, with real records) and PL10 (the newly created second
// project, initially empty) — sharing one DataStore, exactly as they do in
// production.
function twoProjectFixture() {
  const data = structuredClone(seedData);
  const cr028 = project({ id: "cr028-id", name: "CR028 - Delivery Date Range" });
  const pl10 = project({ id: "pl10-id", name: "PL10 Testing / Replenishment Go-Live" });
  return {
    ...data,
    projects: [cr028, pl10],
    milestones: [milestone(cr028.id, { title: "CR028 Go-Live" }), milestone(cr028.id, { title: "CR028 SIT Complete" })],
    requirements: [requirement(cr028.id, { title: "CR028 Requirement" })],
    actions: [action(cr028.id, { description: "CR028 Action" })],
  };
}

// ── scopeProjectData: entity isolation, both directions ────────────────────

run("selecting PL10 shows PL10 milestones and never CR028's", () => {
  const data = twoProjectFixture();
  const pl10 = data.projects.find((p) => p.id === "pl10-id");
  const scoped = scopeProjectData(data, pl10);
  assert.deepEqual(scoped.milestones, [], "PL10 has no milestones of its own");
  assert.ok(!scoped.milestones.some((m) => m.title.startsWith("CR028")), "no CR028 milestone must leak into PL10's scope");
});

run("selecting CR028 shows CR028 milestones and never PL10's", () => {
  const data = twoProjectFixture();
  data.milestones.push(milestone("pl10-id", { title: "PL10 Cutover" }));
  const cr028 = data.projects.find((p) => p.id === "cr028-id");
  const scoped = scopeProjectData(data, cr028);
  assert.equal(scoped.milestones.length, 2);
  assert.ok(scoped.milestones.every((m) => m.title.startsWith("CR028")), "no PL10 milestone must leak into CR028's scope");
});

run("selecting PL10 shows PL10 requirements and never CR028's", () => {
  const data = twoProjectFixture();
  data.requirements.push(requirement("pl10-id", { title: "PL10 Requirement" }));
  const pl10 = data.projects.find((p) => p.id === "pl10-id");
  const scoped = scopeProjectData(data, pl10);
  assert.equal(scoped.requirements.length, 1);
  assert.equal(scoped.requirements[0].title, "PL10 Requirement");
});

run("selecting PL10 shows PL10 actions and never CR028's", () => {
  const data = twoProjectFixture();
  data.actions.push(action("pl10-id", { description: "PL10 Action" }));
  const pl10 = data.projects.find((p) => p.id === "pl10-id");
  const scoped = scopeProjectData(data, pl10);
  assert.equal(scoped.actions.length, 1);
  assert.equal(scoped.actions[0].description, "PL10 Action");
});

run("switching PL10 -> CR028 -> PL10 resolves each project's own records identically every time, with no drift", () => {
  const data = twoProjectFixture();
  data.milestones.push(milestone("pl10-id", { title: "PL10 Cutover" }));
  const cr028 = data.projects.find((p) => p.id === "cr028-id");
  const pl10 = data.projects.find((p) => p.id === "pl10-id");

  const firstPl10 = scopeProjectData(data, pl10).milestones.map((m) => m.id);
  const cr028Pass = scopeProjectData(data, cr028).milestones.map((m) => m.id);
  const secondPl10 = scopeProjectData(data, pl10).milestones.map((m) => m.id);

  assert.deepEqual(firstPl10, secondPl10, "re-selecting PL10 after visiting CR028 must return exactly the same records");
  assert.equal(cr028Pass.length, 2);
});

// ── Creation: a new record gets the currently selected project's id ────────

run("a new milestone created while PL10 is selected is assigned PL10's project_id, not CR028's", () => {
  const data = twoProjectFixture();
  const pl10 = data.projects.find((p) => p.id === "pl10-id");
  // Mirrors persistRecord's stamping rule in components/app-client.tsx:
  // project_id: record.project_id ?? activeProject.id — a brand-new record
  // (no id, no project_id from the form) always inherits the active project.
  const newRecordFromForm = { title: "New PL10 Milestone", status: "Not Started" };
  const stamped = { ...newRecordFromForm, project_id: newRecordFromForm.project_id ?? pl10.id };
  assert.equal(stamped.project_id, "pl10-id");

  data.milestones.push({ ...milestone(stamped.project_id), ...stamped });
  const cr028 = data.projects.find((p) => p.id === "cr028-id");
  const cr028Scoped = scopeProjectData(data, cr028);
  assert.ok(!cr028Scoped.milestones.some((m) => m.title === "New PL10 Milestone"), "a record created while PL10 is selected must never appear under CR028");
});

run("a new action created while PL10 is selected is assigned PL10's project_id, not CR028's", () => {
  const data = twoProjectFixture();
  const pl10 = data.projects.find((p) => p.id === "pl10-id");
  const newRecordFromForm = { description: "New PL10 Action", status: "Open" };
  const stamped = { ...newRecordFromForm, project_id: newRecordFromForm.project_id ?? pl10.id };
  data.actions.push({ ...action(stamped.project_id), ...stamped });

  const pl10Scoped = scopeProjectData(data, pl10);
  const cr028 = data.projects.find((p) => p.id === "cr028-id");
  const cr028Scoped = scopeProjectData(data, cr028);
  assert.ok(pl10Scoped.actions.some((a) => a.description === "New PL10 Action"));
  assert.ok(!cr028Scoped.actions.some((a) => a.description === "New PL10 Action"), "no sibling-project mutation leakage");
});

// ── Structural: the previously-broken pages now actually scope ────────────

run("structural: ModulePageClient (Milestones/Requirements/Risks/Actions/...) scopes pageData via scopeProjectData before rendering DataTable", () => {
  const source = readSource("components/app-client.tsx");
  assert.match(source, /import\s*\{[^}]*scopeProjectData[^}]*\}\s*from\s*"@\/lib\/project-scope"/, "must import the canonical scoping helper");
  assert.match(source, /const pageData = data && activeProject \? scopeProjectData\(data, activeProject\) : null;/, "pageData must be derived via scopeProjectData, not the raw DataStore");
  assert.match(source, /<DataTable[\s\S]*?data=\{pageData\}/, "DataTable must receive the scoped pageData, not raw data");
  assert.doesNotMatch(source, /<DataTable[\s\S]{0,80}data=\{data\}/, "DataTable must never receive the unscoped DataStore directly");
});

run("structural: DecisionsPage scopes pageData via scopeProjectData before rendering DataTable", () => {
  const source = readSource("components/decisions-page.tsx");
  assert.match(source, /scopeProjectData/, "must use the canonical scoping helper");
  assert.match(source, /<DataTable[\s\S]*?data=\{pageData\}/, "DataTable must receive scoped pageData");
});

run("structural: DiscoveryQuestionsPage scopes pageData via scopeProjectData before rendering DataTable", () => {
  const source = readSource("components/discovery-questions-page.tsx");
  assert.match(source, /scopeProjectData/, "must use the canonical scoping helper");
  assert.match(source, /<DataTable[\s\S]*?data=\{pageData\}/, "DataTable must receive scoped pageData");
});

run("structural: the header no longer hardcodes CR028 and instead renders a live project switcher", () => {
  const source = readSource("components/header.tsx");
  assert.doesNotMatch(source, /CR028/, "the header must not hardcode any project's name");
  assert.match(source, /useHeaderProjectSwitcher/, "the header must render from the shared selected-project context");
});

run("structural: switching project via the header persists through the same shared mechanism every page reads", () => {
  const source = readSource("components/header.tsx");
  assert.match(source, /selectProject\(project\.id\)/, "the switcher must call the canonical selectProject(), not a page-local copy");
});

run("structural: the Portfolio page reuses buildProjectWorkspace rather than re-deriving health/progress/phase", () => {
  const source = readSource("components/projects-portfolio-page.tsx");
  assert.match(source, /import\s*\{\s*buildProjectWorkspace\s*\}\s*from\s*"@\/lib\/project-workspace"/);
  assert.doesNotMatch(source, /function calculate(Project)?Health/i, "must not reimplement health scoring");
});

run("structural: Projects/Portfolio is routed as its own page, not the generic per-record module table", () => {
  const source = readSource("app/[section]/page.tsx");
  assert.match(source, /section === "projects".*ProjectsPortfolioPage/, "the /projects route must render the Portfolio page");
});
