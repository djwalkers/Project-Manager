// Phase 2 — empty-project semantics. computeDeliveryConfidence() and
// classifyProject() both previously read a project with zero delivery
// evidence as falsely Green/100%/"On Track", because their underlying
// candidate/signal generation simply had nothing to flag as wrong. This
// proves both now report a neutral "Not Assessed" state instead — never a
// manufactured low score either — and that the moment even one lifecycle
// record exists, they resume full, unchanged assessment.
//
// Evidence threshold (documented here as the single source of truth):
// hasDeliveryEvidence() (lib/project-scope.ts) is true once a project has
// at least one record in ANY of requirements, deliverables, risks,
// decisions, actions, dependencies, test_cases, acceptance_criteria,
// milestones, timeline_items, or discovery_questions — the exact
// collections buildDeliveryInsightAnalysis/classifyProject's signal
// derivation already draw from. Not a count threshold ("5 records"): one
// record of any kind is enough to leave "Not Assessed" and enter genuine
// assessment.
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
const { hasDeliveryEvidence } = req("../lib/project-scope.ts");
const { computeDeliveryConfidence } = req("../lib/delivery-confidence.ts");
const { classifyProject } = req("../lib/manager-summary.ts");
const { seedData } = req("../lib/seed-data.ts");

const now = new Date("2026-09-18T09:00:00Z");
const PROJECT_ID = "empty-assessment-project";

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function emptyProject(overrides = {}) {
  return {
    ...seedData.projects[0],
    id: PROJECT_ID,
    project_ref: "PL10",
    name: "PL10 Testing",
    status: "Discovery",
    health: "Amber",
    schedule_variance: 0,
    planned_start_date: null,
    planned_end_date: null,
    go_live_date: null,
    uat_complete_date: null,
    hypercare_start_date: null,
    hypercare_end_date: null,
    description: null,
    owner: null,
    ...overrides,
  };
}

function baseData(projectOverrides = {}, dataOverrides = {}) {
  const data = structuredClone(seedData);
  return {
    ...data,
    projects: [emptyProject(projectOverrides)],
    requirements: [],
    milestones: [],
    actions: [],
    risks: [],
    decisions: [],
    dependencies: [],
    discovery_questions: [],
    test_cases: [],
    timeline_items: [],
    deliverables: [],
    acceptance_criteria: [],
    project_snapshots: [],
    evidence: [],
    requirement_sign_offs: [],
    meeting_intelligence: [],
    meeting_suggestions: [],
    go_live_checklists: [],
    cutover_plan: [],
    activity_log: [],
    documents: [],
    meetings: [],
    ...dataOverrides,
  };
}

function requirement(overrides = {}) {
  return {
    id: `req-${Math.random()}`, project_id: PROJECT_ID, requirement_ref: "REQ-001",
    title: "A requirement", description: null, priority: "Medium", category: "Business Rule",
    status: "Approved", owner: "Owner", source: null, notes: null,
    created_at: now.toISOString(), updated_at: now.toISOString(),
    ...overrides,
  };
}

// ── hasDeliveryEvidence: the documented threshold ───────────────────────────

run("hasDeliveryEvidence is false when every lifecycle collection is empty", () => {
  const data = baseData();
  assert.equal(hasDeliveryEvidence(data), false);
});

run("hasDeliveryEvidence is true with a single requirement — one record of any kind is enough", () => {
  const data = baseData({}, { requirements: [requirement()] });
  assert.equal(hasDeliveryEvidence(data), true);
});

run("hasDeliveryEvidence is true with a single risk, even with everything else empty", () => {
  const data = baseData({}, {
    risks: [{ id: "risk-1", project_id: PROJECT_ID, risk_ref: "RSK-001", description: "x", impact: "Low", probability: "Low", mitigation: null, owner: "Owner", status: "Open", trend: null, created_at: now.toISOString(), updated_at: now.toISOString() }],
  });
  assert.equal(hasDeliveryEvidence(data), true);
});

// ── computeDeliveryConfidence: Not Assessed, never false-Green, never invented-low ──

run("an entirely empty project reports Delivery Confidence as Not Assessed, not Green/100", () => {
  const data = baseData();
  const project = data.projects[0];
  const confidence = computeDeliveryConfidence(data, project);
  assert.equal(confidence.rag, "Not Assessed");
  assert.equal(confidence.score, null, "score must not be manufactured — null, not 0 and not 100");
});

run("Delivery Confidence's Not Assessed reasons explain why, not manufacture a gap list", () => {
  const data = baseData();
  const confidence = computeDeliveryConfidence(data, data.projects[0]);
  assert.equal(confidence.reasons.length, 1);
  assert.match(confidence.reasons[0], /no delivery evidence/i);
});

run("a single requirement is enough to leave Not Assessed and enter real assessment", () => {
  const data = baseData({}, { requirements: [requirement()] });
  const confidence = computeDeliveryConfidence(data, data.projects[0]);
  assert.notEqual(confidence.rag, "Not Assessed");
  assert.equal(typeof confidence.score, "number");
});

// ── classifyProject: Not Assessed, never false-Green/On Track ──────────────

run("an entirely empty project's Manager Summary is Not Assessed, not Green/On Track", () => {
  const data = baseData();
  const summary = classifyProject(data, data.projects[0], now);
  assert.equal(summary.status, "Not Assessed");
  assert.equal(summary.dateConfidence, "Not Assessed");
  assert.equal(summary.managementAction, "Not Required");
  assert.equal(summary.attentionRequired, null);
});

run("a single requirement is enough for Manager Summary to leave Not Assessed and enter real classification", () => {
  const data = baseData(
    { planned_start_date: "2026-09-01", planned_end_date: "2026-12-01" },
    { requirements: [requirement()] },
  );
  const summary = classifyProject(data, data.projects[0], now);
  assert.notEqual(summary.status, "Not Assessed");
  assert.notEqual(summary.dateConfidence, "Not Assessed");
});

console.log("\nAll empty-project-assessment tests passed.\n");
