// Phase 1D integrity — a source document cannot be permanently deleted while
// promoted Requirements depend on its analysis provenance (migration 042).
// REAL route handlers, role guards and server code; only the session lookup
// and the service-role client are stubbed, the latter mirroring the database:
// the document delete cascades documents → versions → extraction jobs →
// fragments / analysis runs → proposals, and 042's BEFORE DELETE guard walks
// that whole chain. 042 itself was validated against the live database in a
// rolled-back run on a synthetic project (promotion on an older version,
// service-role refusal, version/job/run deletes refused, unpromoted document
// deleted, whole-project delete leaving no rows) before being applied.
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
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename });
  module._compile(result.outputText, filename);
};
Module._extensions[".tsx"] = Module._extensions[".ts"];

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
const req = Module.createRequire(import.meta.url);
const serverModule = req("../lib/supabase/server.ts");
const serviceRoleModule = req("../lib/supabase/service-role.ts");
const shared = req("../lib/source-documents.ts");
const analysis = req("../lib/requirement-analysis.ts");
const docsRoute = req("../app/api/source-documents/route.ts");
const archiveRoute = req("../app/api/source-documents/archive/route.ts");
const analysisRoute = req("../app/api/source-documents/analysis/route.ts");
const provenanceRoute = req("../app/api/requirements/provenance/route.ts");
const { NextRequest } = req("next/server");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function run(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`✓ ${name}`), (error) => { console.error(`✗ ${name}`); throw error; }); }

