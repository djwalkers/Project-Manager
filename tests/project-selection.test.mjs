// Multi-project selection — the canonical "which project is currently
// selected" mechanism. Before this phase, selectActiveProject() preferred
// any project whose name contained "cr028" outright, and seven read-only
// consumers (Dashboard, Control Tower, Reports, notification bell, the
// meeting list) resolved a project independently via selectActiveProject()
// rather than respecting whatever the user had actually selected elsewhere
// — so a project chosen on the Workspace page's switcher would not
// necessarily be what Dashboard/Control Tower/Reports showed. This proves:
//   - selectActiveProject()'s fallback is now purely data-strength-driven,
//     with no name preference of any kind
//   - resolveSelectedProject() (the shared resolver those seven consumers
//     now use) honours an explicit persisted selection, falls back
//     deterministically when unset, and recovers safely when the
//     persisted id no longer resolves to a real project
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

// lib/project-selection.ts is a "use client" module that reads/writes
// window.localStorage directly (no Node-safe abstraction — there was no
// existing test coverage for it to preserve a different contract). This
// stub is the minimal, deterministic browser environment it needs to run
// under plain Node, isolated per test via resetLocalStorage().
const localStorageStore = new Map();
global.window = {
  localStorage: {
    getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
    setItem: (key, value) => localStorageStore.set(key, value),
  },
};
function resetLocalStorage() {
  localStorageStore.clear();
}

const req = Module.createRequire(import.meta.url);
const { selectActiveProject, selectCanonicalProjects, scopeProjectData } = req("../lib/project-scope.ts");
const { resolveSelectedProject, persistSelectedProjectId } = req("../lib/project-selection.ts");
const { seedData } = req("../lib/seed-data.ts");

function run(name, fn) {
  resetLocalStorage();
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function project(overrides = {}) {
  return {
    ...seedData.projects[0],
    project_ref: null,
    owner: null,
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

// A two-project fixture: a CR028-named project with NO records, and a
// differently-named project with real records — proving any remaining
// name preference would pick the wrong (weaker, empty) one.
function biasProbeFixture() {
  const data = structuredClone(seedData);
  const cr028Project = project({ id: "weak-cr028", name: "CR028 - Nothing Recorded Yet" });
  const strongProject = project({ id: "strong-other", name: "Warehouse Automation Phase 2" });
  return {
    ...data,
    projects: [cr028Project, strongProject],
    requirements: [requirement(strongProject.id), requirement(strongProject.id)],
  };
}

// ── selectActiveProject: no CR028 preference in the production resolver ────

run("selectActiveProject picks the project with real data over an empty CR028-named project", () => {
  const data = biasProbeFixture();
  const resolved = selectActiveProject(data);
  assert.equal(resolved.id, "strong-other", "the project with actual records must win, regardless of the other project's name");
});

run("selectActiveProject picks a CR028-named project when it is genuinely the strongest — no penalty for the name either", () => {
  const data = biasProbeFixture();
  data.requirements = [requirement("weak-cr028"), requirement("weak-cr028"), requirement("weak-cr028")];
  const resolved = selectActiveProject(data);
  assert.equal(resolved.id, "weak-cr028", "a CR028-named project must be selectable on its own merits, not excluded for its name");
});

run("structural: selectActiveProject's source contains no cr028 substring check", () => {
  const source = fs.readFileSync(path.join(root, "lib/project-scope.ts"), "utf8");
  const start = source.indexOf("export function selectActiveProject");
  const end = source.indexOf("\nexport function", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(body, /cr028/i, "selectActiveProject must not reference cr028 in any form");
});

// ── resolveSelectedProject: the canonical resolver for read-only consumers ──

run("an explicitly persisted selection wins over the deterministic fallback", () => {
  const data = biasProbeFixture(); // fallback would pick "strong-other"
  persistSelectedProjectId("weak-cr028");
  const resolved = resolveSelectedProject(data);
  assert.equal(resolved.id, "weak-cr028", "the persisted selection must be honoured even though it isn't the deterministic fallback pick");
});

run("with no selection ever made, resolution falls back deterministically and matches selectActiveProject exactly", () => {
  const data = biasProbeFixture();
  const resolved = resolveSelectedProject(data);
  assert.equal(resolved.id, selectActiveProject(data).id);
});

run("an invalid/no-longer-existing persisted id falls back safely, not to null or a throw", () => {
  const data = biasProbeFixture();
  persistSelectedProjectId("this-project-id-does-not-exist");
  const resolved = resolveSelectedProject(data);
  assert.equal(resolved.id, selectActiveProject(data).id, "must fall back to the deterministic pick, not throw or return null");
});

run("a newly created project becomes selectable and resolvable by id immediately", () => {
  const data = biasProbeFixture();
  const newProject = project({ id: "brand-new-pl10", name: "PL10 Testing" });
  data.projects.push(newProject);
  persistSelectedProjectId("brand-new-pl10");
  const resolved = resolveSelectedProject(data);
  assert.equal(resolved.id, "brand-new-pl10");
  assert.ok(selectCanonicalProjects(data).some((p) => p.id === "brand-new-pl10"), "the new project must appear in the canonical/selectable list");
});

run("selection survives repeated re-resolution (navigation) without drifting", () => {
  const data = biasProbeFixture();
  persistSelectedProjectId("weak-cr028");
  const first = resolveSelectedProject(data);
  const second = resolveSelectedProject(data);
  assert.equal(first.id, "weak-cr028");
  assert.equal(second.id, "weak-cr028");
});

run("switching the persisted selection between two projects resolves each in turn", () => {
  const data = biasProbeFixture();
  persistSelectedProjectId("weak-cr028");
  assert.equal(resolveSelectedProject(data).id, "weak-cr028");
  persistSelectedProjectId("strong-other");
  assert.equal(resolveSelectedProject(data).id, "strong-other");
  persistSelectedProjectId("weak-cr028");
  assert.equal(resolveSelectedProject(data).id, "weak-cr028", "switching back must work identically");
});

run("resolving + scoping never leaks a sibling project's records", () => {
  const data = biasProbeFixture();
  persistSelectedProjectId("weak-cr028");
  const resolved = resolveSelectedProject(data);
  const scoped = scopeProjectData(data, resolved);
  assert.equal(scoped.requirements.length, 0, "weak-cr028 has no requirements of its own — strong-other's must not leak in");
});

console.log("\nAll project-selection tests passed.\n");
