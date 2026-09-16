// Corrective fix — calculateProgress()'s Requirements component must use the
// shared isRequirementSignedOff() lifecycle helper (Approved/Complete/Closed
// all count as done), not a bare `status === "Complete"` check. Every other
// readiness/gating computation in the app already treats a signed-off
// requirement as done; calculateProgress() was the one outlier, silently
// scoring a fully-approved requirement set at 0% and dragging the CR028
// Workspace "Progress" tile down to 64% instead of ~94%.
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
const { calculateProgress } = req("../lib/control-tower.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function requirement(status, overrides = {}) {
  return {
    id: `req-${Math.random()}`,
    project_id: "p1",
    requirement_ref: "REQ-000",
    title: "Requirement",
    description: null,
    priority: "Medium",
    category: "Business Rule",
    status,
    owner: "Owner",
    source: null,
    notes: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// calculateProgress only reads these five arrays off the DataStore it's given.
function dataWith(requirements) {
  return {
    requirements,
    milestones: [],
    actions: [],
    test_cases: [],
    discovery_questions: [],
  };
}

function requirementsScore(requirements) {
  const progress = calculateProgress(dataWith(requirements), "Green");
  return progress.components.find((c) => c.label === "Requirements").score;
}

// ── Requirement sign-off statuses count as done ─────────────────────────────

run("an Approved requirement counts as complete", () => {
  assert.equal(requirementsScore([requirement("Approved")]), 1);
});

run("a Complete requirement counts as complete", () => {
  assert.equal(requirementsScore([requirement("Complete")]), 1);
});

run("a Closed requirement counts as complete", () => {
  assert.equal(requirementsScore([requirement("Closed")]), 1);
});

run("non-terminal requirement statuses do not count as complete", () => {
  for (const status of ["Discovery", "Open", "In Progress", "Pending", "Blocked"]) {
    assert.equal(requirementsScore([requirement(status)]), 0, `expected "${status}" to score 0`);
  }
});

run("a mix of signed-off and open requirements scores proportionally", () => {
  // 3 of 4 signed off (Approved, Complete, Closed), 1 still Open.
  const score = requirementsScore([
    requirement("Approved"),
    requirement("Complete"),
    requirement("Closed"),
    requirement("Open"),
  ]);
  assert.equal(score, 0.75);
});

// ── Weighting is unchanged ──────────────────────────────────────────────────

run("component weights remain Requirements 30 / Milestones 25 / Actions 20 / Testing 15 / Discovery 10", () => {
  const progress = calculateProgress(dataWith([requirement("Approved")]), "Green");
  const weightsByLabel = Object.fromEntries(progress.components.map((c) => [c.label, c.weight]));
  assert.deepEqual(weightsByLabel, {
    Requirements: 30,
    Milestones: 25,
    Actions: 20,
    Testing: 15,
    Discovery: 10,
  });
});

// ── CR028-shaped data reproduces the verified ~94% result ───────────────────

run("CR028-shaped live data (15 Approved requirements, 5/6 milestones, 9/10 actions, 6/6 tests passed, 13/13 discovery closed) produces ~94% overall progress", () => {
  const data = {
    requirements: Array.from({ length: 15 }, () => requirement("Approved")),
    milestones: [
      ...Array.from({ length: 5 }, () => ({ status: "Complete" })),
      { status: "In Progress" },
    ],
    actions: [
      ...Array.from({ length: 9 }, () => ({ status: "Complete" })),
      { status: "In Progress" },
    ],
    test_cases: Array.from({ length: 6 }, () => ({ status: "Passed" })),
    discovery_questions: Array.from({ length: 13 }, () => ({ status: "Closed" })),
  };
  const progress = calculateProgress(data, "Green");
  assert.equal(progress.overall, 94, `expected overall progress of 94, got ${progress.overall}`);
});

console.log("\nAll progress-requirement-signoff tests passed.\n");
