// New feature — the "Create New Project" workflow. Project creation was
// previously undiscoverable/broken: the generic module CRUD table already
// rendered an "Add Project" button, but the projects table's RLS only
// allowed Admin (not Manager) to write, there was no reference/owner field,
// and nothing wired a new project into the selected-project dropdown or
// navigated to it. This introduces:
//   - lib/permissions.ts: canCreateProject (Admin/Manager only)
//   - lib/project-creation.ts: pure validation/conflict/record-building,
//     shared by the client dialog and the server route
//   - app/api/projects POST: a service-role-backed route (bypasses the
//     Admin-only RLS mismatch), enforcing the same role check server-side
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
const { canCreateProject } = req("../lib/permissions.ts");
const { validateNewProjectInput, findConflictingProject, buildNewProjectRecord } = req("../lib/project-creation.ts");
const projectsRoute = req("../app/api/projects/route.ts");
const { NextRequest } = req("next/server");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

function fullInput(overrides = {}) {
  return {
    project_ref: "PL10",
    name: "PL10 Testing / Replenishment Go-Live — Week of 21 Sept",
    customer: "Sysco",
    workstream: "Replenishment",
    owner: "Andy Walker",
    description: "A second live project.",
    status: "Discovery",
    planned_start_date: null,
    planned_end_date: null,
    go_live_date: null,
    uat_complete_date: null,
    hypercare_start_date: null,
    hypercare_end_date: null,
    ...overrides,
  };
}

// ── canCreateProject: the permission predicate ──────────────────────────────

run("Admin can create a project", () => {
  assert.equal(canCreateProject("Admin"), true);
});

run("Manager can create a project", () => {
  assert.equal(canCreateProject("Manager"), true);
});

run("Viewer cannot create a project", () => {
  assert.equal(canCreateProject("Viewer"), false);
});

run("an unresolved/missing role cannot create a project", () => {
  assert.equal(canCreateProject(null), false);
  assert.equal(canCreateProject(undefined), false);
});

// ── validateNewProjectInput: required-field validation ──────────────────────

run("a fully-populated input is valid", () => {
  assert.equal(validateNewProjectInput(fullInput()), null);
});

run("a valid input needs no lifecycle dates at all — only name/customer/workstream/reference", () => {
  const input = fullInput({
    owner: null,
    description: null,
    planned_start_date: undefined,
    planned_end_date: undefined,
    go_live_date: undefined,
    uat_complete_date: undefined,
    hypercare_start_date: undefined,
    hypercare_end_date: undefined,
  });
  assert.equal(validateNewProjectInput(input), null);
});

for (const field of ["project_ref", "name", "customer", "workstream"]) {
  run(`missing ${field} is rejected`, () => {
    const error = validateNewProjectInput(fullInput({ [field]: "" }));
    assert.ok(error, `expected an error when ${field} is blank`);
    assert.match(error, new RegExp(field === "project_ref" ? "reference" : field, "i"));
  });

  run(`whitespace-only ${field} is rejected`, () => {
    const error = validateNewProjectInput(fullInput({ [field]: "   " }));
    assert.ok(error, `expected an error when ${field} is whitespace-only`);
  });
}

// ── findConflictingProject: duplicate/conflicting reference handling ───────

run("no conflict against an empty project list", () => {
  assert.equal(findConflictingProject([], fullInput()), null);
});

run("no conflict when name and reference are both distinct", () => {
  const existing = [{ name: "CR 28 Multi Delivery Dates", project_ref: "CR028" }];
  assert.equal(findConflictingProject(existing, fullInput()), null);
});

run("an exact duplicate name conflicts", () => {
  const existing = [{ name: "PL10 Testing / Replenishment Go-Live — Week of 21 Sept", project_ref: null }];
  const conflict = findConflictingProject(existing, fullInput());
  assert.deepEqual(conflict, { field: "name", value: fullInput().name });
});

run("a duplicate name differing only in case/whitespace still conflicts (the DB's plain unique index would miss this)", () => {
  const existing = [{ name: "  pl10 testing / replenishment go-live — week of 21 sept  ", project_ref: null }];
  const conflict = findConflictingProject(existing, fullInput());
  assert.equal(conflict?.field, "name");
});

run("a duplicate project_ref conflicts even with a different name", () => {
  const existing = [{ name: "Something Else Entirely", project_ref: "PL10" }];
  const conflict = findConflictingProject(existing, fullInput());
  assert.deepEqual(conflict, { field: "project_ref", value: "PL10" });
});

