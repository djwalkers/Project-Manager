// Go/No-Go decision (migration 028) and the derived CURRENT deployment
// status: recorded decision history is append-only and never inferred;
// the executive state comes from the latest decision plus live readiness,
// with hard stops taking precedence and outstanding items never NO GO.
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
const { buildGoLiveDashboard } = req("../lib/go-live-readiness.ts");
const { latestGoLiveDecision, sortDecisionHistory, validateDecisionBody, isCheckOutstanding } = req("../lib/go-live-decision.ts");
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


const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const MANUAL = ["customer_approval", "deployment_cutover_approval", "rollback_plan_approved", "hypercare_owner_assigned", "support_rota_confirmed"];

function readyProject({ phaseName = "Production Deployment", phaseStatus = "In Progress" } = {}) {
  const p = project("gng", { project_ref: "GN1", go_live_date: "2026-09-28" });
  const data = baseDataStore();
  data.projects = [p];
  data.timeline_items = [{ id: uid("tl"), project_id: p.id, phase_ref: "PH", phase_name: phaseName, start_date: "2026-09-20", end_date: "2026-09-30", owner: null, status: phaseStatus, progress_percent: 50, notes: null, created_at: "", updated_at: "" }];
  data.requirements = [{ id: uid("req"), project_id: p.id, requirement_ref: "REQ-1", title: "R", description: null, priority: "High", category: "UI", status: "Approved", owner: null, source: null, notes: null, created_at: "", updated_at: "" }];
  data.test_cases = [testCase(p.id, "T1", "Passed")];
  data.milestones = [{ id: uid("ms"), project_id: p.id, milestone_ref: "M1", title: "Dev Handover", target_date: "2026-09-20", status: "Complete", owner: null, notes: null, created_at: "", updated_at: "" },
                     { id: uid("ms"), project_id: p.id, milestone_ref: "M2", title: "SIT Sign-off", target_date: "2026-09-22", status: "Complete", owner: null, notes: null, created_at: "", updated_at: "" }];
  return { p, data };
}
function assess(data, p, key, status) {
  data.go_live_readiness_overrides = [...(data.go_live_readiness_overrides ?? []).filter((o) => o.check_key !== key),
    { id: uid("ov"), project_id: p.id, check_key: key, override_status: status, override_reason: "r", overridden_by: "tester", overridden_at: "2026-09-24T10:00:00Z", created_at: "", updated_at: "" }];
}
function decide(data, p, decision, at) {
  data.go_live_decisions = [...(data.go_live_decisions ?? []), { id: uid("dec"), project_id: p.id, decision, reason: `because ${decision}`, decided_by: "Andy", decided_by_user_id: null, decided_at: at, created_at: at }];
}
const status = (data, p) => buildGoLiveDashboard(data, p, now).deployment;

// ── States ─────────────────────────────────────────────────────────────────

run("no decision → NO DECISION (never NO GO), outstanding items still listed", () => {
  const { p, data } = readyProject();
  const d = status(data, p);
  assert.equal(d.state, "NO_DECISION");
  assert.equal(d.label, "No Decision");
  assert.equal(d.tone, "neutral");
  assert.deepEqual(d.outstandingItems.sort(), ["Customer Approval", "Deployment / Cutover Approval", "Hypercare Owner Assigned", "Rollback Plan Approved", "Support Rota Confirmed"].sort());
  assert.equal(d.summary, "Customer approval + 4 pre-deployment readiness items outstanding");
  assert.deepEqual(d.blockingItems, []);
});

run("GO + customer outstanding (+ other controls outstanding) → GO – PENDING CUSTOMER APPROVAL (amber)", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  let d = status(data, p);
  assert.equal(d.state, "GO_PENDING_CUSTOMER_APPROVAL");
  assert.equal(d.label, "GO – Pending Customer Approval");
  assert.equal(d.tone, "amber");
  assert.equal(d.summary, "Customer approval + 4 pre-deployment readiness items outstanding");
  for (const k of MANUAL.slice(1)) assess(data, p, k, "Complete");
  d = status(data, p);
  assert.equal(d.state, "GO_PENDING_CUSTOMER_APPROVAL", "customer alone outstanding");
  assert.equal(d.summary, "Customer approval outstanding");
});

run("GO + customer complete + other controls outstanding → GO – PENDING READINESS ITEMS", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  assess(data, p, "customer_approval", "Complete");
  const d = status(data, p);
  assert.equal(d.state, "GO_PENDING_READINESS_ITEMS");
  assert.equal(d.summary, "4 pre-deployment readiness items outstanding");
  assert.equal(d.customerApproval, "Complete");
});

