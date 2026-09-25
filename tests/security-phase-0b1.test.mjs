// Phase 0B1 — security prerequisites (role escalation, delete reliability,
// audit reads, fail-closed server secrets, route role checks, project delete).
//
// Route tests call the REAL route handlers and the REAL role guards
// (lib/api-auth.ts → lib/permissions.ts). Only the two I/O edges are stubbed:
// the session lookup (lib/supabase/server createClient) and the service-role
// client (lib/supabase/service-role createServiceRoleClient), which also
// serves the user_profiles role lookup. The migration-030 database behaviour
// itself (signup role, self-update, helpers) was validated against the live
// database in rolled-back transactions; the SQL assertions here pin the file.
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

// Env before import: Supabase is "configured" (client/server paths active), no service key, no cron secret.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.RESEND_API_KEY;
process.env.CRON_SECRET = "test-cron-secret";

const req = Module.createRequire(import.meta.url);
const serverModule = req("../lib/supabase/server.ts");
const serviceRoleModule = req("../lib/supabase/service-role.ts");
const clientModule = req("../lib/supabase/client.ts");
const permissions = req("../lib/permissions.ts");
const audit = req("../lib/audit.ts");
const dataStore = req("../lib/supabase/data-store.ts");
const emailDelivery = req("../lib/email-delivery.ts");
const aiSettings = req("../lib/ai/settings.ts");
const auditRoute = req("../app/api/audit/route.ts");
const checklistsRoute = req("../app/api/go-live/checklists/route.ts");
const cutoverRoute = req("../app/api/go-live/cutover/route.ts");
const decisionsRoute = req("../app/api/go-live/decisions/route.ts");
const overridesRoute = req("../app/api/go-live/overrides/route.ts");
const aiSettingsRoute = req("../app/api/ai-settings/route.ts");
const EMAIL_ROUTES = ["daily-brief", "weekly-summary", "manager-summary", "test", "test-status"]
  .map((name) => [name, req(`../app/api/email/${name}/route.ts`)]);
const { NextRequest } = req("next/server");

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const U = { Viewer: "11111111-1111-4111-8111-111111111111", Manager: "22222222-2222-4222-8222-222222222222", Admin: "33333333-3333-4333-8333-333333333333" };
const P = "44444444-4444-4444-8444-444444444444";

// ── I/O stubs ────────────────────────────────────────────────────────────────
let session = null;          // { id } of the signed-in user, or null
let profileRole = null;      // role returned by the user_profiles lookup
let serviceRoleAvailable = true;
const dbWrites = [];

// Chainable, awaitable stand-in for a supabase-js query builder.
function fakeDb() {
  return {
    from(table) {
      const state = { table, op: "select", payload: null };
      // single = maybeSingle()/single(); otherwise the awaited builder (a list).
      const result = (single) => {
        if (table === "user_profiles") return { data: profileRole ? { role: profileRole, full_name: `${profileRole} User` } : null, error: null };
        if (state.op !== "select") {
          const rows = (Array.isArray(state.payload) ? state.payload : [state.payload ?? {}]).map((r) => ({ id: "new-id", ...r }));
          return { data: single ? rows[0] : rows, error: null };
        }
        if (table === "projects") return { data: single ? { id: P } : [{ id: P }], error: null };
        return { data: single ? null : [], error: null };
      };
      const builder = {
        select() { return builder; }, eq() { return builder; }, in() { return builder; }, gte() { return builder; },
        lte() { return builder; }, order() { return builder; }, limit() { return builder; }, range() { return builder; },
        insert(payload) { state.op = "insert"; state.payload = payload; dbWrites.push({ table, op: "insert", payload }); return builder; },
        update(payload) { state.op = "update"; state.payload = payload; dbWrites.push({ table, op: "update", payload }); return builder; },
        upsert(payload) { state.op = "upsert"; state.payload = payload; dbWrites.push({ table, op: "upsert", payload }); return builder; },
        delete() { state.op = "delete"; dbWrites.push({ table, op: "delete" }); return builder; },
        maybeSingle: async () => result(true), single: async () => result(true),
        then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
      };
      return builder;
    },
  };
}
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: session ? null : { message: "no session" } }) } });
serviceRoleModule.createServiceRoleClient = () => (serviceRoleAvailable ? fakeDb() : null);
globalThis.fetch = async () => { throw new Error("no network in tests"); };

