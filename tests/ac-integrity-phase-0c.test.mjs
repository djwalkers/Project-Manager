// Phase 0C — Acceptance Criteria integrity (migration 033) and the UI/data
// paths around it. The live database behaviour (orphan refusal, same-project
// FK, delete restriction, link-cleanup trigger, project cascade, Viewer
// read-only, the seven CR 28 orphans untouched) was validated in rolled-back
// transactions before and after applying 033; these tests pin the migration
// and exercise the real client-side rules.
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

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
const req = Module.createRequire(import.meta.url);
const clientModule = req("../lib/supabase/client.ts");
const dataStore = req("../lib/supabase/data-store.ts");
const { modules } = req("../lib/modules.ts");
const refs = req("../lib/reference-fields.ts");
const links = req("../lib/artefact-links.ts");
const { scopeProjectData } = req("../lib/project-scope.ts");
const { computeTestVerification } = req("../lib/lifecycle/test-verification.ts");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const m033 = code(read("supabase/migrations/033_acceptance_criteria_integrity.sql"));
const acConfig = modules.find((m) => m.key === "acceptance_criteria");
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

// ── Migration 033 ───────────────────────────────────────────────────────────

await run("033: new orphan ACs are refused (CHECK NOT VALID) while existing rows are left untouched", () => {
  assert.match(m033, /ADD CONSTRAINT acceptance_criteria_requirement_required\s+CHECK \(requirement_id IS NOT NULL\) NOT VALID;/);
  assert.doesNotMatch(m033, /VALIDATE CONSTRAINT/, "validation waits until the CR 28 orphans are repaired");
  assert.doesNotMatch(m033, /\b(UPDATE|DELETE FROM|INSERT INTO) public\.(acceptance_criteria|requirements)\b/, "no existing data is changed");
});

await run("033: same-project composite FK replaces the cascading FK; project_id NOT NULL", () => {
  assert.match(m033, /ADD CONSTRAINT requirements_id_project_id_key UNIQUE \(id, project_id\);/);
  assert.match(m033, /ALTER TABLE public\.acceptance_criteria ALTER COLUMN project_id SET NOT NULL;/);
  assert.match(m033, /DROP CONSTRAINT acceptance_criteria_requirement_id_fkey;/);
  assert.match(m033, /FOREIGN KEY \(requirement_id, project_id\)\s+REFERENCES public\.requirements \(id, project_id\)\s+ON UPDATE NO ACTION\s+ON DELETE NO ACTION;/);
});

await run("033: requirement delete is blocked by ACs and by sign-offs (no cascade); evidence cascade unchanged", () => {
  assert.match(m033, /DROP CONSTRAINT requirement_sign_offs_requirement_id_fkey;[\s\S]*FOREIGN KEY \(requirement_id\)\s+REFERENCES public\.requirements \(id\)\s+ON DELETE NO ACTION;/);
  assert.doesNotMatch(m033, /ON DELETE CASCADE/);
  assert.doesNotMatch(m033, /\bevidence\b/, "evidence.ac_id ON DELETE CASCADE is not touched");
  assert.doesNotMatch(m033, /POLICY/, "RLS (Viewer read-only) is unchanged");
});