run("GO + all required controls complete → GO; waived where permitted → GO", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  for (const k of MANUAL) assess(data, p, k, "Complete");
  assert.equal(status(data, p).state, "GO");
  assess(data, p, "rollback_plan_approved", "Waived");
  assess(data, p, "customer_approval", "Waived");
  const d = status(data, p);
  assert.equal(d.state, "GO");
  assert.equal(d.tone, "green");
  assert.equal(d.customerApproval, "Waived");
});

run("NO_GO decision → NO GO", () => {
  const { p, data } = readyProject();
  decide(data, p, "NO_GO", "2026-09-24T14:40:00Z");
  const d = status(data, p);
  assert.equal(d.state, "NO_GO");
  assert.deepEqual(d.reasons, ["Recorded decision: NO GO"]);
});

run("GO followed by NO_GO → current NO GO, both history rows retained", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T10:00:00Z");
  decide(data, p, "NO_GO", "2026-09-24T12:00:00Z");
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.deployment.state, "NO_GO");
  assert.equal(dash.decisionHistory.length, 2);
  assert.deepEqual(dash.decisionHistory.map((h) => h.decision), ["NO_GO", "GO"], "newest first");
  assert.equal(dash.latestDecision.decision, "NO_GO");
});

run("NO_GO followed by GO → current state derives from latest GO plus readiness", () => {
  const { p, data } = readyProject();
  decide(data, p, "NO_GO", "2026-09-24T10:00:00Z");
  decide(data, p, "GO", "2026-09-24T12:00:00Z");
  assert.equal(status(data, p).state, "GO_PENDING_CUSTOMER_APPROVAL");
  for (const k of MANUAL) assess(data, p, k, "Complete");
  assert.equal(status(data, p).state, "GO");
  assert.equal(buildGoLiveDashboard(data, p, now).decisionHistory.length, 2);
});

run("GO + Customer Approval Rejected → NO GO (hard stop)", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  assess(data, p, "customer_approval", "Rejected");
  const d = status(data, p);
  assert.equal(d.state, "NO_GO");
  assert.deepEqual(d.blockingItems, ["Customer Approval rejected"]);
  assert.equal(d.customerApproval, "Rejected");
  assert.ok(!d.outstandingItems.includes("Customer Approval"), "rejected is not merely outstanding");
});

run("GO + another manual control Rejected → NO GO", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  assess(data, p, "rollback_plan_approved", "Rejected");
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.deployment.state, "NO_GO");
  assert.deepEqual(dash.deployment.blockingItems, ["Rollback Plan Approved rejected"]);
  assert.ok(dash.blockerCount >= 1, "a rejected control counts as a blocker");
});

run("GO + open Critical risk → current NO GO while the recorded GO remains intact", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  data.risks = [{ id: uid("r"), project_id: p.id, risk_ref: "RSK-9", description: "Cutover data risk", impact: "Critical", probability: "High", mitigation: null, owner: null, status: "Open", created_at: "", updated_at: "" }];
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.deployment.state, "NO_GO");
  assert.deepEqual(dash.deployment.blockingItems, ["1 open Critical risk"]);
  assert.equal(dash.latestDecision.decision, "GO", "recorded GO untouched");
  assert.equal(data.go_live_decisions.length, 1);
});

run("GO + genuine blocker (Blocked checklist item) → NO GO", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  data.go_live_checklists = [{ id: uid("c"), project_id: p.id, category: "Rollback", item: "Rollback plan", owner: null, status: "Blocked", due_date: null, completed_date: null, notes: null, created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z" }];
  const d = status(data, p);
  assert.equal(d.state, "NO_GO");
  assert.deepEqual(d.blockingItems, ["Rollback Plan Approved blocked"]);
});

run("an outstanding manual control alone is not a blocker and never NO GO", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  assess(data, p, "support_rota_confirmed", "Incomplete");
  assess(data, p, "hypercare_owner_assigned", "Not Yet Assessed");
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.blockerCount, 0);
  assert.deepEqual(dash.deployment.blockingItems, []);
  assert.notEqual(dash.deployment.state, "NO_GO");
  assert.ok(dash.deployment.outstandingItems.includes("Hypercare Owner Assigned"), "an unanswered control is outstanding");
});

