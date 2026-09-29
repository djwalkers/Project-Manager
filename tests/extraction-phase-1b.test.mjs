// Phase 1B — persisted extraction: worker authentication, the narrow worker
// protocol, Manager/Admin queue/retry, worker credentials and status, and
// the migration's guarantees. REAL route handlers and role guards; only the
// session lookup and the service-role client (tables, RPC, Storage) are
// stubbed, the latter mirroring migration 036's functions. The migration
// itself was validated against the live database in a rolled-back
// transaction; the deterministic extractor has its own suite in
// local-worker/tests.
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
const { createHash } = req("node:crypto");
const serverModule = req("../lib/supabase/server.ts");
const serviceRoleModule = req("../lib/supabase/service-role.ts");
const shared = req("../lib/source-documents.ts");
const routes = Object.fromEntries(["claim", "fragments", "complete", "fail", "heartbeat", "credentials", "status"].map((r) => [r, req(`../app/api/worker/${r}/route.ts`)]));
const queueRoute = req("../app/api/source-documents/extraction/route.ts");
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
const sha = (v) => createHash("sha256").update(v).digest("hex");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

// ── In-memory service-role stand-in ─────────────────────────────────────────
let session = null;
const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  documents: [{ id: "d1", project_id: P, document_name: "Spec" }],
  document_versions: [{ id: V1, document_id: "d1", project_id: P, version_number: 1, storage_path: `${P}/x.pdf`, content_type: "application/pdf", sha256: "f".repeat(64), size_bytes: 10, original_filename: "spec.pdf", extraction_status: "Queued" }],
  extraction_jobs: [], source_fragments: [], worker_credentials: [], audit_log: [], rpcCalls: [],
};
const tables = ["documents", "document_versions", "extraction_jobs", "source_fragments", "worker_credentials", "audit_log"];
function builder(table) {
  const q = { op: "select", filters: [], payload: null, head: false };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const match = () => rows().filter((r) => q.filters.every(([k, v, kind]) => (kind === "is" ? (r[k] ?? null) === v : kind === "gte" ? r[k] >= v : r[k] === v)));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), created_at: new Date().toISOString(), revoked_at: null, ...r })); db[table].push(...list); return list; }
    if (q.op === "update") { const hit = match(); hit.forEach((r) => Object.assign(r, q.payload)); return hit; }
    return match();
  };
  const b = {
    select(_c, opts) { if (opts?.head) q.head = true; return b; },
    eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, is(k, v) { q.filters.push([k, v, "is"]); return b; }, gte(k, v) { q.filters.push([k, v, "gte"]); return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }), single: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve) { const data = exec(); return Promise.resolve(q.head ? { count: data.length, error: null } : { data, error: null }).then(resolve); },
  };
  assert.ok(table === "user_profiles" || tables.includes(table), `unexpected table ${table}`);
  return b;
}
const err = (code, message) => ({ data: null, error: { code, message } });
function rpc(name, a) {
  db.rpcCalls.push({ name, args: a });
  const job = (id) => db.extraction_jobs.find((j) => j.id === id);
  const version = (id) => db.document_versions.find((v) => v.id === id);
  switch (name) {
    case "queue_extraction_job": {
      // Mirrors migration 037.
      const v = db.document_versions.find((x) => x.id === a.p_version_id && x.project_id === a.p_project_id);
      if (!v) return err("P0002", "Document version not found in this project");
      const mine = db.extraction_jobs.filter((j) => j.document_version_id === v.id);
      const latest = mine.at(-1);
      if (latest && ["Queued", "Running"].includes(latest.status)) return err("23505", `Extraction is already ${latest.status.toLowerCase()} for this version`);
      const success = mine.filter((j) => j.status === "Completed").at(-1);
      let trigger;
      if (a.p_mode === "upgrade") {
        if (!success) return err("55000", "This version has no successful extraction to upgrade");
        if ((shared.compareSemver(a.p_available_extractor_version, success.extractor_version) ?? 0) <= 0) return err("55000", `Already extracted with extractor ${success.extractor_version} — the worker reports ${a.p_available_extractor_version ?? "no version"}, which is not newer`);
        trigger = "upgrade";
      } else if (latest?.status === "Failed") trigger = "retry";
      else if (success) return err("55000", "This version has already been extracted; re-extract only when a newer extractor is available");
      else trigger = "manual";
      const j = { id: uuid(), project_id: P, document_version_id: v.id, status: "Queued", trigger, queued_at: new Date(Date.now() + ++seq).toISOString(), requested_by: a.p_user_id, requested_extractor_version: trigger === "upgrade" ? a.p_available_extractor_version : null };
      db.extraction_jobs.push(j);
      const previous = v.extraction_status; v.extraction_status = "Queued";
      return { data: [{ job_id: j.id, trigger, previous_status: previous, previous_extractor_version: success?.extractor_version ?? null }], error: null };
    }
    case "claim_extraction_job": {
      const j = db.extraction_jobs.find((x) => x.status === "Queued");
      if (!j) return { data: [], error: null };
      Object.assign(j, { status: "Running", worker_id: a.p_worker_id, worker_name: a.p_worker_name, attempt_count: (j.attempt_count ?? 0) + 1 });
      const v = version(j.document_version_id); v.extraction_status = "Running";
      return { data: [{ job_id: j.id, project_id: v.project_id, document_version_id: v.id, storage_path: v.storage_path, content_type: v.content_type, sha256: v.sha256, size_bytes: v.size_bytes, original_filename: v.original_filename, attempt_count: j.attempt_count }], error: null };
    }
    case "add_extraction_fragments": {
      const j = job(a.p_job_id);
      if (!j || j.status !== "Running" || j.worker_id !== a.p_worker_id) return err("55000", "This extraction job is not running for this worker");
      if (a.p_fragments.some((f) => sha(f.text) !== f.text_hash)) return err("22023", "text_hash mismatch");
      db.source_fragments.push(...a.p_fragments.map((f) => ({ ...f, extraction_job_id: j.id, document_version_id: j.document_version_id, project_id: j.project_id })));
      return { data: a.p_fragments.length, error: null };
    }
    case "complete_extraction_job": {
      const j = job(a.p_job_id);
      if (!j || j.status !== "Running" || j.worker_id !== a.p_worker_id) return err("55000", "This extraction job is not running for this worker");
      const stored = db.source_fragments.filter((f) => f.extraction_job_id === j.id).length;
      if (stored !== a.p_fragment_count) return err("22023", `Expected ${a.p_fragment_count} fragments but ${stored} were stored`);
      const status = a.p_outcome === "completed" ? "Completed" : "Completed with warnings";
      Object.assign(j, { status: "Completed", outcome: a.p_outcome, extractor_version: a.p_extractor_version, fragment_count: stored, completed_at: new Date(Date.now() + ++seq).toISOString() });
      version(j.document_version_id).extraction_status = status;
      return { data: [{ document_version_id: j.document_version_id, project_id: j.project_id, extraction_status: status }], error: null };
    }
    case "fail_extraction_job": {
      const j = job(a.p_job_id);
      if (!j || j.status !== "Running" || j.worker_id !== a.p_worker_id) return err("55000", "This extraction job is not running for this worker");
      db.source_fragments = db.source_fragments.filter((f) => f.extraction_job_id !== j.id);
      Object.assign(j, { status: "Failed", error_category: a.p_category, error_message: a.p_message, extractor_version: a.p_extractor_version, completed_at: new Date(Date.now() + ++seq).toISOString() });
      // 037: a failed run keeps the previous successful status.
      const prior = db.extraction_jobs.filter((x) => x.document_version_id === j.document_version_id && x.status === "Completed").at(-1);
      version(j.document_version_id).extraction_status = prior ? (prior.outcome === "completed" ? "Completed" : "Completed with warnings") : "Failed";
      return { data: [{ document_version_id: j.document_version_id, project_id: j.project_id }], error: null };
    }
  }
  return err("42883", "unknown function");
}
const storage = { from: () => ({ createSignedUrl: async (p, secs) => ({ data: { signedUrl: `https://example.supabase.co/sign/${p}?expires=${secs}` }, error: null }) }) };
serviceRoleModule.createServiceRoleClient = () => ({ from: builder, rpc: async (n, a) => rpc(n, a), storage });
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };

