// Post-audit Phase 1 — provider-scope correctness fixes:
//   A. Warehouse Training removed from all active application logic.
//   B. Reports RAID Log scoped to the explicitly selected project.
//   C. Dead navigation links (/evidence, /traceability) removed.
// See the provider-perspective product audit this phase implements.
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
const { buildGoLiveDashboard, GO_LIVE_CATEGORIES } = req("../lib/go-live-readiness.ts");
const { buildProjectIntelligence } = req("../lib/project-intelligence.ts");
const { buildProjectState } = req("../lib/project-state.ts");
const { buildProjectAssistantDTO } = req("../lib/ai/project-assistant-dto.ts");
const { seedData } = req("../lib/seed-data.ts");
const { ALL_ITEMS } = req("../lib/nav-data.ts");
const { ROLE_NAV_ACCESS } = req("../lib/auth.ts");
const { moduleBySlug } = req("../lib/modules.ts");

const now = new Date("2026-07-28T12:00:00Z");
const PROJECT_ID = "phase1-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function checkByKey(dashboard, key) {
  return dashboard.checks.find((c) => c.key === key);
}

function baseData(overrides = {}) {
  const data = structuredClone(seedData);
  const project = {
    ...data.projects[0],
    id: PROJECT_ID,
    name: "Phase 1 Provider Scope Test Project",
    status: "In Progress",
    planned_start_date: "2026-01-01",
    planned_end_date: "2026-12-01",
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

function timelineFor(phaseName, overrides = {}) {
  return [{
    id: "tl-1", project_id: PROJECT_ID, phase_ref: "PH-1", phase_name: phaseName,
    start_date: "2026-01-01", end_date: "2026-12-01", owner: null, status: "In Progress",
    progress_percent: 50, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: now.toISOString(),
    ...overrides,
  }];
}

// A historical checklist row is just free text at runtime — GoLiveChecklistCategory
// is a compile-time-only type, so nothing stops a pre-existing DB row from still
// literally carrying category "Training" (see supabase/migrations/012_go_live_readiness.sql:
// `category text NOT NULL`, no CHECK constraint). This helper deliberately builds
// exactly that shape without importing any removed type.
function historicalTrainingRow(overrides = {}) {
  return {
    id: "glc-legacy-training", project_id: PROJECT_ID, category: "Training", item: "Warehouse training",
    owner: "Sysco (Customer)", status: "Not Started", due_date: null, completed_date: null,
    notes: "Customer-owned activity outside Bluestonex delivery scope.",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── A. Warehouse Training removed from all active application logic ───────

run("GO_LIVE_CATEGORIES no longer includes Training, and exactly 12 checks exist (not 13) for a fully-populated, fully-applicable project", () => {
  assert.ok(!GO_LIVE_CATEGORIES.includes("Training"), "Training must no longer be a valid go-live checklist category");
  const data = baseData({
    timeline_items: timelineFor("Deployment Phase"),
    requirements: [{ id: "req-1", project_id: PROJECT_ID, requirement_ref: "REQ-001", title: "r", description: "d", priority: "High", category: "Business Rule", status: "Approved", owner: "Andrew", source: "s", notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    deliverables: [{ id: "del-1", project_id: PROJECT_ID, deliverable_ref: "DEL-001", title: "d", description: null, workstream: "Backend", owner: null, priority: "Medium", status: "Deployed", planned_completion_date: null, actual_completion_date: null, development_status: "Complete", sit_status: "Passed", uat_status: "Complete", deployment_status: "Deployed", notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    risks: [{ id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "d", impact: "Low", probability: "Low", mitigation: "m", owner: "Andrew", status: "Closed", trend: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    test_cases: [{ id: "test-1", project_id: PROJECT_ID, test_ref: "TEST-001", scenario: "s", expected_result: "e", actual_result: "a", status: "Passed", owner: "QA", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    acceptance_criteria: [{ id: "ac-1", project_id: PROJECT_ID, requirement_id: "req-1", ac_ref: "AC-001", criterion: "c", description: null, status: "Met", owner: "QA", evidence: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    go_live_checklists: [
      { id: "glc-1", project_id: PROJECT_ID, category: "Customer Approval", item: "Customer sign-off", owner: "Sysco", status: "Complete", due_date: null, completed_date: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "glc-2", project_id: PROJECT_ID, category: "Deployment", item: "Deployment approval", owner: "PM", status: "Complete", due_date: null, completed_date: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "glc-3", project_id: PROJECT_ID, category: "Rollback", item: "Rollback plan", owner: "PM", status: "Complete", due_date: null, completed_date: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "glc-4", project_id: PROJECT_ID, category: "Hypercare", item: "Hypercare owner", owner: "PM", status: "Complete", due_date: null, completed_date: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      { id: "glc-5", project_id: PROJECT_ID, category: "Support", item: "Support rota", owner: "PM", status: "Complete", due_date: null, completed_date: null, notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    ],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(dashboard.checks.length, 12, "expected exactly 12 checks (7 auto + 5 manual), not the pre-Phase-1 13");
  assert.equal(checkByKey(dashboard, "warehouse_training"), undefined);
  assert.ok(!dashboard.checks.some((c) => c.label === "Warehouse Training"));
});

run("a historical category-'Training' checklist row — even Blocked — never creates a check, never counts toward the denominator, and never forces a blocker/Red", () => {
  const data = baseData({
    timeline_items: timelineFor("Development Phase"),
    go_live_checklists: [historicalTrainingRow({ status: "Blocked" })],
  });
  const dashboard = buildGoLiveDashboard(data, data.projects[0], now);
  assert.equal(dashboard.totalItems, 0, "the historical Training row must not be assessed at all");
  assert.equal(dashboard.blockerCount, 0, "a Blocked Training row must never register as a blocker");
  assert.equal(dashboard.status, "Not Assessed", "no genuine check exists yet — must not read Red because of the ignored Training row");
  assert.equal(checkByKey(dashboard, "warehouse_training"), undefined);
});

run("GLR-006 (training) no longer fires from Project Intelligence, regardless of an incomplete Training checklist row near go-live", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    milestones: [{ id: "m-go-live", milestone_ref: "M001", project_id: PROJECT_ID, title: "Go Live", target_date: "2026-08-05", status: "Not Started", owner: "PM", notes: "", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    go_live_checklists: [historicalTrainingRow({ status: "Not Started" })],
  });
  const intelligence = buildProjectIntelligence(data, data.projects[0], now);
  assert.equal(intelligence.findings.some((f) => f.ruleId === "GLR-006"), false, "GLR-006 must no longer exist as a rule");
  assert.equal(intelligence.findings.some((f) => /training/i.test(f.title) || /training/i.test(f.detail)), false, "no finding of any rule ID may mention training");
});

run("ProjectState never surfaces a warehouse_training check or a training-related finding for a project with a historical Training checklist row", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    go_live_checklists: [historicalTrainingRow()],
  });
  const state = buildProjectState(data, data.projects[0], now);
  assert.doesNotMatch(JSON.stringify(state.goLive), /warehouse_training/i);
  assert.doesNotMatch(JSON.stringify(state.intelligence.findings), /training/i);
});

run("Daily Brief recommendations (state.intelligence.recommendations) never include a training-related item", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    milestones: [{ id: "m-go-live", milestone_ref: "M001", project_id: PROJECT_ID, title: "Go Live", target_date: "2026-08-01", status: "Not Started", owner: "PM", notes: "", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    go_live_checklists: [historicalTrainingRow({ status: "Not Started" })],
  });
  const state = buildProjectState(data, data.projects[0], now);
  assert.doesNotMatch(JSON.stringify(state.intelligence.recommendations), /training/i);
});

run("ProjectAssistantDTO never surfaces a Training checklist row anywhere — not in customerOwnedItems, not in sourceRefs — even one carrying a legitimate owner+reason customer-ownership signal", () => {
  const data = baseData({
    timeline_items: timelineFor("Customer UAT"),
    go_live_checklists: [historicalTrainingRow({ status: "Waived" })],
  });
  const dto = buildProjectAssistantDTO(data, data.projects[0], now);
  assert.equal(dto.customerOwnedItems.length, 0, "a Training row must never be surfaced, even though its owner+notes would otherwise qualify as confirmed_customer_owned");
  assert.doesNotMatch(JSON.stringify(dto), /training/i, "the word 'training' must never appear anywhere in the serialised DTO");
});

// ── B. Reports RAID Log scoped to the explicitly selected project ──────────

run("structural: RaidLogReport reads risks/actions/decisions via buildProjectState(...).scoped for the explicitly selected project, not raw unscoped data", () => {
  const source = fs.readFileSync(path.join(root, "app/reports/page.tsx"), "utf8");
  const start = source.indexOf("function RaidLogReport");
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  assert.match(body, /selectActiveProject\(data\)/, "must resolve one explicit project");
  assert.match(body, /buildProjectState\(data, project\)\.scoped/, "must read through ProjectState's scoped data");
  assert.doesNotMatch(body, /data\.risks\.filter|data\.actions\.filter|data\.decisions\.filter/, "must never read the raw, unscoped data.risks/actions/decisions arrays directly");
});

run("two similarly-named sibling projects: the scoped data RaidLogReport now reads never mixes their risks, actions, or decisions", () => {
  const data = structuredClone(seedData);
  const projectA = { ...data.projects[0], id: "raid-project-a", name: "CR028", planned_start_date: "2026-06-01", planned_end_date: "2026-10-15" };
  const projectB = { ...data.projects[0], id: "raid-project-b", name: "CR028 Phase 2", planned_start_date: "2026-06-01", planned_end_date: "2026-11-15" };
  const fixture = {
    ...data,
    projects: [projectA, projectB],
    risks: [
      { id: "risk-a", project_id: projectA.id, risk_ref: "RSK-A001", description: "A's risk", impact: "High", probability: "Medium", mitigation: null, owner: "Andrew", status: "Open", trend: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
      { id: "risk-b", project_id: projectB.id, risk_ref: "RSK-B001", description: "B's risk", impact: "High", probability: "Medium", mitigation: null, owner: "Andrew", status: "Open", trend: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    ],
    actions: [
      { id: "act-a", project_id: projectA.id, action_ref: "ACT-A001", description: "A's action", owner: "Andrew", due_date: "2026-07-01", status: "Open", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
      { id: "act-b", project_id: projectB.id, action_ref: "ACT-B001", description: "B's action", owner: "Andrew", due_date: "2026-07-01", status: "Open", notes: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    ],
    decisions: [
      { id: "dec-a", project_id: projectA.id, decision_ref: "DEC-A001", question: "A's decision", decision: null, owner: "Andrew", status: "Open", decision_date: null, due_date: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
      { id: "dec-b", project_id: projectB.id, decision_ref: "DEC-B001", question: "B's decision", decision: null, owner: "Andrew", status: "Open", decision_date: null, due_date: null, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    ],
    timeline_items: [], milestones: [], deliverables: [], requirements: [], dependencies: [], discovery_questions: [], test_cases: [], acceptance_criteria: [],
    go_live_checklists: [], cutover_plan: [], go_live_readiness_overrides: [], project_snapshots: [], evidence: [], requirement_sign_offs: [],
    meeting_intelligence: [], meeting_suggestions: [], activity_log: [], documents: [], meetings: [],
  };

  const scopedA = buildProjectState(fixture, projectA, now).scoped;
  const scopedB = buildProjectState(fixture, projectB, now).scoped;

  assert.deepEqual(scopedA.risks.map((r) => r.risk_ref), ["RSK-A001"]);
  assert.deepEqual(scopedA.actions.map((a) => a.action_ref), ["ACT-A001"]);
  assert.deepEqual(scopedA.decisions.map((d) => d.decision_ref), ["DEC-A001"]);
  assert.deepEqual(scopedB.risks.map((r) => r.risk_ref), ["RSK-B001"]);
  assert.deepEqual(scopedB.actions.map((a) => a.action_ref), ["ACT-B001"]);
  assert.deepEqual(scopedB.decisions.map((d) => d.decision_ref), ["DEC-B001"]);
});

// ── C. Dead navigation links removed ────────────────────────────────────────

run("/evidence and /traceability no longer appear in navigation or role access", () => {
  assert.ok(!ALL_ITEMS.some((item) => item.href === "/evidence"), "/evidence must be removed from navigation");
  assert.ok(!ALL_ITEMS.some((item) => item.href === "/traceability"), "/traceability must be removed from navigation");
  for (const [role, access] of Object.entries(ROLE_NAV_ACCESS)) {
    if (access === "all") continue;
    assert.ok(!access.includes("/evidence"), `${role} must not list /evidence`);
    assert.ok(!access.includes("/traceability"), `${role} must not list /traceability`);
  }
});

run("every active navigation href resolves to a real route", () => {
  const sectionPageSource = fs.readFileSync(path.join(root, "app/[section]/page.tsx"), "utf8");
  const specialCasedSections = [...sectionPageSource.matchAll(/section === "([a-z-]+)"/g)].map((m) => m[1]);

  function resolves(href) {
    if (href === "/") return fs.existsSync(path.join(root, "app/page.tsx"));
    const dedicated = path.join(root, "app", href.slice(1), "page.tsx");
    if (fs.existsSync(dedicated)) return true;
    const section = href.slice(1);
    return specialCasedSections.includes(section) || moduleBySlug.has(section);
  }

  const unresolved = ALL_ITEMS.filter((item) => !resolves(item.href));
  assert.deepEqual(unresolved.map((item) => item.href), [], `every nav href must resolve to a real route; unresolved: ${unresolved.map((i) => i.href).join(", ")}`);
});

console.log("\nAll post-audit Phase 1 provider-scope tests passed.\n");
