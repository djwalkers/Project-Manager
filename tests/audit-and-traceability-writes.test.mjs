// Phase 0 foundation: Audit Trail and artefact_links write paths.
// Audit writes go through POST /api/audit (identity stamped server-side);
// traceability writes use the session-aware browser client and a removal is
// only reported as done when a row was really deleted.
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

// Env must be set before lib/supabase/client.ts is loaded (they read it at import).
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
const req = Module.createRequire(import.meta.url);
const audit = req("../lib/audit.ts");
const { normaliseAuditEntries, MAX_AUDIT_ENTRIES_PER_REQUEST } = req("../lib/audit-entry.ts");
const clientModule = req("../lib/supabase/client.ts");
const links = req("../lib/artefact-links.ts");
const { computeTestVerification } = req("../lib/lifecycle/test-verification.ts");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const TABLES = new Set(["requirements", "test_cases", "projects", "risks"]);
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

await run("normaliseAuditEntries: valid entry kept; 'null'/invalid project_id → null; client identity never accepted", () => {
  const r = normaliseAuditEntries({ entries: [
    { entity_type: "requirements", entity_id: U1, entity_name: "REQ-1", action_type: "Status Change", project_id: U2, field_name: "status", old_value: "Open", new_value: "Approved", changed_by: U2, changed_by_name: "Forged" },
    { entity_type: "projects", entity_id: U1, entity_name: "P", action_type: "Create", project_id: "null" },
  ] }, TABLES);
  assert.equal(r.error, null);
  assert.equal(r.entries[0].project_id, U2);
  assert.equal(r.entries[1].project_id, null, "the historical 'null' string no longer breaks the insert");
  assert.ok(!("changed_by" in r.entries[0]) && !("changed_by_name" in r.entries[0]), "identity is stamped by the server only");
});

await run("normaliseAuditEntries rejects bad input", () => {
  const bad = (entries) => normaliseAuditEntries({ entries }, TABLES).error;
  assert.match(bad([]), /non-empty/);
  assert.match(bad([{ entity_type: "audit_log", entity_id: U1, action_type: "Create" }]), /auditable/);
  assert.match(bad([{ entity_type: "requirements", entity_id: "not-a-uuid", action_type: "Create" }]), /uuid/);
  assert.match(bad([{ entity_type: "requirements", entity_id: U1, action_type: "Hack" }]), /action_type/);
  assert.match(bad(Array.from({ length: MAX_AUDIT_ENTRIES_PER_REQUEST + 1 }, () => ({ entity_type: "requirements", entity_id: U1, action_type: "Create" }))), /at most/);
  assert.match(normaliseAuditEntries(null, TABLES).error, /non-empty/);
});

// Browser-like globals for the client helper.
const calls = [];
const events = [];
globalThis.window = { dispatchEvent: (e) => events.push(e) };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const errors = [];
const origError = console.error;

await run("logAuditEntries posts one batched request to /api/audit, without any client identity", async () => {
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ inserted: 2 }) }; };
  const ok = await audit.logAuditEntries([
    { table: "requirements", entityId: U1, entityName: "REQ-1", actionType: "Status Change", projectId: U2, fieldName: "status", oldValue: "Open", newValue: "Approved" },
    { table: "requirements", entityId: U1, entityName: "REQ-1", actionType: "Update", projectId: U2, fieldName: "title", oldValue: "a", newValue: "b" },
    { table: "go_live_checklists", entityId: U1, entityName: "x", actionType: "Update", projectId: U2 },
  ]);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/audit");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin", "the session cookie is sent");
  const sent = JSON.parse(calls[0].init.body).entries;
  assert.equal(sent.length, 2, "non-auditable tables are filtered out");
  assert.deepEqual(Object.keys(sent[0]).sort(), ["action_type", "entity_id", "entity_name", "entity_type", "field_name", "new_value", "old_value", "project_id"]);
});

await run("a failed audit write is reported (console.error + event), never silently dropped", async () => {
  console.error = (...a) => errors.push(a.join(" "));
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) });
    assert.equal(await audit.logAudit("risks", U1, "RSK-1", "Create", U2), false);
    globalThis.fetch = async () => { throw new Error("network down"); };
    assert.equal(await audit.logAudit("risks", U1, "RSK-1", "Create", U2), false);
  } finally { console.error = origError; }
  assert.ok(errors.some((e) => /Unauthorized/.test(e)) && errors.some((e) => /network down/.test(e)));
  assert.equal(events.filter((e) => e.type === audit.AUDIT_FAILED_EVENT).length, 2);
});

