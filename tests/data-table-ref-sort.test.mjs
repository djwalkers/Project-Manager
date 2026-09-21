// Test Cases (and every other ref-bearing module) were displayed in
// whatever order the Supabase query happened to return rows in —
// effectively created_at/insertion order, not Ref order. PL10's 35 F20
// test cases surfaced this directly: TST-001..TST-034b appeared scrambled
// on the Testing page.
//
// Root cause: components/data-table.tsx never sorted `rows` at all — it
// rendered data[config.key] exactly as received. There was no column-sort
// control to preserve either (none existed).
//
// Fix: DataTable now defaults to Ref ascending, using a natural/
// alphanumeric comparator (Intl.Collator with numeric:true) rather than
// plain string comparison, so "TST-9" sorts before "TST-10" and "TST-034"
// before "TST-034a" before "TST-034b" regardless of zero-padding. The ref
// field is discovered generically from the module's own config (the field
// with `refPrefix` set in lib/modules.ts) — no module- or project-specific
// logic — so every ref-bearing module (Deliverables, Requirements,
// Acceptance Criteria, Risks, Decisions, Discovery Questions, Actions,
// Milestones, Timeline, Test Cases) gets the same fix for free through the
// one shared DataTable component.
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
const { sortRowsByRef } = req("../lib/ref-sort.ts");
const { moduleByKey } = req("../lib/modules.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function testCase(ref) {
  return { id: `id-${ref}`, project_id: "pl10", test_ref: ref, scenario: "s", status: "Pending" };
}

// ── PL10's actual F20 test-pack ordering ────────────────────────────────

run("Test Cases: 35 refs (TST-001..TST-034a/034b) sort to exact Ref ascending order", () => {
  const refs = [
    ...Array.from({ length: 33 }, (_, i) => `TST-${String(i + 1).padStart(3, "0")}`), // TST-001..TST-033
    "TST-034a", "TST-034b",
  ];
  const shuffled = [...refs].reverse(); // worst case: fully reversed input
  const rows = shuffled.map(testCase);
  const config = moduleByKey.get("test_cases");
  const sorted = sortRowsByRef(rows, config).map((r) => r.test_ref);
  assert.deepEqual(sorted, refs, "must recover exact TST-001..TST-034a,TST-034b order regardless of input order");
});

// ── Natural/alphanumeric ordering, not naive string ordering ───────────

run("natural sort: unpadded numeric refs order numerically (TST-9 before TST-10), not lexicographically", () => {
  const rows = ["TST-10", "TST-2", "TST-1", "TST-9"].map(testCase);
  const config = moduleByKey.get("test_cases");
  const sorted = sortRowsByRef(rows, config).map((r) => r.test_ref);
  assert.deepEqual(sorted, ["TST-1", "TST-2", "TST-9", "TST-10"], "naive string sort would wrongly produce TST-1, TST-10, TST-2, TST-9");
});

run("natural sort: a bare ref sorts before its lettered suffixes (TST-034 < TST-034a < TST-034b)", () => {
  const rows = ["TST-034b", "TST-034", "TST-034a"].map(testCase);
  const config = moduleByKey.get("test_cases");
  const sorted = sortRowsByRef(rows, config).map((r) => r.test_ref);
  assert.deepEqual(sorted, ["TST-034", "TST-034a", "TST-034b"]);
});

// ── Generic — no module- or project-specific logic ──────────────────────

run("the ref field is discovered generically from config.fields' refPrefix, not hardcoded to test_cases", () => {
  const source = fs.readFileSync(path.join(root, "lib/ref-sort.ts"), "utf8");
  const start = source.indexOf("export function sortRowsByRef");
  const body = source.slice(start);
  assert.doesNotMatch(body, /test_ref/, "sortRowsByRef's implementation must not name test_cases' field specifically");
  assert.match(body, /field\.refPrefix/, "the ref field must be discovered from config.fields' refPrefix metadata");
});

run("Milestones (a different ref-bearing module) also default to Ref ascending, with zero special-casing", () => {
  const rows = ["MIL-006", "MIL-001", "MIL-003", "MIL-002", "MIL-005", "MIL-004"].map((ref) => ({
    id: `id-${ref}`, project_id: "pl10", milestone_ref: ref, title: "m", status: "Not Started",
  }));
  const config = moduleByKey.get("milestones");
  const sorted = sortRowsByRef(rows, config).map((r) => r.milestone_ref);
  assert.deepEqual(sorted, ["MIL-001", "MIL-002", "MIL-003", "MIL-004", "MIL-005", "MIL-006"]);
});

run("a module with no ref field (Dependencies) is returned unchanged, in its original order", () => {
  const rows = [{ id: "c", name: "Zebra dependency" }, { id: "a", name: "Alpha dependency" }];
  const config = moduleByKey.get("dependencies");
  const sorted = sortRowsByRef(rows, config);
  assert.deepEqual(sorted, rows, "no ref field exists on dependencies — order must pass through unsorted");
});

run("sortRowsByRef does not mutate its input array", () => {
  const rows = ["TST-002", "TST-001"].map(testCase);
  const original = [...rows];
  sortRowsByRef(rows, moduleByKey.get("test_cases"));
  assert.deepEqual(rows, original, "the original array/order passed in must be untouched");
});

// ── Structural: DataTable actually applies this as the default row order ──

run("structural: DataTable derives its row order via sortRowsByRef, not the raw unsorted DataStore array", () => {
  const source = fs.readFileSync(path.join(root, "components/data-table.tsx"), "utf8");
  assert.match(source, /import \{ sortRowsByRef \} from "@\/lib\/ref-sort";/, "DataTable must import the shared sortRowsByRef helper");
  assert.match(source, /const rows = useMemo\(\(\) => sortRowsByRef\(data\[config\.key\] as Row\[\], config\), \[data, config\]\);/, "rows must be derived via sortRowsByRef");
});
