// Go-Live Readiness semantics (post-PL10 audit): canonical calendar-day
// countdown, customer testing recognised as UAT, lifecycle-evidence SIT and
// Development gates, AC completion still manual, manual-control gating.
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
const { businessDate, calendarDaysBetween, calendarDaysUntil } = req("../lib/calendar-days.ts");
const { phaseFromText, deriveProjectPhase } = req("../lib/project-phase.ts");
const { sitMilestoneSignal, developmentMilestoneSignal, preDeploymentDecisionReached } = req("../lib/readiness-evidence.ts");
const { PROJECT_PHASE_ORDER } = req("../lib/project-phase.ts");
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { daysUntil: briefDaysUntil } = req("../lib/daily-brief-format.ts");
const { classifyProject } = req("../lib/manager-summary.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-09-22T12:00:00Z");

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


function milestone(projectId, ref, title, status, date = "2026-09-24") {
  return { id: uid("ms"), project_id: projectId, milestone_ref: ref, title, target_date: date, status, owner: null, notes: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };
}
function timeline(projectId, name, status, start = "2026-09-20", end = "2026-09-30") {
  return { id: uid("tl"), project_id: projectId, phase_ref: uid("PHS"), phase_name: name, start_date: start, end_date: end, owner: null, status, progress_percent: 50, notes: null, created_at: "", updated_at: "" };
}
function deliverable(projectId, overrides = {}) {
  return { ...structuredClone(seedData.deliverables[0]), id: uid("del"), project_id: projectId, deliverable_ref: uid("DEL"), ...overrides };
}
const check = (dash, key) => dash.checks.find((c) => c.key === key).effective;

// ── 1. Calendar days to go-live ────────────────────────────────────────────

run("24 Sep → 28 Sep is 4 calendar days for the whole business day (Europe/London)", () => {
  // 24 Sep in London (BST, UTC+1) runs from 23 Sep 23:00Z to 24 Sep 22:59:59Z.
  for (const iso of ["2026-09-23T23:00:00Z", "2026-09-24T00:00:00Z", "2026-09-24T06:00:00Z", "2026-09-24T11:59:59Z", "2026-09-24T12:00:00Z", "2026-09-24T12:14:09Z", "2026-09-24T18:00:00Z", "2026-09-24T22:59:59Z"]) {
    assert.equal(calendarDaysUntil("2026-09-28", new Date(iso)), 4, iso);
  }
  assert.equal(calendarDaysUntil("2026-09-28", new Date("2026-09-23T22:59:59Z")), 5, "still 23 Sep in London");
  assert.equal(calendarDaysUntil("2026-09-28", new Date("2026-09-24T23:00:00Z")), 3, "already 25 Sep in London");
});

run("winter (GMT) midnight boundary and date-only parsing", () => {
  assert.equal(businessDate(new Date("2026-12-24T23:59:59Z")), "2026-12-24");
  assert.equal(businessDate(new Date("2026-12-25T00:00:00Z")), "2026-12-25");
  assert.equal(calendarDaysUntil("2026-12-28", new Date("2026-12-24T23:59:59Z")), 4);
  assert.equal(calendarDaysUntil("2026-09-28T00:00:00.000Z", new Date("2026-09-24T15:00:00Z")), 4, "timestamps are treated as their date");
  assert.equal(calendarDaysUntil("2026-09-20", new Date("2026-09-24T15:00:00Z")), -4, "past dates are negative");
  assert.equal(calendarDaysUntil("2026-09-24", new Date("2026-09-24T15:00:00Z")), 0);
  assert.equal(calendarDaysUntil(null, new Date()), null);
  assert.equal(calendarDaysUntil("2026-02-30", new Date()), null, "impossible dates rejected, not rolled over");
  assert.equal(calendarDaysBetween("2026-03-28", "2026-03-30"), 2, "DST change does not shift whole-day arithmetic");
});

