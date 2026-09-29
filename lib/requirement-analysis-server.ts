// ── Requirement analysis (Phase 1C) — server orchestration ────────────────
//
// Server-only. Two kinds of caller:
//   * people (Manager/Admin) — queue / retry analysis of one completed
//     extraction run, and read runs, proposals and issues; the calling route
//     has already applied the role guard (Viewer is refused in Phase 1C);
//   * the local worker — the same narrow worker token as extraction
//     (lib/extraction-server.ts authenticateWorker). For analysis it grants
//     exactly: claim a queued run, receive the fragments of THAT run's one
//     extraction job, record validated stage results, and complete / fail
//     THAT run. It grants no Requirements (or other project-data) access.
// All state changes go through the SQL functions from migration 038
// (ownership, lease, provenance, one active run per extraction job).
// Nothing here reads or writes canonical Requirements, Actions, Risks,
// Decisions, Discovery Questions, ProjectState or Go-Live Readiness — and
// the AI input is built only from the analysed run's source_fragments.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerIdentity } from "@/lib/extraction-server";
import type { Actor, ServiceResult } from "@/lib/source-documents-server";
import { ANALYSIS_STAGES, DEFAULT_ANALYSIS_MODEL, MODEL_NAME, validateAnalysisSubmission } from "@/lib/requirement-analysis";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d{1,6}(\.\d{1,6}){0,2}$/;
export const ANALYSIS_LEASE_SECONDS = 1800;
const MAX_STAGE_OUTPUT_CHARS = 250_000;
const ERROR_CATEGORIES = new Set(["ollama_unreachable", "model_unavailable", "invalid_model_output", "validation_failed", "context_too_large", "model_timeout", "worker_timeout", "upload_failed", "internal_error"]);
/** The fragment columns the worker receives — provenance and text only. */
const FRAGMENT_COLUMNS = "id, sequence, fragment_type, section_heading, section_number, section_path, page_start, page_end, text, metadata";

const fail = (status: number, error: string): ServiceResult => ({ status, body: { error } });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function mapDbError(error: { code?: string; message?: string }): ServiceResult {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "P0002": return fail(404, message);
    case "55000": return fail(409, message);
    case "23505": return fail(409, message);
    case "22023": return fail(400, message);
    case "23514": return fail(400, message);
    default: return fail(500, message);
  }
}

type AuditRow = { project_id: string; entity_id: string; entity_name: string; old_value: string | null; new_value: string };

async function audit(db: SupabaseClient, changedBy: string | null, changedByName: string, row: AuditRow) {
  const { error } = await db.from("audit_log").insert({
    ...row, entity_type: "analysis_runs", action_type: "Status Change", field_name: "analysis", changed_by: changedBy, changed_by_name: changedByName,
  });
  if (error) console.error("[analysis] audit write failed:", error.message);
  return error?.message ?? null;
}

async function runLabel(db: SupabaseClient, versionId: string): Promise<string> {
  const { data: version } = await db.from("document_versions").select("document_id, version_number").eq("id", versionId).maybeSingle();
  if (!version) return "Source document — analysis";
  const { data: doc } = await db.from("documents").select("document_name").eq("id", (version as { document_id: string }).document_id).maybeSingle();
  return `${(doc as { document_name?: string } | null)?.document_name ?? "Source document"} v${(version as { version_number: number }).version_number} — analysis`;
}

// ── Configuration ───────────────────────────────────────────────────────────

/** The configured Ollama model for batch analysis (ai_settings.analysis_model), else the default. */
export async function configuredAnalysisModel(db: SupabaseClient): Promise<string> {
  const { data } = await db.from("ai_settings").select("analysis_model").order("created_at", { ascending: true }).limit(1).maybeSingle();
  const model = (data as { analysis_model?: string | null } | null)?.analysis_model;
  return model && MODEL_NAME.test(model) ? model : DEFAULT_ANALYSIS_MODEL;
}

