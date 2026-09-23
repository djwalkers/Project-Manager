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

// ── 1. Mixed Passed/Failed/Blocked/Pending, executive summary counts ───────

run("executive summary counts Total/Executed/Passed/Failed/Blocked/Pending correctly (Executed = Passed + Failed)", () => {
  const pl10 = project("pl10", { name: "PL10 Replenishment" });
  const data = baseDataStore();
  data.projects = [pl10];
  data.test_cases = [
    testCase(pl10.id, "TST-001", "Passed"),
    testCase(pl10.id, "TST-002", "Passed"),
    testCase(pl10.id, "TST-003", "Failed"),
    testCase(pl10.id, "TST-004", "Blocked"),
    testCase(pl10.id, "TST-005", "Pending"),
    testCase(pl10.id, "TST-006", "In Progress"),
  ];

  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.text, /Total:?\s*6/i);
  assert.match(content.text, /Executed:?\s*3/i, "Executed must be Passed(2) + Failed(1) = 3, not counting Blocked/Pending/In Progress");
  assert.match(content.text, /Passed:?\s*2/i);
  assert.match(content.text, /Failed:?\s*1/i);
  assert.match(content.text, /Blocked:?\s*1/i);
  assert.match(content.text, /Pending:?\s*1/i);
  assert.match(content.text, /In Progress:?\s*1/i);
  assert.match(content.text, /50%/, "execution percentage must be 3/6 = 50%");
});

// ── 2. Natural Ref ordering ──────────────────────────────────────────────────

run("Full Test Status lists tests in natural Ref ascending order regardless of input order", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  data.test_cases = [
    testCase(pl10.id, "TST-10", "Passed"),
    testCase(pl10.id, "TST-2", "Passed"),
    testCase(pl10.id, "TST-1", "Passed"),
    testCase(pl10.id, "TST-9", "Passed"),
  ];

  const content = buildTestStatusEmail(data, pl10, now);
  const order = ["TST-1", "TST-2", "TST-9", "TST-10"].map((ref) => content.text.indexOf(ref));
  assert.ok(order.every((idx) => idx !== -1), "every ref must appear in the output");
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], `expected natural ref order, got indices ${JSON.stringify(order)}`);
  }
});

// ── 3. Project isolation ─────────────────────────────────────────────────────

run("the email for project A never includes project B's tests, requirements, or AC refs", () => {
  const projA = project("proj-a", { name: "Project A" });
  const projB = project("proj-b", { name: "Project B" });
  const data = baseDataStore();
  data.projects = [projA, projB];
  const reqA = requirement(projA.id, { requirement_ref: "REQ-AAA" });
  const reqB = requirement(projB.id, { requirement_ref: "REQ-BBB" });
  const acA = ac(projA.id, reqA.id, { ac_ref: "AC-AAA" });
  const acB = ac(projB.id, reqB.id, { ac_ref: "AC-BBB" });
  data.requirements = [reqA, reqB];
  data.acceptance_criteria = [acA, acB];
  data.test_cases = [
    testCase(projA.id, "TST-A01", "Passed"),
    testCase(projB.id, "TST-B01", "Failed"),
  ];
  data.artefact_links = [
    link(projA.id, "acceptance_criteria", acA.id, "test_cases", data.test_cases[0].id),
    link(projB.id, "acceptance_criteria", acB.id, "test_cases", data.test_cases[1].id),
  ];

  const content = buildTestStatusEmail(data, projA, now);
  assert.match(content.text, /TST-A01/);
  assert.doesNotMatch(content.text, /TST-B01/, "project B's test must never appear in project A's report");
  assert.doesNotMatch(content.text, /REQ-BBB/, "project B's requirement must never appear");
  assert.doesNotMatch(content.text, /AC-BBB/, "project B's AC must never appear");
  assert.doesNotMatch(content.text, /Project B/, "project B's name must never appear");
});

// ── 4. Requirement verification summary comes from the canonical rollup ────

