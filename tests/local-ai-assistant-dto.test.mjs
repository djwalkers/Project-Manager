// Phase C — deterministic tests for the real ProjectState AI DTO
// (lib/ai/project-assistant-dto.ts). No Ollama required; this only tests
// the pure DTO-building logic on the app side. See
// local-gateway/tests/gateway.test.mjs for the corresponding gateway-side
// tests (accepts the real DTO, rejects a malformed one, citation checking).
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
const dtoModule = req("../lib/ai/project-assistant-dto.ts");
const { buildProjectAssistantDTO } = dtoModule;
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-08-03T12:00:00Z");
const PROJECT_ID = "dto-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function baseData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "CR028 - AI DTO Fixture",
    customer: "Sysco",
    workstream: "Delivery",
    status: "In Progress",
    planned_start_date: "2026-06-01",
    planned_end_date: "2026-10-15",
    go_live_date: null,
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
    start_date: "2026-06-01", end_date: "2026-06-10", owner: null, status: "Complete", progress_percent: 100,
    notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: now.toISOString(),
    ...overrides,
  };
}

function milestone(overrides = {}) {
  return {
    id: `ms-${overrides.milestone_ref ?? "1"}`, milestone_ref: "M001", project_id: PROJECT_ID, title: "Milestone",
    target_date: "2026-09-01", status: "Not Started", owner: null, notes: "",
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function risk(overrides = {}) {
  return {
    id: `risk-${overrides.risk_ref ?? "1"}`, project_id: PROJECT_ID, risk_ref: "RSK-001", description: "A risk",
    impact: "Medium", probability: "Medium", mitigation: null, owner: "Andrew Walker", status: "Open", trend: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    id: `act-${overrides.action_ref ?? "1"}`, project_id: PROJECT_ID, action_ref: "ACT-001", description: "An action",
    owner: "Andrew Walker", due_date: "2026-08-01", status: "Open", notes: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    id: `dec-${overrides.decision_ref ?? "1"}`, project_id: PROJECT_ID, decision_ref: "DEC-001", question: "A decision",
    decision: null, owner: "Andrew Walker", status: "Open", decision_date: null, due_date: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function dependency(overrides = {}) {
  return {
    id: `dep-${Math.random()}`, project_id: PROJECT_ID, name: "A dependency", owner: "Andrew Walker",
    status: "Open", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function testCase(overrides = {}) {
  return {
    id: `test-${overrides.test_ref ?? "1"}`, project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "A scenario",
    expected_result: "Pass", actual_result: null, status: "Passed", owner: "QA",
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function acceptanceCriteria(overrides = {}) {
  return {
    id: `ac-${overrides.ac_ref ?? "1"}`, project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001",
    criterion: "A criterion", description: null, status: "Met", owner: "QA", evidence: null, notes: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function checklistItem(overrides = {}) {
  return {
    id: `glc-${Math.random()}`, project_id: PROJECT_ID, category: "Customer Approval", item: "A checklist item",
    owner: null, status: "Not Started", due_date: null, completed_date: null, notes: null,
    created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── The main fixture ─────────────────────────────────────────────────────────
// Functional Analysis / Development / SIT all Complete, Customer UAT In
// Progress (derives phase UAT), plus a Blocked and an At-Risk item so
// scheduleEvidence.activeTimelineItems has more than one status to order.
function buildFixture() {
  const timeline_items = [
    timelineItem({ phase_ref: "PH-1", phase_name: "Functional Analysis", start_date: "2026-06-01", end_date: "2026-06-15", status: "Complete", progress_percent: 100 }),
    timelineItem({ phase_ref: "PH-2", phase_name: "Development", start_date: "2026-06-16", end_date: "2026-07-10", status: "Complete", progress_percent: 100 }),
    timelineItem({ phase_ref: "PH-3", phase_name: "System Integration Testing", start_date: "2026-07-11", end_date: "2026-07-20", status: "Complete", progress_percent: 100 }),
    timelineItem({ phase_ref: "PH-4", phase_name: "Customer UAT", start_date: "2026-07-21", end_date: "2026-10-10", status: "In Progress", progress_percent: 40 }),
    timelineItem({ phase_ref: "PH-5", phase_name: "Data Migration", start_date: "2026-08-01", end_date: "2026-09-01", status: "At Risk", progress_percent: 20 }),
    timelineItem({ phase_ref: "PH-6", phase_name: "Reporting Module", start_date: "2026-08-05", end_date: "2026-09-10", status: "Blocked", progress_percent: 10 }),
  ];

  const milestones = [
    milestone({ milestone_ref: "M001", title: "Kickoff", target_date: "2026-06-01", status: "Complete" }),
    milestone({ milestone_ref: "M002", title: "Requirements Sign-off", target_date: "2026-07-01", status: "Complete" }),
    milestone({ milestone_ref: "M003", title: "UAT Sign-off", target_date: "2026-09-15", status: "Not Started" }),
    milestone({ milestone_ref: "M004", title: "Go Live", target_date: "2026-10-15", status: "Not Started" }),
    milestone({ milestone_ref: "M005", title: "Hypercare Review", target_date: "2026-11-01", status: "Not Started" }),
    // 9 filler milestones so the non-complete total (12) exceeds the
    // scheduleEvidence cap (10) — proves the cap is actually enforced.
    ...Array.from({ length: 9 }, (_, i) =>
      milestone({ milestone_ref: `M1${i}`, title: `Filler ${i}`, target_date: `2026-10-${16 + i}`, status: "Not Started" }),
    ),
  ];

  // A long description (>120 chars) to prove truncation is applied.
  const longDescription = "This risk description is deliberately written to be much longer than the one-hundred-and-twenty character truncation limit so the test can verify the ellipsis behaviour.";

  // 14 open risks — one over the MAX_LIST_ITEMS (12) cap — plus one Closed
  // risk that must never appear in openRisks.
  const risks = [
    ...Array.from({ length: 14 }, (_, i) =>
      risk({ risk_ref: `RSK-0${String(i + 1).padStart(2, "0")}`, description: i === 0 ? longDescription : `Open risk ${i + 1}`, impact: i === 0 ? "Critical" : "Medium" }),
    ),
    risk({ id: "11111111-1111-4111-8111-111111111111", risk_ref: "RSK-099", description: "A closed risk", status: "Closed" }),
  ];

  const actions = [
    action({ action_ref: "ACT-001", description: "Open action", status: "Open" }),
    action({ action_ref: "ACT-002", description: "Closed action", status: "Closed" }),
  ];

  const decisions = [
    decision({ decision_ref: "DEC-001", question: "An open decision", status: "Open" }),
    decision({ decision_ref: "DEC-002", question: "A closed decision", status: "Complete" }),
  ];

  const dependencies = [
    dependency({ name: "Open dependency", status: "Open" }),
    dependency({ name: "Closed dependency", status: "Closed" }),
  ];

  const test_cases = [
    testCase({ test_ref: "TEST-001", status: "Passed" }),
    testCase({ test_ref: "TEST-002", status: "Passed" }),
    testCase({ test_ref: "TEST-003", status: "Failed", scenario: "A failed scenario" }),
    testCase({ test_ref: "TEST-004", status: "Blocked", scenario: "A blocked scenario" }),
  ];

  const requirements = [
    { id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "A requirement", description: null, priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew Walker", source: null, notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const acceptance_criteria = [
    acceptanceCriteria({ ac_ref: "AC-001", status: "Met", requirement_id: "req-1" }),
    acceptanceCriteria({ ac_ref: "AC-002", status: "Failed", requirement_id: "req-1", criterion: "A failed criterion with a known requirement" }),
    acceptanceCriteria({ ac_ref: "AC-003", status: "Failed", requirement_id: "nonexistent-req-id", criterion: "A failed criterion with no matching requirement" }),
  ];

  const deliverables = [
    // Stale sit_status/uat_status (never updated once the team moved on),
    // even though the timeline/tests above show SIT has genuinely finished
    // and the project has reached UAT — the same defect shape Phase 8 fixed.
    { id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "A deliverable", description: null, workstream: "Backend", owner: null, priority: "High", status: "Ready for UAT", planned_completion_date: null, actual_completion_date: null, development_status: "Complete", sit_status: "In Progress", uat_status: "Not Started", deployment_status: "Not Started", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
  ];

  const go_live_checklists = [
    checklistItem({
      category: "Customer Approval", item: "Customer sign-off on go-live approval", owner: "Sysco (Customer)", status: "Waived",
      notes: "Customer-owned activity outside Bluestonex delivery scope.",
    }),
    checklistItem({ category: "Customer Approval", item: "Customer sign-off on UAT", owner: "Sysco", status: "Not Started", notes: null }),
    checklistItem({
      category: "Data", item: "Legacy data validation", owner: "Bluestonex PM", status: "Not Started",
      notes: "Customer-owned activity outside Bluestonex delivery scope.",
    }),
    checklistItem({ category: "Deployment", item: "Cutover rehearsal", owner: "Bluestonex Dev Lead", status: "Not Started", notes: null }),
  ];

  return baseData({
    timeline_items, milestones, risks, actions, decisions, dependencies, test_cases,
    requirements, acceptance_criteria, deliverables, go_live_checklists,
  });
}

// ── 1/12. Exact-project scoping — no unrelated-project records ─────────────

function buildSiblingProject(data) {
  const sibling = { ...data.projects[0], id: "dto-project-sibling", name: "CR028 Phase 2" };
  return {
    ...data,
    projects: [...data.projects, sibling],
    risks: [...data.risks, risk({ id: "sibling-risk", project_id: sibling.id, risk_ref: "RSK-SIB1", description: "Sibling project's own risk" })],
    actions: [...data.actions, action({ id: "sibling-action", project_id: sibling.id, action_ref: "ACT-SIB1", description: "Sibling project's own action" })],
  };
}

run("buildProjectAssistantDTO for one exact project ID never includes entities from a similarly-named sibling project", () => {
  const data = buildSiblingProject(buildFixture());
  const project = data.projects.find((p) => p.id === PROJECT_ID);
  const dto = buildProjectAssistantDTO(data, project, now);

  assert.ok(!dto.openRisks.some((r) => r.ref === "RSK-SIB1"), "sibling project's risk must not appear");
  assert.ok(!dto.openActions.some((a) => a.ref === "ACT-SIB1"), "sibling project's action must not appear");
  assert.ok(!dto.sourceRefs.includes("RSK-SIB1"), "sibling project's ref must not appear in sourceRefs");
});

run("buildProjectAssistantDTO scopes strictly to the exact project passed in — every ref traces back to this project's own records", () => {
  const data = buildFixture();
  const project = data.projects[0];
  const dto = buildProjectAssistantDTO(data, project, now);

  const ownRiskRefs = new Set(data.risks.filter((r) => r.project_id === project.id).map((r) => r.risk_ref));
  for (const r of dto.openRisks) assert.ok(ownRiskRefs.has(r.ref), `${r.ref} must belong to the exact project`);
});

// ── 2. Correct CR028 phase ───────────────────────────────────────────────────

run("phase is correctly derived as UAT from the fixture's active Customer UAT timeline item", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  assert.equal(dto.phase.phase, "UAT");
  assert.equal(dto.phase.source, "timeline");
});

// ── 3. Correct Go-Live date/source ──────────────────────────────────────────

run("goLiveDate resolves to the fixture's Go Live milestone, not planned_end_date", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  assert.equal(dto.goLiveDate.date, "2026-10-15");
  assert.equal(dto.goLiveDate.source, "milestone");
  assert.equal(dto.goLiveDate.milestoneTitle, "Go Live");
});

// ── 4. generatedAt parity ───────────────────────────────────────────────────

run("generatedAt is exactly the `now` passed in, serialised as ISO", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  assert.equal(dto.generatedAt, now.toISOString());
});

// ── 5. No raw UUIDs anywhere in the serialised DTO ──────────────────────────

run("no raw UUIDs appear anywhere in the serialised DTO", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  const json = JSON.stringify(dto);
  assert.ok(!json.includes("11111111-1111-4111-8111-111111111111"), "a record's raw id must never be embedded");
  assert.doesNotMatch(json, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no UUID-shaped string anywhere in the DTO");
});

// ── 6. Closed decisions excluded ────────────────────────────────────────────

run("closed decisions are excluded from openDecisions", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  assert.deepEqual(dto.openDecisions.map((d) => d.ref), ["DEC-001"]);
});

// ── 7. Passed SIT not shown as incomplete ───────────────────────────────────

run("SIT Complete reads Complete in goLiveReadiness.checks once the project has reached UAT, even with a stale deliverable sit_status", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  const sitCheck = dto.goLiveReadiness.checks.find((c) => c.key === "sit_complete");
  assert.equal(sitCheck.effective, "Complete");
});

// ── 8. List caps and text truncation ────────────────────────────────────────

run("openRisks is capped at 12 even though the fixture has 14 open risks", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  assert.equal(dto.openRisks.length, 12);
  assert.ok(!dto.openRisks.some((r) => r.ref === "RSK-099"), "the Closed risk must never appear regardless of the cap");
});

run("free text longer than 120 characters is truncated with an ellipsis", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  const truncated = dto.openRisks.find((r) => r.ref === "RSK-001");
  assert.ok(truncated.description.length <= 120, `expected <= 120 chars, got ${truncated.description.length}`);
  assert.ok(truncated.description.endsWith("…"), "truncated text must end with an ellipsis");
});

// ── 9. Customer ownership tiers ──────────────────────────────────────────────

run("customer-ownership tiers: owner match + explicit reason = confirmed, owner match alone = likely, reason alone = unknown, neither = excluded", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);

  const goLiveApproval = dto.customerOwnedItems.find((i) => i.label === "Customer sign-off on go-live approval");
  const approval = dto.customerOwnedItems.find((i) => i.label === "Customer sign-off on UAT");
  const dataValidation = dto.customerOwnedItems.find((i) => i.label === "Legacy data validation");
  const cutover = dto.customerOwnedItems.find((i) => i.label === "Cutover rehearsal");

  assert.equal(goLiveApproval.ownership, "confirmed_customer_owned");
  assert.equal(approval.ownership, "likely_customer_owned");
  assert.equal(dataValidation.ownership, "unknown");
  assert.equal(cutover, undefined, "an item with neither an owner match nor an explicit reason must not be surfaced at all — never present name-matching alone as confirmed ownership");
});

// ── 10. Schedule evidence ────────────────────────────────────────────────────

run("scheduleEvidence.upcomingMilestones excludes Complete milestones, is capped, and is sorted ascending by date", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  const { upcomingMilestones } = dto.scheduleEvidence;

  assert.equal(upcomingMilestones.length, 10, "12 non-complete milestones must be capped to 10");
  assert.ok(!upcomingMilestones.some((m) => m.title === "Kickoff"), "Complete milestones must be excluded");
  for (let i = 1; i < upcomingMilestones.length; i++) {
    assert.ok(String(upcomingMilestones[i - 1].date) <= String(upcomingMilestones[i].date), "must be sorted ascending by date");
  }
});

run("scheduleEvidence.activeTimelineItems surfaces blocked and at-risk work ahead of plain in-progress work", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  const { activeTimelineItems } = dto.scheduleEvidence;

  assert.deepEqual(activeTimelineItems.map((i) => i.phase), ["Reporting Module", "Data Migration", "Customer UAT"]);
  assert.deepEqual(activeTimelineItems.map((i) => i.status), ["Blocked", "At Risk", "In Progress"]);
  assert.equal(activeTimelineItems[0].progressPercent, 10);
  assert.equal(activeTimelineItems[0].endDate, "2026-09-10");
});

// ── 11. sourceRefs completeness and uniqueness ──────────────────────────────

run("sourceRefs contains every ref used across every list, with no duplicates", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  const sourceRefSet = new Set(dto.sourceRefs);

  assert.equal(sourceRefSet.size, dto.sourceRefs.length, "sourceRefs must contain no duplicates");

  const usedRefs = [
    ...dto.recommendations.map((r) => r.ref).filter(Boolean),
    ...dto.openRisks.map((r) => r.ref),
    ...dto.openActions.map((a) => a.ref),
    ...dto.openDecisions.map((d) => d.ref),
    ...dto.openDependencies.map((d) => d.name),
    ...dto.failedOrBlockedTests.map((t) => t.ref),
    ...dto.outstandingAcceptanceCriteria.flatMap((ac) => [ac.ref, ac.requirementRef].filter(Boolean)),
    ...dto.customerOwnedItems.map((i) => i.ref),
    ...dto.scheduleEvidence.upcomingMilestones.map((m) => m.ref),
  ];
  for (const ref of usedRefs) assert.ok(sourceRefSet.has(ref), `${ref} is used in the DTO but missing from sourceRefs`);
});

run("outstandingAcceptanceCriteria excludes Met criteria and resolves requirementRef (or null when the requirement can't be found)", () => {
  const data = buildFixture();
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);

  assert.ok(!dto.outstandingAcceptanceCriteria.some((ac) => ac.ref === "AC-001"), "the Met criterion must be excluded");
  assert.equal(dto.outstandingAcceptanceCriteria.find((ac) => ac.ref === "AC-002").requirementRef, "REQ-001");
  assert.equal(dto.outstandingAcceptanceCriteria.find((ac) => ac.ref === "AC-003").requirementRef, null);
});

// ── Bonus: single explicit buildProjectState call, matching the discipline
// buildProjectState's own doc comment and Phase 7's tests already enforce
// for every other consumer.

run("buildProjectAssistantDTO calls buildProjectState exactly once per invocation", () => {
  const projectStateModule = req("../lib/project-state.ts");
  const original = projectStateModule.buildProjectState;
  let callCount = 0;
  projectStateModule.buildProjectState = (...args) => { callCount += 1; return original(...args); };
  try {
    const data = buildFixture();
    buildProjectAssistantDTO(data, data.projects[0], now);
    assert.equal(callCount, 1);
  } finally {
    projectStateModule.buildProjectState = original;
  }
});

console.log("\nAll Phase C ProjectState AI DTO tests passed.\n");
