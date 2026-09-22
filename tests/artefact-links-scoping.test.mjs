// artefact_links wired into the canonical scoped-data layer.
//
// Root cause (PL10/F20 audit): artefact_links — the only place a test case
// is ever linked to a requirement or acceptance criterion — was never part
// of EntityMap/DataStore, never in schemaTables (so the generic bulk
// loadData() never fetched it), and never included in scopeProjectData()'s
// output. Every rollup/aggregate calculation (ProjectState, Go-Live,
// Progress) was therefore structurally blind to test<->requirement/AC
// linkage. This file proves the table now flows through the same canonical
// pipeline every other project-scoped table already uses, with project
// isolation preserved (no schema/migration change required — the DB table
// already existed since migration 017).
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
const { schemaTables, writableColumns } = req("../lib/schema.ts");
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

function project(overrides = {}) {
  return { ...seedData.projects[0], project_ref: null, owner: null, ...overrides };
}

function testCase(projectId, overrides = {}) {
  const id = overrides.id ?? `test-${Math.random()}`;
  return {
    id, project_id: projectId, test_ref: "TST-000", scenario: "Scenario",
    expected_result: null, actual_result: null, status: "Pending", owner: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}

function artefactLink(projectId, overrides = {}) {
  const id = overrides.id ?? `link-${Math.random()}`;
  return {
    id, project_id: projectId, source_entity: "requirements", source_id: "req-x",
    target_entity: "test_cases", target_id: "test-x", created_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}

run("schemaTables includes artefact_links, so the generic bulk loadData() fetches it like every other project table", () => {
  const table = schemaTables.find((t) => t.name === "artefact_links");
  assert.ok(table, "artefact_links must be registered in schemaTables");
  const columnNames = table.columns.map((c) => c.name);
  for (const expected of ["id", "project_id", "source_entity", "source_id", "target_entity", "target_id", "created_at"]) {
    assert.ok(columnNames.includes(expected), `artefact_links schema must include column ${expected}`);
  }
});

run("writableColumns includes artefact_links' user-writable columns (not id/created_at)", () => {
  const cols = writableColumns.artefact_links;
  assert.ok(cols, "writableColumns must have an artefact_links entry");
  assert.ok(cols.includes("source_entity"));
  assert.ok(cols.includes("target_id"));
});

run("seedData carries an artefact_links array, so a fresh/local dataset always has the key present", () => {
  assert.ok(Array.isArray(seedData.artefact_links), "seedData.artefact_links must be an array");
});

run("scopeProjectData isolates artefact_links per project — PL10's links never leak into CR028's scope", () => {
  const data = structuredClone(seedData);
  const cr028 = project({ id: "cr028-id", name: "CR028" });
  const pl10 = project({ id: "pl10-id", name: "PL10" });
  data.projects = [cr028, pl10];
  data.artefact_links = [
    artefactLink(cr028.id, { id: "link-cr028" }),
    artefactLink(pl10.id, { id: "link-pl10" }),
  ];

  const scopedCr028 = scopeProjectData(data, cr028);
  const scopedPl10 = scopeProjectData(data, pl10);

  assert.deepEqual(scopedCr028.artefact_links.map((l) => l.id), ["link-cr028"]);
  assert.deepEqual(scopedPl10.artefact_links.map((l) => l.id), ["link-pl10"]);
});

run("scopeProjectData's artefact_links defaults to an empty array when the dataset predates this field", () => {
  const data = structuredClone(seedData);
  const cr028 = project({ id: "cr028-id" });
  data.projects = [cr028];
  delete data.artefact_links;
  const scoped = scopeProjectData(data, cr028);
  assert.deepEqual(scoped.artefact_links, []);
});

run("scopeProjectData also isolates test_cases referenced only by another project's artefact_links", () => {
  const data = structuredClone(seedData);
  const cr028 = project({ id: "cr028-id" });
  const pl10 = project({ id: "pl10-id" });
  data.projects = [cr028, pl10];
  data.test_cases = [testCase(cr028.id, { id: "t-cr028" }), testCase(pl10.id, { id: "t-pl10" })];
  data.artefact_links = [artefactLink(pl10.id, { source_id: "req-pl10", target_id: "t-pl10" })];

  const scopedCr028 = scopeProjectData(data, cr028);
  assert.deepEqual(scopedCr028.test_cases.map((t) => t.id), ["t-cr028"]);
  assert.equal(scopedCr028.artefact_links.length, 0, "PL10's link must not appear in CR028's scope");
});

console.log("\nAll artefact_links scoping tests passed.\n");