run("Requirement Verification Summary reflects the canonical computeTestVerification/summarizeVerificationStates output, not independently re-derived counts", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  const reqVerified = requirement(pl10.id, { requirement_ref: "REQ-100" });
  const acVerified = ac(pl10.id, reqVerified.id);
  const reqFailure = requirement(pl10.id, { requirement_ref: "REQ-200" });
  const acFailure = ac(pl10.id, reqFailure.id);
  data.requirements = [reqVerified, reqFailure];
  data.acceptance_criteria = [acVerified, acFailure];
  const tPass = testCase(pl10.id, "TST-100", "Passed");
  const tFail = testCase(pl10.id, "TST-200", "Failed");
  data.test_cases = [tPass, tFail];
  data.artefact_links = [
    link(pl10.id, "acceptance_criteria", acVerified.id, "test_cases", tPass.id),
    link(pl10.id, "acceptance_criteria", acFailure.id, "test_cases", tFail.id),
  ];

  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.text, /Verified:?\s*1/i);
  assert.match(content.text, /Test Failure:?\s*1/i);
  assert.match(content.text, /Testing Blocked:?\s*0/i);
  assert.match(content.text, /No Tests Linked:?\s*0/i);
});

run("structural: buildTestStatusEmail imports/uses the canonical test-verification module, never re-deriving requirement verification itself", () => {
  const source = fs.readFileSync(path.join(root, "lib/email-content.ts"), "utf8");
  assert.match(source, /computeTestVerification/, "must call the canonical computeTestVerification");
  assert.match(source, /summarizeVerificationStates/, "must call the canonical summarizeVerificationStates");
});

// ── 5. Linked Requirement/AC references resolve correctly ──────────────────

run("a failed test's row shows its linked requirement ref/title and AC ref/title", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  const req = requirement(pl10.id, { requirement_ref: "REQ-777", title: "Replenishment cutoff" });
  const acRow = ac(pl10.id, req.id, { ac_ref: "AC-777", criterion: "Cutoff time is enforced" });
  data.requirements = [req];
  data.acceptance_criteria = [acRow];
  const tFail = testCase(pl10.id, "TST-777", "Failed", { scenario: "Cutoff enforcement scenario" });
  data.test_cases = [tFail];
  data.artefact_links = [link(pl10.id, "acceptance_criteria", acRow.id, "test_cases", tFail.id)];

  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.text, /REQ-777/);
  assert.match(content.text, /Replenishment cutoff/);
  assert.match(content.text, /AC-777/);
  assert.match(content.text, /Cutoff time is enforced/);
});

run("a test with no linked requirement/AC shows a placeholder, never invented trace information", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  data.test_cases = [testCase(pl10.id, "TST-900", "Failed", { scenario: "Orphan test" })];

  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.text, /TST-900/);
  assert.match(content.text, /Orphan test[\s\S]{0,80}—/, "an untraceable test must show an em-dash / placeholder, not fabricated requirement info");
});

// ── 6. Duplicate artefact links do not duplicate a test ─────────────────────

run("a test with two duplicate artefact_links rows to the same AC appears exactly once in Full Test Status", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  const req = requirement(pl10.id);
  const acRow = ac(pl10.id, req.id);
  data.requirements = [req];
  data.acceptance_criteria = [acRow];
  const t = testCase(pl10.id, "TST-DUP", "Passed");
  data.test_cases = [t];
  data.artefact_links = [
    link(pl10.id, "acceptance_criteria", acRow.id, "test_cases", t.id),
    link(pl10.id, "acceptance_criteria", acRow.id, "test_cases", t.id),
  ];

  const content = buildTestStatusEmail(data, pl10, now);
  // Anchored to the start of a table row ("<ref> — ...") rather than a raw
  // substring count — the scenario text itself legitimately contains the
  // ref again ("Scenario for TST-DUP"), which a plain substring count would
  // misreport as a duplicate row.
  const rowOccurrences = content.text.match(/^TST-DUP —/gm) ?? [];
  assert.equal(rowOccurrences.length, 1, "a duplicated link must not cause the test to be listed twice");
});

// ── 7. Zero tests ─────────────────────────────────────────────────────────

run("a project with zero test cases produces a graceful empty report, not a crash", () => {
  const pl10 = project("pl10", { name: "Empty Project" });
  const data = baseDataStore();
  data.projects = [pl10];

  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.subject, /Empty Project|PL10/i);
  assert.match(content.text, /Total:?\s*0/i);
  assert.match(content.text, /no test cases/i);
});

// ── 8. No Failed/Blocked tests -> concise positive statement ────────────────

