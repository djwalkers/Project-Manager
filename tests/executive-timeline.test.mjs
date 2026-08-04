// Executive Timeline MVP — deterministic tests.
//
// Covers: viewport windowing (lib/executive-timeline.ts), positioning math
// (lib/schedule.ts's additive dateRangePosition/datePosition, and the
// scheduleBarPosition refactor's behaviour-preservation), the Timeline
// Intelligence panel's pure projection of ProjectState, and structural
// checks proving the page never duplicates a calculation, never mutates
// data, and reads mobile/desktop from the same source.
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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

const req = Module.createRequire(import.meta.url);
const { scheduleBarPosition, dateRangePosition, datePosition } = req("../lib/schedule.ts");
const { zoomWindow, weekendRanges, monthTicks, weekTicks, buildTimelineIntelligence } = req("../lib/executive-timeline.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "exec-timeline-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// ── Fixture helpers (same shape/conventions as every other phase's tests) ──

function baseData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Executive Timeline Test Project",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-15",
    go_live_date: null,
    hypercare_start_date: null,
    hypercare_end_date: null,
  };
  return {
    ...data,
    projects: [project],
    timeline_items: [],
    milestones: [],
    requirements: [],
    deliverables: [],
    risks: [],
    decisions: [],
    actions: [],
    dependencies: [],
    discovery_questions: [],
    test_cases: [],
    acceptance_criteria: [],
    go_live_checklists: [],
    cutover_plan: [],
    go_live_readiness_overrides: [],
    project_snapshots: [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    activity_log: [],
    documents: [],
    meetings: [],
    ...overrides,
  };
}

function timelineItem(overrides = {}) {
  return {
    id: `tl-${overrides.phase_ref ?? "1"}`, project_id: PROJECT_ID, phase_ref: "PH-1", phase_name: "Phase",
    start_date: "2026-06-01", end_date: "2026-06-15", owner: "Andrew", status: "In Progress", progress_percent: 40,
    notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString(),
    ...overrides,
  };
}

