// ── Document extraction (Phase 1B) — server orchestration ──────────────────
//
// Server-only. Two kinds of caller:
//   * people (Manager/Admin) — queue or retry extraction of a version; the
//     calling route has already applied the role guard;
//   * the local extraction worker — authenticated here by a revocable bearer
//     token (only its SHA-256 is stored, in worker_credentials). The token
//     grants exactly: claim a queued job, download that job's file via a
//     short-lived signed URL, add fragments / complete / fail THAT job, and
//     report a heartbeat. Nothing else in the app accepts it, and the worker
//     never receives Supabase credentials. The same token also serves the
//     Phase 1C analysis protocol (lib/requirement-analysis-server.ts).
// All state changes go through the SECURITY-checked SQL functions from
// migration 036 (ownership, lease, hash verification, one active job).
// Significant events are written to the canonical audit_log.

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SOURCE_DOCUMENTS_BUCKET, semverParts } from "@/lib/source-documents";
import type { Actor, ServiceResult } from "@/lib/source-documents-server";
import { analysisHealth, recordAnalysisHeartbeat } from "@/lib/requirement-analysis-server";

export type WorkerIdentity = { id: string; name: string };

export const WORKER_TOKEN_PREFIX = "tmw_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOWNLOAD_URL_SECONDS = 300;
const LEASE_SECONDS = 600;
export const MAX_FRAGMENTS_PER_BATCH = 500;
const ERROR_CATEGORIES = new Set(["download_failed", "integrity_mismatch", "unsupported_type", "parse_error", "encrypted", "ocr_required", "worker_timeout", "upload_failed", "internal_error"]);
const OUTCOMES = new Set(["completed", "completed_with_warnings"]);

const fail = (status: number, error: string): ServiceResult => ({ status, body: { error } });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function mapDbError(error: { code?: string; message?: string }): ServiceResult {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "P0002": return fail(404, message);
    case "55000": return fail(409, message);
    case "23505": return fail(409, message);
    case "22023": return fail(400, message);
    default: return fail(500, message);
  }
}

type AuditRow = {
  project_id: string; entity_type: string; entity_id: string; entity_name: string;
  action_type: "Status Change"; field_name: string; old_value: string | null; new_value: string;
};

async function audit(db: SupabaseClient, changedBy: string | null, changedByName: string, rows: AuditRow[]) {
  const { error } = await db.from("audit_log").insert(rows.map((row) => ({ ...row, changed_by: changedBy, changed_by_name: changedByName })));
  if (error) console.error("[extraction] audit write failed:", error.message);
  return error?.message ?? null;
}

async function versionLabel(db: SupabaseClient, versionId: string): Promise<string> {
  const { data: version } = await db.from("document_versions").select("document_id, version_number").eq("id", versionId).maybeSingle();
  if (!version) return "Source document";
  const { data: doc } = await db.from("documents").select("document_name").eq("id", (version as { document_id: string }).document_id).maybeSingle();
  return `${(doc as { document_name?: string } | null)?.document_name ?? "Source document"} v${(version as { version_number: number }).version_number}`;
}

/** Audit row for "extraction queued" — also used by the upload flow (automatic queueing). */
export function extractionQueuedAudit(projectId: string, versionId: string, label: string, how: "automatic" | "manual" | "retry" | "upgrade", previous: string | null, versions?: { from: string | null; to: string | null }): AuditRow {
  return {
    project_id: projectId, entity_type: "document_versions", entity_id: versionId, entity_name: label,
    action_type: "Status Change", field_name: "extraction", old_value: previous,
    new_value: how === "upgrade" ? `Queued (re-extraction: extractor ${versions?.from ?? "?"} → ${versions?.to ?? "?"})`
      : how === "retry" ? "Queued (manual retry)" : how === "manual" ? "Queued (manual)" : "Queued (automatic, on upload)",
  };
}

/** The extractor version the active worker last reported (heartbeat / claim), if any. */
export async function availableExtractorVersion(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from("worker_credentials").select("last_seen_extractor_version").eq("scope", "extraction").is("revoked_at", null).maybeSingle();
  return (data as { last_seen_extractor_version?: string | null } | null)?.last_seen_extractor_version ?? null;
}

// ── People: queue / retry ───────────────────────────────────────────────────

/**
 * Queue / retry, or (mode "upgrade") re-extract with a newer extractor. The
 * newer version comes from what the worker actually reported — never from
 * the request — and the database re-checks it (compare_semver).
 */