run("future / not-applicable controls do not prevent GO", () => {
  // Phase SIT with no go/no-go step reached: all five manual controls are Not Yet Required.
  const { p, data } = readyProject({ phaseName: "System Testing" });
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  const dash = buildGoLiveDashboard(data, p, now);
  assert.ok(MANUAL.every((k) => dash.checks.find((c) => c.key === k).effective === "Not Yet Required"));
  assert.equal(dash.deployment.state, "GO");
  assert.equal(dash.deployment.customerApproval, "Not Applicable");
  // A Rejected assessment on a control that is not yet applicable is not a hard stop.
  assess(data, p, "rollback_plan_approved", "Rejected");
  assert.equal(buildGoLiveDashboard(data, p, now).deployment.state, "GO");
});

run("empty project cannot show GO, even with a recorded GO", () => {
  const p = project("empty", { project_ref: "EM1" });
  const data = baseDataStore();
  data.projects = [p];
  assert.equal(status(data, p).state, "NO_DECISION");
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  const d = status(data, p);
  assert.equal(d.state, "GO_PENDING_READINESS_ITEMS");
  assert.equal(d.summary, "No provider readiness evidence recorded yet");
});

run("hard stop outranks a recorded NO GO; both reasons reported", () => {
  const { p, data } = readyProject();
  decide(data, p, "NO_GO", "2026-09-24T14:40:00Z");
  assess(data, p, "customer_approval", "Rejected");
  const d = status(data, p);
  assert.equal(d.state, "NO_GO");
  assert.deepEqual(d.reasons, ["Customer Approval rejected", "Recorded decision: NO GO"]);
});

run("provider readiness counts only applicable automatic gates; checklist % no longer drives the label", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  const dash = buildGoLiveDashboard(data, p, now);
  // Requirements, Development (handover), SIT (sign-off), Tests = 4 assessed;
  // UAT sign-off, AC Met and Risks have no records here → excluded, not failures.
  assert.deepEqual(dash.providerReadiness, { complete: 4, total: 4 });
  assert.deepEqual(dash.checks.filter((c) => c.source === "Auto" && c.effective === "Not Yet Assessed").map((c) => c.key).sort(), ["acceptance_criteria_met", "risks_closed", "uat_signed_off"]);
  assert.ok(dash.readinessPercent < 60, "checklist % is low because 5 controls are outstanding");
  assert.equal(dash.status, "Red", "the unchanged checklist RAG may be Red…");
  assert.equal(dash.deployment.state, "GO_PENDING_CUSTOMER_APPROVAL", "…but the executive state is not NO GO");
});

// ── Risk semantics: Critical is a hard stop; High is a warning ─────────────

function addRisk(data, p, ref, impact, status = "Open") {
  data.risks = [...(data.risks ?? []), { id: uid("r"), project_id: p.id, risk_ref: ref, description: `${impact} risk ${ref}`, impact, probability: "Medium", mitigation: null, owner: null, status, created_at: "", updated_at: "" }];
}

run("open High risk does NOT produce an automatic NO GO, and stays visible", () => {
  const { p, data } = readyProject();
  addRisk(data, p, "RSK-H1", "High");
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.deployment.state, "NO_DECISION", "not NO GO");
  assert.deepEqual(dash.deployment.blockingItems, []);
  assert.deepEqual(dash.deployment.warnings, ["1 open High risk: RSK-H1"]);
  assert.equal(dash.openRisks, 1, "Open Risks still counts it");
  assert.deepEqual(dash.openHighRisks.map((r) => r.ref), ["RSK-H1"]);
});

run("Critical Risks count excludes High; combined count kept separately", () => {
  const { p, data } = readyProject();
  addRisk(data, p, "RSK-H1", "High");
  addRisk(data, p, "RSK-M1", "Medium");
  let dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.openCriticalRisks, 0, "High is not Critical");
  assert.equal(dash.openHighOrCriticalRisks, 1);
  assert.equal(dash.openRisks, 2);
  addRisk(data, p, "RSK-C1", "Critical");
  addRisk(data, p, "RSK-C2", "Critical", "Closed");
  dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.openCriticalRisks, 1, "only the OPEN Critical risk");
  assert.equal(dash.openHighOrCriticalRisks, 2);
});

run("recorded GO + open High risk keeps the appropriate GO / pending state (with warning)", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  addRisk(data, p, "RSK-H1", "High");
  let d = status(data, p);
  assert.equal(d.state, "GO_PENDING_CUSTOMER_APPROVAL");
  assert.equal(d.warnings.length, 1);
  for (const k of MANUAL) assess(data, p, k, "Complete");
  d = status(data, p);
  // The existing automatic "Risks Closed" gate is Incomplete while any risk is
  // open — that is an OUTSTANDING item (pending), never an automatic NO GO.
  assert.equal(d.state, "GO_PENDING_READINESS_ITEMS", "a High risk never forces NO GO");
  assert.deepEqual(d.outstandingItems, ["Risks Closed"]);
  assert.deepEqual(d.blockingItems, []);
  assert.deepEqual(d.warnings, ["1 open High risk: RSK-H1"]);
});

