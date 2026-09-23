// Display-only formatting helpers for the Test Status report
// (lib/test-report-format.ts) and the redesigned report layout
// (buildTestStatusEmail). Nothing here writes data; these prove the
// formatter handles old "Objective: … Steps: …" scenarios, concise newer
// titles, missing ACs, multi-requirement links and every test status.
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
const { buildTestStatusEmail } = req("../lib/email-content.ts");
const { parseTestScenario, splitSteps, groupTestsByRequirement, TEST_TITLE_MAX_LENGTH } = req("../lib/test-report-format.ts");
const { computeTestVerification } = req("../lib/lifecycle/test-verification.ts");
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

function requirement(projectId, overrides = {}) {
  const id = overrides.id ?? uid("req");
  return {
    id, project_id: projectId, requirement_ref: `REQ-${id}`, title: `Requirement ${id}`,
    description: null, priority: "Medium", category: "Business Rule", status: "Approved",
    owner: "Owner", source: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}

function ac(projectId, requirementId, overrides = {}) {
  const id = overrides.id ?? uid("ac");
  return {
    id, project_id: projectId, requirement_id: requirementId, ac_ref: `AC-${id}`,
    criterion: `Criterion ${id}`, description: null, status: "Not Started", owner: null,
    evidence: null, notes: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
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

function link(projectId, sourceEntity, sourceId, targetEntity, targetId, overrides = {}) {
  return {
    id: uid("link"), project_id: projectId,
    source_entity: sourceEntity, source_id: sourceId,
    target_entity: targetEntity, target_id: targetId,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
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


// ── parseTestScenario ───────────────────────────────────────────────────────

run("old combined format: strips 'Objective:', title = objective only, steps split out", () => {
  const p = parseTestScenario("Objective: verify Pick Execution filters to the user's configured plant. Steps: 1) Log in as a user configured to Plant A. 2) Open Pick Execution.");
  assert.equal(p.title, "Verify Pick Execution filters to the user's configured plant");
  assert.equal(p.objective, "verify Pick Execution filters to the user's configured plant.");
  assert.equal(p.steps, "1) Log in as a user configured to Plant A. 2) Open Pick Execution.");
  assert.doesNotMatch(p.title, /Objective:|Steps:/);
  assert.deepEqual(splitSteps(p.steps), ["Log in as a user configured to Plant A.", "Open Pick Execution."]);
});

run("objective only (no Steps) and case-insensitive prefix", () => {
  const p = parseTestScenario("OBJECTIVE:   check the thing works  ");
  assert.equal(p.title, "Check the thing works");
  assert.equal(p.steps, null);
  assert.deepEqual(splitSteps(p.steps), []);
});

run("concise newer title is used as-is", () => {
  const p = parseTestScenario("Pick Execution main flow");
  assert.deepEqual(p, { title: "Pick Execution main flow", objective: "Pick Execution main flow", steps: null });
});

run("free text followed by Steps: splits without an Objective prefix", () => {
  const p = parseTestScenario("Exact-weight validation. Steps: 1) Enter weight.");
  assert.equal(p.title, "Exact-weight validation");
  assert.equal(p.steps, "1) Enter weight.");
});

run("empty / null scenario yields a placeholder, never throws", () => {
  assert.equal(parseTestScenario(null).title, "—");
  assert.equal(parseTestScenario("   ").title, "—");
});

run("very long objective is truncated for the title but kept whole as the objective", () => {
  const long = `Objective: ${"verify a very long objective sentence ".repeat(8)}Steps: 1) Go.`;
  const p = parseTestScenario(long);
  assert.ok(p.title.length <= TEST_TITLE_MAX_LENGTH, `title length ${p.title.length}`);
  assert.match(p.title, /…$/);
  assert.ok(p.objective.length > TEST_TITLE_MAX_LENGTH);
});

run("unnumbered steps come back as one step", () => {
  assert.deepEqual(splitSteps("Open the screen and look."), ["Open the screen and look."]);
});

run("parseTestScenario never mutates the stored test", () => {
  const t = testCase("p", "TST-1", "Passed", { scenario: "Objective: a. Steps: 1) b." });
  const before = JSON.stringify(t);
  parseTestScenario(t.scenario);
  assert.equal(JSON.stringify(t), before);
});

// ── groupTestsByRequirement ─────────────────────────────────────────────────

function fixture() {
  const p = project("proj", { name: "Fixture Project" });
  const data = baseDataStore();
  data.projects = [p];
  const r1 = requirement(p.id, { requirement_ref: "REQ-002", title: "Second requirement" });
  const r2 = requirement(p.id, { requirement_ref: "REQ-001", title: "First requirement" });
  const r3 = requirement(p.id, { requirement_ref: "REQ-010", title: "Untested requirement" });
  const ac1 = ac(p.id, r1.id, { ac_ref: "AC-001" });
  const tAc = testCase(p.id, "TST-001", "Passed", { scenario: "Objective: verify via AC. Steps: 1) Do it." });
  const tDirect = testCase(p.id, "TST-002", "Pending", { scenario: "Direct requirement link" });
  const tMulti = testCase(p.id, "TST-003", "Blocked", { scenario: "End-to-end flow", actual_result: "No test data available." });
  const tFail = testCase(p.id, "TST-004", "Failed", { scenario: "Outside tolerance" });
  const tInProg = testCase(p.id, "TST-005", "In Progress", { scenario: "Being run" });
  const tOrphan = testCase(p.id, "TST-006", "Pending", { scenario: "Orphan" });
  data.requirements = [r1, r2, r3];
  data.acceptance_criteria = [ac1];
  data.test_cases = [tAc, tDirect, tMulti, tFail, tInProg, tOrphan];
  data.artefact_links = [
    link(p.id, "test_cases", tAc.id, "acceptance_criteria", ac1.id),
    link(p.id, "test_cases", tDirect.id, "requirements", r2.id),
    link(p.id, "test_cases", tMulti.id, "requirements", r1.id),
    link(p.id, "test_cases", tMulti.id, "requirements", r2.id),
    link(p.id, "test_cases", tFail.id, "requirements", r2.id),
    link(p.id, "requirements", r1.id, "test_cases", tInProg.id),
  ];
  return { p, data, r1, r2, r3, tAc, tDirect, tMulti, tFail, tInProg, tOrphan };
}

run("groups are in requirement-ref order and use the stored requirement title", () => {
  const f = fixture();
  const g = groupTestsByRequirement(f.data.requirements, f.data.test_cases, computeTestVerification(f.data));
  assert.deepEqual(g.groups.map((x) => x.requirementRef), ["REQ-001", "REQ-002"]);
  assert.equal(g.groups[0].requirementTitle, "First requirement");
});

run("a test linked to several requirements appears under each, with 'alsoUnder' cross-references", () => {
  const f = fixture();
  const g = groupTestsByRequirement(f.data.requirements, f.data.test_cases, computeTestVerification(f.data));
  const inR1 = g.groups.find((x) => x.requirementRef === "REQ-002").rows.find((r) => r.test.test_ref === "TST-003");
  const inR2 = g.groups.find((x) => x.requirementRef === "REQ-001").rows.find((r) => r.test.test_ref === "TST-003");
  assert.ok(inR1 && inR2);
  assert.deepEqual(inR1.alsoUnder, ["REQ-001"]);
  assert.deepEqual(inR2.alsoUnder, ["REQ-002"]);
  assert.deepEqual(g.requirementRefsByTest.get(f.tMulti.id), ["REQ-001", "REQ-002"]);
});

run("AC refs are carried through; a direct requirement link has no AC", () => {
  const f = fixture();
  const g = groupTestsByRequirement(f.data.requirements, f.data.test_cases, computeTestVerification(f.data));
  const r2 = g.groups.find((x) => x.requirementRef === "REQ-002");
  assert.deepEqual(r2.rows.find((r) => r.test.test_ref === "TST-001").acRefs, ["AC-001"]);
  const r1 = g.groups.find((x) => x.requirementRef === "REQ-001");
  assert.deepEqual(r1.rows.find((r) => r.test.test_ref === "TST-002").acRefs, []);
});

run("group tallies come straight from the canonical verification (never re-derived)", () => {
  const f = fixture();
  const v = computeTestVerification(f.data);
  const g = groupTestsByRequirement(f.data.requirements, f.data.test_cases, v);
  for (const grp of g.groups) {
    assert.equal(grp.passed, v.byRequirement[grp.requirementId].passed);
    assert.equal(grp.testCount, v.byRequirement[grp.requirementId].testCount);
    assert.equal(grp.state, v.byRequirement[grp.requirementId].state);
  }
});

run("unlinked tests and untested requirements are reported separately", () => {
  const f = fixture();
  const g = groupTestsByRequirement(f.data.requirements, f.data.test_cases, computeTestVerification(f.data));
  assert.deepEqual(g.unlinkedTests.map((t) => t.test_ref), ["TST-006"]);
  assert.deepEqual(g.untestedRequirements.map((r) => r.requirementRef), ["REQ-010"]);
});

run("a link to a test outside the provided test list is ignored", () => {
  const f = fixture();
  const foreign = testCase("other", "TST-X", "Passed");
  f.data.artefact_links.push(link(f.p.id, "test_cases", foreign.id, "requirements", f.r3.id));
  const g = groupTestsByRequirement(f.data.requirements, f.data.test_cases, computeTestVerification(f.data));
  assert.ok(!g.groups.some((x) => x.rows.some((r) => r.test.test_ref === "TST-X")));
  assert.deepEqual(g.untestedRequirements.map((r) => r.requirementRef), ["REQ-010"]);
});

// ── Report layout ───────────────────────────────────────────────────────────

function mainSection(html) {
  const start = html.indexOf("Full Test Status");
  const end = html.indexOf("Detailed Test Procedures");
  return html.slice(start, end === -1 ? undefined : end);
}

run("main status list shows concise titles, never 'Objective:' / 'Steps:' text", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  const main = mainSection(c.html);
  assert.match(main, /Verify via AC/);
  assert.doesNotMatch(main, /Objective:|Steps:|Do it\./);
  const mainText = c.text.slice(c.text.indexOf("FULL TEST STATUS"));
  assert.doesNotMatch(mainText, /Objective:|Steps:/);
});

run("appendix (print variant) keeps the full objective and numbered steps", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now, { includeProcedures: true });
  const appendix = c.html.slice(c.html.indexOf("Detailed Test Procedures"));
  assert.match(appendix, /Objective:<\/span> verify via AC\./);
  assert.match(appendix, /<li[^>]*>Do it\.<\/li>/);
  assert.match(c.text, /Steps:\n  1\. Do it\./);
});

run("every status renders as a labelled badge (readable without colour)", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  for (const s of ["Passed", "Pending", "Failed", "Blocked", "In Progress"]) {
    assert.match(c.html, new RegExp(`class="badge nw"[^>]*>[^<]* ${s}</span>`), `badge for ${s}`);
  }
});

run("Failed and Blocked tests are surfaced in Exceptions & Attention with requirement and reason", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  const exc = c.html.slice(c.html.indexOf("Exceptions"), c.html.indexOf("Full Test Status"));
  assert.match(exc, /1 failed · 1 blocked/);
  assert.match(exc, /TST-003/);
  assert.match(exc, /TST-004/);
  assert.match(exc, /No test data available\./);
  assert.match(exc, /First requirement/);
  assert.match(exc, /Awaiting execution:<\/strong> 3 tests are pending or in progress/);
  assert.match(exc, /These are open, not defects\./);
  assert.doesNotMatch(exc, /No failed or blocked tests/);
});

