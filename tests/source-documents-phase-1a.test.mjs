// Phase 1A — Source Documents. Exercises the REAL route handlers, role guards
// (lib/api-auth.ts → lib/permissions.ts), upload/verify/hash logic
// (lib/source-documents-server.ts) and shared validation. Only the I/O edges
// are stubbed: the session lookup, and the service-role client (tables,
// RPC and Storage) with an in-memory stand-in that mirrors migration 035's
// functions. The migration itself was validated against the live database
// in rolled-back transactions, and anon access was probed over real HTTP.
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
const permissions = req("../lib/permissions.ts");
const uploadsRoute = req("../app/api/source-documents/uploads/route.ts");
const docsRoute = req("../app/api/source-documents/route.ts");
const downloadRoute = req("../app/api/source-documents/download/route.ts");
const currentRoute = req("../app/api/source-documents/current/route.ts");
const archiveRoute = req("../app/api/source-documents/archive/route.ts");
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const PDF = (tag) => new TextEncoder().encode(`%PDF-1.7\n% ${tag}\n1 0 obj << >> endobj\ntrailer\n%%EOF`);
const DOCX = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("....[Content_Types].xml....word/document.xml....")]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── In-memory service-role stand-in ─────────────────────────────────────────
let session = null;
const db = { projects: [{ id: P1 }, { id: P2 }], documents: [], document_versions: [], audit_log: [], profiles: {}, objects: new Map(), removed: [] };
const tables = { projects: () => db.projects, documents: () => db.documents, document_versions: () => db.document_versions, audit_log: () => db.audit_log };
let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`;

function builder(table) {
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles"
    ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` }))
    : tables[table]());
  const match = () => rows().filter((r) => q.filters.every(([k, v]) => r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = Array.isArray(q.payload) ? q.payload : [q.payload]; tables[table]().push(...list.map((r) => ({ id: uuid(), ...r }))); return list; }
    if (q.op === "update") { const hit = match(); hit.forEach((r) => Object.assign(r, q.payload)); return hit; }
    if (q.op === "delete") {
      const hit = match(); db[table] = tables[table]().filter((r) => !hit.includes(r));
      if (table === "documents") db.document_versions = db.document_versions.filter((v) => !hit.some((d) => d.id === v.document_id));
      return hit;
    }
    return match();
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v]); return b; }, order() { return b; }, limit() { return b; }, in() { return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; }, delete() { q.op = "delete"; return b; },
    maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }),
    single: async () => ({ data: exec()[0] ?? null, error: null }),
    then(resolve, reject) { return Promise.resolve({ data: exec(), error: null }).then(resolve, reject); },
  };
  return b;
}

function rpc(name, a) {
  const err = (code, message) => ({ data: null, error: { code, message } });
  if (name === "register_source_document_version") {
    let doc; let prev = null; let next = 1; let created = false; const versionId = uuid();
    if (!a.p_document_id) {
      doc = { id: uuid(), project_id: a.p_project_id, document_name: a.p_title.trim(), document_type: a.p_document_type, notes: a.p_notes, current_version_id: versionId, created_by: a.p_user_id, created_by_name: a.p_user_name, created_at: new Date().toISOString(), archived_at: null, archived_by_name: null, uploaded_at: new Date().toISOString(), storage_path: null };
      db.documents.push(doc); created = true;
    } else {
      doc = db.documents.find((d) => d.id === a.p_document_id && d.project_id === a.p_project_id);
      if (!doc) return err("P0002", "Source document not found in this project");
      if (doc.archived_at) return err("55000", "This source document is archived; restore it before uploading a new version");
      const mine = db.document_versions.filter((v) => v.document_id === doc.id);
      const dup = mine.find((v) => v.sha256 === a.p_sha256);
      if (dup) return err("23505", `This file is identical to version ${dup.version_number} of this document`);
      prev = mine.find((v) => v.id === doc.current_version_id)?.version_number ?? null;
      next = Math.max(0, ...mine.map((v) => v.version_number)) + 1;
    }
    db.document_versions.push({ id: versionId, document_id: doc.id, project_id: a.p_project_id, version_number: next, original_filename: a.p_original_filename, storage_bucket: "source-documents", storage_path: a.p_storage_path, sha256: a.p_sha256, content_type: a.p_content_type, size_bytes: a.p_size_bytes, uploaded_by: a.p_user_id, uploaded_by_name: a.p_user_name, uploaded_at: new Date().toISOString(), is_original: true, extraction_status: "Not Started", analysis_status: "Not Started", status_updated_at: null });
    doc.current_version_id = versionId;
    return { data: [{ document_id: doc.id, version_id: versionId, version_number: next, previous_version_number: prev, created_document: created }], error: null };
  }
  if (name === "set_current_document_version") {
    const doc = db.documents.find((d) => d.id === a.p_document_id && d.project_id === a.p_project_id);
    if (!doc) return err("P0002", "Source document not found in this project");
    const version = db.document_versions.find((v) => v.id === a.p_version_id && v.document_id === doc.id);
    if (!version) return err("P0002", "That version does not belong to this document");
    const prev = db.document_versions.find((v) => v.id === doc.current_version_id)?.version_number ?? null;
    doc.current_version_id = version.id;
    return { data: [{ previous_version_number: prev, current_version_number: version.version_number }], error: null };
  }
  return err("42883", "unknown function");
}