/** Admin: set (or clear, with null) the analysis model. Must be installed on the worker's Ollama when it has reported. */
export async function setAnalysisModel(db: SupabaseClient, body: Record<string, unknown>): Promise<ServiceResult> {
  const model = body.model === null ? null : text(body.model);
  if (model !== null && !MODEL_NAME.test(model)) return fail(400, "model must be an Ollama model name such as qwen3:8b");
  if (model) {
    const { data: cred } = await db.from("worker_credentials").select("last_seen_ollama").eq("scope", "extraction").is("revoked_at", null).maybeSingle();
    const reported = (cred as { last_seen_ollama?: { models?: { name: string }[] } | null } | null)?.last_seen_ollama?.models;
    if (Array.isArray(reported) && reported.length && !reported.some((m) => m.name === model)) {
      return fail(400, `"${model}" is not installed in Ollama on the worker's Mac (installed: ${reported.map((m) => m.name).join(", ")})`);
    }
  }
  const { data: existing } = await db.from("ai_settings").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  const { error } = existing
    ? await db.from("ai_settings").update({ analysis_model: model, updated_at: new Date().toISOString() }).eq("id", (existing as { id: string }).id)
    : await db.from("ai_settings").insert({ provider: "none", enabled: false, analysis_model: model });
  if (error) return fail(500, error.message);
  return { status: 200, body: { analysis_model: model ?? DEFAULT_ANALYSIS_MODEL, is_default: model === null } };
}

// ── People: queue / retry / read ────────────────────────────────────────────

/**
 * Queue analysis of a version's newest successful extraction (chosen by the
 * server), or — with retry_of_run_id — retry a failed run against the SAME
 * extraction job it analysed. The model comes from configuration, never
 * from the request.
 */
export async function queueAnalysis(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id);
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  const retryOf = text(body.retry_of_run_id);
  let extractionJobId: string;
  if (retryOf) {
    if (!UUID.test(retryOf)) return fail(400, "retry_of_run_id is invalid");
    const { data: prior } = await db.from("analysis_runs").select("extraction_job_id, project_id").eq("id", retryOf).maybeSingle();
    const run = prior as { extraction_job_id: string; project_id: string } | null;
    if (!run || run.project_id !== projectId) return fail(404, "Analysis run not found in this project");
    extractionJobId = run.extraction_job_id;
  } else {
    const versionId = text(body.version_id);
    if (!UUID.test(versionId)) return fail(400, "version_id is required");
    const { data: jobs } = await db.from("extraction_jobs").select("id, status, completed_at, project_id").eq("document_version_id", versionId).eq("status", "Completed");
    const newest = ((jobs ?? []) as { id: string; completed_at: string; project_id: string }[])
      .filter((j) => j.project_id === projectId).sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id.localeCompare(a.id))[0];
    if (!newest) return fail(409, "This version has no completed extraction to analyse");
    extractionJobId = newest.id;
  }
  const model = await configuredAnalysisModel(db);
  const { data, error } = await db.rpc("queue_analysis_run", {
    p_project_id: projectId, p_extraction_job_id: extractionJobId, p_model: model,
    p_user_id: actor.userId, p_user_name: actor.displayName, p_retry_of_run_id: retryOf || null,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { run_id: string; trigger: "manual" | "retry"; document_version_id: string };
  const auditWarning = await audit(db, actor.userId, actor.displayName, {
    project_id: projectId, entity_id: row.run_id, entity_name: await runLabel(db, row.document_version_id),
    old_value: row.trigger === "retry" ? "Failed" : null, new_value: row.trigger === "retry" ? `Queued (manual retry, model ${model})` : `Queued (model ${model})`,
  });
  const { data: run } = await db.from("analysis_runs").select("*").eq("id", row.run_id).maybeSingle();
  return { status: 200, body: { run, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

/** Manager/Admin: every analysis run of a project, with open-issue counts (no proposal content). */
export async function listAnalysisRuns(db: SupabaseClient, projectId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId)) return fail(400, "project_id is required");
  const { data: runs, error } = await db.from("analysis_runs").select("*").eq("project_id", projectId);
  if (error) return fail(500, error.message);
  const ids = ((runs ?? []) as { id: string }[]).map((r) => r.id);
  const open: Record<string, number> = {};
  if (ids.length) {
    const { data: issues } = await db.from("analysis_issues").select("analysis_run_id, status").in("analysis_run_id", ids);
    for (const i of (issues ?? []) as { analysis_run_id: string; status: string }[]) if (i.status === "Open") open[i.analysis_run_id] = (open[i.analysis_run_id] ?? 0) + 1;
  }
  return { status: 200, body: { runs: ((runs ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, open_issue_count: open[r.id as string] ?? 0 })), configured_model: await configuredAnalysisModel(db) } };
}

/** Manager/Admin: one run with its proposals, issues and the analysed fragments (for provenance). */
export async function getAnalysisRun(db: SupabaseClient, projectId: string, runId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId) || !UUID.test(runId)) return fail(400, "project_id and run_id are required");
  const { data: run } = await db.from("analysis_runs").select("*").eq("id", runId).eq("project_id", projectId).maybeSingle();
  if (!run) return fail(404, "Analysis run not found in this project");
  const r = run as { extraction_job_id: string; document_version_id: string; document_id: string };
  const [proposals, issues, fragments, version, document, job] = await Promise.all([
    db.from("requirement_proposals").select("*").eq("analysis_run_id", runId).order("sequence", { ascending: true }),
    db.from("analysis_issues").select("*").eq("analysis_run_id", runId).order("sequence", { ascending: true }),
    db.from("source_fragments").select(FRAGMENT_COLUMNS).eq("extraction_job_id", r.extraction_job_id).order("sequence", { ascending: true }),
    db.from("document_versions").select("id, version_number, original_filename, content_type, uploaded_at").eq("id", r.document_version_id).maybeSingle(),
    db.from("documents").select("id, document_name, document_type, current_version_id").eq("id", r.document_id).maybeSingle(),
    db.from("extraction_jobs").select("id, extractor_version, completed_at, fragment_count").eq("id", r.extraction_job_id).maybeSingle(),
  ]);
  return {
    status: 200,
    body: {
      run, proposals: proposals.data ?? [], issues: issues.data ?? [], fragments: fragments.data ?? [],
      version: version.data, document: document.data, extraction_job: job.data,
    },
  };
}

