// Phase 0B2 — role-based delivery RLS (031) and no anonymous data access (032).
//
// The live database was verified separately: a rolled-back role matrix
// (anon / signed-in-without-profile / Viewer / Manager / Admin × SELECT /
// INSERT / UPDATE / DELETE on every public table) and real anon-key REST
// requests. These tests pin the migration files and the client behaviour
// that makes refused writes visible instead of silent.
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
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const m031 = read("supabase/migrations/031_role_based_delivery_policies.sql");
const m032 = read("supabase/migrations/032_remove_anon_data_access.sql");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
const DELIVERY_TABLES = [
  "requirements", "test_cases", "risks", "actions", "decisions", "dependencies",
  "discovery_questions", "milestones", "timeline_items", "deliverables", "documents",
  "meetings", "activity_log", "project_snapshots",
  "acceptance_criteria", "evidence", "artefact_links", "requirement_sign_offs",
  "meeting_intelligence", "meeting_suggestions",
];

// ── 031 ─────────────────────────────────────────────────────────────────────

await run("031: every delivery table (incl. the former any-authenticated Group B) gets Viewer read / Manager+Admin write", () => {
  const list = code(m031).match(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]/)[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...list].sort(), [...DELIVERY_TABLES].sort());
  const loop = code(m031).match(/FOREACH t IN ARRAY[\s\S]*?END LOOP;/)[0];
  assert.match(loop, /FOR SELECT TO authenticated USING \(\(SELECT public\.can_read\(\)\)\)/);
  assert.match(loop, /FOR INSERT TO authenticated WITH CHECK \(\(SELECT public\.can_write\(\)\)\)/);
  assert.match(loop, /FOR UPDATE TO authenticated USING \(\(SELECT public\.can_write\(\)\)\) WITH CHECK \(\(SELECT public\.can_write\(\)\)\)/);
  assert.match(loop, /FOR DELETE TO authenticated USING \(\(SELECT public\.can_write\(\)\)\)/);
  for (const legacy of ["acceptance_criteria_auth_all", "evidence_auth_all", "artefact_links_auth_all", "req_sign_offs_auth_all", "auth_all_meeting_intelligence", "auth_all_meeting_suggestions", "requirements_admin", "tests_read"]) {
    assert.match(m031, new RegExp(`DROP POLICY IF EXISTS "${legacy}"`), legacy);
  }
});

await run("031: projects — Viewer reads, Manager/Admin edit, only Admin deletes, no direct INSERT (API route only)", () => {
  const sql = code(m031);
  assert.match(sql, /CREATE POLICY "projects_select" ON public\.projects FOR SELECT TO authenticated USING \(\(SELECT public\.can_read\(\)\)\);/);
  assert.match(sql, /CREATE POLICY "projects_update" ON public\.projects FOR UPDATE TO authenticated USING \(\(SELECT public\.can_write\(\)\)\) WITH CHECK \(\(SELECT public\.can_write\(\)\)\);/);
  assert.match(sql, /CREATE POLICY "projects_delete" ON public\.projects FOR DELETE TO authenticated USING \(\(SELECT public\.is_admin\(\)\)\);/);
  assert.doesNotMatch(sql, /ON public\.projects FOR (INSERT|ALL)/);
  assert.match(read("app/api/projects/route.ts"), /requireCanCreateProject\(\)[\s\S]*createServiceRoleClient\(\)/, "the single creation path is unchanged");
});

await run("031: email settings Admin-configured / Manager-readable; email activity server-written only", () => {
  const sql = code(m031);
  assert.match(sql, /"email_settings_select"[^;]*app_role\(\)\) IN \('Admin', 'Manager'\)/);
  for (const op of ["insert", "update", "delete"]) assert.match(sql, new RegExp(`"email_settings_${op}"[^;]*is_admin\\(\\)`), op);
  assert.match(sql, /"email_activity_log_select"[^;]*app_role\(\)\) IN \('Admin', 'Manager'\)/);
  assert.doesNotMatch(sql, /ON public\.email_activity_log FOR (INSERT|UPDATE|DELETE|ALL)/);
});

await run("031: no policy is granted to anon or PUBLIC, and server-managed tables are untouched", () => {
  const sql = code(m031);
  for (const stmt of sql.split(";").filter((s) => /CREATE POLICY/.test(s))) assert.match(stmt, /TO authenticated/, stmt.trim());
  for (const t of ["go_live_readiness_overrides", "go_live_decisions", "go_live_checklists", "cutover_plan", "audit_log", "ai_settings", "microsoft_tokens", "user_profiles"]) {
    assert.doesNotMatch(sql, new RegExp(`public\\.${t}\\b`), t);
  }
});

// ── 032 ─────────────────────────────────────────────────────────────────────

await run("032 drops every anon policy that migrations 001–030 left alive (derived from the migration history)", () => {
  const dir = path.join(root, "supabase/migrations");
  const alive = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f < "031").sort()) {
    for (const stmt of code(fs.readFileSync(path.join(dir, file), "utf8")).split(";")) {
      const created = stmt.match(/CREATE POLICY\s+"?([^"\s]+)"?\s+ON\s+(?:public\.)?([a-z_]+)/i);
      if (created && /\bTO\s+anon\b/i.test(stmt)) alive.set(created[1], created[2]);
      const dropped = stmt.match(/DROP POLICY\s+(?:IF EXISTS\s+)?"?([^"\s]+)"?\s+ON\s+(?:public\.)?([a-z_]+)/i);
      if (dropped && !created) alive.delete(dropped[1]);
    }
  }
  assert.equal(alive.size, 27, `the 27 anon policies found live in the Phase 0B review (found ${alive.size})`);
  for (const [name, table] of alive) {
    assert.match(m032, new RegExp(`DROP POLICY IF EXISTS "${name}" ON public\\.${table};`), `${name} on ${table}`);
  }
  assert.match(m032, /DROP POLICY IF EXISTS "email_log_anon_insert" ON public\.email_activity_log;/);
});