run("independent of the process/browser time zone", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Europe/London"]) {
      process.env.TZ = tz;
      assert.equal(calendarDaysUntil("2026-09-28", new Date("2026-09-24T12:14:09Z")), 4, tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

run("every go-live countdown agrees: Go-Live Readiness, Daily Brief, Manager Summary", () => {
  const p = project("gl", { go_live_date: "2026-09-28" });
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "T1", "Passed")];
  for (const iso of ["2026-09-23T23:30:00Z", "2026-09-24T07:00:00Z", "2026-09-24T12:14:09Z", "2026-09-24T22:30:00Z"]) {
    const now2 = new Date(iso);
    assert.equal(buildGoLiveDashboard(data, p, now2).daysToGoLive, 4, `readiness ${iso}`);
    assert.equal(briefDaysUntil("2026-09-28", now2), 4, `brief ${iso}`);
    assert.equal(classifyProject(data, p, now2) && buildProjectState(data, p, now2).goLive.daysToGoLive, 4, `state ${iso}`);
  }
});

// ── 2. Customer testing is UAT; generic testing stays SIT ───────────────────

run("phase vocabulary: customer testing → UAT, generic testing → SIT", () => {
  const expected = {
    "F20 Testing": "SIT", "System Integration Testing": "SIT", "Testing": "SIT", "Test Execution": "SIT",
    "F28 Customer Testing": "UAT", "Customer Testing": "UAT", "Customer-Testing": "UAT", "UAT": "UAT",
    "User Acceptance Testing": "UAT", "Customer Acceptance": "UAT",
    "Deployment": "Deployment", "Production Deployment": "Deployment", "Go-Live": "Deployment",
    // Unchanged existing precedence: support/hypercare wording wins.
    "Customer UAT Support": "Hypercare", "Go-Live & Hypercare": "Hypercare",
  };
  for (const [name, phase] of Object.entries(expected)) assert.equal(phaseFromText(name), phase, name);
  assert.equal(phaseFromText("Customer testers onboarding"), null, "narrow: 'customer testers' is not customer testing");
});

run("timeline-derived phase: an active Customer Testing phase makes the project UAT", () => {
  const p = project("ph");
  const data = baseDataStore();
  data.projects = [p];
  data.timeline_items = [timeline(p.id, "F20 Testing", "Complete", "2026-09-20", "2026-09-23"), timeline(p.id, "F28 Customer Testing", "In Progress", "2026-09-24", "2026-09-25")];
  assert.equal(deriveProjectPhase(data, p, now).phase, "UAT");
  data.timeline_items[1].status = "Not Started";
  data.timeline_items[0].status = "In Progress";
  assert.equal(deriveProjectPhase(data, p, now).phase, "SIT");
});

// ── 3. SIT Complete ────────────────────────────────────────────────────────

function sitProject() {
  const p = project("sit");
  const data = baseDataStore();
  data.projects = [p];
  data.timeline_items = [timeline(p.id, "System Testing", "In Progress")];
  data.test_cases = [testCase(p.id, "T1", "Passed"), testCase(p.id, "T2", "Passed")];
  return { p, data };
}

run("all tests Passed alone does NOT make SIT Complete (distinct from Tests Passed)", () => {
  const { p, data } = sitProject();
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(check(dash, "tests_passed"), "Complete");
  assert.equal(check(dash, "sit_complete"), "Not Yet Assessed");
});

run("a completed SIT/testing sign-off milestone makes SIT Complete; an incomplete one does not", () => {
  const { p, data } = sitProject();
  data.milestones = [milestone(p.id, "M1", "F20 Testing Sign Off", "Complete")];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Complete");
  data.milestones[0].status = "In Progress";
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Incomplete");
  data.milestones[0].status = "Not Started";
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Incomplete");
});

run("sign-off tier outranks completion markers; completion markers work when no sign-off exists", () => {
  assert.equal(sitMilestoneSignal([{ title: "F20 Testing Sign Off", status: "Complete" }, { title: "Testing Complete", status: "In Progress" }]), "Complete");
  assert.equal(sitMilestoneSignal([{ title: "System Integration Testing Complete", status: "Complete" }]), "Complete");
  assert.equal(sitMilestoneSignal([{ title: "SIT Exit", status: "Not Started" }]), "Incomplete");
  assert.equal(sitMilestoneSignal([{ title: "Customer Testing Sign Off", status: "Complete" }]), null, "a UAT sign-off is not SIT evidence");
  assert.equal(sitMilestoneSignal([{ title: "Go/No Go", status: "Complete" }, { title: "Deployment", status: "Complete" }]), null);
});

