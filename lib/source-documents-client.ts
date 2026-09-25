"use client";

// ── Source Documents (Phase 1A) — browser helpers ───────────────────────────
//
// Upload is three steps, none of which carries the file through a Vercel
// function: (1) the server validates the request and issues a one-time
// signed upload URL for a fresh private path; (2) the browser uploads the
// file straight to Storage with that token; (3) the server verifies, hashes
// and records it. Reads/downloads use a 60-second signed URL from the server.

import { SOURCE_DOCUMENTS_BUCKET, checkUploadCandidate } from "@/lib/source-documents";
import { supabase } from "@/lib/supabase/client";
import type { DocumentRecord, DocumentVersion } from "@/lib/types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export type UploadInput = {
  projectId: string;
  file: File;
  /** Set to upload a new version of an existing document. */
  documentId?: string;
  title?: string;
  documentType?: string;
  notes?: string;
};

export async function uploadSourceDocument(input: UploadInput): Promise<{ document: DocumentRecord; version: DocumentVersion }> {
  const check = checkUploadCandidate({ filename: input.file.name, contentType: input.file.type, size: input.file.size });
  if (!check.ok) throw new Error(check.error);
  if (!supabase) throw new Error("Uploading needs the Supabase connection (not available in local mode).");

  const prepared = await call<{ path: string; token: string; content_type: string }>("/api/source-documents/uploads", {
    method: "POST",
    body: JSON.stringify({ project_id: input.projectId, document_id: input.documentId, filename: input.file.name, content_type: input.file.type, size: input.file.size }),
  });

  const { error: uploadError } = await supabase.storage.from(SOURCE_DOCUMENTS_BUCKET)
    .uploadToSignedUrl(prepared.path, prepared.token, input.file, { contentType: prepared.content_type });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  return call("/api/source-documents", {
    method: "POST",
    body: JSON.stringify({
      project_id: input.projectId, storage_path: prepared.path, original_filename: input.file.name,
      document_id: input.documentId, title: input.title, document_type: input.documentType, notes: input.notes,
    }),
  });
}

/** Opens a version's original file (inline view or download) via a short-lived signed URL. */
export async function openSourceDocumentVersion(projectId: string, versionId: string, disposition: "inline" | "attachment") {
  const target = disposition === "inline" ? window.open("about:blank", "_blank") : null;
  try {
    const { url } = await call<{ url: string }>(`/api/source-documents/download?project_id=${encodeURIComponent(projectId)}&version_id=${encodeURIComponent(versionId)}&disposition=${disposition}`);
    if (target) target.location.href = url;
    else window.location.assign(url);
  } catch (error) {
    target?.close();
    throw error;
  }
}

export function setCurrentSourceDocumentVersion(projectId: string, documentId: string, versionId: string) {
  return call<{ document: DocumentRecord }>("/api/source-documents/current", {
    method: "PATCH", body: JSON.stringify({ project_id: projectId, document_id: documentId, version_id: versionId }),
  });
}

export function setSourceDocumentArchived(projectId: string, documentId: string, archived: boolean) {
  return call<{ document: DocumentRecord }>("/api/source-documents/archive", {
    method: "POST", body: JSON.stringify({ project_id: projectId, document_id: documentId, archived }),
  });
}

export function deleteSourceDocument(projectId: string, documentId: string) {
  return call<{ deleted: true; storage_warning?: string }>(`/api/source-documents?project_id=${encodeURIComponent(projectId)}&document_id=${encodeURIComponent(documentId)}`, { method: "DELETE" });
}