function as(role) {
  session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null;
  profileRole = role;
  serviceRoleAvailable = true;
  dbWrites.length = 0;
}
const post = (url, body, headers = {}) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const patch = (url, body) => new NextRequest(`http://localhost${url}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const del = (url) => new NextRequest(`http://localhost${url}`, { method: "DELETE" });
const auditBody = { entries: [{ entity_type: "requirements", entity_id: U.Viewer, entity_name: "REQ-1", action_type: "Update", project_id: P }] };
const quiet = async (fn) => { const e = console.error, l = console.log, w = console.warn; console.error = console.log = console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; console.warn = w; } };

// ── 1. Role escalation (migration 030) ──────────────────────────────────────

const mig = read("supabase/migrations/030_role_escalation_and_security_helpers.sql");
const fnBody = (name) => mig.slice(mig.indexOf(`FUNCTION public.${name}(`), mig.indexOf("$$;", mig.indexOf(`FUNCTION public.${name}(`)));

await run("030: handle_new_user always creates Viewer — client signup metadata role can no longer create Admin/Manager", () => {
  const body = fnBody("handle_new_user");
  assert.doesNotMatch(body, /raw_user_meta_data\s*->>\s*'role'/, "metadata role must not be read");
  assert.match(body, /'Viewer'\s*\)\s*ON CONFLICT \(id\) DO NOTHING/);
  assert.match(body, /SECURITY DEFINER\s+SET search_path = ''/);
});

await run("030: self-update cannot change role; role changes are Admin-only and never on your own row", () => {
  const guard = fnBody("user_profiles_guard");
  assert.match(guard, /IF NEW\.role IS DISTINCT FROM OLD\.role THEN\s+IF OLD\.id = auth\.uid\(\) THEN\s+RAISE EXCEPTION 'You cannot change your own role'/);
  assert.match(guard, /IF NOT public\.is_admin\(\) THEN\s+RAISE EXCEPTION 'Only an Admin can change a user''s role'/);
  assert.match(guard, /current_user NOT IN \('anon', 'authenticated'\)/, "server/dashboard administration is unaffected");
  assert.match(guard, /NEW\.id IS DISTINCT FROM OLD\.id OR NEW\.created_at IS DISTINCT FROM OLD\.created_at/);
  assert.match(mig, /CREATE TRIGGER user_profiles_guard\s+BEFORE UPDATE ON public\.user_profiles/);
});

await run("030: own full_name update remains permitted (column grant); no direct profile insert/delete", () => {
  assert.match(mig, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.user_profiles FROM anon, authenticated;/);
  assert.match(mig, /GRANT UPDATE \(full_name, role\) ON public\.user_profiles TO authenticated;/);
  assert.doesNotMatch(mig, /DROP POLICY[^;]*profiles_update_own/, "the own-row policy (full_name edits) is kept");
});

await run("030: role helpers exist, are SECURITY DEFINER with a pinned search_path, and a missing profile yields no access", () => {
  for (const name of ["app_role", "is_admin", "can_write", "can_read", "get_user_role"]) {
    assert.match(fnBody(name), /SECURITY DEFINER\s+SET search_path = ''/, name);
  }
  assert.match(fnBody("app_role"), /WHERE p\.id = auth\.uid\(\)\s+AND p\.role IN \('Admin', 'Manager', 'Viewer'\)/);
  assert.match(fnBody("is_admin"), /COALESCE\(public\.app_role\(\) = 'Admin', false\)/);
  assert.match(fnBody("can_write"), /COALESCE\(public\.app_role\(\) IN \('Admin', 'Manager'\), false\)/);
  assert.match(fnBody("can_read"), /public\.app_role\(\) IS NOT NULL/);
  assert.match(mig, /ALTER FUNCTION public\.set_updated_at\(\) SET search_path = '';/);
  assert.doesNotMatch(mig, /CREATE POLICY|DROP POLICY/, "no table policy changes in 0B1");
  assert.ok(req("../lib/schema.ts").latestMigration >= "030_role_escalation_and_security_helpers");
});

// ── 2. Delete reliability ───────────────────────────────────────────────────

function deleteClient(deletedRows) {
  const calls = [];
  return { calls, client: { from(table) {
    const b = { op: "select",
      select() { return b; }, eq() { return b; },
      delete() { b.op = "delete"; calls.push(`delete:${table}`); return b; },
      single: async () => ({ data: { id: U.Viewer, requirement_ref: "REQ-1", title: "T", project_id: P }, error: null }),
      then(resolve) { return Promise.resolve(b.op === "delete" ? { data: deletedRows, error: null } : { data: [], error: null }).then(resolve); },
    };
    return b;
  } } };
}