function milestone(overrides = {}) {
  return {
    id: `ms-${overrides.milestone_ref ?? "1"}`, milestone_ref: "M001", project_id: PROJECT_ID, title: "Milestone",
    target_date: "2026-07-01", status: "Not Started", owner: "PM", notes: "",
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function risk(overrides = {}) {
  return {
    id: `risk-${overrides.risk_ref ?? "1"}`, project_id: PROJECT_ID, risk_ref: "RSK-001", description: "A risk",
    impact: "High", probability: "Medium", mitigation: null, owner: "Andrew", status: "Open", trend: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function deliverable(overrides = {}) {
  return {
    id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "A deliverable",
    description: null, workstream: "Backend", owner: null, priority: "Medium", status: "In Development",
    planned_completion_date: null, actual_completion_date: null,
    development_status: "In Progress", sit_status: "Not Started", uat_status: "Not Started", deployment_status: "Not Started",
    notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function signOff(overrides = {}) {
  return {
    id: `signoff-${Math.random()}`, project_id: PROJECT_ID, requirement_id: "req-1", sign_off_type: "Customer",
    person: "Sysco Contact", sign_off_date: null, status: "Pending", notes: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── 1. Timeline positioning: dateRangePosition matches scheduleBarPosition (refactor safety) ──

run("dateRangePosition produces the exact same output as scheduleBarPosition for the same range and window", () => {
  const item = timelineItem({ start_date: "2026-06-10", end_date: "2026-06-20" });
  const window = { start: "2026-06-01", end: "2026-07-01" };
  const viaBarPosition = scheduleBarPosition(item, window.start, window.end);
  const viaDateRangePosition = dateRangePosition(item.start_date, item.end_date, window.start, window.end);
  assert.deepEqual(viaDateRangePosition, viaBarPosition);
});

run("dateRangePosition returns null for an invalid or out-of-order range", () => {
  assert.equal(dateRangePosition("2026-06-20", "2026-06-10", "2026-06-01", "2026-07-01"), null, "end before start");
  assert.equal(dateRangePosition("not-a-date", "2026-06-10", "2026-06-01", "2026-07-01"), null, "unparseable date");
});

// ── 2. Timeline positioning: datePosition (single-date markers) ──

run("datePosition places a date at the start of the window near 0% and at the end near 100%", () => {
  const window = { start: "2026-06-01", end: "2026-06-30" };
  assert.equal(datePosition("2026-06-01", window.start, window.end), 0);
  const endPct = datePosition("2026-06-30", window.start, window.end);
  assert.ok(endPct > 90, `expected the last day to sit near 100%, got ${endPct}`);
});

run("datePosition returns null for a date outside the window, or a null/undefined value", () => {
  const window = { start: "2026-06-01", end: "2026-06-30" };
  assert.equal(datePosition("2026-07-15", window.start, window.end), null);
  assert.equal(datePosition(null, window.start, window.end), null);
  assert.equal(datePosition(undefined, window.start, window.end), null);
});

// ── 3. Go-Live marker positioning ──

run("the Go-Live marker positions correctly within the view window, and is null when the date falls outside it", () => {
  const window = { start: "2026-10-01", end: "2026-10-31" };
  assert.ok(datePosition("2026-10-15", window.start, window.end) !== null, "a go-live date inside the window must position");
  assert.equal(datePosition("2026-12-25", window.start, window.end), null, "a go-live date outside the window must not fake a position");
});

// ── 4. Hypercare band positioning ──

run("the hypercare band positions as a range, and clips correctly when it extends beyond the window", () => {
  const window = { start: "2026-10-01", end: "2026-10-31" };
  const fullyInside = dateRangePosition("2026-10-10", "2026-10-20", window.start, window.end);
  assert.ok(fullyInside && fullyInside.left > 0 && fullyInside.width > 0);

  const overhanging = dateRangePosition("2026-10-25", "2026-11-10", window.start, window.end);
  assert.ok(overhanging, "a hypercare band starting inside and ending after the window must still render, clipped");
  assert.ok(overhanging.left + overhanging.width <= 100.01, "must not overflow the window's right edge");
});

// ── 5. Zoom calculations ──

run("zoomWindow(Month) returns the exact calendar month containing the center date", () => {
  const window = zoomWindow(new Date(2026, 6, 15), "Month"); // 15 Jul 2026 (local)
  assert.equal(window.start, "2026-07-01");
  assert.equal(window.end, "2026-07-31");
});

run("zoomWindow(Quarter) returns the exact calendar quarter, including the Q4/year-end edge case", () => {
  const q3 = zoomWindow(new Date(2026, 7, 1), "Quarter"); // Aug 2026 -> Q3
  assert.equal(q3.start, "2026-07-01");
  assert.equal(q3.end, "2026-09-30");

  const q4 = zoomWindow(new Date(2026, 11, 10), "Quarter"); // Dec 2026 -> Q4
  assert.equal(q4.start, "2026-10-01");
  assert.equal(q4.end, "2026-12-31");
});

run("zoomWindow(Year) returns the full calendar year", () => {
  const window = zoomWindow(new Date(2026, 3, 1), "Year");
  assert.equal(window.start, "2026-01-01");
  assert.equal(window.end, "2026-12-31");
});

// ── 6. Weekend rendering ──

run("weekendRanges returns every Saturday-Sunday pair within the window", () => {
  const ranges = weekendRanges("2026-07-01", "2026-07-31"); // July 2026: Wednesday 1st
  assert.ok(ranges.length >= 4, `expected at least 4 weekends in July, got ${ranges.length}`);
  for (const r of ranges) {
    const startDay = new Date(`${r.start}T00:00:00Z`).getUTCDay();
    assert.equal(startDay, 6, `${r.start} must be a Saturday`);
  }
});

run("weekendRanges clips the final Sunday to the window end when the window cuts a weekend short", () => {
  // 2026-07-04 is a Saturday; ending the window on the Saturday itself
  // must clip the paired Sunday to the window end, not spill past it.
  const ranges = weekendRanges("2026-07-01", "2026-07-04");
  const last = ranges[ranges.length - 1];
  assert.equal(last.start, "2026-07-04");
  assert.equal(last.end, "2026-07-04", "the Sunday half must be clipped to the window end");
});

// ── 7. Month/week gridlines ──

run("monthTicks lists the 1st of every month in the window, and includes the year once the window spans more than one calendar year", () => {
  const singleYear = monthTicks("2026-06-01", "2026-08-31");
  assert.deepEqual(singleYear.map((t) => t.date), ["2026-06-01", "2026-07-01", "2026-08-01"]);
  assert.ok(!singleYear[0].label.match(/\d{2}$/), "single-year window labels should not need a year suffix");

  const spanningYears = monthTicks("2026-11-01", "2027-02-28");
  assert.deepEqual(spanningYears.map((t) => t.date), ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
  assert.ok(spanningYears[0].label.match(/26|2026/), "a multi-year window's labels should disambiguate the year");
});

run("weekTicks lists every Monday within the window", () => {
  const ticks = weekTicks("2026-07-01", "2026-07-31");
  for (const t of ticks) {
    const day = new Date(`${t}T00:00:00Z`).getUTCDay();
    assert.equal(day, 1, `${t} must be a Monday`);
  }
  assert.ok(ticks.length >= 4);
});

// ── 8. Timeline Intelligence panel — pure ProjectState projection ──

run("buildTimelineIntelligence surfaces Go-Live blockers, exactly matching state.goLive.checks filtered to Incomplete", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_name: "Customer UAT" })],
  });
  const state = buildProjectState(data, data.projects[0], now);
  const intelligence = buildTimelineIntelligence(state);
  const expected = state.goLive.checks.filter((c) => c.effective === "Incomplete");
  assert.deepEqual(intelligence.blockers, expected);
});

run("buildTimelineIntelligence's upcoming milestones exclude Complete, sort ascending by date, and cap at 5", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_name: "Customer UAT" })],
    milestones: [
      milestone({ milestone_ref: "M-complete", title: "Done", target_date: "2026-06-01", status: "Complete" }),
      milestone({ milestone_ref: "M-6", title: "Sixth", target_date: "2026-12-06", status: "Not Started" }),
      milestone({ milestone_ref: "M-1", title: "First", target_date: "2026-08-01", status: "Not Started" }),
      milestone({ milestone_ref: "M-2", title: "Second", target_date: "2026-08-15", status: "Not Started" }),
      milestone({ milestone_ref: "M-3", title: "Third", target_date: "2026-09-01", status: "Not Started" }),
      milestone({ milestone_ref: "M-4", title: "Fourth", target_date: "2026-09-15", status: "Not Started" }),
      milestone({ milestone_ref: "M-5", title: "Fifth", target_date: "2026-10-01", status: "Not Started" }),
    ],
  });
  const state = buildProjectState(data, data.projects[0], now);
  const intelligence = buildTimelineIntelligence(state);
  assert.equal(intelligence.upcomingMilestones.length, 5);
  assert.ok(!intelligence.upcomingMilestones.some((m) => m.milestone_ref === "M-complete"));
  assert.deepEqual(intelligence.upcomingMilestones.map((m) => m.milestone_ref), ["M-1", "M-2", "M-3", "M-4", "M-5"]);
});