const storage = {
  from(bucket) {
    assert.equal(bucket, "source-documents");
    return {
      createSignedUploadUrl: async (p) => (db.objects.has(p) ? { data: null, error: { message: "The resource already exists" } } : { data: { path: p, token: `token:${p}`, signedUrl: `https://example.supabase.co/upload/${p}` }, error: null }),
      download: async (p) => (db.objects.has(p) ? { data: new Blob([db.objects.get(p)]), error: null } : { data: null, error: { message: "Object not found" } }),
      createSignedUrl: async (p, seconds, opts) => ({ data: { signedUrl: `https://example.supabase.co/sign/${p}?expires=${seconds}${opts?.download ? `&download=${encodeURIComponent(opts.download)}` : ""}` }, error: null }),
      remove: async (paths) => { paths.forEach((p) => { db.objects.delete(p); db.removed.push(p); }); return { data: [], error: null }; },
    };
  },
};
serviceRoleModule.createServiceRoleClient = () => ({ from: builder, rpc: async (n, a) => rpc(n, a), storage });
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
db.profiles = { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" };
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };

const call = async (handler, method, url, body) => {
  const res = await handler(new NextRequest(`http://localhost${url}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const prepare = (body) => call(uploadsRoute.POST, "POST", "/api/source-documents/uploads", body);
const finalize = (body) => call(docsRoute.POST, "POST", "/api/source-documents", body);
const download = (projectId, versionId, disposition = "inline") => call(downloadRoute.GET, "GET", `/api/source-documents/download?project_id=${projectId}&version_id=${versionId}&disposition=${disposition}`);

/** Full Manager/Admin flow: prepare → (browser) upload bytes to the signed path → finalize. */
async function upload({ projectId = P1, filename = "spec.pdf", bytes = PDF("v1"), documentId, title = "Functional Spec", documentType = "Functional Specification" } = {}) {
  const prepared = await prepare({ project_id: projectId, document_id: documentId, filename, content_type: "", size: bytes.length });
  if (prepared.status !== 200) return prepared;
  db.objects.set(prepared.body.path, bytes);
  return finalize({ project_id: projectId, storage_path: prepared.body.path, original_filename: filename, document_id: documentId, title, document_type: documentType });
}

// ── Shared validation ───────────────────────────────────────────────────────

await run("only PDF and DOCX are accepted; unsupported types are refused clearly", () => {
  assert.equal(shared.checkUploadCandidate({ filename: "Spec.PDF", contentType: "application/pdf", size: 10 }).ok, true);
  assert.equal(shared.checkUploadCandidate({ filename: "design.docx", contentType: "", size: 10 }).ok, true, "browsers that report no DOCX type are tolerated");
  assert.match(shared.checkUploadCandidate({ filename: "notes.doc", size: 10 }).error, /Only PDF \(\.pdf\) and Word \(\.docx\)/);
  assert.match(shared.checkUploadCandidate({ filename: "run.exe", size: 10 }).error, /Unsupported file type/);
  assert.match(shared.checkUploadCandidate({ filename: "fake.pdf", contentType: "image/png", size: 10 }).error, /does not match/);
});

await run("oversized and empty files are refused (25 MB limit)", () => {
  assert.equal(shared.MAX_SOURCE_DOCUMENT_BYTES, 25 * 1024 * 1024);
  assert.match(shared.checkUploadCandidate({ filename: "big.pdf", size: shared.MAX_SOURCE_DOCUMENT_BYTES + 1 }).error, /maximum is 25\.0 MB/);
  assert.equal(shared.checkUploadCandidate({ filename: "edge.pdf", size: shared.MAX_SOURCE_DOCUMENT_BYTES }).ok, true);
  assert.match(shared.checkUploadCandidate({ filename: "empty.pdf", size: 0 }).error, /empty/);
});

await run("file type is identified from the bytes, not the name", () => {
  assert.equal(shared.detectSourceDocumentKind(PDF("x")), "pdf");
  assert.equal(shared.detectSourceDocumentKind(DOCX()), "docx");
  assert.equal(shared.detectSourceDocumentKind(new TextEncoder().encode("MZ not a pdf")), null);
  assert.equal(shared.detectSourceDocumentKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), null, "a ZIP that is not a Word document");
});

await run("storage paths are project-scoped and never built from the uploaded file name", () => {
  const p = shared.buildSourceDocumentPath(P1, "33333333-3333-4333-8333-333333333333", "pdf");
  assert.equal(p, `${P1}/33333333-3333-4333-8333-333333333333.pdf`);
  assert.equal(shared.isIssuedPathForProject(p, P1), true);
  assert.equal(shared.isIssuedPathForProject(p, P2), false);
  assert.equal(shared.isIssuedPathForProject(`${P1}/../${P2}/x.pdf`, P1), false);
  assert.equal(shared.isIssuedPathForProject(`${P1}/My Spec.pdf`, P1), false);
});

// ── Anonymous & Viewer ──────────────────────────────────────────────────────

await run("anonymous callers are refused everywhere, including signed download links", async () => {
  as(null);
  assert.equal((await prepare({ project_id: P1, filename: "a.pdf", size: 5 })).status, 401);
  assert.equal((await finalize({ project_id: P1 })).status, 401);
  assert.equal((await download(P1, U.Viewer)).status, 401, "a signed URL requires authentication");
  assert.equal((await call(currentRoute.PATCH, "PATCH", "/api/source-documents/current", {})).status, 401);
  assert.equal((await call(archiveRoute.POST, "POST", "/api/source-documents/archive", {})).status, 401);
  assert.equal((await call(docsRoute.DELETE, "DELETE", `/api/source-documents?project_id=${P1}&document_id=${P1}`)).status, 401);
});

await run("Viewer cannot upload, version, change current, archive or delete", async () => {
  as("Viewer");
  for (const res of [
    await prepare({ project_id: P1, filename: "a.pdf", size: 5 }),
    await finalize({ project_id: P1 }),
    await call(currentRoute.PATCH, "PATCH", "/api/source-documents/current", {}),
    await call(archiveRoute.POST, "POST", "/api/source-documents/archive", {}),
    await call(docsRoute.DELETE, "DELETE", `/api/source-documents?project_id=${P1}&document_id=${P1}`),
  ]) assert.equal(res.status, 403);
  assert.equal(db.documents.length, 0);
});

// ── Manager upload and versioning ───────────────────────────────────────────

let docId, v1Id, v2Id;
const v1Bytes = PDF("first"), v2Bytes = PDF("second");

await run("Manager uploads a source document: version 1 is created, current, hashed and audited", async () => {
  as("Manager");
  const res = await upload({ bytes: v1Bytes });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { document, version } = res.body;
  docId = document.id; v1Id = version.id;
  assert.equal(document.project_id, P1);
  assert.equal(document.document_name, "Functional Spec");
  assert.equal(document.current_version_id, version.id);
  assert.deepEqual({ n: version.version_number, name: version.original_filename, type: version.content_type, size: version.size_bytes, by: version.uploaded_by, byName: version.uploaded_by_name },
    { n: 1, name: "spec.pdf", type: "application/pdf", size: v1Bytes.length, by: U.Manager, byName: "Manager User" });
  assert.equal(version.sha256, sha(v1Bytes), "server-computed SHA-256 of the stored bytes");
  assert.match(version.storage_path, new RegExp(`^${P1}/[0-9a-f-]{36}\\.pdf$`));
  const audits = db.audit_log.map((a) => `${a.entity_type}:${a.action_type}:${a.field_name}`);
  assert.deepEqual(audits, ["documents:Create:source_document", "document_versions:Create:version"]);
  assert.ok(db.audit_log.every((a) => a.changed_by === U.Manager && a.changed_by_name === "Manager User" && a.project_id === P1));
});

await run("uploading a revision creates version 2 — version 1 is kept, not overwritten — and v2 becomes current", async () => {
  as("Manager");
  const beforePath = db.document_versions.find((v) => v.id === v1Id).storage_path;
  const res = await upload({ documentId: docId, filename: "spec-rev-b.pdf", bytes: v2Bytes, title: undefined, documentType: undefined });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  v2Id = res.body.version.id;
  assert.equal(res.body.version.version_number, 2);
  assert.notEqual(res.body.version.storage_path, beforePath, "a new object, never the old path");
  assert.equal(db.document_versions.filter((v) => v.document_id === docId).length, 2);
  assert.deepEqual(db.objects.get(beforePath), v1Bytes, "v1's stored file is untouched");
  assert.equal(db.documents.find((d) => d.id === docId).current_version_id, v2Id);
  const last = db.audit_log.slice(-2).map((a) => [a.entity_type, a.action_type, a.field_name, a.old_value, a.new_value]);
  assert.deepEqual(last[1], ["documents", "Update", "current_version", "v1", "v2"]);
  assert.equal(last[0][0], "document_versions");
});

await run("the old version remains accessible via a short-lived signed URL", async () => {
  as("Viewer");
  const res = await download(P1, v1Id, "attachment");
  assert.equal(res.status, 200);
  assert.match(res.body.url, /\/sign\/.*\?expires=60&download=spec\.pdf$/);
  assert.equal(res.body.expires_in, 60);
  assert.equal((await download(P1, v2Id, "inline")).status, 200, "Viewer can view the current version");
});

await run("the current version can be switched back to v1, and the change is audited", async () => {
  as("Manager");
  const res = await call(currentRoute.PATCH, "PATCH", "/api/source-documents/current", { project_id: P1, document_id: docId, version_id: v1Id });
  assert.equal(res.status, 200);
  assert.equal(db.documents.find((d) => d.id === docId).current_version_id, v1Id);
  const a = db.audit_log.at(-1);
  assert.deepEqual([a.field_name, a.old_value, a.new_value], ["current_version", "v2", "v1"]);
});

await run("an identical file is refused as a new version, and its upload is discarded", async () => {
  as("Manager");
  const res = await upload({ documentId: docId, filename: "again.pdf", bytes: v2Bytes });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /identical to version 2/);
  assert.ok(db.removed.some((p) => p.endsWith(".pdf")), "the orphaned object was removed");
  assert.equal(db.document_versions.filter((v) => v.document_id === docId).length, 2);
});

await run("a renamed non-PDF, and an oversized stored object, are refused at verification", async () => {
  as("Manager");
  const fake = await upload({ filename: "malware.pdf", bytes: new TextEncoder().encode("MZ...not a pdf") });
  assert.equal(fake.status, 400);
  assert.match(fake.body.error, /not a valid PDF/);
  const prepared = await prepare({ project_id: P1, filename: "huge.pdf", size: 10 });
  const huge = new Uint8Array(shared.MAX_SOURCE_DOCUMENT_BYTES + 1); huge.set(PDF("x"));
  db.objects.set(prepared.body.path, huge);
  const res = await finalize({ project_id: P1, storage_path: prepared.body.path, original_filename: "huge.pdf", title: "Huge" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /25 MB limit/);
  assert.equal(db.objects.has(prepared.body.path), false);
});

await run("unsupported types and over-limit sizes are refused before any upload URL is issued", async () => {
  as("Manager");
  assert.match((await prepare({ project_id: P1, filename: "a.xlsx", size: 10 })).body.error, /Unsupported file type/);
  assert.match((await prepare({ project_id: P1, filename: "a.pdf", size: shared.MAX_SOURCE_DOCUMENT_BYTES + 1 })).body.error, /maximum/);
});

await run("project mismatches are refused (unknown project, foreign path, foreign document, foreign version)", async () => {
  as("Manager");
  assert.equal((await prepare({ project_id: "99999999-9999-4999-8999-999999999999", filename: "a.pdf", size: 10 })).status, 404);
  assert.equal((await prepare({ project_id: P2, document_id: docId, filename: "a.pdf", size: 10 })).status, 404, "P1's document is not in P2");
  const foreign = await prepare({ project_id: P2, filename: "a.pdf", size: 10 });
  db.objects.set(foreign.body.path, PDF("p2"));
  assert.equal((await finalize({ project_id: P1, storage_path: foreign.body.path, original_filename: "a.pdf", title: "x" })).status, 400, "a P2 path cannot be recorded against P1");
  as("Viewer");
  const res = await download(P2, v1Id);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /does not belong to this project/);
});

await run("DOCX uploads work end to end", async () => {
  as("Admin");
  const res = await upload({ filename: "Design.docx", bytes: DOCX(), title: "Design", documentType: "Design Document" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.version.content_type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

// ── Admin archive / delete ──────────────────────────────────────────────────

await run("Manager cannot archive or delete; Admin archives, which blocks new versions", async () => {
  as("Manager");
  assert.equal((await call(archiveRoute.POST, "POST", "/api/source-documents/archive", { project_id: P1, document_id: docId, archived: true })).status, 403);
  assert.equal((await call(docsRoute.DELETE, "DELETE", `/api/source-documents?project_id=${P1}&document_id=${docId}`)).status, 403);
  as("Admin");
  assert.equal((await call(docsRoute.DELETE, "DELETE", `/api/source-documents?project_id=${P1}&document_id=${docId}`)).status, 409, "must be archived first");
  const archived = await call(archiveRoute.POST, "POST", "/api/source-documents/archive", { project_id: P1, document_id: docId, archived: true });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.document.archived_at);
  assert.deepEqual([db.audit_log.at(-1).action_type, db.audit_log.at(-1).new_value], ["Status Change", "Archived"]);
  as("Manager");
  assert.equal((await prepare({ project_id: P1, document_id: docId, filename: "v3.pdf", size: 10 })).status, 409);
});

await run("Admin permanently deletes an archived document: rows, all version files, and a Delete audit", async () => {
  as("Admin");
  const paths = db.document_versions.filter((v) => v.document_id === docId).map((v) => v.storage_path);
  const res = await call(docsRoute.DELETE, "DELETE", `/api/source-documents?project_id=${P1}&document_id=${docId}`);
  assert.equal(res.status, 200);
  assert.equal(db.documents.some((d) => d.id === docId), false);
  assert.equal(db.document_versions.some((v) => v.document_id === docId), false);
  assert.ok(paths.every((p) => !db.objects.has(p)));
  assert.deepEqual([db.audit_log.at(-1).action_type, db.audit_log.at(-1).old_value], ["Delete", "2 versions"]);
});

await run("role rules match the agreed model", () => {
  const expect = { canReadProjectData: [true, true, true], canManageSourceDocuments: [true, true, false], canArchiveOrDeleteSourceDocuments: [true, false, false] };
  for (const [fn, [admin, manager, viewer]] of Object.entries(expect)) {
    assert.deepEqual([permissions[fn]("Admin"), permissions[fn]("Manager"), permissions[fn]("Viewer"), permissions[fn](null)], [admin, manager, viewer, false], fn);
  }
});

// ── Migration 035 and UI ────────────────────────────────────────────────────

const m035 = code(read("supabase/migrations/035_source_documents.sql"));

await run("035: private bucket (25 MB, PDF/DOCX), no storage policies, no public access", () => {
  assert.match(m035, /INSERT INTO storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+VALUES \(\s+'source-documents', 'source-documents', false, 26214400,/);
  assert.doesNotMatch(m035, /ON storage\.objects/, "no storage.objects policy: only signed URLs / service role");
  assert.doesNotMatch(m035, /public\s*=\s*true|, true, 26214400/);
});

await run("035: Viewer reads under RLS; no direct writes; write functions are service-role only; anon has nothing", () => {
  assert.match(m035, /CREATE POLICY "document_versions_select" ON public\.document_versions\s+FOR SELECT TO authenticated USING \(\(SELECT public\.can_read\(\)\)\);/);
  for (const p of ["documents_insert", "documents_update", "documents_delete"]) assert.match(m035, new RegExp(`DROP POLICY IF EXISTS "${p}" ON public\\.documents;`));
  assert.match(m035, /REVOKE ALL ON public\.document_versions FROM anon;/);
  assert.match(m035, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.document_versions FROM authenticated;/);
  assert.match(m035, /REVOKE ALL ON FUNCTION public\.register_source_document_version\([^)]*\) FROM PUBLIC, anon, authenticated;/);
  assert.match(m035, /GRANT EXECUTE ON FUNCTION public\.register_source_document_version\([^)]*\) TO service_role;/);
});

await run("035: versions are immutable, numbered monotonically, and exactly one is current", () => {
  assert.match(m035, /CONSTRAINT document_versions_document_version_key UNIQUE \(document_id, version_number\)/);
  assert.match(m035, /SELECT coalesce\(max\(v\.version_number\), 0\) \+ 1 INTO v_next/);
  assert.match(m035, /FOR UPDATE;/, "the parent document is locked while numbering");
  assert.match(m035, /FOREIGN KEY \(current_version_id, id\) REFERENCES public\.document_versions \(id, document_id\)\s+DEFERRABLE INITIALLY DEFERRED;/);
  assert.match(m035, /ALTER TABLE public\.documents ALTER COLUMN current_version_id SET NOT NULL;/);
  assert.match(m035, /BEFORE UPDATE OR DELETE ON public\.document_versions/);
  assert.match(m035, /RAISE EXCEPTION 'document versions are immutable: only extraction\/analysis status may change'/);
  assert.match(m035, /FOREIGN KEY \(document_id, project_id\) REFERENCES public\.documents \(id, project_id\) ON DELETE CASCADE/);
  assert.match(m035, /sha256\s+text\s+NOT NULL CHECK \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
});

await run("035 adds to the existing documents table without changing existing rows", () => {
  assert.match(m035, /ALTER TABLE public\.documents\s+ADD COLUMN IF NOT EXISTS current_version_id uuid,/);
  const topLevel = m035.replace(/AS \$\$[\s\S]*?\$\$;/g, "");
  assert.doesNotMatch(topLevel, /\bUPDATE public\.|\bDELETE FROM public\.|DROP TABLE|DROP COLUMN/);
  assert.equal(req("../lib/schema.ts").latestMigration, "035_source_documents");
});

await run("UI: upload / new-version controls only for Manager+; archive / delete only for Admin; no generic document form", () => {
  const page = read("components/source-documents-page.tsx");
  assert.match(page, /const mayManage = canManageSourceDocuments\(user\?\.role\);/);
  assert.match(page, /const mayArchive = canArchiveOrDeleteSourceDocuments\(user\?\.role\);/);
  assert.match(page, /\{mayManage \? \(\n\s+<Button onClick=\{\(\) => setUploadTarget\(\{ mode: "new" \}\)\}/);
  assert.match(page, /\{mayManage && !document\.archived_at \? \(\n\s+<Button[^\n]*Upload New Version/);
  assert.match(page, /\{mayArchive && document\.archived_at \? \(/);
  assert.match(read("app/[section]/page.tsx"), /if \(section === "documents"\) return <SourceDocumentsPage \/>;/);
  assert.doesNotMatch(read("components/form-dialog.tsx") + read("components/app-client.tsx"), /Document upload will be added in v2/);
});

console.log("\nAll Phase 1A source-document tests passed.\n");