// ── Worker protocol ─────────────────────────────────────────────────────────

/** Sanitised Ollama status from a heartbeat: names/digests/sizes only. */
export function sanitiseOllamaStatus(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as { reachable?: unknown; version?: unknown; models?: unknown };
  const models = (Array.isArray(o.models) ? o.models : []).slice(0, 50).flatMap((m) => {
    const x = (m ?? {}) as Record<string, unknown>;
    const name = text(x.name);
    if (!MODEL_NAME.test(name)) return [];
    const clean = (v: unknown, n: number) => (typeof v === "string" && /^[\w .:+-]*$/.test(v) ? v.slice(0, n) : null);
    return [{ name, digest: clean(x.digest, 64), family: clean(x.family, 40), parameter_size: clean(x.parameter_size, 20) }];
  });
  return { reachable: o.reachable === true, version: typeof o.version === "string" && VERSION.test(o.version) ? o.version : null, models, reported_at: new Date().toISOString() };
}

/** Records what the worker reports about analysis (heartbeat / claim). */
export async function recordAnalysisHeartbeat(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>) {
  const update: Record<string, unknown> = {};
  const version = text(body.analysis_version);
  if (VERSION.test(version)) update.last_seen_analysis_version = version;
  if ("ollama" in body) { const o = sanitiseOllamaStatus(body.ollama); if (o) update.last_seen_ollama = o; }
  if (Object.keys(update).length) await db.from("worker_credentials").update(update).eq("id", worker.id);
}

type RunRow = { id: string; project_id: string; extraction_job_id: string; document_version_id: string; retry_of_run_id: string | null; model: string; prompt_version: string | null; attempt_count: number };

/**
 * Claims the oldest queued run. Returns the run, the fragments of exactly its
 * extraction job, and earlier validated stage results that may be reused
 * (this run's own, and those of the failed runs it retries, with the same
 * model and prompt version).
 */
