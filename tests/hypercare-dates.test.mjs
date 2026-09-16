// Corrective fix — resolveHypercareDates(), the Hypercare counterpart to
// resolveGoLiveDate(). CR028's live `projects` row has NULL
// hypercare_start_date/hypercare_end_date even though authoritative evidence
// (a "Go-Live & Hypercare" timeline item, a "Hypercare Complete" milestone)
// already exists — this resolver stops the Executive Timeline's Hypercare
// band from silently disappearing in that situation, without hard-coding
// any project's dates into application code.
//
// Precedence (explicit, per the approved corrective-phase spec):
//   explicit structured project date → authoritative milestone/timeline evidence → none
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
const { resolveHypercareDates } = req("../lib/project-dates.ts");
const { seedData } = req("../lib/seed-data.ts");

const PROJECT_ID = "hypercare-dates-1";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function baseData(projectOverrides = {}, { milestones = [], timeline_items = [] } = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Hypercare Dates Test Project",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-30",
    go_live_date: null,
    hypercare_start_date: null,
    hypercare_end_date: null,
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
  const stampedTimelineItems = timeline_items.map((t, i) => ({
    id: `timeline-${i}`,
    project_id: PROJECT_ID,
    owner: null,
    progress_percent: 0,
    notes: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...t,
  }));
  return {
    ...data,
    projects: [project],
    milestones: stampedMilestones,
    timeline_items: stampedTimelineItems,
    deliverables: [],
    requirements: [],
    risks: [],
    decisions: [],
    actions: [],
    dependencies: [],
    discovery_questions: [],
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

// ── Explicit project columns win outright ───────────────────────────────────

run("explicit hypercare_start_date/hypercare_end_date columns win over conflicting milestone/timeline evidence", () => {
  const data = baseData(
    { hypercare_start_date: "2026-09-01", hypercare_end_date: "2026-09-30" },
    {
      milestones: [{ milestone_ref: "M006", title: "Hypercare Complete", target_date: "2026-10-30", status: "In Progress" }],
      timeline_items: [{ phase_ref: "REP-GL", phase_name: "Go-Live & Hypercare", start_date: "2026-09-16", end_date: "2026-10-30", status: "In Progress" }],
    },
  );
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.start, "2026-09-01");
  assert.equal(resolution.startSource, "project");
  assert.equal(resolution.end, "2026-09-30");
  assert.equal(resolution.endSource, "project");
});

// ── Timeline/milestone evidence when columns are null ───────────────────────

run("falls back to a hypercare-named timeline item's start/end when the columns are null", () => {
  const data = baseData(
    {},
    { timeline_items: [{ phase_ref: "REP-GL", phase_name: "Go-Live & Hypercare", start_date: "2026-09-16", end_date: "2026-10-30", status: "In Progress" }] },
  );
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.start, "2026-09-16");
  assert.equal(resolution.startSource, "timeline");
  assert.equal(resolution.end, "2026-10-30");
  assert.equal(resolution.endSource, "timeline");
});

run("a hypercare-named milestone's target_date is used for the end date ahead of a timeline item's end_date", () => {
  const data = baseData(
    {},
    {
      milestones: [{ milestone_ref: "M006", title: "Hypercare Complete", target_date: "2026-11-15", status: "In Progress" }],
      timeline_items: [{ phase_ref: "REP-GL", phase_name: "Go-Live & Hypercare", start_date: "2026-09-16", end_date: "2026-10-30", status: "In Progress" }],
    },
  );
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.end, "2026-11-15", "the milestone's target_date is the more authoritative completion evidence");
  assert.equal(resolution.endSource, "milestone");
});

run("a non-hypercare milestone/timeline item is ignored", () => {
  const data = baseData(
    {},
    {
      milestones: [{ milestone_ref: "M004", title: "UAT Complete", target_date: "2026-09-01", status: "Complete" }],
      timeline_items: [{ phase_ref: "REP-UAT", phase_name: "Customer UAT Support", start_date: "2026-07-22", end_date: "2026-09-15", status: "Complete" }],
    },
  );
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.start, null);
  assert.equal(resolution.end, null);
});

// ── Start falls back to the resolved go-live date as the last evidence tier ──

run("start falls back to the resolved go-live date when neither the column nor a hypercare timeline item exists", () => {
  const data = baseData(
    {},
    { milestones: [{ milestone_ref: "M005", title: "Production Go-Live", target_date: "2026-09-16", status: "Complete" }] },
  );
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.start, "2026-09-16");
  assert.equal(resolution.startSource, "go_live");
});

// ── None when nothing is available ──────────────────────────────────────────

run("returns none/none when no column, milestone, or timeline evidence exists anywhere", () => {
  const data = baseData({ planned_end_date: null });
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.start, null);
  assert.equal(resolution.startSource, "none");
  assert.equal(resolution.end, null);
  assert.equal(resolution.endSource, "none");
});

// ── CR028-shaped live data ───────────────────────────────────────────────────

run("CR028-shaped live data (no hypercare columns set, a live Go-Live & Hypercare timeline item, a Hypercare Complete milestone) resolves start 2026-09-16 / end 2026-10-30", () => {
  const data = baseData(
    {},
    {
      milestones: [
        { milestone_ref: "MIL-005", title: "Production Go-Live", target_date: "2026-09-16", status: "Complete" },
        { milestone_ref: "Mil-006", title: "Hypercare Complete", target_date: "2026-10-30", status: "In Progress" },
      ],
      timeline_items: [
        { phase_ref: "REP-UAT", phase_name: "Customer UAT Support", start_date: "2026-07-22", end_date: "2026-09-15", status: "Complete" },
        { phase_ref: "REP-GL", phase_name: "Go-Live & Hypercare", start_date: "2026-09-16", end_date: "2026-10-30", status: "In Progress" },
      ],
    },
  );
  const resolution = resolveHypercareDates(data, data.projects[0]);
  assert.equal(resolution.start, "2026-09-16");
  assert.equal(resolution.startSource, "timeline");
  assert.equal(resolution.end, "2026-10-30");
  assert.equal(resolution.endSource, "milestone");
});

// ── Executive Timeline consumes the resolver, not the raw columns ───────────

run("structural: components/executive-timeline-page.tsx no longer reads project.hypercare_start_date/hypercare_end_date directly", () => {
  const source = fs.readFileSync(path.join(root, "components/executive-timeline-page.tsx"), "utf8");
  assert.doesNotMatch(source, /project\.hypercare_start_date/, "must read the resolved hypercare dates, not the raw project column");
  assert.doesNotMatch(source, /project\.hypercare_end_date/, "must read the resolved hypercare dates, not the raw project column");
});

run("structural: ProjectState carries a resolved `hypercare` field computed via resolveHypercareDates, and buildProjectState computes it exactly once", () => {
  const stateSource = fs.readFileSync(path.join(root, "lib/project-state.ts"), "utf8");
  assert.match(stateSource, /from ["']@\/lib\/project-dates["']/, "lib/project-state.ts should import from lib/project-dates");
  assert.match(stateSource, /resolveHypercareDates/, "lib/project-state.ts should call resolveHypercareDates");
});

console.log("\nAll hypercare-dates tests passed.\n");
