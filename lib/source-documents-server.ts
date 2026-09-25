// ── Source Documents (Phase 1A) — server orchestration ──────────────────────
//
// Server-only. Every function takes the service-role client; the calling
// route has already applied the role guard (lib/api-auth.ts). Files never
// pass through a route body: the browser uploads straight to the private
// bucket with a one-time signed upload URL, then `finalizeUpload` verifies
// the stored object (size, real file type from its bytes), hashes it and
// records the version atomically (register_source_document_version).
// Audit rows go to the canonical audit_log, exactly like the other
// server-managed governance routes (e.g. the Go/No-Go decision route).

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOCUMENT_TYPE_OPTIONS,
  MAX_SOURCE_DOCUMENT_BYTES,
  SOURCE_DOCUMENTS_BUCKET,
  buildSourceDocumentPath,
  checkUploadCandidate,
  detectSourceDocumentKind,
  extensionOf,
  isIssuedPathForProject,
  typeForExtension,
} from "@/lib/source-documents";

export type Actor = { userId: string | null; displayName: string };
export type ServiceResult = { status: number; body: Record<string, unknown> };

const SIGNED_URL_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string): ServiceResult => ({ status, body: { error } });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function projectExists(db: SupabaseClient, projectId: string): Promise<boolean> {
  const { data } = await db.from("projects").select("id").eq("id", projectId).maybeSingle();
  return Boolean(data);
}

async function loadDocument(db: SupabaseClient, projectId: string, documentId: string) {
  const { data } = await db.from("documents").select("*").eq("id", documentId).eq("project_id", projectId).maybeSingle();
  return data as { id: string; project_id: string; document_name: string; archived_at: string | null; current_version_id: string } | null;
}

type AuditRow = {
  project_id: string; entity_type: string; entity_id: string; entity_name: string;
  action_type: "Create" | "Update" | "Delete" | "Status Change";
  field_name?: string | null; old_value?: string | null; new_value?: string | null;
};

/** Writes audit rows; returns a warning (never throws) so the recorded change is not undone. */
async function audit(db: SupabaseClient, actor: Actor, rows: AuditRow[]): Promise<string | null> {
  if (rows.length === 0) return null;
  const { error } = await db.from("audit_log").insert(rows.map((row) => ({
    field_name: null, old_value: null, new_value: null, ...row,
    changed_by: actor.userId, changed_by_name: actor.displayName,
  })));
  if (error) {
    console.error("[source-documents] audit write failed:", error.message);
    return error.message;
  }
  return null;
}

/** Maps the SQL function's deliberate errors to HTTP responses. */
function mapDbError(error: { code?: string; message?: string }): ServiceResult {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "P0002": return fail(404, message);
    case "55000": return fail(409, message);
    case "23505": return fail(409, message);
    case "22023": return fail(400, message);
    case "23514": return fail(400, `The file was refused by a database rule: ${message}`);
    default: return fail(500, message);
  }
}

// ── 1. Prepare: validate, then issue a one-time signed upload URL ───────────

export async function prepareUpload(db: SupabaseClient, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id);
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  const check = checkUploadCandidate({ filename: body.filename, contentType: body.content_type, size: body.size });
  if (!check.ok) return fail(400, check.error);
  if (!(await projectExists(db, projectId))) return fail(404, "Project not found");

  const documentId = text(body.document_id);
  if (documentId) {
    if (!UUID.test(documentId)) return fail(400, "document_id is invalid");
    const doc = await loadDocument(db, projectId, documentId);
    if (!doc) return fail(404, "Source document not found in this project");
    if (doc.archived_at) return fail(409, "This source document is archived; restore it before uploading a new version");
  }

  const path = buildSourceDocumentPath(projectId, randomUUID(), check.extension);
  // upsert is false by default: an existing object is never overwritten.
  const { data, error } = await db.storage.from(SOURCE_DOCUMENTS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return fail(500, `Could not prepare the upload: ${error?.message ?? "unknown error"}`);
  return { status: 200, body: { path: data.path ?? path, token: data.token, content_type: check.contentType, max_bytes: MAX_SOURCE_DOCUMENT_BYTES } };
}

// ── 2. Finalize: verify the stored object, hash it, record the version ──────