const call = async (handler, url, { body, token, method = "POST" } = {}) => {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await handler(new NextRequest(`http://localhost${url}`, method === "GET" ? { method, headers } : { method, headers, body: JSON.stringify(body ?? {}) }));
  return { status: res.status, body: await res.json() };
};
const worker = (route, body, token) => call(routes[route].POST, `/api/worker/${route}`, { body, token });
const frag = (sequence, text, extra = {}) => ({ sequence, fragment_type: "text", section_heading: "4.2 X", section_number: "4.2", section_path: ["4 R", "4.2 X"], page_start: 12, page_end: 13, text, text_hash: sha(text), metadata: {}, ...extra });

// ── Worker credentials (Admin) ──────────────────────────────────────────────

let token;
await run("only Admin can issue the worker token; it is returned once and only its SHA-256 is stored", async () => {
  as("Manager");
  assert.equal((await call(routes.credentials.POST, "/api/worker/credentials")).status, 403);
  as("Viewer");
  assert.equal((await call(routes.credentials.POST, "/api/worker/credentials")).status, 403);
  as(null);
  assert.equal((await call(routes.credentials.POST, "/api/worker/credentials")).status, 401);
  as("Admin");
  const first = await call(routes.credentials.POST, "/api/worker/credentials", { body: { name: "andrew-mac" } });
  assert.equal(first.status, 200);
  assert.match(first.body.token, /^tmw_[A-Za-z0-9_-]{43}$/);
  const second = await call(routes.credentials.POST, "/api/worker/credentials", { body: { name: "andrew-mac" } });
  token = second.body.token;
  assert.equal(db.worker_credentials.length, 2);
  assert.ok(db.worker_credentials[0].revoked_at, "issuing a new token revokes the previous one");
  assert.equal(db.worker_credentials[1].token_sha256, sha(token));
  assert.ok(!JSON.stringify(db.worker_credentials).includes(token), "the plaintext token is never stored");
  assert.equal((await worker("heartbeat", {}, first.body.token)).status, 401, "the revoked token no longer works");
});

