// Testing page live test-position summary (components/test-position-summary.tsx)
// and the "Complete" percentage label. Renders the real component to static
// markup and checks it agrees with the Test Status email and Print/PDF,
// which share lib/test-report-format.ts countTests().
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

Module._extensions[".tsx"] = Module._extensions[".ts"] = function compileTypeScript(module, filename) {
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
const { buildTestStatusEmail } = req("../lib/email-content.ts");
const { scopeProjectData } = req("../lib/project-scope.ts");
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
const { TestPositionSummary } = req("../components/test-position-summary.tsx");
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


const statuses = (spec) => Object.entries(spec).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));
const render = (tests) => renderToStaticMarkup(React.createElement(TestPositionSummary, { tests }));
function metrics(html) {
  return Object.fromEntries([...html.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)].map((m) => [m[1], m[2]]));
}

run("PL10-shaped data: Complete 89%, Passed 47, Failed 0, Blocked 0, Remaining 6", () => {
  const html = render(statuses({ Passed: 47, "In Progress": 6 }));
  assert.deepEqual(metrics(html), { Complete: "89%", Passed: "47", Failed: "0", Blocked: "0", Remaining: "6" });
  assert.match(html, /aria-label="89% complete: 47 passed, 0 failed, 0 blocked, 6 remaining of 53 tests"/, "not colour-only: a full text summary is exposed");
});

run("Failed and Blocked are never counted in Remaining; totals reconcile", () => {
  const html = render(statuses({ Passed: 3, Failed: 2, Blocked: 1, Pending: 2, "In Progress": 2 }));
  const m = metrics(html);
  assert.deepEqual(m, { Complete: "50%", Passed: "3", Failed: "2", Blocked: "1", Remaining: "4" });
  assert.equal(Number(m.Passed) + Number(m.Failed) + Number(m.Blocked) + Number(m.Remaining), 10);
});

run("Pending / In Progress combinations all land in Remaining", () => {
  assert.equal(metrics(render(statuses({ Pending: 3 }))).Remaining, "3");
  assert.equal(metrics(render(statuses({ "In Progress": 3 }))).Remaining, "3");
  assert.equal(metrics(render(statuses({ Pending: 1, "In Progress": 2, Passed: 1 }))).Remaining, "3");
  assert.equal(metrics(render(statuses({ Pending: 4 }))).Complete, "0%", "0% is genuine when tests exist but none are executed");
});

run("attention colours only when non-zero; labels always present", () => {
  const zero = render(statuses({ Passed: 1 }));
  assert.match(zero, /<dt[^>]*>Failed<\/dt><dd class="[^"]*text-muted-foreground/);
  assert.match(zero, /<dt[^>]*>Blocked<\/dt><dd class="[^"]*text-muted-foreground/);
  const hot = render(statuses({ Failed: 1, Blocked: 1 }));
  assert.match(hot, /<dt[^>]*>Failed<\/dt><dd class="[^"]*text-red-600/);
  assert.match(hot, /<dt[^>]*>Blocked<\/dt><dd class="[^"]*text-amber-600/);
});

run("empty project: neutral 'No tests recorded', never a 0% Complete", () => {
  const html = render([]);
  assert.match(html, /No tests recorded/);
  assert.doesNotMatch(html, /%|Complete/);
});

run("agrees with the Test Status email and Print/PDF for the same project", () => {
  const p = project("agree", { project_ref: "AG1" });
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "T1", "Passed"), testCase(p.id, "T2", "Passed"), testCase(p.id, "T3", "Failed"), testCase(p.id, "T4", "Blocked"), testCase(p.id, "T5", "In Progress"), testCase(p.id, "T6", "Pending"), testCase(p.id, "T7", "Pending")];
  const m = metrics(render(scopeProjectData(data, p).test_cases));
  assert.deepEqual(m, { Complete: "43%", Passed: "2", Failed: "1", Blocked: "1", Remaining: "3" });
  const email = buildTestStatusEmail(data, p, now);
  assert.match(email.text, /2 of 7 tests passed · 43% complete\nRemaining: 3 \(1 in progress, 2 pending\) · Failed: 1 · Blocked: 1/);
  const print = buildTestStatusEmail(data, p, now, { variant: "print" });
  assert.match(print.text, /Executed: 3\nComplete: 43%\nPassed: 2\nFailed: 1\nBlocked: 1/);
  assert.match(print.html, /text-transform:uppercase;color:#64748b;white-space:nowrap">Complete<\/div><div[^>]*>43%<\/div>/);
});

run("user-facing percentage label is 'Complete' everywhere; 'Execution' label is gone", () => {
  const p = project("lbl");
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "T1", "Passed"), testCase(p.id, "T2", "Pending")];
  for (const c of [buildTestStatusEmail(data, p, now), buildTestStatusEmail(data, p, now, { variant: "print" })]) {
    assert.doesNotMatch(c.html + c.text, />Execution<|Execution:|\d+% executed/, "no 'Execution' percentage label");
    assert.match(c.html + c.text, /50% complete|Complete: 50%|>Complete</);
  }
});

run("project switching: summary follows the selected project's scoped tests only", () => {
  const a = project("pa", { project_ref: "PA" });
  const b = project("pb", { project_ref: "PB" });
  const data = baseDataStore();
  data.projects = [a, b];
  data.test_cases = [testCase(a.id, "A1", "Passed"), testCase(a.id, "A2", "In Progress"), testCase(b.id, "B1", "Failed"), testCase(b.id, "B2", "Failed"), testCase(b.id, "B3", "Passed")];
  assert.deepEqual(metrics(render(scopeProjectData(data, a).test_cases)), { Complete: "50%", Passed: "1", Failed: "0", Blocked: "0", Remaining: "1" });
  assert.deepEqual(metrics(render(scopeProjectData(data, b).test_cases)), { Complete: "100%", Passed: "1", Failed: "2", Blocked: "0", Remaining: "0" });
});

run("structural: mounted only on the Testing page, fed by the active project's scoped data; no own counting", () => {
  const app = fs.readFileSync(path.join(root, "components/app-client.tsx"), "utf8");
  assert.match(app, /config\.key === "test_cases" && \(\s*<TestPositionSummary tests=\{pageData\.test_cases\}/);
  assert.match(app, /const pageData = data && activeProject \? scopeProjectData\(data, activeProject\) : null;/);
  const comp = fs.readFileSync(path.join(root, "components/test-position-summary.tsx"), "utf8");
  assert.match(comp, /import \{ countTests \} from "@\/lib\/test-report-format"/);
  assert.doesNotMatch(comp, /\.filter\(|status ===|PL10|CR0?28/, "no independent status counting or project-specific logic");
});

console.log("\nAll Testing page summary tests passed.\n");