run("existing deliverable-based SIT behaviour is preserved, and must agree with a sign-off", () => {
  const { p, data } = sitProject();
  data.deliverables = [deliverable(p.id, { status: "SIT Complete", sit_status: "Complete", development_status: "Complete" })];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Complete", "deliverables alone");
  data.deliverables[0] = { ...data.deliverables[0], status: "Ready for SIT", sit_status: "In Progress" };
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Incomplete", "deliverables alone, SIT underway");
  data.milestones = [milestone(p.id, "M1", "SIT Sign-off", "Complete")];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Incomplete", "sign-off cannot override an unfinished tracked deliverable");
});

run("a later lifecycle phase still completes SIT", () => {
  const { p, data } = sitProject();
  data.timeline_items = [timeline(p.id, "User Acceptance Testing", "In Progress")];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "sit_complete"), "Complete");
});

// ── 4. Development Complete ─────────────────────────────────────────────────

run("development handover / completion milestones are controlled evidence; no deliverables needed", () => {
  const { p, data } = sitProject();
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Not Yet Assessed");
  data.milestones = [milestone(p.id, "M1", "F20 Dev Handover", "Complete")];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Complete");
  data.milestones[0].status = "In Progress";
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Incomplete");
});

run("development evidence vocabulary is narrow", () => {
  assert.equal(developmentMilestoneSignal([{ title: "Replenishment Development Complete", status: "Complete" }]), "Complete");
  assert.equal(developmentMilestoneSignal([{ title: "Code Complete", status: "Complete" }]), "Complete");
  assert.equal(developmentMilestoneSignal([{ title: "Build Sign-off", status: "Not Started" }]), "Incomplete");
  assert.equal(developmentMilestoneSignal([{ title: "Build and Deployment Complete", status: "Complete" }]), null, "a deployment milestone is not development evidence");
  assert.equal(developmentMilestoneSignal([{ title: "Test Scope", status: "Complete" }, { title: "Go/No Go", status: "Complete" }]), null);
  assert.equal(developmentMilestoneSignal([{ title: "Handover to customer", status: "Complete" }]), null, "handover must be a development handover");
});

run("free-text evidence records alone never complete Development", () => {
  const { p, data } = sitProject();
  data.evidence = [{ id: uid("ev"), project_id: p.id, ac_id: null, evidence_type: "Other", title: "Development complete", description: "All development done and handed over.", url: null, evidence_date: "2026-09-21", owner: null, created_at: "", updated_at: "" }];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Not Yet Assessed");
});

run("existing deliverable Development behaviour preserved; milestone cannot override unfinished deliverables", () => {
  const { p, data } = sitProject();
  data.deliverables = [deliverable(p.id, { status: "In Development", development_status: "In Progress", sit_status: "Not Started" })];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Incomplete");
  data.milestones = [milestone(p.id, "M1", "Development Complete", "Complete")];
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Incomplete");
  data.deliverables[0] = { ...data.deliverables[0], status: "Ready for SIT", development_status: "Complete" };
  assert.equal(check(buildGoLiveDashboard(data, p, now), "development_complete"), "Complete");
});

// ── 5. Acceptance criteria stay manual ─────────────────────────────────────

run("passing linked tests never marks an AC Met; AC statuses are not mutated", () => {
  const { p, data } = sitProject();
  const req = { id: uid("req"), project_id: p.id, requirement_ref: "REQ-1", title: "R", description: null, priority: "High", category: "UI", status: "Approved", owner: null, source: null, notes: null, created_at: "", updated_at: "" };
  const acRow = { id: uid("ac"), project_id: p.id, requirement_id: req.id, ac_ref: "AC-1", criterion: "C", description: null, status: "Not Started", owner: null, evidence: null, notes: null, created_at: "", updated_at: "" };
  data.requirements = [req];
  data.acceptance_criteria = [acRow];
  data.artefact_links = [{ id: uid("l"), project_id: p.id, source_entity: "test_cases", source_id: data.test_cases[0].id, target_entity: "acceptance_criteria", target_id: acRow.id, created_at: "" }];
  const before = JSON.stringify(data.acceptance_criteria);
  assert.equal(check(buildGoLiveDashboard(data, p, now), "acceptance_criteria_met"), "Incomplete");
  assert.equal(JSON.stringify(data.acceptance_criteria), before);
});