// ── Worker authentication is narrow ────────────────────────────────────────

await run("worker routes refuse missing, malformed, unknown and browser-session callers", async () => {
  as("Admin"); // even a signed-in Admin session is not a worker
  for (const r of ["claim", "fragments", "complete", "fail", "heartbeat"]) {
    assert.equal((await worker(r, {}, undefined)).status, 401, `${r} without token`);
    assert.equal((await worker(r, {}, "not-a-token")).status, 401, `${r} malformed`);
    assert.equal((await worker(r, {}, `tmw_${"z".repeat(43)}`)).status, 401, `${r} unknown token`);
  }
});

await run("the worker token is accepted nowhere else (people routes still require a session role)", async () => {
  as(null);
  const res = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1 }, token });
  assert.equal(res.status, 401);
  assert.equal((await call(routes.status.GET, "/api/worker/status", { method: "GET", token })).status, 401);
  assert.equal((await call(routes.credentials.POST, "/api/worker/credentials", { token })).status, 401);
});

// ── Queue / retry (people) ─────────────────────────────────────────────────

await run("Viewer cannot start extraction; Manager can, and it is audited", async () => {
  as("Viewer");
  assert.equal((await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1 } })).status, 403);
  as(null);
  assert.equal((await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1 } })).status, 401);
  as("Manager");
  const res = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.job.status, "Queued");
  const a = db.audit_log.at(-1);
  assert.deepEqual([a.entity_type, a.action_type, a.field_name, a.new_value, a.changed_by], ["document_versions", "Status Change", "extraction", "Queued (manual)", U.Manager]);
  const again = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1 } });
  assert.equal(again.status, 409, "only one active extraction per version");
});

// ── Worker protocol ─────────────────────────────────────────────────────────

let jobId;
await run("claim returns the job and a short-lived signed URL for exactly that file, and records the heartbeat", async () => {
  const res = await worker("claim", { worker_version: "0.1.0" }, token);
  assert.equal(res.status, 200);
  jobId = res.body.job.id;
  assert.equal(res.body.job.document_version_id, V1);
  assert.equal(res.body.job.sha256, "f".repeat(64));
  assert.equal(res.body.download.url, `https://example.supabase.co/sign/${P}/x.pdf?expires=300`);
  const claim = db.rpcCalls.findLast((c) => c.name === "claim_extraction_job");
  assert.equal(claim.args.p_worker_id, db.worker_credentials[1].id, "the worker identity comes from the token");
  assert.ok(db.worker_credentials[1].last_seen_at);
  assert.equal((await worker("claim", {}, token)).body.job, null, "nothing else queued");
});

