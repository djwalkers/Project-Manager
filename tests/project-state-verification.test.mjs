// ProjectState exposes the canonical test-verification rollup (lib/lifecycle/test-verification.ts)
// so every consumer — Requirements page, requirement/AC detail panels, and any
// future consumer such as the Test Status email — reads exactly the same
// derived numbers instead of re-deriving them. See PL10/F20 audit.
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
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function project(id, overrides = {}) {
  return { ...seedData.projects[0], id, project_ref: null, owner: null, status: "In Progress", ...overrides };
}

function fixture() {
  const data = structuredClone(seedData);
  const projectA = project("proj-a", { name: "Project A" });
  const projectB = project("proj-b", { name: "Project B" });

  const requirements = [
    { id: "req-a", project_id: "proj-a", requirement_ref: "REQ-A001", title: "Requirement A", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Owner", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    { id: "req-b", project_id: "proj-b", requirement_ref: "REQ-B001", title: "Requirement B", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Owner", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];
  const acceptance_criteria = [
    { id: "ac-a", project_id: "proj-a", requirement_id: "req-a", ac_ref: "AC-A001", criterion: "Criterion A", description: null, status: "Not Started", owner: null, evidence: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];
  const test_cases = [
    { id: "test-a", project_id: "proj-a", test_ref: "TST-A001", scenario: "Scenario A", expected_result: null, actual_result: null, status: "Passed", owner: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    { id: "test-b", project_id: "proj-b", test_ref: "TST-B001", scenario: "Scenario B", expected_result: null, actual_result: null, status: "Failed", owner: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];
  const artefact_links = [
    { id: "link-a", project_id: "proj-a", source_entity: "acceptance_criteria", source_id: "ac-a", target_entity: "test_cases", target_id: "test-a", created_at: "2026-06-01T00:00:00.000Z" },
  ];

  return {
    ...data,
    projects: [projectA, projectB],
    timeline_items: [], milestones: [], risks: [], actions: [], decisions: [],
    requirements, deliverables: [], dependencies: [], discovery_questions: [],
    test_cases, acceptance_criteria, artefact_links,
    go_live_checklists: [], cutover_plan: [], go_live_readiness_overrides: [],
    project_snapshots: [], evidence: [], requirement_sign_offs: [],
    meeting_intelligence: [], meeting_suggestions: [], activity_log: [], documents: [], meetings: [],
  };
}

run("ProjectState exposes a verification rollup derived from the same scoped data as everything else", () => {
  const data = fixture();
  const projectA = data.projects.find((p) => p.id === "proj-a");
  const state = buildProjectState(data, projectA, now);
  assert.ok(state.verification, "ProjectState must expose a verification field");
  const rv = state.verification.byRequirement["req-a"];
  assert.ok(rv, "requirement req-a must have a verification entry");
  assert.equal(rv.state, "Verified");
  assert.equal(rv.testCount, 1);
});

run("ProjectState.verification never leaks project B's tests into project A's requirement", () => {
  const data = fixture();
  const projectA = data.projects.find((p) => p.id === "proj-a");
  const state = buildProjectState(data, projectA, now);
  const rv = state.verification.byRequirement["req-a"];
  assert.ok(!rv.tests.some((t) => t.testId === "test-b"), "project B's test must never appear under project A's requirement");
});

run("ProjectState.verification for project B is computed independently and does not see project A's link", () => {
  const data = fixture();
  const projectB = data.projects.find((p) => p.id === "proj-b");
  const state = buildProjectState(data, projectB, now);
  const rv = state.verification.byRequirement["req-b"];
  assert.equal(rv.testCount, 0, "req-b has no AC and no direct test link, so it must show zero linked tests");
  assert.equal(rv.state, "No Tests Linked");
});

run("structural: buildProjectState computes verification via the canonical computeTestVerification, not a re-derived copy", () => {
  const source = fs.readFileSync(path.join(root, "lib/project-state.ts"), "utf8");
  assert.match(source, /computeTestVerification/, "lib/project-state.ts must call the canonical computeTestVerification");
});

console.log("\nAll ProjectState verification-rollup tests passed.\n");