run("a duplicate project_ref differing only in case still conflicts", () => {
  const existing = [{ name: "Something Else Entirely", project_ref: "pl10" }];
  const conflict = findConflictingProject(existing, fullInput());
  assert.equal(conflict?.field, "project_ref");
});

run("an existing project with a null project_ref never conflicts on reference", () => {
  const existing = [{ name: "CR 28 Multi Delivery Dates", project_ref: null }];
  assert.equal(findConflictingProject(existing, fullInput()), null);
});

// ── buildNewProjectRecord: lifecycle dates are null where appropriate, never invented ──

run("all lifecycle dates default to null when omitted — none are invented", () => {
  const input = fullInput();
  const record = buildNewProjectRecord(input);
  for (const field of ["planned_start_date", "planned_end_date", "go_live_date", "uat_complete_date", "hypercare_start_date", "hypercare_end_date"]) {
    assert.equal(record[field], null, `expected ${field} to be null, not manufactured`);
  }
});

run("a provided lifecycle date is passed through untouched", () => {
  const record = buildNewProjectRecord(fullInput({ go_live_date: "2026-10-01" }));
  assert.equal(record.go_live_date, "2026-10-01");
});

run("status defaults to Discovery when omitted, matching the DB column default", () => {
  const record = buildNewProjectRecord(fullInput({ status: null }));
  assert.equal(record.status, "Discovery");
});

run("strings are trimmed; blank optional fields become null, not empty strings", () => {
  const record = buildNewProjectRecord(fullInput({ project_ref: "  PL10  ", owner: "   ", description: "" }));
  assert.equal(record.project_ref, "PL10");
  assert.equal(record.owner, null);
  assert.equal(record.description, null);
});

run("buildNewProjectRecord never sets health, schedule_variance, or an id — those are the database's job", () => {
  const record = buildNewProjectRecord(fullInput());
  assert.equal("health" in record, false);
  assert.equal("schedule_variance" in record, false);
  assert.equal("id" in record, false);
});

// ── POST /api/projects — validation, permission gate, structural wiring ────

await runAsync("missing required fields are rejected with 400 before any database access", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "", customer: "Sysco", workstream: "Replenishment", project_ref: "PL10" }),
    });
    const res = await projectsRoute.POST(request);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /name/i);
  });
});

await runAsync("a fully valid Admin/Manager-shaped request passes validation and the permission gate, reaching only the (unconfigured, offline-test) database layer", async () => {
  await withNodeEnv("test", async () => {
    const request = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify(fullInput()),
    });
    const res = await projectsRoute.POST(request);
    // 500 "Database not configured" proves required-field validation AND the
    // canCreateProject gate were already passed — only the (unconfigured, in
    // this offline test harness) database layer stops it. A 400/401/403
    // here would mean validation or the permission gate rejected it first.
    assert.equal(res.status, 500, `expected a fully valid request to reach the DB layer, got ${res.status}`);
    const body = await res.json();
    assert.match(body.error, /Database not configured/);
  });
});

await runAsync("anonymous production requests are rejected with 401", async () => {
  await withNodeEnv("production", async () => {
    const request = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify(fullInput()),
    });
    const res = await projectsRoute.POST(request);
    assert.equal(res.status, 401);
  });
});

run("structural: app/api/projects/route.ts enforces canCreateProject, not a re-derived Admin/Manager check", () => {
  const source = fs.readFileSync(path.join(root, "app/api/projects/route.ts"), "utf8");
  assert.match(source, /canCreateProject|requireCanCreateProject/, "the route must use the shared canCreateProject permission predicate");
  assert.doesNotMatch(source, /role\s*===\s*["']Admin["']\s*\|\|\s*role\s*===\s*["']Manager["']/, "must not re-derive the Admin-or-Manager check inline instead of using the shared predicate");
});

run("structural: app/api/projects/route.ts uses the shared lib/project-creation validation, not inline duplicate logic", () => {
  const source = fs.readFileSync(path.join(root, "app/api/projects/route.ts"), "utf8");
  assert.match(source, /from ["']@\/lib\/project-creation["']/, "the route should import the shared validation/record-building module");
});

run("structural: app/api/projects/route.ts writes via the service-role client, not the anon client", () => {
  const source = fs.readFileSync(path.join(root, "app/api/projects/route.ts"), "utf8");
  assert.match(source, /createServiceRoleClient/, "must use the service-role client so Manager isn't blocked by the Admin-only projects RLS policy");
});

console.log("\nAll project-creation tests passed.\n");