await run("fragments: malformed input is refused; only whitelisted fields reach the database", async () => {
  assert.equal((await worker("fragments", { job_id: jobId, fragments: [] }, token)).status, 400);
  assert.equal((await worker("fragments", { job_id: jobId, fragments: [{ sequence: 0, fragment_type: "text", text: "x", text_hash: sha("x") }] }, token)).status, 400);
  assert.equal((await worker("fragments", { job_id: jobId, fragments: [frag(1, "x", { fragment_type: "html" })] }, token)).status, 400);
  assert.equal((await worker("fragments", { job_id: jobId, fragments: Array.from({ length: 501 }, (_, i) => frag(i + 1, "x")) }, token)).status, 400);
  const res = await worker("fragments", { job_id: jobId, fragments: [frag(1, "Hello", { project_id: "EVIL", extraction_job_id: "EVIL" }), frag(2, "World")] }, token);
  assert.equal(res.status, 200);
  const sent = db.rpcCalls.findLast((c) => c.name === "add_extraction_fragments").args;
  assert.equal(sent.p_worker_id, db.worker_credentials[1].id);
  assert.deepEqual(Object.keys(sent.p_fragments[0]).sort(), ["fragment_type", "metadata", "page_end", "page_start", "section_heading", "section_number", "section_path", "sequence", "text", "text_hash"]);
  assert.equal(db.source_fragments[0].project_id, P, "project comes from the job, never from the worker's payload");
});

await run("complete marks the version Completed and audits it as the worker (worker_id from the token, not the body)", async () => {
  const res = await worker("complete", { job_id: jobId, worker_id: "SPOOF", outcome: "completed", extractor_version: "1.0.0", fragment_count: 2, diagnostics: { warnings: [] } }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.extraction_status, "Completed");
  assert.equal(db.rpcCalls.findLast((c) => c.name === "complete_extraction_job").args.p_worker_id, db.worker_credentials[1].id);
  const a = db.audit_log.at(-1);
  assert.deepEqual([a.changed_by, a.changed_by_name, a.new_value], [null, "Extraction worker (andrew-mac)", "Completed — 2 fragments (extractor 1.0.0)"]);
  assert.equal((await worker("complete", { job_id: jobId, outcome: "completed", extractor_version: "1.0.0", fragment_count: 2 }, token)).status, 409, "a completed job cannot be completed again");
});

await run("a completed extraction is never silently replaced (re-queue refused)", async () => {
  as("Manager");
  const res = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1 } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already been extracted; re-extract only when a newer extractor is available/);
});

await run("a failure keeps a categorised, safe error; retry is then allowed and audited as a retry", async () => {
  const V2 = "33333333-3333-4333-8333-333333333333";
  db.document_versions.push({ id: V2, document_id: "d1", project_id: P, version_number: 2, storage_path: `${P}/y.pdf`, content_type: "application/pdf", sha256: "e".repeat(64), size_bytes: 10, original_filename: "v2.pdf", extraction_status: "Queued" });
  db.extraction_jobs.push({ id: uuid(), project_id: P, document_version_id: V2, status: "Queued", trigger: "upload", queued_at: new Date().toISOString() });
  const claim = await worker("claim", {}, token);
  await worker("fragments", { job_id: claim.body.job.id, fragments: [frag(1, "partial")] }, token);
  const res = await worker("fail", { job_id: claim.body.job.id, error_category: "made_up", error_message: `Something\n   at secret.js:1\n${"x".repeat(900)}` }, token);
  assert.equal(res.status, 200);
  const j = db.extraction_jobs.find((x) => x.id === claim.body.job.id);
  assert.equal(j.error_category, "internal_error", "unknown categories are normalised");
  assert.ok(j.error_message.length <= 500 && !/\n/.test(j.error_message));
  assert.equal(db.source_fragments.filter((f) => f.extraction_job_id === j.id).length, 0, "partial output discarded");
  assert.equal(db.source_fragments.filter((f) => f.document_version_id === V1).length, 2, "version 1's fragments untouched");
  as("Manager");
  const retry = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V2 } });
  assert.equal(retry.status, 200);
  assert.equal(db.audit_log.at(-1).new_value, "Queued (manual retry)");
});

