// Phase 1 — equivalence tests for the new lib/lifecycle/* modules.
// These modules are pure wrappers around predicates that already exist,
// scattered, across the codebase. Each test below proves the new helper
// agrees with the exact raw predicate it is meant to replace, and that
// unknown/unrecognised status values always default to "open"/"incomplete",
// never silently to "done" — mirroring lib/lifecycle/decision.ts's existing
// philosophy. No consumer imports these modules yet.
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
const lifecycle = req("../lib/lifecycle/index.ts");
const { isOverdue } = req("../lib/utils.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// ── Risk ─────────────────────────────────────────────────────────────────────
run("isRiskOpen/isRiskClosed match the raw !['Complete','Closed'].includes(status) predicate used across the codebase", () => {
  const closedRaw = (status) => !["Complete", "Closed"].includes(status);
  for (const status of ["Open", "In Progress", "Blocked", "Complete", "Closed", "Discovery"]) {
    assert.equal(lifecycle.isRiskOpen(status), closedRaw(status), `mismatch for ${status}`);
  }
});
run("isRiskOpen defaults unknown/legacy statuses to open, never silently closed", () => {
  assert.equal(lifecycle.isRiskOpen("Some Future Status"), true);
  assert.equal(lifecycle.isRiskOpen(null), true);
  assert.equal(lifecycle.isRiskOpen(undefined), true);
});
run("isRiskHighOrCritical matches ['High','Critical'].includes(impact)", () => {
  assert.equal(lifecycle.isRiskHighOrCritical("Critical"), true);
  assert.equal(lifecycle.isRiskHighOrCritical("High"), true);
  assert.equal(lifecycle.isRiskHighOrCritical("Medium"), false);
  assert.equal(lifecycle.isRiskHighOrCritical("Low"), false);
});
run("isRiskUnmitigated matches !risk.mitigation?.trim()", () => {
  assert.equal(lifecycle.isRiskUnmitigated({ mitigation: "" }), true);
  assert.equal(lifecycle.isRiskUnmitigated({ mitigation: "   " }), true);
  assert.equal(lifecycle.isRiskUnmitigated({ mitigation: null }), true);
  assert.equal(lifecycle.isRiskUnmitigated({ mitigation: "Load tested" }), false);
});

// ── Action ───────────────────────────────────────────────────────────────────
run("isActionOverdue is the exact same function as lib/utils.ts's isOverdue (re-exported, not reimplemented)", () => {
  assert.equal(lifecycle.isActionOverdue, isOverdue);
});
run("isActionOpen/isActionClosed agree with isOverdue's own closed-status list (Complete/Approved/Closed)", () => {
  for (const status of ["Complete", "Approved", "Closed", "Open", "In Progress", "Blocked"]) {
    const treatedAsResolvedByIsOverdue = !isOverdue("2020-01-01", status);
    // isOverdue also returns false for a null/undefined date regardless of status,
    // so compare against status-based closedness directly instead.
    const closedByStatusList = ["Complete", "Approved", "Closed"].includes(status);
    assert.equal(lifecycle.isActionClosed(status), closedByStatusList, `mismatch for ${status}`);
    assert.equal(treatedAsResolvedByIsOverdue, closedByStatusList, `isOverdue disagreement for ${status}`);
  }
});
run("isActionBlocked matches status === 'Blocked'", () => {
  assert.equal(lifecycle.isActionBlocked("Blocked"), true);
  assert.equal(lifecycle.isActionBlocked("Open"), false);
});

// ── Requirement ──────────────────────────────────────────────────────────────
run("isRequirementSignedOff matches ['Approved','Complete','Closed'].includes(status), duplicated today in recommendations.ts and project-intelligence.ts", () => {
  const rawSignedOff = (status) => ["Approved", "Complete", "Closed"].includes(status);
  for (const status of ["Approved", "Complete", "Closed", "Open", "In Progress", "Discovery"]) {
    assert.equal(lifecycle.isRequirementSignedOff(status), rawSignedOff(status), `mismatch for ${status}`);
    assert.equal(lifecycle.isRequirementOpen(status), !rawSignedOff(status));
  }
});
run("isRequirementOpen defaults unknown statuses to open (not signed off)", () => {
  assert.equal(lifecycle.isRequirementOpen("Some Future Status"), true);
});

// ── Dependency ───────────────────────────────────────────────────────────────
run("isDependencyOpen/isDependencyClosed match !['Complete','Closed'].includes(status)", () => {
  for (const status of ["Open", "Complete", "Closed", "Blocked"]) {
    assert.equal(lifecycle.isDependencyOpen(status), !["Complete", "Closed"].includes(status));
  }
});
run("isDependencyBlocked matches status === 'Blocked'", () => {
  assert.equal(lifecycle.isDependencyBlocked("Blocked"), true);
  assert.equal(lifecycle.isDependencyBlocked("Open"), false);
});

// ── Test cases ───────────────────────────────────────────────────────────────
run("isTestPassed matches status === 'Passed'", () => {
  assert.equal(lifecycle.isTestPassed("Passed"), true);
  assert.equal(lifecycle.isTestPassed("Failed"), false);
});
run("isTestOpen treats Pending/In Progress/Blocked as open and only Passed/Failed as closed", () => {
  assert.equal(lifecycle.isTestOpen("Pending"), true);
  assert.equal(lifecycle.isTestOpen("In Progress"), true);
  assert.equal(lifecycle.isTestOpen("Blocked"), true);
  assert.equal(lifecycle.isTestOpen("Passed"), false);
  assert.equal(lifecycle.isTestOpen("Failed"), false);
});
run("isTestFailedOrBlocked matches ['Failed','Blocked'].includes(status), the predicate used in recommendations.ts's testing candidates", () => {
  assert.equal(lifecycle.isTestFailedOrBlocked("Failed"), true);
  assert.equal(lifecycle.isTestFailedOrBlocked("Blocked"), true);
  assert.equal(lifecycle.isTestFailedOrBlocked("Passed"), false);
  assert.equal(lifecycle.isTestFailedOrBlocked("Pending"), false);
});

// ── Acceptance criteria ──────────────────────────────────────────────────────
run("isAcceptanceCriteriaMet matches ['Met','Waived'].includes(status), duplicated today in 8+ places", () => {
  const rawMet = (status) => ["Met", "Waived"].includes(status);
  for (const status of ["Met", "Waived", "Not Started", "In Progress", "Failed"]) {
    assert.equal(lifecycle.isAcceptanceCriteriaMet(status), rawMet(status), `mismatch for ${status}`);
    assert.equal(lifecycle.isAcceptanceCriteriaOutstanding(status), !rawMet(status));
  }
});
run("isAcceptanceCriteriaMet defaults unknown statuses to not-met (outstanding), never silently met", () => {
  assert.equal(lifecycle.isAcceptanceCriteriaMet("Some Future Status"), false);
  assert.equal(lifecycle.isAcceptanceCriteriaOutstanding("Some Future Status"), true);
});
run("isAcceptanceCriteriaFailed matches status === 'Failed'", () => {
  assert.equal(lifecycle.isAcceptanceCriteriaFailed("Failed"), true);
  assert.equal(lifecycle.isAcceptanceCriteriaFailed("Met"), false);
});

// ── Deliverable ──────────────────────────────────────────────────────────────
run("isDeliverableComplete/isDevelopmentComplete/isSitComplete/isUatComplete are re-exported verbatim from lib/delivery.ts, not reimplemented", () => {
  const delivery = req("../lib/delivery.ts");
  assert.equal(lifecycle.isDeliverableComplete, delivery.isDeliverableComplete);
  assert.equal(lifecycle.isDevelopmentComplete, delivery.isDevelopmentComplete);
  assert.equal(lifecycle.isSitComplete, delivery.isSitComplete);
  assert.equal(lifecycle.isUatComplete, delivery.isUatComplete);
});
run("isDeliverableBlocked matches the status==='Blocked' OR any sub-lane==='Blocked' pattern duplicated in project-intelligence.ts/recommendations.ts/manager-summary.ts/control-tower.ts", () => {
  const raw = (item) =>
    item.status === "Blocked" ||
    [item.development_status, item.sit_status, item.uat_status, item.deployment_status].includes("Blocked");

  const cases = [
    { status: "Blocked", development_status: "Complete", sit_status: "Not Started", uat_status: "Not Started", deployment_status: "Not Started" },
    { status: "Ready for UAT", development_status: "Complete", sit_status: "Passed", uat_status: "Blocked", deployment_status: "Not Started" },
    { status: "Ready for UAT", development_status: "Complete", sit_status: "Passed", uat_status: "In Progress", deployment_status: "Not Started" },
  ];
  for (const item of cases) {
    assert.equal(lifecycle.isDeliverableBlocked(item), raw(item), `mismatch for ${JSON.stringify(item)}`);
  }
});
run("isDeliverableBlocked is defensive against untyped/typo'd sub-status strings — never throws, never silently matches", () => {
  const item = { status: "Ready for UAT", development_status: "compelte", sit_status: "Passed", uat_status: "In Progress", deployment_status: "Not Started" };
  assert.equal(lifecycle.isDeliverableBlocked(item), false);
});

console.log("\nAll Phase 1 lifecycle-module equivalence tests passed.\n");
