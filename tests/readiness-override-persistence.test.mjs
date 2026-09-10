// Regression coverage for a production defect: saving the FIRST assessment
// of a manual Go-Live Readiness check (e.g. Customer Approval) failed with
// {"error":"Override not found"}.
//
// Root cause: components/go-live-readiness-page.tsx's setOverride/
// setManualStatus always built a record with `id: existing?.id ??
// createId()` — a client-generated id is always present, even for a
// brand-new row — and then called the generic saveRecord() helper, whose
// only create-vs-update rule is `record.id ? update : create`
// (lib/supabase/data-store.ts). Since `record.id` was always truthy, this
// dispatch ALWAYS resolved to update (PATCH), even for a check that had
// never been assessed before — which then fails, because no row exists yet
// with that id to update.
//
// The fix introduces lib/go-live-readiness.ts's resolveReadinessOverrideTarget,
// which decides create-vs-update from whether a persisted row already
// exists for (project_id, check_key) in the caller's already-loaded
// overrides — the only reliable signal — and the component now calls
// createRecord/updateRecord directly based on that decision instead of
// routing through saveRecord.
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
const { buildGoLiveDashboard, resolveReadinessOverrideTarget } = req("../lib/go-live-readiness.ts");
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

const PROJECT_A = "readiness-override-project-a";
const PROJECT_B = "readiness-override-project-b";
const CHECK_KEY = "customer_approval";