await run("033: a delete trigger removes links pointing at a deleted Requirement/AC in the same transaction", () => {
  const fn = m033.slice(m033.indexOf("FUNCTION public.delete_artefact_links_for_deleted_row()"), m033.indexOf("$$;", m033.indexOf("FUNCTION public.delete_artefact_links_for_deleted_row()")));
  assert.match(fn, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(fn, /DELETE FROM public\.artefact_links l\s+WHERE \(l\.source_entity = TG_TABLE_NAME AND l\.source_id = OLD\.id\)\s+OR \(l\.target_entity = TG_TABLE_NAME AND l\.target_id = OLD\.id\);/);
  assert.match(m033, /CREATE TRIGGER requirements_delete_links\s+AFTER DELETE ON public\.requirements\s+FOR EACH ROW/);
  assert.match(m033, /CREATE TRIGGER acceptance_criteria_delete_links\s+AFTER DELETE ON public\.acceptance_criteria\s+FOR EACH ROW/);
  assert.equal(req("../lib/schema.ts").latestMigration, "033_acceptance_criteria_integrity");
});

// ── Requirement picker (existing generic AC form) ───────────────────────────

const store = {
  projects: [{ id: P1, name: "One" }, { id: P2, name: "Two" }],
  requirements: [
    { id: "r1", project_id: P1, requirement_ref: "REQ-002", title: "Second" },
    { id: "r0", project_id: P1, requirement_ref: "REQ-001", title: "First" },
    { id: "rx", project_id: P2, requirement_ref: "REQ-900", title: "Other project" },
  ],
};
const scoped = scopeProjectData({ ...Object.fromEntries(Object.keys(req("../lib/seed-data.ts").seedData).map((k) => [k, []])), ...store }, store.projects[0]);
const options = refs.buildReferenceOptions(acConfig, scoped);

await run("AC form: Requirement is a required, lockable reference to requirements", () => {
  const field = acConfig.fields.find((f) => f.key === "requirement_id");
  assert.deepEqual({ type: field.type, references: field.references, required: field.required, lockWhenSet: field.lockWhenSet }, { type: "reference", references: "requirements", required: true, lockWhenSet: true });
  assert.equal(acConfig.fields[0].key, "requirement_id");
});

await run("picker offers only the current project's requirements, in ref order", () => {
  assert.deepEqual(options.requirement_id, [{ value: "r0", label: "REQ-001 — First" }, { value: "r1", label: "REQ-002 — Second" }]);
});

await run("creating an AC without a Requirement is refused with a clear message", () => {
  assert.equal(refs.referenceFieldError(acConfig, { criterion: "x" }, null, options), "Select the requirement this acceptance criterion belongs to.");
});

await run("a Requirement from another project (or a nonexistent one) is refused", () => {
  assert.match(refs.referenceFieldError(acConfig, { requirement_id: "rx" }, null, options), /not in the current project/);
  assert.match(refs.referenceFieldError(acConfig, { requirement_id: "missing" }, null, options), /not in the current project/);
});

await run("a valid new AC passes", () => {
  assert.equal(refs.referenceFieldError(acConfig, { requirement_id: "r1", criterion: "x" }, null, options), null);
});

await run("an existing linked AC is locked — no general reassignment", () => {
  const linked = { id: "ac1", requirement_id: "r1" };
  const field = acConfig.fields.find((f) => f.key === "requirement_id");
  assert.equal(refs.isReferenceLocked(field, linked), true);
  assert.equal(refs.referenceFieldError(acConfig, { ...linked, requirement_id: "r0" }, linked, options), null, "locked field is not validated or offered");
  const form = read("components/form-dialog.tsx");
  assert.match(form, /isLocked\(field\) \? \(\n\s+<p[^>]*>\n\s+\{referenceOptions\?\.\[field\.key\]\?\.find/, "locked reference renders read-only, not a select");
});

await run("an existing orphan AC shows the picker and can be repaired with a same-project Requirement", () => {
  const orphan = { id: "ac7", requirement_id: null, project_id: P1 };
  const field = acConfig.fields.find((f) => f.key === "requirement_id");
  assert.equal(refs.isReferenceLocked(field, orphan), false);
  assert.match(refs.referenceFieldError(acConfig, orphan, orphan, options), /Select the requirement/);
  assert.equal(refs.referenceFieldError(acConfig, { ...orphan, requirement_id: "r0" }, orphan, options), null);
  assert.match(refs.referenceFieldError(acConfig, { ...orphan, requirement_id: "rx" }, orphan, options), /not in the current project/);
});

await run("the form dialog and data table use the shared rules (no second AC creation mechanism)", () => {
  const form = read("components/form-dialog.tsx");
  assert.match(form, /const refProblem = referenceFieldError\(config, form, record, referenceOptions\);\n\s+if \(refProblem\) \{ setError\(refProblem\); return; \}/);
  const table = read("components/data-table.tsx");
  assert.match(table, /buildReferenceOptions\(config, data as unknown as Record<string, unknown>\)/);
  assert.match(table, /referenceOptions=\{referenceOptions\}/);
  assert.match(read("components/app-client.tsx"), /<DataTable\n\s+config=\{config\}\n\s+data=\{pageData\}/, "table data is the project-scoped pageData");
  assert.match(read("components/acceptance-criteria-panel.tsx"), /project_id: projectId, requirement_id: requirementId, ac_ref: acRef/, "requirement-panel path unchanged");
});

// ── Clear database errors; no false delete ───────────────────────────────────

function failingClient(error, op) {
  return { from() {
    const b = { op: "select", select() { return b; }, eq() { return b; },
      insert() { b.op = "insert"; return b; }, update() { b.op = "update"; return b; }, delete() { b.op = "delete"; return b; },
      single: async () => (b.op === "insert" ? { data: null, error } : { data: { id: "r1", requirement_ref: "REQ-1", title: "T", project_id: P1 }, error: null }),
      then(resolve) { return Promise.resolve(b.op === op ? { data: null, error } : { data: [], error: null }).then(resolve); } };
    return b;
  } };
}
const audits = [];
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
globalThis.fetch = async (url, init) => { audits.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };

await run("deleting a Requirement that has ACs fails with a clear message and records no Delete audit", async () => {
  clientModule.supabase = failingClient({ code: "23503", message: 'update or delete on table "requirements" violates foreign key constraint "acceptance_criteria_requirement_same_project_fkey" on table "acceptance_criteria"' }, "delete");
  await assert.rejects(dataStore.deleteRecord("requirements", "r1"), /still has acceptance criteria\. Delete those acceptance criteria first/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audits.length, 0);
});

await run("deleting a Requirement with sign-offs fails with a clear message and records no Delete audit", async () => {
  clientModule.supabase = failingClient({ code: "23503", message: 'update or delete on table "requirements" violates foreign key constraint "requirement_sign_offs_requirement_id_fkey" on table "requirement_sign_offs"' }, "delete");
  await assert.rejects(dataStore.deleteRecord("requirements", "r1"), /has recorded sign-offs\. Formal sign-off history is kept/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audits.length, 0);
});

await run("database refusals on AC create read clearly (orphan / cross-project)", async () => {
  clientModule.supabase = failingClient({ code: "23514", message: 'new row for relation "acceptance_criteria" violates check constraint "acceptance_criteria_requirement_required"' }, "insert");
  await assert.rejects(dataStore.createRecord("acceptance_criteria", { criterion: "x" }), /must belong to a requirement/);
  clientModule.supabase = failingClient({ code: "23503", message: 'insert or update on table "acceptance_criteria" violates foreign key constraint "acceptance_criteria_requirement_same_project_fkey"' }, "insert");
  await assert.rejects(dataStore.createRecord("acceptance_criteria", { criterion: "x" }), /does not exist in this project/);
});

// ── In-memory traceability after a successful delete ────────────────────────

await run("withEntityLinksRemoved drops only the deleted entity's links (both directions) and never mutates input", () => {
  const data = { artefact_links: [
    { id: "l1", source_entity: "acceptance_criteria", source_id: "ac1", target_entity: "test_cases", target_id: "t1" },
    { id: "l2", source_entity: "test_cases", source_id: "t1", target_entity: "acceptance_criteria", target_id: "ac1" },
    { id: "l3", source_entity: "acceptance_criteria", source_id: "ac2", target_entity: "test_cases", target_id: "t1" },
    { id: "l4", source_entity: "requirements", source_id: "ac1", target_entity: "test_cases", target_id: "t1" },
  ] };
  const next = links.withEntityLinksRemoved(data, "acceptance_criteria", ["ac1"]);
  assert.deepEqual(next.artefact_links.map((l) => l.id), ["l3", "l4"], "entity type matters, not just the id");
  assert.equal(data.artefact_links.length, 4);
  assert.equal(links.withEntityLinksRemoved(data, "acceptance_criteria", []), data);
});

await run("after an AC delete, verification recomputes from canonical data with no dangling links (calculation unchanged)", () => {
  let data = {
    requirements: [{ id: "r1", project_id: P1, requirement_ref: "REQ-1" }],
    acceptance_criteria: [{ id: "ac1", project_id: P1, requirement_id: "r1", ac_ref: "AC-1" }],
    test_cases: [{ id: "t1", project_id: P1, test_ref: "TST-1", scenario: "s", status: "Passed" }],
    artefact_links: [{ id: "l1", project_id: P1, source_entity: "acceptance_criteria", source_id: "ac1", target_entity: "test_cases", target_id: "t1" }],
  };
  assert.equal(computeTestVerification(data).byRequirement.r1.state, "Verified");
  data = links.withEntityLinksRemoved({ ...data, acceptance_criteria: [] }, "acceptance_criteria", ["ac1"]);
  assert.equal(data.artefact_links.length, 0);
  assert.equal(computeTestVerification(data).byRequirement.r1.state, "No Tests Linked");
});

await run("delete paths mirror the database only after the delete succeeded (links + the AC's own evidence)", () => {
  const app = read("components/app-client.tsx");
  assert.match(app, /await deleteRecord\(config\.key, String\(record\.id\)\);\n\s+const id = String\(record\.id\);\n\s+setData\(\(current\) => \{[\s\S]*?withEntityLinksRemoved\(next, config\.key, \[id\]\)[\s\S]*?next\.evidence\.filter\(\(e\) => e\.ac_id !== id\)/);
  assert.match(app, /const removedIds = existing\.filter\(\(ac\) => ac\.requirement_id === recordId && !existingIds\.has\(ac\.id\)\)[\s\S]*?withEntityLinksRemoved\(next, "acceptance_criteria", removedIds\)/);
  assert.match(read("components/acceptance-criteria-panel.tsx"), /await deleteRecord\("acceptance_criteria", id\);\n\s+onUpdate\(/);
});

console.log("\nAll Phase 0C acceptance-criteria integrity tests passed.\n");