await run("System Health worker status: Manager/Admin only", async () => {
  as("Viewer");
  assert.equal((await call(routes.status.GET, "/api/worker/status", { method: "GET" })).status, 403);
  as("Manager");
  const res = await call(routes.status.GET, "/api/worker/status", { method: "GET" });
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.online, true);
  assert.equal(res.body.name, "andrew-mac");
  assert.ok(!JSON.stringify(res.body).includes("sha256") && !JSON.stringify(res.body).includes(token));
});

// ── Migration 036 ───────────────────────────────────────────────────────────

const m036 = code(read("supabase/migrations/036_document_extraction.sql"));
await run("036: one active job per version, auto-queue on upload, canonical extraction status", () => {
  assert.match(m036, /CREATE UNIQUE INDEX extraction_jobs_one_active_per_version ON public\.extraction_jobs \(document_version_id\) WHERE status IN \('Queued', 'Running'\);/);
  assert.match(m036, /CREATE TRIGGER document_versions_queue_extraction AFTER INSERT ON public\.document_versions/);
  assert.match(m036, /CHECK \(extraction_status IN \('Not Started', 'Queued', 'Running', 'Completed', 'Completed with warnings', 'Failed'\)\)/);
  assert.deepEqual([...shared.EXTRACTION_STATUSES], ["Not Started", "Queued", "Running", "Completed", "Completed with warnings", "Failed"]);
});