run("buildTimelineIntelligence's open risks are High/Critical and Open only, matching isRiskHighOrCritical/isRiskOpen directly", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_name: "Customer UAT" })],
    risks: [
      risk({ risk_ref: "RSK-001", impact: "Critical", status: "Open" }),
      risk({ risk_ref: "RSK-002", impact: "Low", status: "Open" }),
      risk({ risk_ref: "RSK-003", impact: "High", status: "Closed" }),
    ],
  });
  const state = buildProjectState(data, data.projects[0], now);
  const intelligence = buildTimelineIntelligence(state);
  assert.deepEqual(intelligence.openRisks.map((r) => r.risk_ref), ["RSK-001"]);
});

run("buildTimelineIntelligence's outstanding approvals exclude Approved sign-offs", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_name: "Customer UAT" })],
    requirements: [{ id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "r", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }],
    requirement_sign_offs: [
      signOff({ requirement_id: "req-1", status: "Pending" }),
      signOff({ requirement_id: "req-1", sign_off_type: "Technical", status: "Approved" }),
    ],
  });
  const state = buildProjectState(data, data.projects[0], now);
  const intelligence = buildTimelineIntelligence(state);
  assert.equal(intelligence.outstandingApprovals.length, 1);
  assert.equal(intelligence.outstandingApprovals[0].status, "Pending");
});

