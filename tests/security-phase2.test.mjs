// Phase 2 — security hardening tests.
//
// Scope note: this repo has no live-server/integration test infrastructure
// (confirmed during the original audit — every existing test is a plain
// Node unit test over pure functions/fixtures). These tests exercise the
// real route handler functions and the real authorization decision logic
// directly, in-process, the same way tests/delivery-intelligence.test.mjs
// exercises real lib functions — not a full HTTP server, and not a real
// Supabase session (this test process has no NEXT_PUBLIC_SUPABASE_URL/
// NEXT_PUBLIC_SUPABASE_ANON_KEY set, so hasSupabaseConfig is false
// throughout, exactly like a genuinely unconfigured deployment). Where a
// test's name says "accepted"/"rejected", it means the authorization gate
// itself returned the expected decision — not that a live database
// operation completed.
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
const { hasSupabaseConfig } = req("../lib/supabase/client.ts");
const { getAuthenticatedUser, requireAuthenticatedUser, isAuthorizedRequest } = req("../lib/api-auth.ts");
const { isAuthorisedCron } = req("../lib/email-delivery.ts");
const checklistsRoute = req("../app/api/go-live/checklists/route.ts");
const cutoverRoute = req("../app/api/go-live/cutover/route.ts");
const aiTestRoute = req("../app/api/ai-settings/test/route.ts");
const generateTestRoute = req("../app/api/ai-settings/generate-test/route.ts");
const meetingAnalyseRoute = req("../app/api/meeting/analyse/route.ts");
const { NextRequest } = req("next/server");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

// Guard the whole suite's assumptions: if this ever runs somewhere with
// Supabase actually configured, the "local fallback" tests below would be
// exercising a completely different code path than intended.
run("test environment genuinely has no Supabase config (guards this suite's assumptions)", () => {
  assert.equal(hasSupabaseConfig, false);
});

// ── getAuthenticatedUser / requireAuthenticatedUser ─────────────────────────

await runAsync("existing callers (isAuthorizedRequest, email cron/manual routes) keep the default local fallback unchanged", async () => {
  const user = await getAuthenticatedUser();
  assert.deepEqual(user, { id: "local", email: "local@dev" });
  assert.equal(await isAuthorizedRequest(null), true);
});

await runAsync("getAuthenticatedUser({allowLocalFallback:false}) returns null when Supabase is unconfigured", async () => {
  assert.equal(await getAuthenticatedUser({ allowLocalFallback: false }), null);
});

await runAsync("development fallback accepted under documented conditions: NODE_ENV != production and Supabase genuinely unavailable", async () => {
  await withNodeEnv("test", async () => {
    const authError = await requireAuthenticatedUser();
    assert.equal(authError, null);
  });
});

await runAsync("production synthetic fallback rejected: NODE_ENV === production returns 401 even though Supabase is unconfigured", async () => {
  await withNodeEnv("production", async () => {
    const authError = await requireAuthenticatedUser();
    assert.ok(authError, "expected a 401 NextResponse, got null");
    assert.equal(authError.status, 401);
  });
});

// ── AI routes ────────────────────────────────────────────────────────────────

await runAsync("anonymous AI test route rejected in production", async () => {
  await withNodeEnv("production", async () => {
    const res = await aiTestRoute.POST();
    assert.equal(res.status, 401);
  });
});

await runAsync("anonymous AI generate-test route rejected in production", async () => {
  await withNodeEnv("production", async () => {
    const res = await generateTestRoute.POST();
    assert.equal(res.status, 401);
  });
});

await runAsync("AI test route accepts the documented dev fallback (not 401) outside production", async () => {
  await withNodeEnv("test", async () => {
    const res = await aiTestRoute.POST();
    assert.notEqual(res.status, 401);
  });
});

// ── Meeting analysis route ───────────────────────────────────────────────────

await runAsync("anonymous meeting analysis rejected in production", async () => {
  await withNodeEnv("production", async () => {
    const request = new NextRequest("http://localhost/api/meeting/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compactContext: "", meetingText: "irrelevant — should be rejected before body is read" }),
    });
    const res = await meetingAnalyseRoute.POST(request);
    assert.equal(res.status, 401);
  });
});

// ── Go-Live / Cutover routes ─────────────────────────────────────────────────

await runAsync("anonymous Go-Live checklist CRUD rejected in production (GET/POST/PATCH/DELETE)", async () => {
  await withNodeEnv("production", async () => {
    assert.equal((await checklistsRoute.GET()).status, 401);
    assert.equal((await checklistsRoute.POST(new NextRequest("http://localhost/api/go-live/checklists", { method: "POST", body: "{}" }))).status, 401);
    assert.equal((await checklistsRoute.PATCH(new NextRequest("http://localhost/api/go-live/checklists", { method: "PATCH", body: "{}" }))).status, 401);
    assert.equal((await checklistsRoute.DELETE(new NextRequest("http://localhost/api/go-live/checklists?id=x", { method: "DELETE" }))).status, 401);
  });
});

await runAsync("anonymous cutover plan CRUD rejected in production (GET/POST/PATCH/DELETE)", async () => {
  await withNodeEnv("production", async () => {
    assert.equal((await cutoverRoute.GET()).status, 401);
    assert.equal((await cutoverRoute.POST(new NextRequest("http://localhost/api/go-live/cutover", { method: "POST", body: "{}" }))).status, 401);
    assert.equal((await cutoverRoute.PATCH(new NextRequest("http://localhost/api/go-live/cutover", { method: "PATCH", body: "{}" }))).status, 401);
    assert.equal((await cutoverRoute.DELETE(new NextRequest("http://localhost/api/go-live/cutover?id=x", { method: "DELETE" }))).status, 401);
  });
});

await runAsync("authenticated (dev-fallback) Go-Live checklist CRUD passes the auth gate — proceeds to the database layer instead of 401", async () => {
  await withNodeEnv("test", async () => {
    const get = await checklistsRoute.GET();
    assert.notEqual(get.status, 401);
    assert.equal(get.status, 500); // no SUPABASE_SERVICE_ROLE_KEY in this test process — proves auth passed and it reached the DB layer
    const body = await get.json();
    assert.equal(body.error, "Database not configured");
  });
});

// ── Cron ─────────────────────────────────────────────────────────────────────

run("cron rejects when CRON_SECRET is missing (fails closed, does not silently allow)", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorisedCron(null, null, null), false);
    assert.equal(isAuthorisedCron("Bearer anything", null, null), false);
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous;
  }
});

run("cron accepts a correctly configured CRON_SECRET via Authorization header", () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-secret-value";
  try {
    assert.equal(isAuthorisedCron("Bearer test-secret-value", null, null), true);
    assert.equal(isAuthorisedCron("Bearer wrong-value", null, null), false);
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous; else delete process.env.CRON_SECRET;
  }
});

run("cron accepts Vercel's x-vercel-cron header regardless of CRON_SECRET configuration", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorisedCron(null, "1", null), true);
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous;
  }
});

console.log("\nAll Phase 2 security tests passed.\n");