await run("deleteRecord: zero rows deleted (RLS refusal) throws a meaningful error and records NO Delete audit", async () => {
  const auditCalls = [];
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
  globalThis.fetch = async (url, init) => { auditCalls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; };
  const { client, calls } = deleteClient([]);
  clientModule.supabase = client;
  await assert.rejects(dataStore.deleteRecord("requirements", U.Viewer), /was not deleted — you may not have permission/);
  assert.deepEqual(calls, ["delete:requirements"]);
  assert.equal(auditCalls.length, 0, "no false Delete audit event");
});

await run("deleteRecord: a real delete still resolves and audits exactly one Delete (unchanged behaviour)", async () => {
  const auditCalls = [];
  globalThis.fetch = async (url, init) => { auditCalls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; };
  const { client } = deleteClient([{ id: U.Viewer }]);
  clientModule.supabase = client;
  await dataStore.deleteRecord("requirements", U.Viewer);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].url, "/api/audit");
  assert.equal(auditCalls[0].body.entries[0].action_type, "Delete");
  globalThis.fetch = async () => { throw new Error("no network in tests"); };
});

await run("callers remove a deleted item from UI state only after deleteRecord resolves", () => {
  const app = read("components/app-client.tsx");
  assert.match(app, /await deleteRecord\(config\.key, String\(record\.id\)\);\n\s+const id = String\(record\.id\);\n\s+setData\(/);
  const table = read("components/data-table.tsx");
  assert.match(table, /await onDeleteRecord\(row\);\n\s+const nextRows = rows\.filter/);
  assert.match(table, /catch \(error\) \{\n\s+setOperationError\(error instanceof Error \? error\.message/);
  for (const [file, entity] of [["components/acceptance-criteria-panel.tsx", "acceptance_criteria"], ["components/evidence-panel.tsx", "evidence"]]) {
    const src = read(file);
    assert.match(src, new RegExp(`await deleteRecord\\("${entity}", id\\);\\n\\s+onUpdate\\(`), file);
    assert.match(src, /setError\(e instanceof Error \? e\.message/, `${file} shows the real reason`);
  }
});

// ── 3. Audit Trail reads ────────────────────────────────────────────────────

await run("Audit Trail reads use the session-aware authenticated client, not a standalone anon client", async () => {
  const tables = [];
  clientModule.supabase = { from(t) { tables.push(t); const b = { select() { return b; }, order() { return b; }, eq() { return b; }, in() { return b; }, limit() { return b; },
    then(resolve) { return Promise.resolve({ data: [{ id: "a1" }], count: 7, error: null }).then(resolve); } }; return b; } };
  assert.deepEqual(await audit.getAuditLog({ projectId: P }), [{ id: "a1" }]);
  assert.equal((await audit.getRecentChanges(P)).length, 1);
  assert.equal(await audit.getAuditCount(), 7);
  assert.deepEqual(tables, ["audit_log", "audit_log", "audit_log"]);
  const src = read("lib/audit.ts");
  assert.match(src, /import \{ supabase \} from "@\/lib\/supabase\/client";/);
  assert.doesNotMatch(src, /supabase\/anon|supabaseAnon/);
  assert.equal(fs.existsSync(path.join(root, "lib/supabase/anon.ts")), false, "the standalone anon client module is gone");
});

await run("server-side audit reads (email) use the caller's service-role client", async () => {
  const tables = [];
  const svc = { from(t) { tables.push(t); const b = { select() { return b; }, in() { return b; }, gte() { return b; }, order() { return b; }, limit() { return b; },
    then(resolve) { return Promise.resolve({ data: [{ id: "s1" }], error: null }).then(resolve); } }; return b; } };
  assert.deepEqual(await audit.getChangesSince(svc, 24, [P]), [{ id: "s1" }]);
  assert.deepEqual(tables, ["audit_log"]);
  assert.match(read("lib/email-delivery.ts"), /getChangesSince\(client, 24, projectIds\)/);
});

// ── 4. Missing service-role key fails closed ────────────────────────────────

await run("email: missing service-role key fails closed with a clear config_error (never the anon key)", async () => {
  serviceRoleAvailable = false;
  const result = await quiet(() => emailDelivery.executeEmail("Test", "Manual"));
  assert.equal(result.ok, false);
  assert.equal(result.status, "config_error");
  assert.match(result.message, /SUPABASE_SERVICE_ROLE_KEY is not configured/);
  const health = await quiet(() => emailDelivery.getEmailDeliveryHealth());
  assert.equal(health.serviceRoleConfigured, false);
  assert.doesNotMatch(read("lib/email-delivery.ts"), /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  serviceRoleAvailable = true;
});

await run("AI settings: missing service-role key fails closed (no anon fallback); the Admin check no longer lets requests through", async () => {
  serviceRoleAvailable = false;
  await assert.rejects(aiSettings.loadAISettings(), /SUPABASE_SERVICE_ROLE_KEY is not configured/);
  await assert.rejects(aiSettings.saveAISettings({ provider: "none", enabled: false }), /SUPABASE_SERVICE_ROLE_KEY/);
  session = { id: U.Admin }; profileRole = "Admin";
  const res = await quiet(() => aiSettingsRoute.POST(post("/api/ai-settings", { provider: "none", enabled: false })));
  assert.equal(res.status, 503, "previously: 'no service client, allowing through'");
  for (const file of ["lib/ai/settings.ts", "app/api/ai-settings/route.ts"]) assert.doesNotMatch(read(file), /NEXT_PUBLIC_SUPABASE_ANON_KEY/, file);
  serviceRoleAvailable = true;
});

await run("role guards fail closed (503) when the role cannot be verified", async () => {
  as("Manager"); serviceRoleAvailable = false;
  assert.equal((await auditRoute.POST(post("/api/audit", auditBody))).status, 503);
  assert.equal((await checklistsRoute.POST(post("/api/go-live/checklists", {}))).status, 503);
  assert.equal((await EMAIL_ROUTES[0][1].POST(post("/api/email/daily-brief", {}))).status, 503);
});

await run("the service-role key never reaches browser code", () => {
  const sr = read("lib/supabase/service-role.ts");
  assert.match(sr, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(sr, /NEXT_PUBLIC_SUPABASE_SERVICE/);
  for (const file of ["lib/supabase/client.ts", "lib/supabase/data-store.ts", "lib/audit.ts", "contexts/auth-context.tsx"]) {
    const src = read(file);
    assert.doesNotMatch(src, /SUPABASE_SERVICE_ROLE_KEY|from "@\/lib\/supabase\/service-role"/, file);
  }
});

// ── 5. Route role checks — Viewer refused ───────────────────────────────────

await run("Viewer is refused by POST /api/audit (403)", async () => {
  as("Viewer");
  const res = await auditRoute.POST(post("/api/audit", auditBody));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Admin or Manager access required \(resolved role: Viewer\)/);
  assert.equal(dbWrites.length, 0);
});

await run("Viewer is refused by go-live checklist and cutover writes (403) but keeps read access", async () => {
  as("Viewer");
  for (const [route, url] of [[checklistsRoute, "/api/go-live/checklists"], [cutoverRoute, "/api/go-live/cutover"]]) {
    assert.equal((await route.POST(post(url, { project_id: P }))).status, 403, `${url} POST`);
    assert.equal((await route.PATCH(patch(url, { id: "x" }))).status, 403, `${url} PATCH`);
    assert.equal((await route.DELETE(del(`${url}?id=x`))).status, 403, `${url} DELETE`);
    assert.equal((await route.GET()).status, 200, `${url} GET stays open to every signed-in role`);
  }
  assert.equal(dbWrites.length, 0);
});

await run("Viewer is refused by every manual email-send route (403)", async () => {
  as("Viewer");
  for (const [name, route] of EMAIL_ROUTES) {
    const res = await route.POST(post(`/api/email/${name}`, {}));
    assert.equal(res.status, 403, name);
    assert.match((await res.json()).message, /Admin or Manager access required to send emails/, name);
  }
});

await run("signed-out callers get 401 on audit, go-live writes and email sends", async () => {
  as(null);
  assert.equal((await auditRoute.POST(post("/api/audit", auditBody))).status, 401);
  assert.equal((await checklistsRoute.POST(post("/api/go-live/checklists", {}))).status, 401);
  assert.equal((await cutoverRoute.DELETE(del("/api/go-live/cutover?id=x"))).status, 401);
  for (const [name, route] of EMAIL_ROUTES) assert.equal((await route.POST(post(`/api/email/${name}`, {}))).status, 401, name);
});

// ── 6. Manager succeeds; Admin intact ───────────────────────────────────────

for (const role of ["Manager", "Admin"]) {
  await run(`${role} succeeds on audit write and go-live checklist/cutover writes`, async () => {
    as(role);
    const res = await auditRoute.POST(post("/api/audit", auditBody));
    assert.equal(res.status, 200);
    const inserted = dbWrites.find((w) => w.table === "audit_log");
    assert.equal(inserted.payload[0].changed_by, U[role], "identity still stamped from the session");
    for (const [route, url] of [[checklistsRoute, "/api/go-live/checklists"], [cutoverRoute, "/api/go-live/cutover"]]) {
      assert.ok((await route.POST(post(url, { project_id: P }))).status < 300, `${url} POST`);
      assert.ok((await route.PATCH(patch(url, { id: "x" }))).status < 300, `${url} PATCH`);
      assert.ok((await route.DELETE(del(`${url}?id=x`))).status < 300, `${url} DELETE`);
    }
  });

  await run(`${role} passes the email-send gate (reaches delivery; here only RESEND_API_KEY is missing)`, async () => {
    as(role);
    for (const [name, route] of EMAIL_ROUTES) {
      const res = await quiet(() => route.POST(post(`/api/email/${name}`, name === "test-status" ? { projectId: P, recipients: ["a@example.test"] } : {})));
      assert.notEqual(res.status, 401, name);
      assert.notEqual(res.status, 403, name);
    }
  });

  await run(`${role} can still record governance actions (Go/No-Go decision, readiness override)`, async () => {
    as(role);
    const decision = await quiet(() => decisionsRoute.POST(post("/api/go-live/decisions", { project_id: P, decision: "GO", reason: "test" })));
    assert.ok(decision.status < 300, `decision ${decision.status}`);
    assert.ok(dbWrites.some((w) => w.table === "go_live_decisions" && w.op === "insert"));
    const override = await quiet(() => overridesRoute.POST(post("/api/go-live/overrides", { project_id: P, check_key: "customer_approval", override_status: "Complete", override_reason: "ok" })));
    assert.notEqual(override.status, 401);
    assert.notEqual(override.status, 403);
  });
}

await run("a valid CRON_SECRET bearer still authorises manual/automated email sends without a session", async () => {
  as(null);
  const res = await quiet(() => EMAIL_ROUTES[0][1].POST(post("/api/email/daily-brief", {}, { authorization: "Bearer test-cron-secret" })));
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

// ── 7. AI settings ──────────────────────────────────────────────────────────

await run("GET /api/ai-settings requires authentication; configuration changes stay Admin-only", async () => {
  as(null);
  assert.equal((await aiSettingsRoute.GET()).status, 401);
  as("Viewer");
  assert.equal((await quiet(() => aiSettingsRoute.GET())).status, 200);
  as("Manager");
  assert.equal((await quiet(() => aiSettingsRoute.POST(post("/api/ai-settings", { provider: "none", enabled: false })))).status, 403);
  as("Admin");
  assert.equal((await quiet(() => aiSettingsRoute.POST(post("/api/ai-settings", { provider: "bogus", enabled: false })))).status, 400, "Admin passes the gate (then body validation)");
});

// ── 8. Role model and project deletion ──────────────────────────────────────

await run("permission rules match the agreed role model", () => {
  const table = {
    canWriteDeliveryData: { Admin: true, Manager: true, Viewer: false },
    canCreateProject: { Admin: true, Manager: true, Viewer: false },
    canEditProject: { Admin: true, Manager: true, Viewer: false },
    canDeleteProject: { Admin: true, Manager: false, Viewer: false },
    canSendProjectEmail: { Admin: true, Manager: true, Viewer: false },
    canAssessManualChecks: { Admin: true, Manager: true, Viewer: false },
    canConfigureSystem: { Admin: true, Manager: false, Viewer: false },
  };
  for (const [fn, expected] of Object.entries(table)) {
    for (const [role, allowed] of Object.entries(expected)) assert.equal(permissions[fn](role), allowed, `${fn}(${role})`);
    assert.equal(permissions[fn](null), false, `${fn}(null)`);
    assert.equal(permissions[fn](undefined), false, `${fn}(undefined)`);
  }
});

await run("only Admin sees/uses project delete; Viewer gets no project Edit control", () => {
  const app = read("components/app-client.tsx");
  assert.match(app, /const mayDelete = config\?\.key !== "projects" \|\| canDeleteProject\(user\?\.role\);/);
  assert.match(app, /if \(!mayDelete\) throw new Error\("Only an Admin can delete a project\."\);/);
  assert.match(app, /onDeleteRecord=\{mayDelete \? removeRecord : undefined\}/);
  const table = read("components/data-table.tsx");
  assert.match(table, /\{onDeleteRecord && <Button variant="ghost" size="icon" onClick=\{\(\) => deleteRecord\(row\)\} aria-label="Delete record">/);
  const portfolio = read("components/projects-portfolio-page.tsx");
  assert.match(portfolio, /onEdit=\{canEditProject\(user\?\.role\) \? \(\) => setEditingProject\(project\) : undefined\}/);
  assert.match(portfolio, /\{onEdit && <button/);
});

console.log("\nAll Phase 0B1 security tests passed.\n");