run("groups show 'x / y passed' and the canonical verification state", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  assert.match(c.html, /REQ-001<\/span><span[^>]*>First requirement<\/span>/);
  assert.match(c.html, /0 \/ 3 passed · <span[^>]*>Test Failure<\/span>/);
  assert.match(c.text, /REQ-002 — Second requirement — 1\/3 passed — Testing Blocked/);
  assert.match(c.html, /Also under/);
  assert.match(c.html, /Not linked to a requirement/);
  assert.match(c.html, /No tests linked:<\/strong> <span[^>]*>REQ-010<\/span> Untested requirement/);
});

run("verification states render in reading order: Verified, Testing, Test Failure, Testing Blocked, No Tests Linked", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  const vs = c.html.slice(c.html.indexOf('class="vs"'));
  const order = ["Verified", "Testing", "Test Failure", "Testing Blocked", "No Tests Linked"].map((st) => vs.indexOf(`</span>${st}</div>`));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

run("refs are non-breaking and print CSS guards page breaks", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  assert.match(c.html, /<span class="nw" style="white-space:nowrap;font-weight:600">TST-001<\/span>/);
  assert.match(c.html, /<span class="nw" style="white-space:nowrap;font-weight:400">AC-001<\/span>/);
  assert.match(c.html, /@page\{size:A4/);
  assert.match(c.html, /\.appendix\{break-before:page/);
  assert.match(c.html, /tr,[^{]*\{break-inside:avoid/);
  assert.match(c.html, /max-width:780px/);
});

run("header uses project data only; current phase shown when a timeline item is In Progress, omitted otherwise", () => {
  const f = fixture();
  f.p.project_ref = "ZZ9";
  f.p.customer = "Globex";
  const without = buildTestStatusEmail(f.data, f.p, now);
  assert.match(without.html, /ZZ9<\/div>/);
  assert.match(without.html, /Globex · 22 September 2026/);
  assert.doesNotMatch(without.html, /Test Status Report <span/);
  assert.doesNotMatch(without.text, /Current phase/);
  f.data.timeline_items = [
    { id: "t1", project_id: f.p.id, phase_ref: "P1", phase_name: "Build", start_date: "2026-08-01", end_date: "2026-08-30", owner: null, status: "Complete", progress_percent: 100, notes: null, created_at: "", updated_at: "" },
    { id: "t2", project_id: f.p.id, phase_ref: "P2", phase_name: "System Test", start_date: "2026-09-01", end_date: "2026-09-30", owner: null, status: "In Progress", progress_percent: 50, notes: null, created_at: "", updated_at: "" },
  ];
  const withPhase = buildTestStatusEmail(f.data, f.p, now);
  assert.match(withPhase.html, /Test Status Report <span[^>]*>· System Test<\/span>/);
  assert.match(withPhase.text, /Current phase: System Test/);
});

run("footer replaces the old 'manual report' line", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  assert.match(c.html, /Project Manager · Test Status Report · Generated 22 Sept? 2026, 13:00/);
  assert.doesNotMatch(c.html + c.text, /manual report/);
});

run("a small all-passed project renders without exceptions block or appendix noise", () => {
  const p = project("small");
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "TST-1", "Passed", { scenario: "Only test" })];
  const c = buildTestStatusEmail(data, p, now);
  assert.match(c.html, /No failed or blocked tests\./);
  assert.doesNotMatch(c.html, /Awaiting execution/);
  assert.match(c.html, /Not linked to a requirement/);
  assert.match(c.html, /No requirements recorded for this project\./);
});

run("an empty project omits the appendix even in the print variant", () => {
  const p = project("empty");
  const data = baseDataStore();
  data.projects = [p];
  const c = buildTestStatusEmail(data, p, now, { includeProcedures: true });
  assert.doesNotMatch(c.html + c.text, /Detailed Test Procedures|DETAILED TEST PROCEDURES/);
  assert.match(c.html, /No test cases recorded for this project\./);
});

// ── Email vs Print / PDF variants ───────────────────────────────────────────

const APPENDIX_HTML = /<section class="rs appendix"[\s\S]*?<\/section>/;
const APPENDIX_TEXT = /\n\nAPPENDIX — DETAILED TEST PROCEDURES\n[\s\S]*?(?=\n\nProject Manager · Test Status Report · Generated)/;

run("email output (default) excludes the Detailed Test Procedures appendix", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now);
  assert.doesNotMatch(c.html, /Detailed Test Procedures/);
  assert.doesNotMatch(c.html, /class="proc"/);
  assert.doesNotMatch(c.text, /DETAILED TEST PROCEDURES|Recorded result:|Steps:/);
  assert.deepEqual(buildTestStatusEmail(f.data, f.p, now, { includeProcedures: false }), c, "explicit false is the same as the default");
});