const P = "11111111-1111-4111-8111-111111111111";
const U = { Viewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Admin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const MESSAGE = shared.SOURCE_DOCUMENT_PROVENANCE_DELETE_MESSAGE;

// ── Fixture: document A (v1 + v2, promotion from v1's analysis), document B (analysed, nothing promoted), document C (never analysed)
const [DA, DB, DC] = [uuid(), uuid(), uuid()];
const [VA1, VA2, VB1, VC1] = [uuid(), uuid(), uuid(), uuid()];
const [JA1, JA2, JB1, JC1] = [uuid(), uuid(), uuid(), uuid()];
const [FA1, FA2, FB1] = [uuid(), uuid(), uuid()];
const [RA1, RA2, RB1] = [uuid(), uuid(), uuid()];
const REQ = uuid();
const doc = (id, name, current) => ({ id, project_id: P, document_name: name, document_type: "Functional Specification", current_version_id: current, archived_at: null, archived_by_name: null });
const version = (id, documentId, n) => ({ id, document_id: documentId, project_id: P, version_number: n, original_filename: `v${n}.pdf`, storage_path: `${P}/${id}.pdf`, content_type: "application/pdf" });
const job = (id, versionId) => ({ id, project_id: P, document_version_id: versionId, status: "Completed", extractor_version: "1.2.0", completed_at: "2026-09-01" });
const fragment = (id, jobId, versionId) => ({ id, project_id: P, extraction_job_id: jobId, document_version_id: versionId, sequence: 1, section_heading: "Scope", section_path: ["Spec", "Scope"], page_start: 1, page_end: 1, text: "Add a plant filter." });
const analysisRun = (id, documentId, versionId, jobId) => ({ id, project_id: P, document_id: documentId, document_version_id: versionId, extraction_job_id: jobId, status: "Completed", model: "qwen3:8b", queued_at: "2026-09-01" });
const proposal = (runId, fragmentId, o = {}) => ({ id: uuid(), analysis_run_id: runId, project_id: P, sequence: 1, origin: "ai", source_fragment_ids: [fragmentId], review_status: "Proposed", promoted_record_id: null, promoted_ref: null, promoted_at: null, promoted_by_name: null, ...o });

const db = {
  profiles: { [U.Viewer]: "Viewer", [U.Manager]: "Manager", [U.Admin]: "Admin" },
  projects: [{ id: P, name: "Project" }],
  documents: [doc(DA, "PL10 Spec", VA2), doc(DB, "Other Spec", VB1), doc(DC, "Unanalysed", VC1)],
  document_versions: [version(VA1, DA, 1), version(VA2, DA, 2), version(VB1, DB, 1), version(VC1, DC, 1)],
  extraction_jobs: [job(JA1, VA1), job(JA2, VA2), job(JB1, VB1), job(JC1, VC1)],
  source_fragments: [fragment(FA1, JA1, VA1), fragment(FA2, JA2, VA2), fragment(FB1, JB1, VB1)],
  analysis_runs: [analysisRun(RA1, DA, VA1, JA1), analysisRun(RA2, DA, VA2, JA2), analysisRun(RB1, DB, VB1, JB1)],
  requirement_proposals: [],
  requirements: [{ id: REQ, project_id: P, requirement_ref: "REP-008", title: "Plant filter", status: "Discovery", owner: null, priority: "High", category: "UI" }],
  analysis_issues: [], ai_settings: [], audit_log: [], removedObjects: [],
};
db.requirement_proposals.push(
  proposal(RA1, FA1, { review_status: "Promoted", promoted_record_id: REQ, promoted_ref: "REP-008", promoted_at: "2026-09-02", promoted_by_name: "Manager User" }),
  proposal(RA2, FA2, { review_status: "Approved" }),
  proposal(RB1, FB1, { review_status: "Rejected" }),
);
const promotedProposal = () => db.requirement_proposals.find((p) => p.promoted_record_id === REQ);

// Mirrors 042's guard: any Promoted / promoted_record_id proposal on any run of any version's extraction job.
function promotedProvenance(documentId) {
  const versions = db.document_versions.filter((v) => v.document_id === documentId).map((v) => v.id);
  const jobs = db.extraction_jobs.filter((j) => versions.includes(j.document_version_id)).map((j) => j.id);
  const runs = db.analysis_runs.filter((r) => jobs.includes(r.extraction_job_id)).map((r) => r.id);
  return db.requirement_proposals.some((p) => runs.includes(p.analysis_run_id) && (p.review_status === "Promoted" || p.promoted_record_id));
}
// The FK cascade below a document (every level refuses deletion on its own).
function cascadeDocument(documentId) {
  const versions = db.document_versions.filter((v) => v.document_id === documentId).map((v) => v.id);
  const jobs = db.extraction_jobs.filter((j) => versions.includes(j.document_version_id)).map((j) => j.id);
  const runs = db.analysis_runs.filter((r) => jobs.includes(r.extraction_job_id)).map((r) => r.id);
  db.requirement_proposals = db.requirement_proposals.filter((p) => !runs.includes(p.analysis_run_id));
  db.analysis_runs = db.analysis_runs.filter((r) => !runs.includes(r.id));
  db.source_fragments = db.source_fragments.filter((f) => !jobs.includes(f.extraction_job_id));
  db.extraction_jobs = db.extraction_jobs.filter((j) => !jobs.includes(j.id));
  db.document_versions = db.document_versions.filter((v) => !versions.includes(v.id));
  db.documents = db.documents.filter((d) => d.id !== documentId);
}
const GUARDED = { document_versions: "document versions are immutable: a version cannot be deleted on its own", extraction_jobs: "extraction jobs are history and cannot be deleted on their own", analysis_runs: "analysis runs are history and cannot be deleted on their own" };

function builder(table) {
  const q = { op: "select", filters: [], payload: null };
  const rows = () => (table === "user_profiles" ? Object.entries(db.profiles).map(([id, role]) => ({ id, role, full_name: `${role} User` })) : db[table]);
  const matches = (r) => q.filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : r[k] === v));
  const exec = () => {
    if (q.op === "insert") { const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: uuid(), ...r })); db[table].push(...list); return { data: list, error: null }; }
    if (q.op === "update") { const hit = rows().filter(matches); hit.forEach((r) => Object.assign(r, q.payload)); return { data: hit.map((r) => ({ ...r })), error: null }; }
    if (q.op === "delete") {
      const hit = rows().filter(matches);
      if (GUARDED[table] && hit.length) return { data: null, error: { code: "P0001", message: GUARDED[table] } };
      if (table === "documents") {
        for (const d of hit) {
          if (promotedProvenance(d.id) && db.projects.some((p) => p.id === d.project_id)) return { data: null, error: { code: "23001", message: MESSAGE } };
        }
        hit.forEach((d) => cascadeDocument(d.id));
        return { data: hit.map((d) => ({ id: d.id })), error: null };
      }
      db[table] = rows().filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    return { data: rows().filter(matches).map((r) => ({ ...r })), error: null };
  };
  const b = {
    select() { return b; }, eq(k, v) { q.filters.push([k, v, "eq"]); return b; }, in(k, v) { q.filters.push([k, v, "in"]); return b; },
    order() { return b; }, limit() { return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; }, delete() { q.op = "delete"; return b; },
    maybeSingle: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: r.error }; },
    single: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then(resolve, reject) { return Promise.resolve(exec()).then(resolve, reject); },
  };
  return b;
}
const storage = { from() { return { remove: async (paths) => { db.removedObjects.push(...paths); return { data: [], error: null }; } }; } };
const serviceRole = { from: builder, rpc: async () => ({ data: null, error: { code: "42883", message: "unknown function" } }), storage };
serviceRoleModule.createServiceRoleClient = () => serviceRole;
let session = null;
serverModule.createClient = async () => ({ auth: { getUser: async () => ({ data: { user: session }, error: null }) } });
const as = (role) => { session = role ? { id: U[role], email: `${role.toLowerCase()}@example.test` } : null; };
const call = async (handler, method, url, body) => {
  const res = await handler(new NextRequest(`http://localhost${url}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const archive = (documentId, archived = true) => call(archiveRoute.POST, "POST", "/api/source-documents/archive", { project_id: P, document_id: documentId, archived });
const destroy = (documentId) => call(docsRoute.DELETE, "DELETE", `/api/source-documents?project_id=${P}&document_id=${documentId}`);
const provenance = () => call(provenanceRoute.GET, "GET", `/api/requirements/provenance?project_id=${P}&requirement_id=${REQ}`);
const snapshot = () => JSON.stringify({ req: db.requirements.find((r) => r.id === REQ), proposal: promotedProposal() });

// ── Migration 042 ───────────────────────────────────────────────────────────

const m042 = code(read("supabase/migrations/042_source_document_provenance_delete_protection.sql"));

await run("042: a BEFORE DELETE guard on documents walks versions → extraction jobs → analysis runs → proposals (every version)", () => {
  assert.match(m042, /CREATE TRIGGER documents_promoted_provenance_guard BEFORE DELETE ON public\.documents\s+FOR EACH ROW EXECUTE FUNCTION public\.documents_promoted_provenance_guard\(\);/);
  const fn = m042.slice(m042.indexOf("FUNCTION public.documents_promoted_provenance_guard()"), m042.indexOf("$$;", m042.indexOf("FUNCTION public.documents_promoted_provenance_guard()")));
  assert.match(fn, /SECURITY DEFINER SET search_path = ''/);
  assert.match(fn, /FROM public\.document_versions v\s+JOIN public\.extraction_jobs j ON j\.document_version_id = v\.id\s+JOIN public\.analysis_runs r ON r\.extraction_job_id = j\.id\s+JOIN public\.requirement_proposals p ON p\.analysis_run_id = r\.id\s+WHERE v\.document_id = OLD\.id\s+AND \(p\.review_status = 'Promoted' OR p\.promoted_record_id IS NOT NULL\)\)/);
  assert.doesNotMatch(fn, /current_version_id/, "not limited to the current version");
  assert.ok(fn.includes(`RAISE EXCEPTION '${MESSAGE}'`));
  assert.match(fn, /USING ERRCODE = '23001';/);
  assert.match(m042, /REVOKE ALL ON FUNCTION public\.documents_promoted_provenance_guard\(\) FROM PUBLIC, anon, authenticated;/);
});

await run("042: whole-project delete is exempt (project row already gone); nothing else changes", () => {
  assert.match(m042, /AND EXISTS \(SELECT 1 FROM public\.projects pr WHERE pr\.id = OLD\.project_id\) THEN/);
  assert.doesNotMatch(m042, /\b(UPDATE|DELETE FROM|INSERT INTO) public\./, "no data is modified");
  assert.doesNotMatch(m042, /POLICY|GRANT |ALTER TABLE|requirements_promoted_delete_guard|promote_requirement_proposal/, "RLS, FKs, 041 and promotion untouched");
  const schema = req("../lib/schema.ts");
  assert.ok(schema.latestMigration >= "042_source_document_provenance_delete_protection");
  assert.equal(schema.schemaVersion, schema.latestMigration);
  assert.equal(schema.allMigrations.at(-1), schema.latestMigration);
  // The lower levels of the chain already refuse deletion on their own.
  assert.match(read("supabase/migrations/035_source_documents.sql"), /document versions are immutable: a version cannot be deleted on its own/);
  assert.match(read("supabase/migrations/038_requirement_analysis.sql"), /analysis runs are history and cannot be deleted on their own/);
});

// ── Normal application path ─────────────────────────────────────────────────

await run("an archived document with no promoted proposals is still permanently deleted (rows, analysis, files, audit)", async () => {
  as("Admin");
  assert.equal((await archive(DB)).status, 200);
  const res = await destroy(DB);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(db.documents.some((d) => d.id === DB), false);
  assert.equal(db.analysis_runs.some((r) => r.id === RB1), false, "its analysis history goes with it");
  assert.ok(db.removedObjects.includes(`${P}/${VB1}.pdf`));
  assert.deepEqual([db.audit_log.at(-1).action_type, db.audit_log.at(-1).entity_id], ["Delete", DB]);
  assert.equal((await archive(DC)).status, 200);
  assert.equal((await destroy(DC)).status, 200, "never-analysed documents too");
});

await run("archiving a document with promoted provenance is allowed, and it stays readable", async () => {
  as("Admin");
  const res = await archive(DA);
  assert.equal(res.status, 200);
  assert.ok(db.documents.find((d) => d.id === DA).archived_at);
  as("Viewer");
  const p = await provenance();
  assert.equal(p.status, 200);
  assert.equal(p.body.provenance.document.document_name, "PL10 Spec", "archived document still resolves in provenance");
});

await run("Admin's permanent delete is refused with the clear message — the promotion came from the OLDER version (v1; current is v2)", async () => {
  as("Admin");
  assert.equal(db.documents.find((d) => d.id === DA).current_version_id, VA2);
  const before = snapshot(), audits = db.audit_log.length;
  const res = await destroy(DA);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, MESSAGE);
  assert.match(MESSAGE, /^This source document cannot be permanently deleted because one or more promoted Requirements depend on its analysis provenance\. Keep it archived instead\.$/);
  assert.equal(db.audit_log.length, audits, "no Delete audit");
  assert.equal(db.removedObjects.some((p) => p.includes(VA1) || p.includes(VA2)), false, "no stored file removed");
  assert.equal(snapshot(), before, "Requirement and proposal unchanged");
  assert.deepEqual([promotedProposal().review_status, promotedProposal().promoted_record_id, promotedProposal().promoted_ref], ["Promoted", REQ, "REP-008"]);
  assert.deepEqual([db.document_versions.filter((v) => v.document_id === DA).length, db.analysis_runs.filter((r) => r.document_id === DA).length], [2, 2], "no analysis history deleted selectively");
});

await run("promoted provenance stays readable after the refused delete: Requirement → proposal → fragments → extraction → version → document", async () => {
  as("Viewer");
  const res = await provenance();
  const v = res.body.provenance;
  assert.deepEqual([v.proposal.sequence, v.document.id, v.version.id, v.version.version_number, v.extraction_job.id, v.fragments.map((f) => f.id)], [1, DA, VA1, 1, JA1, [FA1]]);
});

await run("Manager still cannot perform the Admin-only permanent delete; Viewer and anon neither", async () => {
  for (const [role, status] of [["Manager", 403], ["Viewer", 403], [null, 401]]) {
    as(role);
    assert.equal((await destroy(DA)).status, status, `${role ?? "anon"}`);
  }
  assert.ok(db.documents.some((d) => d.id === DA));
});

await run("Admin cannot get round it: restore + re-archive + delete, or repeated attempts, are still refused", async () => {
  as("Admin");
  assert.equal((await archive(DA, false)).status, 200, "restore allowed");
  assert.equal((await destroy(DA)).status, 409, "unarchived: must archive first (existing rule)");
  assert.equal((await archive(DA, true)).status, 200);
  for (let i = 0; i < 2; i++) assert.deepEqual([(await destroy(DA)).status, promotedProposal().promoted_record_id], [409, REQ]);
});

await run("direct database deletion is refused too — the document, and each lower level of the chain", async () => {
  const before = snapshot();
  const direct = await serviceRole.from("documents").delete().eq("id", DA).select("id");
  assert.deepEqual([direct.error?.code, direct.error?.message], ["23001", MESSAGE]);
  for (const [table, id] of [["document_versions", VA1], ["extraction_jobs", JA1], ["analysis_runs", RA1]]) {
    const r = await serviceRole.from(table).delete().eq("id", id);
    assert.ok(r.error, `${table} refuses deletion on its own`);
  }
  assert.equal(snapshot(), before);
  assert.ok(db.documents.some((d) => d.id === DA));
});

await run("the analysis list reports promoted counts, and the helper flags documents whose ANY version was promoted from", async () => {
  as("Admin");
  const res = await call(analysisRoute.GET, "GET", `/api/source-documents/analysis?project_id=${P}`);
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.runs.map((r) => [r.id, r.promoted_count]));
  assert.deepEqual([byId[RA1], byId[RA2]], [1, 0]);
  assert.equal(analysis.isProvenanceProtected(DA, res.body.runs), true, "v1's promotion protects the whole document");
  assert.equal(analysis.isProvenanceProtected(DA, res.body.runs.filter((r) => r.id !== RA1)), false);
  assert.equal(analysis.isProvenanceProtected(DA, []), false, "no runs loaded → the database still decides");
  assert.equal(analysis.isProvenanceProtected(DA, [{ document_id: DA, promoted_count: undefined }]), false);
});

await run("whole-project deletion still removes the complete graph together (guard exempt once the project row is gone)", async () => {
  // The project cascade reaches documents after the project row is deleted.
  db.projects = db.projects.filter((p) => p.id !== P);
  const res = await serviceRole.from("documents").delete().eq("project_id", P).select("id");
  assert.equal(res.error, null);
  db.requirements = db.requirements.filter((r) => r.project_id !== P);
  assert.deepEqual([db.documents, db.document_versions, db.extraction_jobs, db.analysis_runs, db.requirement_proposals, db.requirements].map((t) => t.filter((r) => r.project_id === P).length), [0, 0, 0, 0, 0, 0]);
});

// ── UI ──────────────────────────────────────────────────────────────────────

await run("UI: Delete permanently is disabled in advance with the explanation when the document has promoted provenance", () => {
  const page = read("components/source-documents-page.tsx");
  assert.match(page, /const provenanceLocked = isProvenanceProtected\(document\.id, analysisRuns\);/);
  assert.match(page, /if \(mayArchive && document\.archived_at\) items\.push\(\{ label: "Delete permanently", icon: Trash2, onSelect: \(\) => remove\(document\), destructive: true, disabled: provenanceLocked, hint: provenanceLocked \? SOURCE_DOCUMENT_PROVENANCE_DELETE_MESSAGE : undefined \}\);/);
  assert.match(page, /disabled=\{item\.disabled\}/);
  assert.match(page, /\{item\.hint \? <p id=\{`\$\{item\.label\}-hint`\}/);
  assert.match(page, /if \(mayArchive\) items\.push\(\{ label: document\.archived_at \? "Restore" : "Archive"/, "archive/restore unchanged");
  assert.match(page, /await deleteSourceDocument\(projectId, document\.id\);/, "a stale list still reaches the server, whose 409 message is shown");
  assert.match(page, /\{ \.\.\.queued, open_issue_count: 0, promoted_count: 0 \}/);
});

console.log("\nAll Phase 1D source-document provenance tests passed.\n");