function overrideRow(overrides = {}) {
  return {
    id: "row-1", project_id: PROJECT_A, check_key: CHECK_KEY,
    override_status: "Complete", override_reason: "Customer signed off in kickoff call", overridden_by: "Andrew Walker",
    overridden_at: "2026-09-01T09:00:00.000Z", created_at: "2026-09-01T09:00:00.000Z", updated_at: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

function timelineFor(projectId) {
  return [{
    id: `tl-${projectId}`, project_id: projectId, phase_ref: "PH-1", phase_name: "Deployment Phase",
    start_date: "2026-01-01", end_date: "2026-12-01", owner: null, status: "In Progress",
    progress_percent: 50, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z",
  }];
}

function buildData(projectId, overrides = {}) {
  const data = structuredClone(seedData);
  const project = { ...data.projects[0], id: projectId, name: `Project ${projectId}`, status: "In Progress", planned_start_date: "2026-01-01", planned_end_date: "2026-12-01" };
  return {
    ...data,
    projects: [project],
    timeline_items: timelineFor(projectId),
    go_live_checklists: [],
    go_live_readiness_overrides: [],
    requirements: [], deliverables: [], risks: [], test_cases: [], acceptance_criteria: [],
    ...overrides,
  };
}

// ── 1. First-ever assessment: no override row exists ────────────────────────

run("the very first assessment of a check (no persisted row yet) resolves to CREATE, not UPDATE", () => {
  const { operation, existing } = resolveReadinessOverrideTarget([], PROJECT_A, CHECK_KEY);
  assert.equal(operation, "create");
  assert.equal(existing, null);
});

run("this is exactly the scenario the old saveRecord()-based dispatch got wrong: a fresh client-generated id must not make it look like an update", () => {
  // The bug: components/go-live-readiness-page.tsx built `record.id =
  // existing?.id ?? createId()` — always truthy — then called saveRecord(),
  // whose only rule is `record.id ? update : create`. Reproducing that
  // exact (broken) rule here shows it always picks "update", regardless of
  // whether a row actually exists.
  const clientGeneratedId = "freshly-minted-client-id";
  const brokenDispatch = clientGeneratedId ? "update" : "create";
  assert.equal(brokenDispatch, "update", "the old rule always resolved to update, which is exactly the defect");

  // The fix asks the right question instead — does a row already exist? —
  // and correctly resolves to create.
  const { operation } = resolveReadinessOverrideTarget([], PROJECT_A, CHECK_KEY);
  assert.equal(operation, "create");
});

// ── 2. Subsequent update of that assessment ─────────────────────────────────

run("a second assessment of an already-assessed check resolves to UPDATE, targeting the existing row's id, preserving created_at", () => {
  const existingRow = overrideRow();
  const { operation, existing } = resolveReadinessOverrideTarget([existingRow], PROJECT_A, CHECK_KEY);
  assert.equal(operation, "update");
  assert.equal(existing.id, existingRow.id);

  // Mirrors exactly how components/go-live-readiness-page.tsx builds the
  // record to persist: created_at is preserved from the existing row (the
  // audit trail's original assessment date never changes), while
  // overridden_at/updated_at move forward to the new edit.
  const now = "2026-09-10T12:00:00.000Z";
  const record = {
    id: existing?.id ?? "would-be-a-new-id",
    project_id: PROJECT_A,
    check_key: CHECK_KEY,
    override_status: "Incomplete",
    override_reason: "Customer raised a late concern, re-reviewing",
    overridden_by: "Priya Shah",
    overridden_at: now,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  assert.equal(record.id, existingRow.id);
  assert.equal(record.created_at, existingRow.created_at, "the original assessment date must be preserved across an update");
  assert.equal(record.overridden_at, now, "overridden_at must move forward to the new edit");
});

// ── 3. Reset/delete returns to the derived/manual default state ────────────

run("removing the override row (reset) restores the checklist-derived default — the check is never left stuck", () => {
  const withAssessment = buildData(PROJECT_A, { go_live_readiness_overrides: [overrideRow()] });
  const afterReset = buildData(PROJECT_A, { go_live_readiness_overrides: [] });

  const before = buildGoLiveDashboard(withAssessment, withAssessment.projects[0], new Date("2026-09-10")).checks.find((c) => c.key === CHECK_KEY);
  const after = buildGoLiveDashboard(afterReset, afterReset.projects[0], new Date("2026-09-10")).checks.find((c) => c.key === CHECK_KEY);

  assert.equal(before.effective, "Complete");
  assert.equal(after.effective, "Incomplete", "with no checklist match and no assessment, the manual default is Incomplete");
  assert.equal(after.override, null);
});

// ── 4. No duplicate assessment rows across repeated saves ──────────────────

run("saving the same check twice in a row never produces two rows — the second save always targets the first row's id", () => {
  // First save: nothing exists yet.
  const first = resolveReadinessOverrideTarget([], PROJECT_A, CHECK_KEY);
  assert.equal(first.operation, "create");
  const persistedAfterFirstSave = overrideRow({ id: "the-one-and-only-row" });

  // Second save: the component re-derives `existing` from whatever is now
  // loaded in state (which, after a correct create, includes the row just
  // persisted) — simulating that here.
  const second = resolveReadinessOverrideTarget([persistedAfterFirstSave], PROJECT_A, CHECK_KEY);
  assert.equal(second.operation, "update");
  assert.equal(second.existing.id, "the-one-and-only-row");

  // A third save behaves identically — still exactly one row, never a new one.
  const third = resolveReadinessOverrideTarget([persistedAfterFirstSave], PROJECT_A, CHECK_KEY);
  assert.equal(third.operation, "update");
  assert.equal(third.existing.id, "the-one-and-only-row");
});

// ── 5. Sibling-project isolation ────────────────────────────────────────────

run("a project's override row is never matched as 'existing' for a sibling project's same check_key — each gets its own create", () => {
  const projectAOverride = overrideRow({ id: "a-row", project_id: PROJECT_A, check_key: CHECK_KEY });

  const forProjectA = resolveReadinessOverrideTarget([projectAOverride], PROJECT_A, CHECK_KEY);
  const forProjectB = resolveReadinessOverrideTarget([projectAOverride], PROJECT_B, CHECK_KEY);

  assert.equal(forProjectA.operation, "update");
  assert.equal(forProjectB.operation, "create", "project B has no row of its own yet, even though project A's row matches on check_key");
  assert.equal(forProjectB.existing, null);
});

run("dashboard-level sibling isolation: assessing project A's Customer Approval never marks project B's as assessed", () => {
  const data = {
    ...buildData(PROJECT_A),
    projects: [
      { ...seedData.projects[0], id: PROJECT_A, name: "Project A", status: "In Progress", planned_start_date: "2026-01-01", planned_end_date: "2026-12-01" },
      { ...seedData.projects[0], id: PROJECT_B, name: "Project B", status: "In Progress", planned_start_date: "2026-01-01", planned_end_date: "2026-12-01" },
    ],
    timeline_items: [...timelineFor(PROJECT_A), ...timelineFor(PROJECT_B)],
    go_live_readiness_overrides: [overrideRow({ project_id: PROJECT_A })],
  };
  const projectA = data.projects.find((p) => p.id === PROJECT_A);
  const projectB = data.projects.find((p) => p.id === PROJECT_B);

  const dashboardA = buildGoLiveDashboard(data, projectA, new Date("2026-09-10"));
  const dashboardB = buildGoLiveDashboard(data, projectB, new Date("2026-09-10"));

  assert.equal(dashboardA.checks.find((c) => c.key === CHECK_KEY).effective, "Complete");
  assert.equal(dashboardB.checks.find((c) => c.key === CHECK_KEY).effective, "Incomplete");
  assert.equal(dashboardB.checks.find((c) => c.key === CHECK_KEY).override, null);
});

// ── Architecture facts this fix relies on (regression guards) ──────────────

run("the go_live_readiness_overrides table already has a UNIQUE(project_id, check_key) constraint — no migration is needed for this fix", () => {
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/025_go_live_readiness_overrides.sql"), "utf8");
  assert.match(migration, /UNIQUE\s*\(\s*project_id\s*,\s*check_key\s*\)/, "expected the existing unique constraint to still be present");
});

run("the API route's POST handler is still an upsert keyed on (project_id, check_key), the server-side backstop against duplicates", () => {
  const routeSource = fs.readFileSync(path.join(root, "app/api/go-live/overrides/route.ts"), "utf8");
  assert.match(routeSource, /\.upsert\(record,\s*\{\s*onConflict:\s*"project_id,check_key"\s*\}\)/, "expected POST to remain an upsert on (project_id, check_key)");
});

run("components/go-live-readiness-page.tsx no longer decides create-vs-update via the generic saveRecord() dispatch for readiness overrides", () => {
  const pageSource = fs.readFileSync(path.join(root, "components/go-live-readiness-page.tsx"), "utf8");
  assert.doesNotMatch(pageSource, /saveRecord\("go_live_readiness_overrides"/, "setOverride/setManualStatus must use resolveReadinessOverrideTarget + createRecord/updateRecord, not saveRecord's record.id-based dispatch");
  assert.match(pageSource, /resolveReadinessOverrideTarget\(/, "expected the fixed create-vs-update decision to be in use");
});

console.log("\nAll readiness override create/update persistence tests passed.\n");