run("print / PDF output includes the appendix with every test's procedure", () => {
  const f = fixture();
  const c = buildTestStatusEmail(f.data, f.p, now, { includeProcedures: true });
  assert.match(c.html, /Appendix — Detailed Test Procedures/);
  assert.equal((c.html.match(/class="proc"/g) ?? []).length, f.data.test_cases.length);
  assert.match(c.html, /\.appendix\{break-before:page/, "A4 appendix page-break rule preserved");
  assert.match(c.text, /APPENDIX — DETAILED TEST PROCEDURES/);
});

run("both variants share an identical main report: print minus appendix === email, html and text", () => {
  const f = fixture();
  for (const [data, p] of [[f.data, f.p], (() => { const q = project("one"); const d = baseDataStore(); d.projects = [q]; d.test_cases = [testCase(q.id, "TST-1", "Pending")]; return [d, q]; })()]) {
    const email = buildTestStatusEmail(data, p, now);
    const print = buildTestStatusEmail(data, p, now, { includeProcedures: true });
    assert.equal(email.subject, print.subject);
    assert.match(print.html, APPENDIX_HTML);
    assert.equal(print.html.replace(APPENDIX_HTML, ""), email.html);
    assert.match(print.text, APPENDIX_TEXT);
    assert.equal(print.text.replace(APPENDIX_TEXT, ""), email.text);
    for (const section of ["Executive Test Summary", "Requirement Verification Summary", "Exceptions &amp; Attention", "Full Test Status", "Project Manager · Test Status Report · Generated"]) {
      assert.ok(email.html.includes(section) && print.html.includes(section), section);
    }
  }
});

run("structural: the send path and the preview use the default (appendix-free) variant; Print / PDF uses the full one", () => {
  const delivery = fs.readFileSync(path.join(root, "lib/email-delivery.ts"), "utf8");
  assert.match(delivery, /kind === "Test Status" \? buildTestStatusEmail\(data, testStatusProject as Project, now\)/, "send must not pass includeProcedures");
  assert.doesNotMatch(delivery, /includeProcedures/);
  const panel = fs.readFileSync(path.join(root, "components/test-status-email-panel.tsx"), "utf8");
  assert.match(panel, /const content = useMemo\(\(\) => buildTestStatusEmail\(data, project, generatedAt\), /, "preview = the email as sent");
  assert.match(panel, /const printContent = useMemo\(\(\) => buildTestStatusEmail\(data, project, generatedAt, \{ includeProcedures: true \}\)/);
  assert.match(panel, /srcDoc=\{content\.html\}/, "rendered preview shows the email variant");
  assert.match(panel, /mode === "html" \? content\.html : content\.text/, "HTML / plain-text tabs show the email variant");
  const printFn = panel.slice(panel.indexOf("function openPrintableReport"), panel.indexOf("async function sendNow"));
  assert.match(printFn, /new Blob\(\[printContent\.html\]/, "Print / PDF opens the full report, not the email DOM");
  const sendFn = panel.slice(panel.indexOf("async function sendNow"));
  assert.doesNotMatch(sendFn.slice(0, sendFn.indexOf("return (")), /printContent/, "send never uses the print variant");
});

run("structural: the report builder contains no project-specific literals", () => {
  const source = fs.readFileSync(path.join(root, "lib/email-content.ts"), "utf8");
  const section = source.slice(source.indexOf("const TEST_STATUS_STYLE"), source.indexOf("// ── Manager Exception Email"));
  assert.doesNotMatch(section, /PL10|CR0?28|F20|Sysco|REP-0/);
  const helpers = fs.readFileSync(path.join(root, "lib/test-report-format.ts"), "utf8");
  assert.doesNotMatch(helpers, /PL10|CR0?28|F20|Sysco|REP-0/);
});

console.log("\nAll Test Status report formatting tests passed.\n");