await run("036: fragments belong to one job of one version, are immutable, and their hashes are verified by the database", () => {
  assert.match(m036, /FOREIGN KEY \(extraction_job_id, document_version_id, project_id\)\s+REFERENCES public\.extraction_jobs \(id, document_version_id, project_id\) ON DELETE CASCADE/);
  assert.match(m036, /RAISE EXCEPTION 'source fragments are immutable/);
  assert.match(m036, /RAISE EXCEPTION 'fragments of a completed extraction cannot be deleted'/);
  assert.match(m036, /encode\(sha256\(convert_to\(f->>'text', 'UTF8'\)\), 'hex'\) IS DISTINCT FROM f->>'text_hash'/);
  assert.match(m036, /v_job\.worker_id IS DISTINCT FROM p_worker_id OR v_job\.lease_expires_at < now\(\)/, "only the leasing worker can write");
  assert.match(m036, /RAISE EXCEPTION 'This version has already been extracted; re-extraction is not supported yet'/);
});

await run("036: reads for every role, writes for nobody but the service role, nothing for anon; credentials fully hidden", () => {
  assert.match(m036, /CREATE POLICY "extraction_jobs_select" ON public\.extraction_jobs FOR SELECT TO authenticated USING \(\(SELECT public\.can_read\(\)\)\);/);
  assert.match(m036, /CREATE POLICY "source_fragments_select" ON public\.source_fragments FOR SELECT TO authenticated USING \(\(SELECT public\.can_read\(\)\)\);/);
  assert.doesNotMatch(m036, /ON public\.worker_credentials FOR/, "no policy at all on worker_credentials");
  assert.match(m036, /REVOKE ALL ON public\.worker_credentials, public\.extraction_jobs, public\.source_fragments FROM anon;/);
  assert.match(m036, /REVOKE ALL ON public\.worker_credentials FROM authenticated;/);
  assert.match(m036, /EXECUTE format\('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn\);\s+EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO service_role', fn\);/);
  assert.ok(req("../lib/schema.ts").latestMigration >= "036_document_extraction");
});

// ── UI ──────────────────────────────────────────────────────────────────────

await run("UI: everyone can view a completed extraction; only Manager/Admin see Extract / Retry; no editing of extracted text", () => {
  const page = read("components/source-documents-page.tsx");
  assert.match(page, /\{mayManage && !document\.archived_at && canQueueExtraction\(job\) \? \(/);
  assert.match(page, /\{job && \(success \|\| job\.status === "Failed"\) \? \(/, "View extraction is not role-gated");
  const viewer = read("components/extraction-viewer.tsx");
  assert.doesNotMatch(viewer, /saveRecord|createRecord|updateRecord|\.insert\(|\.update\(|contentEditable|<textarea/i, "read-only");
  assert.match(viewer, /Extracted content · read-only/);
  assert.equal(shared.canQueueExtraction(null), true);
  assert.equal(shared.canQueueExtraction({ status: "Failed" }), true);
  for (const s of ["Queued", "Running", "Completed"]) assert.equal(shared.canQueueExtraction({ status: s }), false, s);
});

await run("System Health shows the worker; token issuing is Admin-only in the UI", () => {
  assert.match(read("components/system-health-page.tsx"), /<ExtractionWorkerHealth \/>/);
  const card = read("components/extraction-worker-health.tsx");
  assert.match(card, /const isAdmin = canConfigureSystem\(user\?\.role\);/);
  assert.match(card, /\{isAdmin \? \(\n\s+<Button/);
});

await run("the local worker never talks to an external AI provider and holds no Supabase credentials; extraction uses no AI", () => {
  // Executable code only (comments legitimately say "no Supabase credentials").
  const strip = (src) => src.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
  // Extraction itself is deterministic: no model of any kind.
  assert.doesNotMatch(strip(read("local-worker/extract.js")), /openai|anthropic|gemini|generativelanguage|ollama|SUPABASE|service_role|supabase\.co/i);
  // Phase 1C: the worker may use a LOCAL Ollama (loopback-enforced in analysis/ollama.js) — never an external provider.
  const analysis = ["worker.js", "analysis/ollama.js", "analysis/pipeline.js", "analysis/prompts.js", "analysis/chunk.js", "analysis/schemas.js"].map((f) => strip(read(`local-worker/${f}`))).join("\n");
  assert.doesNotMatch(analysis, /openai|anthropic|gemini|generativelanguage|SUPABASE|service_role|supabase\.co/i);
  assert.match(read("local-worker/worker.js"), /\/api\/worker\/\$\{route\}/, "it only calls the /api/worker/* routes");
  const pkg = JSON.parse(read("local-worker/package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["jszip", "mammoth", "pdfjs-dist"], "jszip reads DOCX outline levels / list ids (already a mammoth dependency)");
  assert.match(read("local-worker/.gitignore"), /^config\.json$/m);
});

// ── Re-extraction with a newer extractor (migration 037) ───────────────────

await run("(setup) the V2 retry queued by the earlier test is processed first — the queue is oldest-first", async () => {
  const claim = await worker("claim", {}, token);
  assert.equal(claim.body.job.document_version_id, "33333333-3333-4333-8333-333333333333");
  await worker("fragments", { job_id: claim.body.job.id, fragments: [frag(1, "V2 text")] }, token);
  assert.equal((await worker("complete", { job_id: claim.body.job.id, outcome: "completed", extractor_version: "1.0.0", fragment_count: 1 }, token)).status, 200);
  assert.equal((await worker("claim", {}, token)).body.job, null);
});

await run("semantic version comparison (not lexical): 1.10.0 > 1.9.0, missing parts are zero, junk is not a version", () => {
  assert.equal(shared.compareSemver("1.10.0", "1.9.0"), 1);
  assert.equal(shared.compareSemver("1.9.0", "1.10.0"), -1);
  assert.equal(shared.compareSemver("1.1.0", "1.1.0"), 0);
  assert.equal(shared.compareSemver("1.1", "1.1.0"), 0);
  assert.equal(shared.compareSemver("2", "1.99.99"), 1);
  assert.equal(shared.compareSemver("1.0.0-beta", "1.0.0"), 0, "pre-release suffix ignored");
  assert.equal(shared.compareSemver("banana", "1.0.0"), null);
  assert.equal(shared.compareSemver(null, "1.0.0"), null);
  assert.ok("1.10.0" < "1.9.0", "…whereas a plain string comparison gets it wrong");
});

const run_ = (id, status, extractor, when, extra = {}) => ({ id, document_version_id: "v", status, extractor_version: extractor, outcome: status === "Completed" ? "completed" : null, queued_at: when, completed_at: status === "Completed" || status === "Failed" ? when : null, ...extra });
await run("eligibility: older successful run + newer worker → eligible; same version, active job, no success, unknown worker → not", () => {
  const done100 = [run_("a", "Completed", "1.0.0", "2026-09-28T10:00:00Z")];
  assert.equal(shared.canReextract("v", done100, "1.1.0"), true);
  assert.equal(shared.canReextract("v", [run_("a", "Completed", "1.1.0", "2026-09-28T10:00:00Z")], "1.1.0"), false, "same version");
  assert.equal(shared.canReextract("v", [run_("a", "Completed", "1.1.0", "2026-09-28T10:00:00Z")], "1.0.9"), false, "older worker");
  assert.equal(shared.canReextract("v", [...done100, run_("b", "Queued", null, "2026-09-28T11:00:00Z")], "1.1.0"), false, "active job");
  assert.equal(shared.canReextract("v", [...done100, run_("b", "Running", null, "2026-09-28T11:00:00Z")], "1.1.0"), false, "running job");
  assert.equal(shared.canReextract("v", [run_("a", "Failed", "1.0.0", "2026-09-28T10:00:00Z")], "1.1.0"), false, "no successful extraction (retry instead)");
  assert.equal(shared.canReextract("v", done100, null), false, "worker has not reported a version");
  assert.equal(shared.canReextract("v", [run_("a", "Completed", "1.9.0", "2026-09-28T10:00:00Z")], "1.10.0"), true, "1.10.0 is newer than 1.9.0");
});

await run("default extraction = newest SUCCESSFUL run; a newer failed run never replaces it", () => {
  const jobs = [run_("old", "Completed", "1.0.0", "2026-09-28T10:00:00Z"), run_("new", "Completed", "1.1.0", "2026-09-28T11:00:00Z"), run_("fail", "Failed", "1.2.0", "2026-09-28T12:00:00Z")];
  assert.equal(shared.latestSuccessfulJobFor("v", jobs).id, "new");
  assert.equal(shared.latestJobFor("v", jobs).id, "fail");
  assert.deepEqual(shared.jobsForVersion("v", jobs).map((j) => j.id), ["fail", "new", "old"], "full history, newest first");
});

await run("the worker's reported extractor version is recorded (heartbeat/claim) and shown in worker status", async () => {
  await worker("heartbeat", { extractor_version: "1.1.0" }, token);
  assert.equal(db.worker_credentials[1].last_seen_extractor_version, "1.1.0");
  await worker("heartbeat", { extractor_version: "drop table; --" }, token);
  assert.equal(db.worker_credentials[1].last_seen_extractor_version, "1.1.0", "malformed versions are ignored");
  as("Manager");
  assert.equal((await call(routes.status.GET, "/api/worker/status", { method: "GET" })).body.extractor_version, "1.1.0");
});

await run("Viewer is refused re-extraction; the available version comes from the worker, never the request", async () => {
  as("Viewer");
  assert.equal((await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "upgrade" } })).status, 403);
  as("Manager");
  const bad = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "sideways" } });
  assert.equal(bad.status, 400);
});

let upgradeJob;
const v1FragmentsBefore = () => JSON.stringify(db.source_fragments.filter((f) => f.document_version_id === V1 && f.extraction_job_id === jobId));
await run("Manager re-extracts V1 (1.0.0 → worker 1.1.0): a NEW job is created, old job and fragments untouched, audited", async () => {
  const oldJob = JSON.stringify(db.extraction_jobs.find((j) => j.id === jobId));
  const oldFragments = v1FragmentsBefore();
  as("Manager");
  const res = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "upgrade", available_extractor_version: "99.0.0" } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  upgradeJob = res.body.job;
  assert.notEqual(upgradeJob.id, jobId);
  assert.deepEqual([upgradeJob.trigger, upgradeJob.requested_extractor_version], ["upgrade", "1.1.0"], "the request body's version is ignored");
  assert.equal(JSON.stringify(db.extraction_jobs.find((j) => j.id === jobId)), oldJob, "previous job unchanged");
  assert.equal(v1FragmentsBefore(), oldFragments, "previous fragments unchanged");
  assert.equal(db.audit_log.at(-1).new_value, "Queued (re-extraction: extractor 1.0.0 → 1.1.0)");
  assert.equal((await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "upgrade" } })).status, 409, "only one active job");
});

await run("the new run completes and becomes the default; both runs stay readable; same-version repeat refused", async () => {
  const claim = await worker("claim", { extractor_version: "1.1.0" }, token);
  assert.equal(claim.body.job.id, upgradeJob.id);
  await worker("fragments", { job_id: upgradeJob.id, fragments: [frag(1, "New A"), frag(2, "New B"), frag(3, "New C")] }, token);
  await worker("complete", { job_id: upgradeJob.id, outcome: "completed", extractor_version: "1.1.0", fragment_count: 3 }, token);
  assert.equal(db.audit_log.at(-1).new_value, "Completed — 3 fragments (extractor 1.1.0)");
  assert.equal(shared.latestSuccessfulJobFor(V1, db.extraction_jobs).id, upgradeJob.id);
  assert.equal(db.source_fragments.filter((f) => f.extraction_job_id === jobId).length, 2, "historical run still readable");
  assert.equal(db.source_fragments.filter((f) => f.extraction_job_id === upgradeJob.id).length, 3);
  as("Manager");
  const again = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "upgrade" } });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Already extracted with extractor 1\.1\.0/);
});