// ── 6. Manual controls follow the lifecycle ────────────────────────────────

run("Customer Approval applies during Customer Testing/UAT; deployment controls from Deployment", () => {
  const p = project("man");
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "T1", "Passed")];
  data.timeline_items = [timeline(p.id, "F28 Customer Testing", "In Progress")];
  let dash = buildGoLiveDashboard(data, p, now);
  assert.equal(check(dash, "customer_approval"), "Incomplete", "applicable in UAT (nothing recorded yet)");
  for (const k of ["deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"]) assert.equal(check(dash, k), "Not Yet Required", k);
  data.timeline_items = [timeline(p.id, "Production Deployment", "In Progress")];
  dash = buildGoLiveDashboard(data, p, now);
  for (const k of ["customer_approval", "deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"]) assert.equal(check(dash, k), "Incomplete", k);
});

// ── 7. Lifecycle phase never regresses through a neutral step ─────────────

function lifecycle(statuses, extraMilestones = []) {
  const p = project("lc");
  const data = baseDataStore();
  data.projects = [p];
  const names = ["Build", "F20 Testing", "F28 Customer Testing", "Go/No GO", "PL10 Deployment", "Hypercare"];
  data.timeline_items = names.map((n, i) => timeline(p.id, n, statuses[i] ?? "Not Started", `2026-09-${String(10 + i * 3).padStart(2, "0")}`, `2026-09-${String(12 + i * 3).padStart(2, "0")}`));
  data.milestones = [milestone(p.id, "M-T", "Testing Complete", "In Progress", "2026-09-24"), ...extraMilestones.map((m) => milestone(p.id, m[0], m[1], m[2]))];
  data.test_cases = [testCase(p.id, "T1", "Passed")];
  return { p, data, phase: () => deriveProjectPhase(data, p, now).phase };
}
const C = "Complete", A = "In Progress", N = "Not Started";

run("SIT active → SIT; Customer Testing active → UAT", () => {
  assert.equal(lifecycle([C, A, N, N, N, N]).phase(), "SIT");
  assert.equal(lifecycle([C, C, A, N, N, N]).phase(), "UAT");
});

run("Customer Testing completed + neutral Go/No-Go active → remains UAT (never SIT → UAT → SIT)", () => {
  const lc = lifecycle([C, C, C, A, N, N]);
  const ev = deriveProjectPhase(lc.data, lc.p, now);
  assert.equal(ev.phase, "UAT");
  assert.match(ev.detail, /F28 Customer Testing is Complete; current step Go\/No GO has no phase wording/);
});

run("future Deployment / Hypercare items (Not Started) never advance an earlier project", () => {
  assert.equal(lifecycle([C, A, N, N, N, N]).phase(), "SIT", "future Deployment + Hypercare present");
  assert.equal(lifecycle([C, C, C, A, N, N]).phase(), "UAT", "future Deployment not reached during Go/No-Go");
});

run("a future (Not Started) Deployment milestone does not advance a project whose timeline has only reached UAT", () => {
  const lc = lifecycle([C, C, C, N, N, N], [["M-D", "Deployment", N]]);
  lc.data.milestones.find((m) => m.title === "Testing Complete").status = C;
  assert.equal(lc.phase(), "UAT", "nothing active, next milestone is Deployment");
  lc.data.timeline_items[3].status = A;
  assert.equal(lc.phase(), "UAT", "Go/No-Go active, next milestone is Deployment");
});

run("projects without a timeline keep the existing next-milestone signal", () => {
  const p = project("nm");
  const data = baseDataStore();
  data.projects = [p];
  data.milestones = [milestone(p.id, "M1", "UAT Complete", N)];
  assert.equal(deriveProjectPhase(data, p, now).phase, "UAT");
});

