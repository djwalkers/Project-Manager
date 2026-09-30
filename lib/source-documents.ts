// ── Source Documents (Phase 1A) — shared rules ──────────────────────────────
//
// Used by the browser (early, friendly validation) and by the server routes
// (authoritative validation). The database repeats the essential limits as
// CHECK constraints (migration 035), and the Storage bucket enforces the
// same size and MIME allow-list.

import type { DocumentRecord, DocumentVersion, ExtractionJob } from "@/lib/types";

export const SOURCE_DOCUMENTS_BUCKET = "source-documents";

/** Migration 042: why a document promoted Requirements came from cannot be permanently deleted. */
export const SOURCE_DOCUMENT_PROVENANCE_DELETE_MESSAGE =
  "This source document cannot be permanently deleted because one or more promoted Requirements depend on its analysis provenance. Keep it archived instead.";

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

/** Short file format for the document list ("PDF", "DOCX"), from the stored content type, else the extension. */
export function fileFormatLabel(version: { content_type?: string | null; original_filename?: string | null }): string {
  if (version.content_type === "application/pdf") return "PDF";
  if (version.content_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "DOCX";
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(version.original_filename ?? "")?.[1];
  return ext ? ext.toUpperCase() : "File";
}

/** Compact file metadata for the document list: "PDF · 116.5 KB". */
export function fileSummary(version: { content_type?: string | null; original_filename?: string | null; size_bytes: number }): string {
  return `${fileFormatLabel(version)} · ${formatBytes(version.size_bytes)}`;
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
export const EXTRACTION_STATUSES = ["Not Started", "Queued", "Running", "Completed", "Completed with warnings", "Failed"] as const;

/** Latest extraction attempt of a version (newest queued first). */
export function latestJobFor(versionId: string, jobs: ExtractionJob[]): ExtractionJob | null {
  return jobs.filter((j) => j.document_version_id === versionId)
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at) || b.id.localeCompare(a.id))[0] ?? null;
}

/** Manager/Admin may queue when nothing has run yet, or deliberately retry a failed run. */
export function canQueueExtraction(job: ExtractionJob | null): boolean {
  return !job || job.status === "Failed";
}

// ── Extractor versions (semantic, not lexical: 1.10.0 > 1.9.0) ─────────────

const SEMVER = /^(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?$/;

/** MAJOR[.MINOR[.PATCH]] → [major, minor, patch]; a -pre/+build suffix is ignored. Null if not a version. */
export function semverParts(version: string | null | undefined): [number, number, number] | null {
  const core = String(version ?? "").trim().split(/[-+]/)[0];
  const m = SEMVER.exec(core);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** -1 / 0 / 1, or null when either side is not a version. Mirrors SQL public.compare_semver. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const x = semverParts(a), y = semverParts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Every extraction run of a version, newest first. */
export function jobsForVersion(versionId: string, jobs: ExtractionJob[]): ExtractionJob[] {
  return jobs.filter((j) => j.document_version_id === versionId)
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at) || b.id.localeCompare(a.id));
}

/**
 * The extraction shown by default: the most recent SUCCESSFUL run
 * (Completed or Completed with warnings). A newer failed run never replaces it.
 */
export function latestSuccessfulJobFor(versionId: string, jobs: ExtractionJob[]): ExtractionJob | null {
  return jobs.filter((j) => j.document_version_id === versionId && j.status === "Completed")
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")) || b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * "Re-extract with newer extractor" is offered only when the version has a
 * successful extraction, nothing is queued/running, and the extractor the
 * worker actually reports is semantically newer than that extraction's.
 */
export function canReextract(versionId: string, jobs: ExtractionJob[], availableExtractorVersion: string | null | undefined): boolean {
  const latest = latestJobFor(versionId, jobs);
  if (latest && (latest.status === "Queued" || latest.status === "Running")) return false;
  const success = latestSuccessfulJobFor(versionId, jobs);
  if (!success) return false;
  return compareSemver(availableExtractorVersion, success.extractor_version) === 1;
}

export const EXTRACTION_ERROR_LABELS: Record<string, string> = {
  download_failed: "The worker could not download the file",
  integrity_mismatch: "The downloaded file did not match its recorded hash",
  unsupported_type: "Unsupported file type",
  parse_error: "The file could not be parsed",
  encrypted: "The file is password-protected",
  ocr_required: "No extractable text — OCR / manual review required",
  worker_timeout: "The extraction worker stopped responding",
  upload_failed: "The worker could not save the extracted fragments",
  internal_error: "Unexpected extraction error",
};

/** Versions of one document, newest first. */
export function versionsFor(documentId: string, versions: DocumentVersion[]): DocumentVersion[] {
  return versions.filter((v) => v.document_id === documentId).sort((a, b) => b.version_number - a.version_number);
}

export function currentVersionOf(document: DocumentRecord, versions: DocumentVersion[]): DocumentVersion | null {
  return versions.find((v) => v.id === document.current_version_id && v.document_id === document.id) ?? null;
}