await run("logAudit keeps its call signature (existing callers unchanged)", () => {
  assert.equal(audit.logAudit.length, 8);
  assert.match(read("lib/supabase/data-store.ts"), /void logAuditEntries\(changes\.map/);
  assert.match(read("lib/supabase/data-store.ts"), /logAudit\(\n\s+table, String\(saved\.id\), getEntityName\(table, saved\),\n\s+"Create"/);
  assert.match(read("components/projects-portfolio-page.tsx"), /logAudit\("projects", created\.id/);
});

await run("route: authenticated only, identity from the session, service-role insert, project FK guarded", () => {
  const route = read("app/api/audit/route.ts");
  assert.match(route, /await requireCanWriteDeliveryData\(\)/, "Phase 0B1: Manager/Admin only");
  assert.match(route, /changed_by: changedBy,/);
  assert.match(route, /changed_by_name: changedByName,/);
  assert.doesNotMatch(route, /body\.changed_by|entries\[.*\]\.changed_by/);
  assert.match(route, /createServiceRoleClient\(\)/);
  assert.match(route, /from\("projects"\)\.select\("id"\)\.in\("id", projectIds\)/);
  assert.match(route, /from\("audit_log"\)\.insert\(rows\)/);
});

await run("migration 029 removes the client INSERT policy on audit_log only", () => {
  const sql = read("supabase/migrations/029_audit_log_server_insert_only.sql");
  assert.match(sql, /DROP POLICY IF EXISTS "audit_insert" ON audit_log;/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /CREATE POLICY|ALTER TABLE(?! audit_log)|artefact_links/);
});

// ── artefact_links ─────────────────────────────────────────────────────────

function fakeClient({ insertResult, deleteResult }) {
  const log = [];
  return { log, from(table) {
    return {
      insert(row) { log.push(["insert", table, row]); return { select: () => ({ single: async () => insertResult }) }; },
      delete() { return { eq(col, val) { log.push(["delete", table, col, val]); return { select: async () => deleteResult }; } }; },
    };
  } };
}

await run("artefact-links uses the session-aware browser client (not a standalone anon client)", () => {
  const src = read("lib/artefact-links.ts");
  assert.match(src, /import \{ supabase \} from "@\/lib\/supabase\/client";/);
  assert.doesNotMatch(src, /@supabase\/supabase-js|NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});

await run("addLink returns the saved link; on RLS/DB error it logs and returns null", async () => {
  const saved = { id: U1, project_id: U2, source_entity: "requirements", source_id: U1, target_entity: "test_cases", target_id: U2, created_at: "" };
  clientModule.supabase = fakeClient({ insertResult: { data: saved, error: null } });
  assert.deepEqual(await links.addLink({ project_id: U2, source_entity: "requirements", source_id: U1, target_entity: "test_cases", target_id: U2 }), saved);
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    clientModule.supabase = fakeClient({ insertResult: { data: null, error: { message: "new row violates row-level security policy" } } });
    assert.equal(await links.addLink({ project_id: U2, source_entity: "requirements", source_id: U1, target_entity: "test_cases", target_id: U2 }), null);
  } finally { console.error = origError; }
  assert.ok(logged.some((l) => /row-level security/.test(l)));
});

await run("removeLink resolves only when a row was deleted; 0 rows or an error throws", async () => {
  clientModule.supabase = fakeClient({ deleteResult: { data: [{ id: U1 }], error: null } });
  await links.removeLink(U1);
  clientModule.supabase = fakeClient({ deleteResult: { data: [], error: null } });
  await assert.rejects(links.removeLink(U1), /not deleted/, "the old silent RLS no-op is now surfaced");
  clientModule.supabase = fakeClient({ deleteResult: { data: null, error: { message: "boom" } } });
  await assert.rejects(links.removeLink(U1), /boom/);
  clientModule.supabase = null;
  await assert.rejects(links.removeLink(U1), /not available/);
});

await run("linker only drops a link from the list after a real delete, and shows the error otherwise", () => {
  const src = read("components/artefact-linker.tsx");
  const fn = src.slice(src.indexOf("async function handleRemove"), src.indexOf("{removeError &&"));
  assert.match(fn, /try \{\n\s+await removeLink\(linkId\);\n\s+onLinkRemoved\(linkId\);/);
  assert.match(fn, /catch \(e\) \{\n\s+setRemoveError/);
  assert.match(src, /\{removeError && <p[^>]*role="alert">\{removeError\}<\/p>\}/);
  assert.doesNotMatch(src, /LINKABLE_ENTITIES: string\[\] = \[[^\]]*documents/, "no Phase 1 entities added");
});

// ── Canonical in-memory state after a link write ────────────────────────────

await run("withLinkAdded / withLinkRemoved update the canonical DataStore and verification recomputes immediately", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const r = { id: "req-1", project_id: P, requirement_ref: "REQ-1" };
  const acRow = { id: "ac-1", project_id: P, requirement_id: r.id, ac_ref: "AC-1" };
  const t = { id: "tst-1", project_id: P, test_ref: "TST-1", scenario: "s", status: "Passed" };
  const link = (id, se, si, te, ti) => ({ id, project_id: P, source_entity: se, source_id: si, target_entity: te, target_id: ti });
  let data = { requirements: [r], acceptance_criteria: [acRow], test_cases: [t], artefact_links: [] };
  assert.equal(computeTestVerification(data).byRequirement[r.id].state, "No Tests Linked");

  const reqLink = link("lnk-1", "requirements", r.id, "test_cases", t.id);
  const before = data;
  data = links.withLinkAdded(data, reqLink);
  assert.notEqual(data, before, "a new DataStore object, so React re-renders");
  assert.equal(before.artefact_links.length, 0, "the previous DataStore is not mutated");
  assert.equal(computeTestVerification(data).byRequirement[r.id].state, "Verified", "requirement ↔ test link counts at once");

  const acLink = link("lnk-2", "acceptance_criteria", acRow.id, "test_cases", t.id);
  data = links.withLinkAdded(data, acLink);
  assert.equal(computeTestVerification(data).byAcceptanceCriteria[acRow.id].state, "Verified", "AC ↔ test link counts at once");

  data = links.withLinkAdded(data, reqLink);
  assert.equal(data.artefact_links.filter((l) => l.id === reqLink.id).length, 1, "re-applying the same saved link never duplicates it");

  data = links.withLinkRemoved(data, reqLink.id);
  data = links.withLinkRemoved(data, acLink.id);
  assert.equal(data.artefact_links.length, 0);
  assert.equal(computeTestVerification(data).byRequirement[r.id].state, "No Tests Linked", "removal reflected at once");
  assert.equal(computeTestVerification(data).byAcceptanceCriteria[acRow.id].state, "No Tests Linked");
});

await run("linker reads links from the canonical DataStore (no parallel link state or separate query)", () => {
  const src = read("components/artefact-linker.tsx");
  assert.match(src, /const links = useMemo\(\s*\(\) => \(data\.artefact_links \?\? \[\]\)\.filter/);
  assert.doesNotMatch(src, /loadLinksForRecord|useState<ArtefactLink\[\]>|setLinks/);
  assert.match(src, /await removeLink\(linkId\);\n\s+onLinkRemoved\(linkId\);/, "state updated only after a confirmed delete");
  assert.match(src, /onAdd=\{onLinkAdded\}/);
  assert.match(src, /if \(!saved\) \{ setError\(/, "a failed add never reaches onLinkAdded");
});

await run("the owner applies confirmed link writes to the canonical DataStore via setData", () => {
  const app = read("components/app-client.tsx");
  assert.match(app, /onLinkAdded=\{\(link\) => setData\(\(current\) => current \? withLinkAdded\(current, link\) : current\)\}/);
  assert.match(app, /onLinkRemoved=\{\(linkId\) => setData\(\(current\) => current \? withLinkRemoved\(current, linkId\) : current\)\}/);
  assert.match(app, /const verification = pageData \? computeTestVerification\(pageData\) : null;/, "verification still derives from the canonical pageData");
});

console.log("\nAll audit and traceability write-path tests passed.\n");