run("Deployment active → Deployment; Hypercare active → Hypercare; completed Deployment + neutral step keeps Deployment", () => {
  assert.equal(lifecycle([C, C, C, C, A, N]).phase(), "Deployment");
  assert.equal(lifecycle([C, C, C, C, C, A]).phase(), "Hypercare");
  const lc = lifecycle([C, C, C, C, C, N]);
  lc.data.timeline_items.push(timeline(lc.p.id, "Business review", A, "2026-09-29", "2026-09-30"));
  assert.equal(lc.phase(), "Deployment");
});

run("explicit active phase wording stays authoritative; stronger later evidence still wins over the floor", () => {
  const lc = lifecycle([C, C, A, N, N, N]);
  assert.equal(lc.phase(), "UAT");
  // All deliverables deployed → Hypercare (existing rule) beats a UAT floor.
  const lc2 = lifecycle([C, C, C, A, N, N]);
  lc2.data.deliverables = [deliverable(lc2.p.id, { status: "Deployed", development_status: "Complete", sit_status: "Complete", uat_status: "Complete", deployment_status: "Deployed" })];
  assert.equal(lc2.phase(), "Hypercare");
});

run("invariant: walking the whole lifecycle, the derived phase index never decreases", () => {
  const stages = [[A, N, N, N, N, N], [C, A, N, N, N, N], [C, C, A, N, N, N], [C, C, C, N, N, N], [C, C, C, A, N, N], [C, C, C, C, A, N], [C, C, C, C, C, A]];
  let last = -1;
  for (const st of stages) {
    const idx = PROJECT_PHASE_ORDER.indexOf(lifecycle(st).phase());
    assert.ok(idx >= last, `regressed at ${st.join(",")} → ${PROJECT_PHASE_ORDER[idx]}`);
    last = idx;
  }
});

// ── 8. Deployment-readiness controls apply from the go/no-go decision ──────

run("preDeploymentDecisionReached: active or complete go/no-go step (timeline or milestone); future one is not", () => {
  assert.equal(preDeploymentDecisionReached([{ phase_ref: "P4", phase_name: "Go/No GO", status: "In Progress" }], []), true);
  assert.equal(preDeploymentDecisionReached([{ phase_ref: "P4", phase_name: "Go/No GO", status: "Complete" }], []), true);
  assert.equal(preDeploymentDecisionReached([{ phase_ref: "P4", phase_name: "Go/No GO", status: "Not Started" }], []), false);
  assert.equal(preDeploymentDecisionReached([], [{ title: "Go-No-Go decision", status: "Complete" }]), true);
  assert.equal(preDeploymentDecisionReached([], [{ title: "Go/No Go", status: "Not Started" }]), false);
  assert.equal(preDeploymentDecisionReached([{ phase_ref: "P", phase_name: "Go-Live", status: "In Progress" }], []), false, "go-live is not a go/no-go decision");
});

const MANUAL = ["customer_approval", "deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"];
const applicability = (lc) => { const d = buildGoLiveDashboard(lc.data, lc.p, now); return MANUAL.map((k) => check(d, k) === "Not Yet Required" ? "-" : "A").join(""); };

run("manual controls: none in SIT; Customer Approval from UAT; all five during Go/No-Go (before Deployment)", () => {
  assert.equal(applicability(lifecycle([C, A, N, N, N, N])), "-----", "SIT");
  assert.equal(applicability(lifecycle([C, C, A, N, N, N])), "A----", "Customer Testing (UAT)");
  assert.equal(applicability(lifecycle([C, C, C, A, N, N])), "AAAAA", "Go/No-Go: safe and authorised to deploy?");
  assert.equal(applicability(lifecycle([C, C, C, C, A, N])), "AAAAA", "Deployment");
});

run("the go/no-go signal never changes the derived phase", () => {
  const lc = lifecycle([C, A, N, N, N, N], [["M-G", "Go/No Go", "Complete"]]);
  assert.equal(lc.phase(), "SIT");
  assert.equal(applicability(lc), "AAAAA", "a completed go/no-go milestone makes the controls answerable");
});

run("structural: no project-specific names or ids in the new evidence/date code", () => {
  for (const f of ["lib/readiness-evidence.ts", "lib/calendar-days.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /PL10|CR0?28|F20|F28|MIL-0|Sysco/, f);
  }
});

console.log("\nAll Go-Live Readiness semantics tests passed.\n");