run("buildTimelineIntelligence's blocked deliverables match isDeliverableBlocked exactly", () => {
  const data = baseData({
    timeline_items: [timelineItem({ phase_name: "Customer UAT" })],
    deliverables: [
      deliverable({ id: "del-blocked", deliverable_ref: "DEL-001", status: "Blocked" }),
      deliverable({ id: "del-ok", deliverable_ref: "DEL-002", status: "In Development" }),
    ],
  });
  const state = buildProjectState(data, data.projects[0], now);
  const intelligence = buildTimelineIntelligence(state);
  assert.deepEqual(intelligence.blockedDeliverables.map((d) => d.deliverable_ref), ["DEL-001"]);
});

run("buildTimelineIntelligence never leaks a sibling project's risks, milestones, or deliverables", () => {
  const data = structuredClone(seedData);
  const projectA = { ...data.projects[0], id: "exec-tl-a", name: "CR028" };
  const projectB = { ...data.projects[0], id: "exec-tl-b", name: "CR028 Phase 2" };
  const fixture = {
    ...data,
    projects: [projectA, projectB],
    timeline_items: [timelineItem({ project_id: projectA.id }), timelineItem({ id: "tl-b", project_id: projectB.id })],
    risks: [risk({ id: "risk-a", project_id: projectA.id, risk_ref: "RSK-A001" }), risk({ id: "risk-b", project_id: projectB.id, risk_ref: "RSK-B001" })],
    milestones: [], deliverables: [], requirements: [], decisions: [], actions: [], dependencies: [], discovery_questions: [],
    test_cases: [], acceptance_criteria: [], go_live_checklists: [], cutover_plan: [], go_live_readiness_overrides: [],
    project_snapshots: [], evidence: [], requirement_sign_offs: [], meeting_intelligence: [], meeting_suggestions: [],
    activity_log: [], documents: [], meetings: [],
  };
  const stateA = buildProjectState(fixture, projectA, now);
  const stateB = buildProjectState(fixture, projectB, now);
  assert.deepEqual(buildTimelineIntelligence(stateA).openRisks.map((r) => r.risk_ref), ["RSK-A001"]);
  assert.deepEqual(buildTimelineIntelligence(stateB).openRisks.map((r) => r.risk_ref), ["RSK-B001"]);
});

// ── 9. ProjectState parity / structural discipline ──────────────────────────

const pageSource = fs.readFileSync(path.join(root, "components/executive-timeline-page.tsx"), "utf8");

run("the Executive Timeline calls buildProjectState exactly once, with the explicitly resolved project", () => {
  const calls = [...pageSource.matchAll(/buildProjectState\(([^)]*)\)/g)];
  assert.equal(calls.length, 1, "expected exactly one buildProjectState call in the whole file");
  assert.match(calls[0][1], /\bproject\b/, "the call must pass the resolved project explicitly");
});

run("the Executive Timeline never imports a data-mutation helper", () => {
  const importLines = [...pageSource.matchAll(/^import\s+[^;]*;/gms)].map((m) => m[0]);
  for (const forbidden of ["createRecord", "updateRecord", "saveRecord", "upsertRecord", "deleteRecord"]) {
    for (const importLine of importLines) {
      assert.doesNotMatch(importLine, new RegExp(`\\b${forbidden}\\b`), `must never import ${forbidden} — found in: ${importLine}`);
    }
  }
});

run("blocked phases get a distinct visual treatment keyed on TimelineItem status, not a separate recomputation", () => {
  assert.match(pageSource, /item\.status === "Blocked"/, "blocked styling must key off the existing TimelineItem.status value");
});

run("desktop and mobile views render from the same state.scoped.timeline_items array — no separate data path for either", () => {
  const desktopUsages = [...pageSource.matchAll(/state\.scoped\.timeline_items/g)];
  assert.ok(desktopUsages.length >= 2, "expected the same timeline_items array referenced by both the desktop chart and the mobile card view");
});

console.log("\nAll Executive Timeline MVP tests passed.\n");