run("recorded GO + open Critical risk → NO GO, recorded GO preserved; closing it restores GO", () => {
  const { p, data } = readyProject();
  decide(data, p, "GO", "2026-09-24T14:40:00Z");
  for (const k of MANUAL) assess(data, p, k, "Complete");
  addRisk(data, p, "RSK-C1", "Critical");
  let dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.deployment.state, "NO_GO");
  assert.deepEqual(dash.deployment.blockingItems, ["1 open Critical risk"]);
  assert.equal(dash.latestDecision.decision, "GO");
  assert.equal(dash.decisionHistory.length, 1);
  data.risks[0].status = "Closed";
  dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.deployment.state, "GO");
});

run("unchanged consumers: checklist RAG and Manager Summary alert keep High + Critical", () => {
  const { p, data } = readyProject();
  for (const k of MANUAL) assess(data, p, k, "Complete");
  addRisk(data, p, "RSK-H1", "High");
  const dash = buildGoLiveDashboard(data, p, now);
  assert.equal(dash.readinessPercent, 90, "only Risks Closed outstanding");
  assert.equal(dash.blockerCount, 0);
  assert.equal(dash.status, "Red", "above the 60% threshold with 0 blockers, so Red comes only from the unchanged High + Critical RAG rule");
  const email = read("lib/email-content.ts");
  assert.match(email, /if \(dashboard\.openHighOrCriticalRisks > 0 && dashboard\.daysToGoLive !== null && dashboard\.daysToGoLive <= 14\)/);
  assert.doesNotMatch(email, /dashboard\.openCriticalRisks/);
  const glr = read("lib/go-live-readiness.ts");
  assert.match(glr, /const openCriticalRisks = scoped\.risks\.filter\(\(r\) => isRiskOpen\(r\.status\) && isRiskCritical\(r\.impact\)\)\.length;/);
  assert.match(glr, /openHighOrCriticalRisks > 0 \|\| readinessPercent < 60/);
  const panel = read("components/go-live-decision-panel.tsx");
  assert.match(panel, /label: "Critical Risks", value: dashboard\.openCriticalRisks/);
});

// ── Decision history helpers & validation ───────────────────────────────────

run("latest decision is deterministic: decided_at, then created_at, then id", () => {
  const mk = (id, at, created) => ({ id, project_id: "p", decision: "GO", reason: "r", decided_by: "a", decided_by_user_id: null, decided_at: at, created_at: created });
  const h = [mk("a", "2026-09-24T10:00:00Z", "2026-09-24T10:00:00Z"), mk("c", "2026-09-24T12:00:00Z", "2026-09-24T12:00:01Z"), mk("b", "2026-09-24T12:00:00Z", "2026-09-24T12:00:00Z")];
  assert.equal(latestGoLiveDecision(h).id, "c");
  assert.deepEqual(sortDecisionHistory(h).map((x) => x.id), ["c", "b", "a"]);
  assert.equal(latestGoLiveDecision([]), null);
});

run("request validation: GO / NO_GO only, reason required, project required", () => {
  assert.equal(validateDecisionBody({ project_id: "p", decision: "GO", reason: "ready" }), null);
  assert.equal(validateDecisionBody({ project_id: "p", decision: "NO_GO", reason: "not ready" }), null);
  assert.match(validateDecisionBody({ project_id: "p", decision: "MAYBE", reason: "x" }), /decision must be one of: GO, NO_GO/);
  assert.match(validateDecisionBody({ project_id: "p", decision: "GO", reason: "   " }), /reason/);
  assert.match(validateDecisionBody({ project_id: "p", decision: "GO" }), /reason/);
  assert.match(validateDecisionBody({ decision: "GO", reason: "x" }), /project_id/);
  assert.match(validateDecisionBody({ project_id: "p", decision: "GO", reason: "x".repeat(2001) }), /2000/);
});

run("isCheckOutstanding: auto Not Yet Assessed excluded; manual unanswered outstanding; Rejected is not 'outstanding'", () => {
  assert.equal(isCheckOutstanding({ key: "uat_signed_off", label: "UAT", source: "Auto", derived: "Not Yet Assessed", effective: "Not Yet Assessed" }), false);
  assert.equal(isCheckOutstanding({ key: "x", label: "X", source: "Manual", derived: "Incomplete", effective: "Not Yet Assessed" }), true);
  assert.equal(isCheckOutstanding({ key: "x", label: "X", source: "Manual", derived: "Incomplete", effective: "Rejected" }), false);
  assert.equal(isCheckOutstanding({ key: "x", label: "X", source: "Manual", derived: "Not Yet Required", effective: "Incomplete" }), false);
});

