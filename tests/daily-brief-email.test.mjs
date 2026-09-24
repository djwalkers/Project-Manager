// Automated Daily Brief email (buildAutomatedDailyBrief): phase-aware
// executive summary built from canonical ProjectState — testing position
// for SIT/UAT, identified attention items, canonical health/progress, no
// misleading zero-denominator percentages, and no empty irrelevant sections.
// Manual "Email Test Status" report (buildTestStatusEmail, lib/email-content.ts).
//
// Business rule: this is a MANUAL, project-scoped report. It must reuse the
// canonical Requirement -> AC -> Test verification calculation
// (lib/lifecycle/test-verification.ts) rather than re-deriving it, and must
// use ONLY the explicitly-passed project's own data (scopeProjectData) —
// never selectActiveProject(), never inferred by name.
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
const { buildAutomatedDailyBrief } = req("../lib/email-content.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { briefFocus, percentOrNull, nextMilestone, activeHypercare, capList, relativeDays, daysUntil } = req("../lib/daily-brief-format.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-09-24T07:00:00Z");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function project(id, overrides = {}) {
  return { ...seedData.projects[0], id, project_ref: id.toUpperCase(), owner: null, status: "In Progress", ...overrides };
}



function testCase(projectId, ref, status, overrides = {}) {
  const id = overrides.id ?? uid("test");
  return {
    id, project_id: projectId, test_ref: ref, scenario: `Scenario for ${ref}`,
    expected_result: null, actual_result: null, status, owner: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}


function baseDataStore() {
  return {
    ...structuredClone(seedData),
    projects: [], requirements: [], acceptance_criteria: [], test_cases: [], artefact_links: [],
    deliverables: [], risks: [], decisions: [], actions: [], dependencies: [], discovery_questions: [],
    milestones: [], timeline_items: [], meetings: [], documents: [], activity_log: [],
    project_snapshots: [], evidence: [], requirement_sign_offs: [],
    meeting_intelligence: [], meeting_suggestions: [], go_live_checklists: [], cutover_plan: [],
    go_live_readiness_overrides: [],
  };
}


function timeline(projectId, name, status, start = "2026-09-20", end = "2026-09-30") {
  return { id: uid("tl"), project_id: projectId, phase_ref: uid("PHS"), phase_name: name, start_date: start, end_date: end, owner: null, status, progress_percent: 50, notes: null, created_at: "", updated_at: "" };
}
function milestone(projectId, ref, title, date, status = "Not Started") {
  return { id: uid("ms"), project_id: projectId, milestone_ref: ref, title, target_date: date, owner: null, status, notes: null, created_at: "", updated_at: "" };
}
function risk(projectId, ref, impact, description, status = "Open") {
  return { id: uid("rsk"), project_id: projectId, risk_ref: ref, description, impact, probability: "Medium", mitigation: null, owner: null, status, created_at: "", updated_at: "" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

run("briefFocus maps every canonical phase to a presentation focus", () => {
  const expected = { Discovery: "discovery", Analysis: "discovery", Design: "discovery", Development: "development", SIT: "testing", UAT: "testing", Deployment: "go-live", Hypercare: "hypercare", Closed: "hypercare" };
  for (const [phase, focus] of Object.entries(expected)) assert.equal(briefFocus(phase), focus, phase);
});

run("percentOrNull never turns a zero denominator into 0%", () => {
  assert.equal(percentOrNull(0, 0), null);
  assert.equal(percentOrNull(3, 4), 75);
});

run("nextMilestone: earliest not-complete milestone on/after today; ignores past and complete", () => {
  const ms = [milestone("p", "MIL-3", "Later", "2026-10-01"), milestone("p", "MIL-1", "Done", "2026-09-25", "Complete"), milestone("p", "MIL-0", "Past", "2026-09-20"), milestone("p", "MIL-2", "Soon", "2026-09-25")];
  assert.deepEqual(nextMilestone(ms, "2026-09-24", now), { label: "MIL-2 Soon", date: "2026-09-25", days: 1 });
  assert.equal(nextMilestone([], "2026-09-24", now), null);
});

run("activeHypercare only while today is inside the window", () => {
  assert.deepEqual(activeHypercare({ start: "2026-09-16", end: "2026-10-31" }, "2026-09-24", now), { label: "Hypercare ends", date: "2026-10-31", days: daysUntil("2026-10-31", now) });
  assert.equal(activeHypercare({ start: "2026-10-01", end: "2026-10-31" }, "2026-09-24", now), null);
  assert.equal(activeHypercare({ start: "2026-08-01", end: "2026-09-01" }, "2026-09-24", now), null);
  assert.equal(activeHypercare({ start: null, end: null }, "2026-09-24", now), null);
});

run("capList and relativeDays", () => {
  assert.deepEqual(capList(["a", "b", "c", "d", "e"]), ["a", "b", "c", "+2 more"]);
  assert.deepEqual(capList(["a"]), ["a"]);
  assert.equal(relativeDays(0), "today");
  assert.equal(relativeDays(1), "tomorrow");
  assert.equal(relativeDays(4), "in 4d");
  assert.equal(relativeDays(-2), "2d overdue");
});

// ── Testing-phase project ───────────────────────────────────────────────────

function testingProject() {
  const p = project("tp", { name: "Testing Project", project_ref: "TP1", status: "In Progress", health: "Green", go_live_date: "2026-09-28" });
  const data = baseDataStore();
  data.projects = [p];
  data.timeline_items = [timeline(p.id, "System Integration Testing", "In Progress")];
  data.test_cases = [
    testCase(p.id, "TST-001", "Passed"), testCase(p.id, "TST-002", "Passed"), testCase(p.id, "TST-003", "In Progress"),
    testCase(p.id, "TST-004", "Pending"), testCase(p.id, "TST-005", "Failed", { scenario: "Objective: verify cutoff. Steps: 1) x." }),
  ];
  data.milestones = [milestone(p.id, "MIL-010", "Testing Complete", "2026-09-25"), milestone(p.id, "MIL-011", "Deployment", "2026-09-28")];
  data.risks = [risk(p.id, "RSK-007", "High", "Test window is compressed")];
  return { p, data };
}

run("testing phase: leads with the canonical test position, counting In Progress as remaining", () => {
  const { p, data } = testingProject();
  const state = buildProjectState(data, p, now);
  assert.equal(state.phase.phase, "SIT");
  const c = buildAutomatedDailyBrief(data, now);
  assert.match(c.html, /Testing Position/);
  assert.match(c.text, /TESTING POSITION\n2 of 5 tests passed · 60% executed\n2 remaining \(1 in progress\) · 1 failed · 0 blocked/);
  assert.match(c.text, /Phase: SIT · System Integration Testing/);
  assert.doesNotMatch(c.html + c.text, /0\/0 deployed|0% deployed|No deliverables in progress|DEVELOPMENT\n/, "no deliverable-derived 0% and no empty Development section");
});

run("health and progress are canonical ProjectState values, not the stored projects.health field", () => {
  const { p, data } = testingProject();
  const state = buildProjectState(data, p, now);
  assert.notEqual(state.projectHealth, "Green", "fixture should make canonical health differ from stored Green");
  const c = buildAutomatedDailyBrief(data, now);
  assert.match(c.text, new RegExp(`Health: ${state.projectHealth}`));
  assert.match(c.html, new RegExp(`>${state.projectHealth}</span></td></tr></table></div>`));
  assert.match(c.text, new RegExp(`Overall progress: ${state.progress.overall}%`));
  assert.match(c.html, /2026-09-28/, "go-live date shown from the canonical resolver");
});

run("attention identifies items, failures first: failed test, then risk ref, then milestones with ref/title/date", () => {
  const { data } = testingProject();
  const c = buildAutomatedDailyBrief(data, now);
  const att = c.text.slice(c.text.indexOf("TODAY'S ATTENTION"));
  const idx = (re) => att.search(re);
  assert.match(att, /Failed \/ blocked tests:\n  - TST-005 Verify cutoff — Failed/);
  assert.match(att, /RSK-007 High — Test window is compressed/);
  assert.match(att, /MIL-010 Testing Complete — 25 Sept? \(tomorrow\)/);
  assert.match(att, /MIL-011 Deployment — 28 Sept? \(in 4d\)/);
  assert.ok(idx(/TST-005/) < idx(/RSK-007/) && idx(/RSK-007/) < idx(/MIL-010/), "failures before risks before milestones");
  assert.match(c.text, /TOP 3 PRIORITIES\n1\. Failed test: TST-005/, "a failed test ranks first");
  assert.doesNotMatch(c.html, /<li[^>]*>\d\. /, "no double numbering in the HTML list");
});

// ── Hypercare / closed project ─────────────────────────────────────────────

run("closed project inside its hypercare window shows the hypercare position", () => {
  const p = project("hc", { name: "Hypercare Project", project_ref: "HC1", status: "Complete", hypercare_start_date: "2026-09-16", hypercare_end_date: "2026-10-31", go_live_date: "2026-09-16" });
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "TST-1", "Passed")];
  const c = buildAutomatedDailyBrief(data, now);
  assert.match(c.html, /Hypercare Position/);
  assert.match(c.text, /Hypercare until 31 Oct \(in 37d\)/);
  assert.match(c.text, /Go-live: 2026-09-16/);
  assert.doesNotMatch(c.text, /TESTING POSITION/);
});

// ── Empty project ───────────────────────────────────────────────────────────

run("empty project: Not Assessed, no fabricated percentages, nothing requiring attention", () => {
  const p = project("empty", { name: "Empty Project", project_ref: "EM1", status: "In Progress", health: "Amber", go_live_date: null, planned_end_date: null });
  const data = baseDataStore();
  data.projects = [p];
  const c = buildAutomatedDailyBrief(data, now);
  assert.match(c.text, /Health: Not Assessed/);
  assert.match(c.html, />Not Assessed<\/span>/);
  assert.doesNotMatch(c.html + c.text, /\b0%|Overall progress/, "no 0% anywhere for a project with no evidence");
  assert.match(c.text, /Nothing requires immediate attention\./);
  assert.doesNotMatch(c.html + c.text, /Acceptance & Sign-off|Governance|Recent Activity/i, "empty supporting sections are suppressed");
});

// ── Development project with deliverables keeps the deliverable position ──

run("development phase uses deliverables, with the ratio shown only when deliverables exist", () => {
  const p = project("dev", { name: "Dev Project", project_ref: "DV1", status: "In Progress" });
  const data = baseDataStore();
  data.projects = [p];
  data.timeline_items = [timeline(p.id, "Build", "In Progress")];
  const c0 = buildAutomatedDailyBrief(data, now);
  assert.match(c0.text, /DEVELOPMENT POSITION\nNo deliverables recorded\./);
  assert.doesNotMatch(c0.html + c0.text, /0 of 0|\b0%|Overall progress/, "progress with no measured inputs is not rendered as 0%");
  data.deliverables = [{ ...structuredClone(seedData.deliverables[0]), id: uid("del"), project_id: p.id, deliverable_ref: "DEL-900", title: "Replenishment job", status: "In Development", deployment_status: "Not Ready" }];
  const c1 = buildAutomatedDailyBrief(data, now);
  assert.match(c1.text, /DEVELOPMENT POSITION\n0 of 1 deliverables deployed \(0%\)\nIn progress: DEL-900 Replenishment job \(In Development\)/);
});

run("structural: Daily Brief code has no project-specific literals", () => {
  const src = fs.readFileSync(path.join(root, "lib/email-content.ts"), "utf8");
  const section = src.slice(src.indexOf("function buildProjectBriefSection("), src.indexOf("export function buildAutomatedDailyBrief("));
  assert.doesNotMatch(section, /PL10|CR0?28|F20|F28|Sysco|REP-0|RSK-0|MIL-0/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "lib/daily-brief-format.ts"), "utf8"), /PL10|CR0?28|F20|Sysco/);
});

console.log("\nAll Daily Brief email tests passed.\n");