await run("a failed newer run keeps the previous successful extraction as default and as the version's status", async () => {
  await worker("heartbeat", { extractor_version: "1.10.0" }, token);
  as("Manager");
  const res = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "upgrade" } });
  assert.equal(res.status, 200, "1.10.0 is newer than 1.1.0");
  const claim = await worker("claim", { extractor_version: "1.10.0" }, token);
  const failed = await worker("fail", { job_id: claim.body.job.id, error_category: "parse_error", error_message: "boom", extractor_version: "1.10.0" }, token);
  assert.equal(failed.body.extraction_status, "Completed");
  assert.equal(db.document_versions.find((v) => v.id === V1).extraction_status, "Completed");
  assert.equal(shared.latestSuccessfulJobFor(V1, db.extraction_jobs).id, upgradeJob.id);
  assert.match(db.audit_log.at(-1).new_value, /^Failed — parse_error \(extractor 1\.10\.0\); previous extraction kept \(Completed\)$/);
});

await run("re-extraction needs a reported worker version", async () => {
  db.worker_credentials[1].last_seen_extractor_version = null;
  as("Manager");
  const res = await call(queueRoute.POST, "/api/source-documents/extraction", { body: { project_id: P, version_id: V1, mode: "upgrade" } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /has not reported an extractor version/);
});

await run("037: only a semantically newer extractor may re-extract; failures keep the last success; old signature kept for deployed code", () => {
  const m037 = code(read("supabase/migrations/037_extractor_version_reextraction.sql"));
  assert.match(m037, /IF coalesce\(public\.compare_semver\(p_available_extractor_version, v_success\.extractor_version\), 0\) <= 0 THEN/);
  assert.match(m037, /\(string_to_array\(core, '\.'\)::integer\[\] \|\| ARRAY\[0, 0\]\)\[1:3\]/, "integer parts, not text");
  assert.match(m037, /ELSIF v_has_success THEN\s+RAISE EXCEPTION 'This version has already been extracted/);
  assert.match(m037, /SET extraction_status = public\.extraction_status_after_failure\(v_job\.document_version_id\)/);
  assert.match(m037, /CASE WHEN u\.status = 'Failed' THEN public\.extraction_status_after_failure\(u\.document_version_id\) ELSE u\.status END/);
  assert.match(m037, /CREATE OR REPLACE FUNCTION public\.queue_extraction_job\(p_project_id uuid, p_version_id uuid, p_user_id uuid, p_user_name text\)[\s\S]*?'manual', NULL\) q;/);
  assert.doesNotMatch(m037, /DROP POLICY|CREATE POLICY|DROP TRIGGER|source_fragments_immutable|extraction_jobs_one_active_per_version/, "RLS, immutability and one-active-job untouched");
  assert.ok(req("../lib/schema.ts").latestMigration >= "037_extractor_version_reextraction");
});

await run("UI: re-extract only for Manager/Admin with an eligible version; the viewer defaults to the newest success and lists run history", () => {
  const page = read("components/source-documents-page.tsx");
  assert.match(page, /\{mayManage && !document\.archived_at && !canQueueExtraction\(job\) && canReextract\(version\.id, jobs, availableExtractor\) \? \(/);
  assert.match(page, /Re-extract with newer extractor \(\{availableExtractor\}\)/);
  assert.match(page, /if \(!mayManage\) return;\n\s+let active = true;\n\s+loadAvailableExtractorVersion\(\)/, "Viewers never request the worker version");
  assert.doesNotMatch(page, /1\.1\.0/, "no hard-coded extractor version");
  const viewer = read("components/extraction-viewer.tsx");
  assert.match(viewer, /const defaultRun = latestSuccessfulJobFor\(version\.id, runs\) \?\? runs\[0\];/);
  assert.match(viewer, /aria-label="Extraction run"/);
});

console.log("\nAll Phase 1B extraction tests passed.\n");