export async function queueExtraction(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), versionId = text(body.version_id);
  if (!UUID.test(projectId) || !UUID.test(versionId)) return fail(400, "project_id and version_id are required");
  const mode = text(body.mode) || "manual";
  if (mode !== "manual" && mode !== "upgrade") return fail(400, "mode must be manual or upgrade");
  const available = mode === "upgrade" ? await availableExtractorVersion(db) : null;
  if (mode === "upgrade" && !available) return fail(409, "The extraction worker has not reported an extractor version yet — start the worker and try again");
  const { data, error } = await db.rpc("queue_extraction_job", {
    p_project_id: projectId, p_version_id: versionId, p_user_id: actor.userId, p_user_name: actor.displayName,
    p_mode: mode, p_available_extractor_version: available,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { job_id: string; trigger: "manual" | "retry" | "upgrade"; previous_status: string; previous_extractor_version: string | null };
  const auditWarning = await audit(db, actor.userId, actor.displayName, [
    extractionQueuedAudit(projectId, versionId, await versionLabel(db, versionId), row.trigger, row.previous_status,
      row.trigger === "upgrade" ? { from: row.previous_extractor_version, to: available } : undefined),
  ]);
  const { data: job } = await db.from("extraction_jobs").select("*").eq("id", row.job_id).maybeSingle();
  return { status: 200, body: { job, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

// ── Worker authentication and credentials ─────────────────────────────────

/** Resolves an active extraction-worker credential from `Authorization: Bearer tmw_…`. */
export async function authenticateWorker(db: SupabaseClient, authorization: string | null): Promise<WorkerIdentity | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1] ?? "";
  if (!token.startsWith(WORKER_TOKEN_PREFIX) || token.length < 40) return null;
  const { data } = await db.from("worker_credentials").select("id, name, scope, revoked_at")
    .eq("token_sha256", sha256(token)).is("revoked_at", null).maybeSingle();
  const row = data as { id: string; name: string; scope: string; revoked_at: string | null } | null;
  return row && row.scope === "extraction" && !row.revoked_at ? { id: row.id, name: row.name } : null;
}

/** Admin: issue a new extraction-worker token (shown once), revoking any previous one. */
export async function issueWorkerToken(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const name = text(body.name) || "local-extraction-worker";
  if (name.length > 80 || !/^[\w .-]+$/.test(name)) return fail(400, "Worker name may contain letters, numbers, spaces, dots, dashes and underscores (max 80)");
  const token = `${WORKER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = new Date().toISOString();
  const { error: revokeError } = await db.from("worker_credentials").update({ revoked_at: now }).eq("scope", "extraction").is("revoked_at", null);
  if (revokeError) return fail(500, revokeError.message);
  const { data, error } = await db.from("worker_credentials")
    .insert({ name, scope: "extraction", token_sha256: sha256(token), created_by_name: actor.displayName })
    .select("id, name, created_at").single();
  if (error) return fail(500, error.message);
  return { status: 200, body: { credential: data, token, note: "Copy this token into local-worker/config.json now — it is not stored and cannot be shown again." } };
}

/** Manager/Admin: worker availability and queue summary for System Health. */
export async function workerStatus(db: SupabaseClient): Promise<ServiceResult> {
  const { data: cred } = await db.from("worker_credentials").select("name, created_at, last_seen_at, last_seen_version, last_seen_extractor_version").eq("scope", "extraction").is("revoked_at", null).maybeSingle();
  const count = async (status: string, sinceHours?: number) => {
    let q = db.from("extraction_jobs").select("id", { count: "exact", head: true }).eq("status", status);
    if (sinceHours) q = q.gte("completed_at", new Date(Date.now() - sinceHours * 3_600_000).toISOString());
    const { count: n } = await q;
    return n ?? 0;
  };
  const c = cred as { name: string; created_at: string; last_seen_at: string | null; last_seen_version: string | null; last_seen_extractor_version: string | null } | null;
  const lastSeen = c?.last_seen_at ? new Date(c.last_seen_at).getTime() : null;
  return {
    status: 200,
    body: {
      configured: Boolean(c),
      name: c?.name ?? null,
      last_seen_at: c?.last_seen_at ?? null,
      last_seen_version: c?.last_seen_version ?? null,
      extractor_version: c?.last_seen_extractor_version ?? null,
      online: lastSeen !== null && Date.now() - lastSeen < 3 * 60_000,
      queue: { queued: await count("Queued"), running: await count("Running"), failed_24h: await count("Failed", 24), completed_24h: await count("Completed", 24) },
      // Phase 1C: local AI analysis — Ollama as last reported by the worker, model, queue.
      // Fails soft: extraction health never depends on the analysis tables.
      analysis: await analysisHealth(db).catch((error: unknown) => { console.error("[analysis] health unavailable:", error instanceof Error ? error.message : error); return null; }),
    },
  };
}

async function touch(db: SupabaseClient, worker: WorkerIdentity, version: string, extractorVersion: string) {
  const update: Record<string, unknown> = { last_seen_at: new Date().toISOString(), last_seen_version: version.slice(0, 40) || null };
  // Only a well-formed MAJOR[.MINOR[.PATCH]] is recorded (it drives re-extraction eligibility).
  if (semverParts(extractorVersion) && /^\d{1,6}(\.\d{1,6}){0,2}$/.test(extractorVersion)) update.last_seen_extractor_version = extractorVersion;
  await db.from("worker_credentials").update(update).eq("id", worker.id);
}

// ── Worker operations ──────────────────────────────────────────────────────

export async function workerHeartbeat(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  await touch(db, worker, text(body.worker_version), text(body.extractor_version));
  await recordAnalysisHeartbeat(db, worker, body);
  return { status: 200, body: { ok: true, worker: worker.name } };
}

/** Claims the oldest queued job and returns a 5-minute signed URL for exactly that file. */
export async function workerClaim(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const workerVersion = text(body.worker_version).slice(0, 40);
  await touch(db, worker, workerVersion, text(body.extractor_version));
  const { data, error } = await db.rpc("claim_extraction_job", { p_worker_id: worker.id, p_worker_name: worker.name, p_worker_version: workerVersion || null, p_lease_seconds: LEASE_SECONDS });
  if (error) return mapDbError(error);
  const job = (Array.isArray(data) ? data[0] : data) as {
    job_id: string; project_id: string; document_version_id: string; storage_path: string; content_type: string;
    sha256: string; size_bytes: number; original_filename: string; attempt_count: number;
  } | undefined;
  if (!job?.job_id) return { status: 200, body: { job: null } };
  const { data: signed, error: signError } = await db.storage.from(SOURCE_DOCUMENTS_BUCKET).createSignedUrl(job.storage_path, DOWNLOAD_URL_SECONDS);
  if (signError || !signed?.signedUrl) {
    await db.rpc("fail_extraction_job", { p_job_id: job.job_id, p_worker_id: worker.id, p_category: "download_failed", p_message: "The server could not create a download link for this file.", p_extractor_version: null, p_diagnostics: null });
    return fail(500, "Could not create a download link for the claimed job");
  }
  return {
    status: 200,
    body: {
      job: {
        id: job.job_id, project_id: job.project_id, document_version_id: job.document_version_id,
        content_type: job.content_type, sha256: job.sha256, size_bytes: job.size_bytes,
        original_filename: job.original_filename, attempt: job.attempt_count, lease_seconds: LEASE_SECONDS,
      },
      download: { url: signed.signedUrl, expires_in: DOWNLOAD_URL_SECONDS },
    },
  };
}

type FragmentInput = {
  sequence: number; fragment_type: string; section_heading?: string | null; section_number?: string | null; section_path?: string[];
  page_start?: number | null; page_end?: number | null; text: string; text_hash: string; metadata?: Record<string, unknown>;
};

function validFragment(f: unknown): f is FragmentInput {
  const x = f as FragmentInput;
  return Boolean(x) && Number.isInteger(x.sequence) && x.sequence >= 1
    && ["text", "table", "list"].includes(x.fragment_type)
    && typeof x.text === "string" && x.text.length >= 1 && x.text.length <= 20000
    && typeof x.text_hash === "string" && /^[0-9a-f]{64}$/.test(x.text_hash)
    && (x.section_path === undefined || (Array.isArray(x.section_path) && x.section_path.every((s) => typeof s === "string")))
    && [x.page_start, x.page_end].every((p) => p === undefined || p === null || (Number.isInteger(p) && p >= 1));
}

export async function workerAddFragments(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const jobId = text(body.job_id);
  if (!UUID.test(jobId)) return fail(400, "job_id is required");
  const fragments = body.fragments;
  if (!Array.isArray(fragments) || fragments.length === 0 || fragments.length > MAX_FRAGMENTS_PER_BATCH) return fail(400, `fragments must be an array of 1–${MAX_FRAGMENTS_PER_BATCH}`);
  if (!fragments.every(validFragment)) return fail(400, "One or more fragments are malformed");
  const clean = fragments.map((f) => ({
    sequence: f.sequence, fragment_type: f.fragment_type, section_heading: f.section_heading ?? null, section_number: f.section_number ?? null,
    section_path: f.section_path ?? [], page_start: f.page_start ?? null, page_end: f.page_end ?? null,
    text: f.text, text_hash: f.text_hash, metadata: f.metadata ?? {},
  }));
  const { data, error } = await db.rpc("add_extraction_fragments", { p_job_id: jobId, p_worker_id: worker.id, p_fragments: clean });
  if (error) return mapDbError(error);
  return { status: 200, body: { stored: data } };
}

export async function workerComplete(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const jobId = text(body.job_id);
  if (!UUID.test(jobId)) return fail(400, "job_id is required");
  const outcome = text(body.outcome);
  if (!OUTCOMES.has(outcome)) return fail(400, "outcome must be completed or completed_with_warnings");
  const extractorVersion = text(body.extractor_version).slice(0, 40);
  if (!extractorVersion) return fail(400, "extractor_version is required");
  const fragmentCount = Number(body.fragment_count);
  if (!Number.isInteger(fragmentCount) || fragmentCount < 1) return fail(400, "fragment_count is required");
  const diagnostics = typeof body.diagnostics === "object" && body.diagnostics ? body.diagnostics : {};
  const { data, error } = await db.rpc("complete_extraction_job", {
    p_job_id: jobId, p_worker_id: worker.id, p_extractor_version: extractorVersion, p_outcome: outcome, p_diagnostics: diagnostics, p_fragment_count: fragmentCount,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { document_version_id: string; project_id: string; extraction_status: string };
  await audit(db, null, `Extraction worker (${worker.name})`, [{
    project_id: row.project_id, entity_type: "document_versions", entity_id: row.document_version_id,
    entity_name: await versionLabel(db, row.document_version_id), action_type: "Status Change", field_name: "extraction",
    old_value: "Running", new_value: `${row.extraction_status} — ${fragmentCount} fragment${fragmentCount === 1 ? "" : "s"} (extractor ${extractorVersion})`,
  }]);
  return { status: 200, body: { ok: true, extraction_status: row.extraction_status } };
}

export async function workerFail(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const jobId = text(body.job_id);
  if (!UUID.test(jobId)) return fail(400, "job_id is required");
  const category = ERROR_CATEGORIES.has(text(body.error_category)) ? text(body.error_category) : "internal_error";
  // Only a short, plain message is kept — never document content or stack traces.
  const message = text(body.error_message).replace(/\s+/g, " ").slice(0, 500) || "Extraction failed.";
  const diagnostics = typeof body.diagnostics === "object" && body.diagnostics ? body.diagnostics : null;
  const { data, error } = await db.rpc("fail_extraction_job", {
    p_job_id: jobId, p_worker_id: worker.id, p_category: category, p_message: message,
    p_extractor_version: text(body.extractor_version).slice(0, 40) || null, p_diagnostics: diagnostics,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { document_version_id: string; project_id: string };
  // After a failed newer run the version keeps its previous successful status (037).
  const { data: version } = await db.from("document_versions").select("extraction_status").eq("id", row.document_version_id).maybeSingle();
  const status = (version as { extraction_status?: string } | null)?.extraction_status ?? "Failed";
  const extractorVersion = text(body.extractor_version).slice(0, 40);
  await audit(db, null, `Extraction worker (${worker.name})`, [{
    project_id: row.project_id, entity_type: "document_versions", entity_id: row.document_version_id,
    entity_name: await versionLabel(db, row.document_version_id), action_type: "Status Change", field_name: "extraction",
    old_value: "Running",
    new_value: `Failed — ${category}${extractorVersion ? ` (extractor ${extractorVersion})` : ""}${status !== "Failed" ? `; previous extraction kept (${status})` : ""}`,
  }]);
  return { status: 200, body: { ok: true, extraction_status: status } };
}
