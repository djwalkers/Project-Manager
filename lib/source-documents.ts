// ── Source Documents (Phase 1A) — shared rules ──────────────────────────────
//
// Used by the browser (early, friendly validation) and by the server routes
// (authoritative validation). The database repeats the essential limits as
// CHECK constraints (migration 035), and the Storage bucket enforces the
// same size and MIME allow-list.

import type { DocumentRecord, DocumentVersion } from "@/lib/types";

export const SOURCE_DOCUMENTS_BUCKET = "source-documents";

/**
 * 25 MB. CR / specification / design documents are typically well under
 * 10 MB even with diagrams. Files go browser → Storage directly via a
 * signed upload URL (so Vercel's 4.5 MB request-body limit does not apply);
 * the server then downloads the object once to hash and verify it, which
 * stays comfortably within a serverless function's memory and time limits.
 * It is also below Supabase Storage's default 50 MB per-file ceiling.
 */
export const MAX_SOURCE_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const SOURCE_DOCUMENT_TYPES = [
  { extension: "pdf", mime: "application/pdf", label: "PDF" },
  { extension: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word (DOCX)" },
] as const;

export type SourceDocumentExtension = typeof SOURCE_DOCUMENT_TYPES[number]["extension"];

export const DOCUMENT_TYPE_OPTIONS = [
  "Change Request",
  "Functional Specification",
  "Technical Specification",
  "Design Document",
  "Other",
] as const;

export const ACCEPT_ATTRIBUTE = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Browsers disagree about DOCX MIME types (some report nothing, or a
// generic binary type), so a generic type is tolerated at the request stage;
// the server decides the stored content type from the file's actual bytes.
const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

export function typeForExtension(extension: string) {
  return SOURCE_DOCUMENT_TYPES.find((type) => type.extension === extension) ?? null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type UploadCheck =
  | { ok: true; extension: SourceDocumentExtension; contentType: string }
  | { ok: false; error: string };

/** Validates a proposed upload from its name, declared type and size. */
export function checkUploadCandidate(input: { filename: unknown; contentType?: unknown; size: unknown }): UploadCheck {
  const filename = typeof input.filename === "string" ? input.filename.trim() : "";
  if (!filename) return { ok: false, error: "A file name is required." };
  if (filename.length > 255) return { ok: false, error: "The file name is too long (maximum 255 characters)." };
  const type = typeForExtension(extensionOf(filename));
  if (!type) return { ok: false, error: "Unsupported file type. Only PDF (.pdf) and Word (.docx) documents can be uploaded." };
  const declared = typeof input.contentType === "string" ? input.contentType.trim().toLowerCase() : "";
  if (!GENERIC_MIME.has(declared) && declared !== type.mime) {
    return { ok: false, error: `The file's type (${declared}) does not match a ${type.label} document.` };
  }
  const size = typeof input.size === "number" ? input.size : Number.NaN;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "The file is empty." };
  if (size > MAX_SOURCE_DOCUMENT_BYTES) {
    return { ok: false, error: `The file is ${formatBytes(size)}; the maximum is ${formatBytes(MAX_SOURCE_DOCUMENT_BYTES)}.` };
  }
  return { ok: true, extension: type.extension, contentType: type.mime };
}

/**
 * Identifies the file from its bytes (the name and declared type are only
 * hints). PDF starts with "%PDF-"; DOCX is a ZIP whose entries include the
 * WordprocessingML part "word/…" and "[Content_Types].xml" (ZIP entry names
 * are stored uncompressed).
 */
export function detectSourceDocumentKind(bytes: Uint8Array): SourceDocumentExtension | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 5 && ascii(0, 5) === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const text = new TextDecoder("latin1").decode(bytes);
    if (text.includes("[Content_Types].xml") && text.includes("word/")) return "docx";
  }
  return null;
}

/**
 * Storage object path: project-scoped and never derived from the uploaded
 * file name (which is recorded separately as original_filename).
 */
export function buildSourceDocumentPath(projectId: string, objectId: string, extension: SourceDocumentExtension): string {
  return `${projectId}/${objectId}.${extension}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_PATTERN = new RegExp(`^(${UUID})/(${UUID})\\.(pdf|docx)$`, "i");

/** True when `path` is a path this app issued for `projectId`. */
export function isIssuedPathForProject(path: unknown, projectId: string): path is string {
  if (typeof path !== "string") return false;
  const match = PATH_PATTERN.exec(path);
  return Boolean(match && match[1].toLowerCase() === projectId.toLowerCase());
}

export const PROCESSING_STATUSES = ["Not Started", "Queued", "In Progress", "Complete", "Failed"] as const;

/** Versions of one document, newest first. */
export function versionsFor(documentId: string, versions: DocumentVersion[]): DocumentVersion[] {
  return versions.filter((v) => v.document_id === documentId).sort((a, b) => b.version_number - a.version_number);
}

export function currentVersionOf(document: DocumentRecord, versions: DocumentVersion[]): DocumentVersion | null {
  return versions.find((v) => v.id === document.current_version_id && v.document_id === document.id) ?? null;
}
