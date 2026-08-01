// Phase 3 — resolveGoLiveDate() and its three migrated consumers.
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
const { resolveGoLiveDate } = req("../lib/project-dates.ts");
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildProjectIntelligence } = req("../lib/project-intelligence.ts");
const { buildAutomatedDailyBrief } = req("../lib/email-content.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "project-dates-1";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function baseData(projectOverrides = {}, milestones = []) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "CR028 - Test Project",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: null,
    go_live_date: null,
    ...projectOverrides,
  };
  const stampedMilestones = milestones.map((m, i) => ({
    id: `milestone-${i}`,
    project_id: PROJECT_ID,
    owner: null,
    notes: "",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...m,
  }));
  return {
    ...data,
    projects: [project],
    milestones: stampedMilestones,
    deliverables: [],
    requirements: [],
    risks: [],
    decisions: [],
    actions: [],
    dependencies: [],
    discovery_questions: [],
    timeline_items: [],
    test_cases: [],
    project_snapshots: [],
    acceptance_criteria: [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    go_live_checklists: [],
    cutover_plan: [],
    activity_log: [],
    documents: [],
    meetings: [],
  };
}

// ── resolveGoLiveDate precedence ─────────────────────────────────────────────

run("milestone outranks go_live_date", () => {
  const data = baseData(
    { go_live_date: "2026-09-01", planned_end_date: "2026-07-24" },
    [{ milestone_ref: "M006", title: "Go Live", target_date: "2026-10-15", status: "Not Started" }],
  );
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.date, "2026-10-15");
  assert.equal(resolution.source, "milestone");
  assert.equal(resolution.milestoneTitle, "Go Live");
});

run("go_live_date outranks planned_end_date when no milestone exists", () => {
  const data = baseData({ go_live_date: "2026-09-01", planned_end_date: "2026-07-24" }, []);
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.date, "2026-09-01");
  assert.equal(resolution.source, "go_live_date");
});

run("planned_end_date fallback when neither milestone nor go_live_date exist", () => {
  const data = baseData({ go_live_date: null, planned_end_date: "2026-07-24" }, []);
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.date, "2026-07-24");
  assert.equal(resolution.source, "planned_end_date");
});

run("no populated source returns none", () => {
  const data = baseData({ go_live_date: null, planned_end_date: null }, []);
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.date, null);
  assert.equal(resolution.source, "none");
});

run("non-Go-Live milestones are ignored", () => {
  const data = baseData(
    { go_live_date: "2026-09-01", planned_end_date: "2026-07-24" },
    [
      { milestone_ref: "M004", title: "SIT Complete", target_date: "2026-07-01", status: "Complete" },
      { milestone_ref: "M005", title: "UAT Complete", target_date: "2026-07-20", status: "Not Started" },
    ],
  );
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.source, "go_live_date");
  assert.equal(resolution.date, "2026-09-01");
});

run("similarly named milestones are handled deterministically: an open milestone outranks a completed one regardless of array order", () => {
  const milestones = [
    { milestone_ref: "M006", title: "Go Live", target_date: "2026-08-01", status: "Complete" },
    { milestone_ref: "M007", title: "Go-Live Retry", target_date: "2026-10-15", status: "Not Started" },
  ];
  const forward = resolveGoLiveDate(baseData({}, milestones), baseData({}, milestones).projects[0]);
  const reversed = resolveGoLiveDate(baseData({}, [...milestones].reverse()), baseData({}, [...milestones].reverse()).projects[0]);
  assert.equal(forward.date, "2026-10-15");
  assert.equal(forward.milestoneTitle, "Go-Live Retry");
  assert.equal(reversed.date, forward.date);
  assert.equal(reversed.milestoneTitle, forward.milestoneTitle);
  assert.ok(forward.conflicts.some((c) => c.date === "2026-08-01"), "expected the losing milestone to be reported as a conflict");
});

run("similarly named milestones with the same status: the latest target_date wins deterministically, independent of array order", () => {
  const milestones = [
    { milestone_ref: "M006", title: "Go Live", target_date: "2026-08-01", status: "Not Started" },
    { milestone_ref: "M007", title: "Go Live (draft)", target_date: "2026-10-15", status: "Not Started" },
  ];
  const forward = resolveGoLiveDate(baseData({}, milestones), baseData({}, milestones).projects[0]);
  const reversed = resolveGoLiveDate(baseData({}, [...milestones].reverse()), baseData({}, [...milestones].reverse()).projects[0]);
  assert.equal(forward.date, "2026-10-15");
  assert.equal(reversed.date, "2026-10-15");
});