run("with no Failed or Blocked tests, the Exceptions & Attention section shows a concise positive statement, not an empty section", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  data.test_cases = [testCase(pl10.id, "TST-1", "Passed"), testCase(pl10.id, "TST-2", "Pending")];

  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.text, /no failed or blocked tests/i);
  assert.doesNotMatch(content.html + content.text, /all (executed )?tests are passing/i, "must not claim everything is passing while Pending tests exist");
});

// ── 9. Failed/Blocked prominence ────────────────────────────────────────────

run("Exceptions & Attention section appears before the Full Test Status section (both html and text)", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  data.test_cases = [testCase(pl10.id, "TST-1", "Passed"), testCase(pl10.id, "TST-2", "Failed")];

  const content = buildTestStatusEmail(data, pl10, now);
  const textExcIdx = content.text.search(/Exceptions & Attention/i);
  const textFullIdx = content.text.search(/Full Test Status/i);
  assert.ok(textExcIdx >= 0 && textFullIdx >= 0 && textExcIdx < textFullIdx, "Exceptions & Attention must appear before Full Test Status in the text version");

  // The HTML section title is HTML-escaped ("Exceptions &amp; Attention"),
  // so match on "Exceptions" alone rather than the literal "&".
  const htmlExcIdx = content.html.search(/Exceptions/i);
  const htmlFullIdx = content.html.search(/Full Test Status/i);
  assert.ok(htmlExcIdx >= 0 && htmlFullIdx >= 0 && htmlExcIdx < htmlFullIdx, "Exceptions & Attention must appear before Full Test Status in the html version");
  assert.doesNotMatch(content.html + content.text, /Failures &(amp;)? Blockers/, "the old section name must be gone");
});

// ── Subject / header ─────────────────────────────────────────────────────────

run("subject follows [<project_ref>] Test Status - <date>, falling back to project name when project_ref is null", () => {
  const pl10 = project("pl10", { project_ref: "PL10" });
  const data = baseDataStore();
  data.projects = [pl10];
  const content = buildTestStatusEmail(data, pl10, now);
  assert.match(content.subject, /^\[PL10\] Test Status - /);

  const noRef = project("no-ref", { project_ref: null, name: "No Ref Project" });
  const data2 = baseDataStore();
  data2.projects = [noRef];
  const content2 = buildTestStatusEmail(data2, noRef, now);
  assert.match(content2.subject, /^\[No Ref Project\] Test Status - /);
});

run("header shows customer only when present, and never crashes when absent", () => {
  const withCustomer = project("with-cust", { customer: "Acme Ltd" });
  const data = baseDataStore();
  data.projects = [withCustomer];
  const content = buildTestStatusEmail(data, withCustomer, now);
  assert.match(content.html, /Acme Ltd/);

  const noCustomer = project("no-cust", { customer: "" });
  const data2 = baseDataStore();
  data2.projects = [noCustomer];
  assert.doesNotThrow(() => buildTestStatusEmail(data2, noCustomer, now));
});

// ── Full Test Status excludes large content ─────────────────────────────────

run("Full Test Status does not include expected_result/actual_result content (kept concise); the recorded result lives only in the print appendix", () => {
  const pl10 = project("pl10");
  const data = baseDataStore();
  data.projects = [pl10];
  data.test_cases = [testCase(pl10.id, "TST-1", "Passed", { expected_result: "SHOULD_NOT_APPEAR_IN_EMAIL", actual_result: "ALSO_SHOULD_NOT_APPEAR" })];
  const content = buildTestStatusEmail(data, pl10, now);
  assert.doesNotMatch(content.html + content.text, /SHOULD_NOT_APPEAR_IN_EMAIL/);
  assert.doesNotMatch(content.html + content.text, /ALSO_SHOULD_NOT_APPEAR/, "the emailed report never carries recorded results");
  const print = buildTestStatusEmail(data, pl10, now, { includeProcedures: true });
  const mainHtml = print.html.slice(0, print.html.indexOf("Detailed Test Procedures"));
  assert.doesNotMatch(mainHtml, /ALSO_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(print.html, /SHOULD_NOT_APPEAR_IN_EMAIL/, "expected_result is never printed anywhere in the report");
  const appendixHtml = print.html.slice(print.html.indexOf("Detailed Test Procedures"));
  assert.match(appendixHtml, /ALSO_SHOULD_NOT_APPEAR/, "the print appendix shows the recorded result for evidence/history");
});

console.log("\nAll Test Status email tests passed.\n");