export async function workerAnalysisClaim(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const promptVersion = text(body.prompt_version), promptSha = text(body.prompt_sha256), schemaVersion = text(body.analysis_schema_version);
  if (!VERSION.test(promptVersion) || !/^[0-9a-f]{64}$/.test(promptSha) || !VERSION.test(schemaVersion)) {
    return fail(400, "prompt_version, prompt_sha256 and analysis_schema_version are required");
  }
  await recordAnalysisHeartbeat(db, worker, body);
  const { data, error } = await db.rpc("claim_analysis_run", {
    p_worker_id: worker.id, p_worker_name: worker.name, p_worker_version: text(body.worker_version).slice(0, 40) || null,
    p_prompt_version: promptVersion, p_prompt_sha256: promptSha, p_schema_version: schemaVersion, p_lease_seconds: ANALYSIS_LEASE_SECONDS,
  });
  if (error) return mapDbError(error);
  const run = (Array.isArray(data) ? data[0] : data) as RunRow | undefined;
  if (!run?.id) return { status: 200, body: { run: null } };

  const { data: fragments, error: fragError } = await db.from("source_fragments").select(FRAGMENT_COLUMNS).eq("extraction_job_id", run.extraction_job_id).order("sequence", { ascending: true });
  if (fragError || !fragments?.length) {
    await db.rpc("fail_analysis_run", { p_run_id: run.id, p_worker_id: worker.id, p_category: "internal_error", p_message: "The analysed extraction run's fragments could not be loaded.", p_model_digest: null, p_diagnostics: null });
    return fail(500, "Could not load the fragments for the claimed analysis run");
  }

  // This run and the failed runs it retries (up to 5 back), same model + prompts.
  const chain = [run.id];
  let cursor = run.retry_of_run_id;
  while (cursor && chain.length < 6) {
    const { data: prior } = await db.from("analysis_runs").select("id, retry_of_run_id, model, prompt_version, extraction_job_id").eq("id", cursor).maybeSingle();
    const p = prior as { id: string; retry_of_run_id: string | null; model: string; prompt_version: string | null; extraction_job_id: string } | null;
    if (!p || p.extraction_job_id !== run.extraction_job_id) break;
    if (p.model === run.model && p.prompt_version === promptVersion) chain.push(p.id);
    cursor = p.retry_of_run_id;
  }
  const { data: stages } = await db.from("analysis_stage_results").select("analysis_run_id, stage, chunk_key, input_hash, output, model, prompt_version").in("analysis_run_id", chain);
  const reusable = ((stages ?? []) as { analysis_run_id: string; stage: string; chunk_key: string; input_hash: string; output: unknown; model: string; prompt_version: string }[])
    .filter((s) => s.model === run.model && s.prompt_version === promptVersion)
    .map((s) => ({ run_id: s.analysis_run_id, stage: s.stage, chunk_key: s.chunk_key, input_hash: s.input_hash, output: s.output }));

  return {
    status: 200,
    body: {
      run: { id: run.id, project_id: run.project_id, extraction_job_id: run.extraction_job_id, model: run.model, attempt_count: run.attempt_count, lease_seconds: ANALYSIS_LEASE_SECONDS },
      fragments, reusable_stages: reusable,
    },
  };
}

export async function workerAnalysisStage(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id), stage = text(body.stage), chunkKey = text(body.chunk_key), inputHash = text(body.input_hash);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  if (!(ANALYSIS_STAGES as readonly string[]).includes(stage)) return fail(400, "stage is invalid");
  if (!/^[A-Za-z0-9:._-]{1,80}$/.test(chunkKey)) return fail(400, "chunk_key is invalid");
  if (!/^[0-9a-f]{64}$/.test(inputHash)) return fail(400, "input_hash is invalid");
  const output = body.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || JSON.stringify(output).length > MAX_STAGE_OUTPUT_CHARS) return fail(400, "output must be a JSON object (≤ 250 KB)");
  const reusedFrom = text(body.reused_from);
  const { data, error } = await db.rpc("record_analysis_stage", {
    p_run_id: runId, p_worker_id: worker.id, p_stage: stage, p_chunk_key: chunkKey, p_input_hash: inputHash,
    p_attempts: Math.max(1, Math.min(10, Number(body.attempts) || 1)), p_reused_from: UUID.test(reusedFrom) ? reusedFrom : null,
    p_output: output, p_lease_seconds: ANALYSIS_LEASE_SECONDS,
  });
  if (error) return mapDbError(error);
  return { status: 200, body: { stored: data === true } };
}