await run("032 revokes anon table privileges, TRUNCATE, and future default grants — but keeps authenticated CRUD", () => {
  const sql = code(m032);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;/);
  assert.match(sql, /REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;/);
  assert.match(sql, /REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM authenticated;/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM authenticated;/);
  assert.doesNotMatch(sql, /REVOKE (ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*FROM[^;]*authenticated/);
  assert.doesNotMatch(sql, /CREATE POLICY|GRANT /);
  assert.equal(req("../lib/schema.ts").latestMigration, "032_remove_anon_data_access");
});

// ── Refused writes are visible, never silent ────────────────────────────────

function updateClient(updatedRows, error = null) {
  return { from() {
    const b = { op: "select",
      select() { return b; }, eq() { return b; },
      update() { b.op = "update"; return b; },
      insert() { b.op = "insert"; return b; },
      single: async () => (b.op === "insert" ? { data: null, error } : { data: { id: "r1", title: "old", project_id: "p" }, error: null }),
      then(resolve) { return Promise.resolve(b.op === "update" ? { data: updatedRows, error } : { data: [], error: null }).then(resolve); },
    };
    return b;
  } };
}

await run("updateRecord: an RLS-refused (zero-row) update throws a clear permission message and audits nothing", async () => {
  const audits = [];
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
  globalThis.fetch = async (url, init) => { audits.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  clientModule.supabase = updateClient([]);
  await assert.rejects(dataStore.updateRecord("requirements", { id: "r1", title: "new" }), /was not updated — you may not have permission to change it/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audits.length, 0);
});

await run("updateRecord: a permitted update is unchanged (returns the saved row, audits the change)", async () => {
  const audits = [];
  globalThis.fetch = async (url, init) => { audits.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  clientModule.supabase = updateClient([{ id: "r1", title: "new", project_id: "p" }]);
  const saved = await dataStore.updateRecord("requirements", { id: "r1", title: "new" });
  assert.equal(saved.title, "new");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audits.length, 1);
});

await run("createRecord: an RLS refusal (42501) reads as a permission error", async () => {
  clientModule.supabase = updateClient([], { code: "42501", message: 'new row violates row-level security policy for table "requirements"' });
  await assert.rejects(dataStore.createRecord("requirements", { title: "x" }), /Failed to create requirements: you do not have permission to make this change\./);
});

await run("delivery panels show the real failure reason; AC quick-status changes are no longer unguarded", () => {
  for (const file of ["components/requirement-sign-off-panel.tsx", "components/acceptance-criteria-panel.tsx", "components/evidence-panel.tsx"]) {
    const src = read(file);
    assert.doesNotMatch(src, /check Supabase connection/, file);
    assert.match(src, /setError\(e instanceof Error \? e\.message : "Failed to save\."\)/, file);
  }
  assert.match(read("components/acceptance-criteria-panel.tsx"), /async function quickStatus[\s\S]*?try \{[\s\S]*?await saveRecord\("acceptance_criteria"[\s\S]*?\} catch \(e\) \{\n\s+setError/);
  assert.match(read("components/artefact-linker.tsx"), /you may not have permission to change traceability links/);
});

await run("no code builds its own anon-key data client (only the session-bound browser/server/middleware clients use it)", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(rel); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (read(rel).includes("NEXT_PUBLIC_SUPABASE_ANON_KEY")) offenders.push(rel);
    }
  };
  for (const dir of ["app", "lib", "components", "contexts", "scripts"]) walk(dir);
  assert.deepEqual(offenders.sort(), ["lib/supabase/client.ts", "lib/supabase/middleware.ts", "lib/supabase/server.ts"]);
  assert.match(read("scripts/report-go-live-dates.mjs"), /SUPABASE_SERVICE_ROLE_KEY is required to read live data/);
});

await run("GET /api/email/status (recent email activity, read with the service role) is Manager/Admin only", async () => {
  const serverModule = req("../lib/supabase/server.ts");
  const serviceRoleModule = req("../lib/supabase/service-role.ts");
  const statusRoute = req("../app/api/email/status/route.ts");
  let session = null; let role = null;
  serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
  const profiles = { from: () => { const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: role ? { role } : null, error: null }) }; return b; } };
  serviceRoleModule.createServiceRoleClient = () => profiles;
  assert.equal((await statusRoute.GET()).status, 401, "anonymous");
  session = { id: "v" }; role = "Viewer";
  assert.equal((await statusRoute.GET()).status, 403, "Viewer");
  role = "Manager";
  const quiet = console.warn; console.warn = () => {};
  const orig = console.log; console.log = () => {};
  try { assert.notEqual((await statusRoute.GET()).status, 403, "Manager"); } finally { console.warn = quiet; console.log = orig; }
});

console.log("\nAll Phase 0B2 security tests passed.\n");