run("conflicts are reported when multiple populated sources disagree, but resolution still succeeds", () => {
  const data = baseData(
    { go_live_date: "2026-09-01", planned_end_date: "2026-07-24" },
    [{ milestone_ref: "M006", title: "Go Live", target_date: "2026-10-15", status: "Not Started" }],
  );
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.date, "2026-10-15");
  assert.ok(resolution.conflicts.length >= 2, "expected go_live_date and planned_end_date to be reported as conflicting sources");
  assert.ok(resolution.conflicts.some((c) => c.source === "go_live_date" && c.date === "2026-09-01"));
  assert.ok(resolution.conflicts.some((c) => c.source === "planned_end_date" && c.date === "2026-07-24"));
});

run("no conflict is reported when populated sources agree on the same date", () => {
  const data = baseData({ go_live_date: "2026-10-15", planned_end_date: "2026-10-15" }, []);
  const resolution = resolveGoLiveDate(data, data.projects[0]);
  assert.equal(resolution.conflicts.length, 0);
});

// ── All three consumers use the shared resolver ─────────────────────────────

// PHASE 7 (reviewed, intentional change): email-content.ts no longer imports
// lib/project-dates directly — it reads goLiveDate off lib/project-state.ts's
// ProjectState instead, which itself calls resolveGoLiveDate exactly once
// per project. This is a stricter form of the same guarantee (one resolver
// call per project, not one per consumer), verified behaviourally below by
// "the automated daily brief's Go-Live KPI reflects go_live_date...".
run("structural: go-live-readiness.ts and project-intelligence.ts import the shared resolver directly; email-content.ts consumes it transitively via lib/project-state.ts", () => {
  for (const file of ["lib/go-live-readiness.ts", "lib/project-intelligence.ts"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /from ["']@\/lib\/project-dates["']/, `${file} does not import lib/project-dates`);
    assert.doesNotMatch(source, /go\.\?live.*test.*milestone|milestone.*find.*go\.\?live/i, `${file} still contains its own milestone-matching go-live-date logic`);
  }
  const emailContentSource = fs.readFileSync(path.join(root, "lib/email-content.ts"), "utf8");
  assert.match(emailContentSource, /from ["']@\/lib\/project-state["']/, "lib/email-content.ts does not import lib/project-state");
  assert.doesNotMatch(emailContentSource, /go\.\?live.*test.*milestone|milestone.*find.*go\.\?live/i, "lib/email-content.ts still contains its own milestone-matching go-live-date logic");
});

run("buildGoLiveDashboard reflects go_live_date over planned_end_date when no milestone exists (proves it uses the resolver, not raw planned_end_date)", () => {
  const data = baseData({ go_live_date: "2026-09-01", planned_end_date: "2026-07-24" }, []);
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(dashboard.goLiveDate, "2026-09-01");
});

run("buildProjectIntelligence's GLR-001 fires based on the resolver's selected date, not planned_end_date", () => {
  const data = baseData({ go_live_date: "2026-08-02", planned_end_date: "2026-12-01" }, []); // go_live_date is within 7 days of `now`; planned_end_date is not
  data.go_live_checklists = [
    { id: "glc-1", project_id: PROJECT_ID, category: "UAT", item: "Customer UAT sign-off", owner: "Sysco", status: "Not Started", due_date: null, completed_date: null, notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
  ];
  const intelligence = buildProjectIntelligence(data, data.projects[0], now);
  assert.ok(intelligence.findings.some((f) => f.ruleId === "GLR-001"), "expected GLR-001 to fire using go_live_date (5 days out), proving planned_end_date (far in the future) is not what's driving the rule");
});

run("buildProjectIntelligence's GLR-001 does not fire when the resolved date is far away even though planned_end_date alone would have been close", () => {
  const data = baseData({ go_live_date: "2026-12-01", planned_end_date: "2026-08-02" }, []); // go_live_date wins and is far away; planned_end_date alone would be within 7 days
  data.go_live_checklists = [
    { id: "glc-1", project_id: PROJECT_ID, category: "UAT", item: "Customer UAT sign-off", owner: "Sysco", status: "Not Started", due_date: null, completed_date: null, notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
  ];
  const intelligence = buildProjectIntelligence(data, data.projects[0], now);
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-001"), false, "GLR-001 should not fire — the resolver's selected date (go_live_date, Dec) is far away, not the stale planned_end_date (Aug)");
});

run("the automated daily brief's Go-Live KPI reflects go_live_date, not planned_end_date, when no milestone exists", () => {
  const data = baseData({ go_live_date: "2026-09-01", planned_end_date: "2026-12-25" }, []);
  const content = buildAutomatedDailyBrief(data, now);
  assert.ok(content.html.includes("2026-09-01"), "expected the resolved go_live_date to appear in the daily brief HTML");
  assert.ok(!content.html.includes("2026-12-25"), "planned_end_date should not appear anywhere in the Go-Live KPI once a go_live_date is set");
});

console.log("\nAll Phase 3 project-dates tests passed.\n");