export async function finalizeUpload(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id);
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  const path = body.storage_path;
  if (!isIssuedPathForProject(path, projectId)) return fail(400, "storage_path does not belong to this project");
  const originalFilename = text(body.original_filename);
  const nameCheck = checkUploadCandidate({ filename: originalFilename, size: 1 });
  if (!nameCheck.ok) return fail(400, nameCheck.error);
  if (extensionOf(path) !== nameCheck.extension) return fail(400, "The uploaded file does not match its original file name");

  const documentId = text(body.document_id) || null;
  if (documentId && !UUID.test(documentId)) return fail(400, "document_id is invalid");
  const title = text(body.title);
  const documentType = text(body.document_type) || null;
  const notes = text(body.notes) || null;
  if (!documentId) {
    if (!title) return fail(400, "A document title is required");
    if (title.length > 200) return fail(400, "The title is too long (maximum 200 characters)");
    if (documentType && !(DOCUMENT_TYPE_OPTIONS as readonly string[]).includes(documentType)) return fail(400, "Unknown document type");
    if (notes && notes.length > 4000) return fail(400, "The description is too long (maximum 4000 characters)");
  }
  if (!(await projectExists(db, projectId))) return fail(404, "Project not found");

  const { data: existing } = await db.from("document_versions").select("id").eq("storage_path", path).maybeSingle();
  if (existing) return fail(409, "This upload has already been recorded");

  const storage = db.storage.from(SOURCE_DOCUMENTS_BUCKET);
  const discard = async () => { await storage.remove([path]); };

  const { data: blob, error: downloadError } = await storage.download(path);
  if (downloadError || !blob) return fail(400, "The uploaded file was not found in storage — please upload it again");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0) { await discard(); return fail(400, "The file is empty"); }
  if (bytes.length > MAX_SOURCE_DOCUMENT_BYTES) { await discard(); return fail(400, "The file is larger than the 25 MB limit"); }
  const kind = detectSourceDocumentKind(bytes);
  if (kind !== nameCheck.extension) {
    await discard();
    return fail(400, `The file's contents are not a valid ${typeForExtension(nameCheck.extension)?.label ?? "document"} — only genuine PDF and DOCX files are accepted`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const { data: rows, error } = await db.rpc("register_source_document_version", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_title: title || null,
    p_document_type: documentType,
    p_notes: notes,
    p_storage_path: path,
    p_original_filename: originalFilename,
    p_content_type: nameCheck.contentType,
    p_size_bytes: bytes.length,
    p_sha256: sha256,
    p_user_id: actor.userId,
    p_user_name: actor.displayName,
  });
  if (error) { await discard(); return mapDbError(error); }
  const result = (Array.isArray(rows) ? rows[0] : rows) as {
    document_id: string; version_id: string; version_number: number; previous_version_number: number | null; created_document: boolean;
  };

  const [{ data: document }, { data: version }] = await Promise.all([
    db.from("documents").select("*").eq("id", result.document_id).maybeSingle(),
    db.from("document_versions").select("*").eq("id", result.version_id).maybeSingle(),
  ]);
  const docTitle = String((document as { document_name?: string } | null)?.document_name ?? title);

  const auditRows: AuditRow[] = [];
  if (result.created_document) {
    auditRows.push({ project_id: projectId, entity_type: "documents", entity_id: result.document_id, entity_name: docTitle, action_type: "Create", field_name: "source_document", new_value: docTitle });
  }
  auditRows.push({
    project_id: projectId, entity_type: "document_versions", entity_id: result.version_id,
    entity_name: `${docTitle} v${result.version_number}`, action_type: "Create", field_name: "version",
    new_value: `v${result.version_number} — ${originalFilename} (sha256 ${sha256.slice(0, 12)}…)`,
  });
  if (!result.created_document) {
    auditRows.push({
      project_id: projectId, entity_type: "documents", entity_id: result.document_id, entity_name: docTitle,
      action_type: "Update", field_name: "current_version",
      old_value: result.previous_version_number ? `v${result.previous_version_number}` : null, new_value: `v${result.version_number}`,
    });
  }
  const auditWarning = await audit(db, actor, auditRows);
  return { status: 200, body: { document, version, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

// ── 3. Download / view: short-lived signed URL after a project check ────────

export async function signDownload(db: SupabaseClient, params: { projectId: string; versionId: string; disposition: string }): Promise<ServiceResult> {
  if (!UUID.test(params.projectId) || !UUID.test(params.versionId)) return fail(400, "project_id and version_id are required");
  const { data: version } = await db.from("document_versions")
    .select("id, project_id, storage_path, original_filename").eq("id", params.versionId).maybeSingle();
  if (!version) return fail(404, "Document version not found");
  const row = version as { project_id: string; storage_path: string; original_filename: string };
  if (row.project_id !== params.projectId) return fail(403, "That document version does not belong to this project");
  const download = params.disposition === "attachment" ? row.original_filename : undefined;
  const { data, error } = await db.storage.from(SOURCE_DOCUMENTS_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_SECONDS, download ? { download } : undefined);
  if (error || !data?.signedUrl) return fail(500, `Could not create a download link: ${error?.message ?? "unknown error"}`);
  return { status: 200, body: { url: data.signedUrl, expires_in: SIGNED_URL_SECONDS, filename: row.original_filename } };
}

// ── 4. Choose the current version ───────────────────────────────────────────

export async function setCurrentVersion(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), documentId = text(body.document_id), versionId = text(body.version_id);
  if (![projectId, documentId, versionId].every((id) => UUID.test(id))) return fail(400, "project_id, document_id and version_id are required");
  const { data: rows, error } = await db.rpc("set_current_document_version", { p_project_id: projectId, p_document_id: documentId, p_version_id: versionId });
  if (error) return mapDbError(error);
  const result = (Array.isArray(rows) ? rows[0] : rows) as { previous_version_number: number | null; current_version_number: number };
  const document = await loadDocument(db, projectId, documentId);
  let auditWarning: string | null = null;
  if (result.previous_version_number !== result.current_version_number) {
    auditWarning = await audit(db, actor, [{
      project_id: projectId, entity_type: "documents", entity_id: documentId, entity_name: document?.document_name ?? "Source document",
      action_type: "Update", field_name: "current_version",
      old_value: result.previous_version_number ? `v${result.previous_version_number}` : null, new_value: `v${result.current_version_number}`,
    }]);
  }
  return { status: 200, body: { document, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

// ── 5. Archive / restore (Admin) ────────────────────────────────────────────

export async function setArchived(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), documentId = text(body.document_id);
  if (!UUID.test(projectId) || !UUID.test(documentId)) return fail(400, "project_id and document_id are required");
  if (typeof body.archived !== "boolean") return fail(400, "archived must be true or false");
  const doc = await loadDocument(db, projectId, documentId);
  if (!doc) return fail(404, "Source document not found in this project");
  if (Boolean(doc.archived_at) === body.archived) return { status: 200, body: { document: doc } };
  const { data: document, error } = await db.from("documents")
    .update(body.archived ? { archived_at: new Date().toISOString(), archived_by_name: actor.displayName } : { archived_at: null, archived_by_name: null })
    .eq("id", documentId).eq("project_id", projectId).select("*").maybeSingle();
  if (error || !document) return fail(500, error?.message ?? "Could not update the document");
  const auditWarning = await audit(db, actor, [{
    project_id: projectId, entity_type: "documents", entity_id: documentId, entity_name: doc.document_name,
    action_type: "Status Change", field_name: "archived",
    old_value: body.archived ? "Active" : "Archived", new_value: body.archived ? "Archived" : "Active",
  }]);
  return { status: 200, body: { document, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

// ── 6. Permanent delete (Admin, archived documents only) ────────────────────

export async function deleteDocument(db: SupabaseClient, actor: Actor, params: { projectId: string; documentId: string }): Promise<ServiceResult> {
  if (!UUID.test(params.projectId) || !UUID.test(params.documentId)) return fail(400, "project_id and document_id are required");
  const doc = await loadDocument(db, params.projectId, params.documentId);
  if (!doc) return fail(404, "Source document not found in this project");
  if (!doc.archived_at) return fail(409, "Archive the source document before deleting it permanently");
  const { data: versions } = await db.from("document_versions").select("storage_path").eq("document_id", params.documentId);
  const paths = ((versions ?? []) as { storage_path: string }[]).map((v) => v.storage_path);

  // Rows first (the versions go with their document in one statement); the
  // files are then removed. If file removal fails the objects are orphaned
  // but unreachable — no row points at them and the bucket is private.
  const { data: deleted, error } = await db.from("documents").delete()
    .eq("id", params.documentId).eq("project_id", params.projectId).select("id");
  if (error) return fail(500, error.message);
  if (!deleted || deleted.length === 0) return fail(404, "Source document not found in this project");
  let storageWarning: string | null = null;
  if (paths.length) {
    const { error: removeError } = await db.storage.from(SOURCE_DOCUMENTS_BUCKET).remove(paths);
    if (removeError) storageWarning = removeError.message;
  }
  const auditWarning = await audit(db, actor, [{
    project_id: params.projectId, entity_type: "documents", entity_id: params.documentId, entity_name: doc.document_name,
    action_type: "Delete", field_name: "source_document", old_value: `${paths.length} version${paths.length === 1 ? "" : "s"}`,
  }]);
  return { status: 200, body: { deleted: true, ...(storageWarning ? { storage_warning: storageWarning } : {}), ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}