export async function workerAnalysisComplete(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const { data: run } = await db.from("analysis_runs").select("id, status, worker_id, extraction_job_id, model, prompt_version").eq("id", runId).maybeSingle();
  const r = run as { status: string; worker_id: string | null; extraction_job_id: string; model: string; prompt_version: string | null } | null;
  if (!r || r.status !== "Running" || r.worker_id !== worker.id) return fail(409, "This analysis run is not running for this worker");

  // Stage 5 on the server: provenance against the run's OWN fragment set.
  const { data: fragments } = await db.from("source_fragments").select("id").eq("extraction_job_id", r.extraction_job_id);
  const fragmentIds = new Set(((fragments ?? []) as { id: string }[]).map((f) => f.id));
  const checked = validateAnalysisSubmission(body.proposals, body.issues, fragmentIds);
  if (!checked.ok) return fail(400, `Analysis output refused: ${checked.problems.slice(0, 5).join("; ")}`);
  const diagnostics = body.diagnostics && typeof body.diagnostics === "object" && !Array.isArray(body.diagnostics) && JSON.stringify(body.diagnostics).length <= 200_000 ? body.diagnostics : {};
  const modelDigest = text(body.model_digest).slice(0, 100) || null;

  const { data, error } = await db.rpc("complete_analysis_run", {
    p_run_id: runId, p_worker_id: worker.id, p_model_digest: modelDigest,
    p_proposals: checked.proposals, p_issues: checked.issues, p_diagnostics: diagnostics, p_with_warnings: body.with_warnings === true,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { project_id: string; document_version_id: string; status: string; proposal_count: number; issue_count: number };
  await audit(db, null, `Analysis worker (${worker.name})`, {
    project_id: row.project_id, entity_id: runId, entity_name: await runLabel(db, row.document_version_id), old_value: "Running",
    new_value: `${row.status} — ${row.proposal_count} proposed requirement${row.proposal_count === 1 ? "" : "s"}, ${row.issue_count} issue${row.issue_count === 1 ? "" : "s"} (model ${r.model}, prompts ${r.prompt_version ?? "?"})`,
  });
  return { status: 200, body: { ok: true, status: row.status, proposal_count: row.proposal_count, issue_count: row.issue_count } };
}

export async function workerAnalysisFail(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const category = ERROR_CATEGORIES.has(text(body.error_category)) ? text(body.error_category) : "internal_error";
  // A short, plain message only — never document content or model output.
  const message = text(body.error_message).replace(/\s+/g, " ").slice(0, 500) || "Analysis failed.";
  const raw = body.diagnostics && typeof body.diagnostics === "object" && !Array.isArray(body.diagnostics) ? body.diagnostics as Record<string, unknown> : null;
  const diagnostics = raw ? { stage_calls: Array.isArray(raw.stage_calls) ? raw.stage_calls.slice(0, 200) : undefined, warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 50).map((w) => String(w).slice(0, 300)) : undefined } : null;
  const { data, error } = await db.rpc("fail_analysis_run", {
    p_run_id: runId, p_worker_id: worker.id, p_category: category, p_message: message,
    p_model_digest: text(body.model_digest).slice(0, 100) || null, p_diagnostics: diagnostics,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { project_id: string; document_version_id: string };
  await audit(db, null, `Analysis worker (${worker.name})`, {
    project_id: row.project_id, entity_id: runId, entity_name: await runLabel(db, row.document_version_id), old_value: "Running", new_value: `Failed — ${category}`,
  });
  return { status: 200, body: { ok: true } };
}

/** System Health: Ollama as last reported, the configured model, and the analysis queue. */
export async function analysisHealth(db: SupabaseClient) {
  const { data: cred } = await db.from("worker_credentials").select("last_seen_ollama, last_seen_analysis_version").eq("scope", "extraction").is("revoked_at", null).maybeSingle();
  const c = cred as { last_seen_ollama: { reachable?: boolean; version?: string | null; models?: { name: string; family: string | null; parameter_size: string | null }[]; reported_at?: string } | null; last_seen_analysis_version: string | null } | null;
  const count = async (status: string, sinceHours?: number) => {
    let q = db.from("analysis_runs").select("id", { count: "exact", head: true }).eq("status", status);
    if (sinceHours) q = q.gte("completed_at", new Date(Date.now() - sinceHours * 3_600_000).toISOString());
    const { count: n } = await q;
    return n ?? 0;
  };
  const model = await configuredAnalysisModel(db);
  const models = c?.last_seen_ollama?.models ?? [];
  return {
    ollama: c?.last_seen_ollama ? { reachable: c.last_seen_ollama.reachable === true, version: c.last_seen_ollama.version ?? null, reported_at: c.last_seen_ollama.reported_at ?? null, models } : null,
    analysis_version: c?.last_seen_analysis_version ?? null,
    configured_model: model,
    configured_model_installed: models.length ? models.some((m) => m.name === model) : null,
    queue: { queued: await count("Queued"), running: await count("Running"), failed_24h: await count("Failed", 24), completed_24h: (await count("Completed", 24)) + (await count("Completed with warnings", 24)) },
  };
}