// ── Structural: migration, route, UI, no automatic/AI decisions ─────────────

run("migration 028: append-only table, GO/NO_GO constraint, non-blank reason, RLS with no policies", () => {
  const sql = read("supabase/migrations/028_go_live_decisions.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS go_live_decisions/);
  assert.match(sql, /decision\s+text\s+NOT NULL CHECK \(decision IN \('GO', 'NO_GO'\)\)/);
  assert.match(sql, /reason\s+text\s+NOT NULL CHECK \(length\(btrim\(reason\)\) > 0\)/);
  assert.match(sql, /project_id\s+uuid\s+NOT NULL REFERENCES projects\(id\) ON DELETE CASCADE/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /CREATE POLICY/, "service-role only, like the other go-live tables");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON go_live_decisions/);
  // Author FK: SET NULL (decision kept), and the append-only guard permits
  // exactly that FK update and the project-deletion cascade — nothing else.
  assert.match(sql, /decided_by_user_id\s+uuid\s+REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  assert.match(sql, /decided_by\s+text\s+NOT NULL/);
  assert.match(sql, /NEW\.decided_by = OLD\.decided_by/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM auth\.users u WHERE u\.id = OLD\.decided_by_user_id\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.projects p WHERE p\.id = OLD\.project_id\)/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = ''/);
  const schema = read("lib/schema.ts");
  assert.match(schema, /latestMigration = "028_go_live_decisions"/);
});

run("route: Admin/Manager-only insert, server-stamped author/time, audit entry, no edit/delete, tolerant GET", () => {
  const route = read("app/api/go-live/decisions/route.ts");
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("function appendOnly"));
  assert.match(post, /requireAdminOrManagerUser\(\)/);
  assert.match(post, /decided_by: displayName/);
  assert.match(post, /decided_at: new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(post, /body\.decided_by|body\.decided_at|body\.decided_by_user_id/, "author/time never trusted from the client");
  assert.match(post, /\.insert\(record\)/);
  assert.doesNotMatch(post, /upsert|\.update\(|\.delete\(/);
  assert.match(post, /from\("audit_log"\)\.insert\(\{[\s\S]*action_type: "Create"/);
  assert.match(route, /export const PATCH = appendOnly;\nexport const PUT = appendOnly;\nexport const DELETE = appendOnly;/);
  assert.match(route, /UNDEFINED_TABLE = "42P01"/);
});

run("UI: explicit Record Go/No-Go Decision action; unselected choice, required reason, audit notice, gated by role", () => {
  const panel = read("components/go-live-decision-panel.tsx");
  assert.match(panel, /Record Go\/No-Go Decision/);
  assert.match(panel, /useState<GoLiveDecisionValue \| null>\(null\)/, "no default decision");
  assert.match(panel, /const canSubmit = decision !== null && reason\.trim\(\)\.length > 0/);
  assert.match(panel, /This creates an auditable project decision/);
  assert.match(panel, /\{canRecord && \(/);
  assert.match(panel, /Outstanding readiness items/);
  assert.match(panel, /Blocking items/);
  const page = read("components/go-live-readiness-page.tsx");
  assert.match(page, /canRecord=\{canAssessManual\}/, "same Admin/Manager rule as manual assessments");
  assert.doesNotMatch(page, /Blocking items: \{blockingChecks/, "old 'Blocking items = every Incomplete check' wording removed");
  assert.doesNotMatch(page, /"No Go" : "Not Assessed"/, "the percentage-driven No Go label is gone");
});

run("no automatic or AI path can record a decision", () => {
  const writers = [];
  const walk = (dir) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel); else if (/\.(ts|tsx)$/.test(e.name) && /recordGoLiveDecision\(|api\/go-live\/decisions/.test(read(rel))) writers.push(rel);
  } };
  ["app", "components", "lib", "contexts"].forEach(walk);
  assert.deepEqual(writers.sort(), ["components/go-live-decision-panel.tsx", "lib/go-live-decision-client.ts", "lib/supabase/data-store.ts"].sort());
  const scan = (dir) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) scan(rel); else assert.doesNotMatch(read(rel), /go_live_decisions|recordGoLiveDecision/, rel);
  } };
  ["lib/ai", "lib/meeting-intelligence"].forEach(scan);
});

console.log("\nAll Go/No-Go decision tests passed.\n");
