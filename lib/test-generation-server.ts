// ── Test Case generation (Phase 1G) — server orchestration ─────────────────
//
// Server-only. Two kinds of caller:
//   * people (Manager/Admin; the route applies the guard) — read eligibility
//     and runs for one Requirement, queue / retry generation for a set of its
//     canonical ACs, read one run;
//   * the local worker — the same narrow worker token as extraction,
//     analysis and AC generation. For test generation it grants exactly:
//     claim a queued run, receive THAT run's fixed input, record validated
//     stage results, and complete / fail THAT run.
// Eligibility and the exact input are decided in SQL (test_generation_input,
// migration 047). Nothing here writes canonical test_cases, artefact_links,
// acceptance_criteria, requirements, evidence, sign-offs, ProjectState or
// Go-Live Readiness, and the worker never receives existing tests. The
// reviewer's run read (Phase 1H) adds advisory similarity against existing
// canonical tests, computed on the server (lib/test-review-server.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerIdentity } from "@/lib/extraction-server";
import { configuredAnalysisModel } from "@/lib/requirement-analysis-server";
import type { Actor, ServiceResult } from "@/lib/source-documents-server";
import { TEST_GENERATION_STAGES, validateTestGenerationSubmission, type TestGenerationInput } from "@/lib/test-generation";
import type { ReviewedTestProposal } from "@/lib/test-review";
import { similarExistingTests } from "@/lib/test-review-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d{1,6}(\.\d{1,6}){0,2}$/;
export const TEST_GENERATION_LEASE_SECONDS = 1800;
const MAX_STAGE_OUTPUT_CHARS = 250_000;
const ERROR_CATEGORIES = new Set(["ollama_unreachable", "model_unavailable", "invalid_model_output", "validation_failed", "context_too_large", "model_timeout", "worker_timeout", "upload_failed", "internal_error"]);
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

type RunRow = {
  id: string; project_id: string; requirement_id: string; ac_ids: string[]; retry_of_run_id: string | null; model: string;
  prompt_version: string | null; attempt_count: number; status: string; worker_id: string | null; extraction_job_ids: string[];
  input_snapshot: TestGenerationInput; allowed_fragment_ids: string[]; human_clarification_ids: string[]; analysis_clarification_ids: string[];
  scope_note_ids: string[]; resolved_issue_ids: string[]; open_issue_ids: string[];
};

const runLabel = (snapshot: TestGenerationInput | null | undefined) => `${snapshot?.requirement?.ref ?? "Requirement"} — test case generation`;

async function audit(db: SupabaseClient, changedBy: string | null, changedByName: string, row: { project_id: string; entity_id: string; entity_name: string; old_value: string | null; new_value: string }) {
  const { error } = await db.from("audit_log").insert({
    ...row, entity_type: "test_generation_runs", action_type: "Status Change", field_name: "test_generation", changed_by: changedBy, changed_by_name: changedByName,
  });
  if (error) console.error("[test-generation] audit write failed:", error.message);
  return error?.message ?? null;
}
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(text).filter((x) => UUID.test(x)))] : null);

// ── People ──────────────────────────────────────────────────────────────────

/** Manager/Admin: is this Requirement (and its ACs) eligible, plus its test generation runs, newest first. */
export async function getRequirementTestGeneration(db: SupabaseClient, projectId: string, requirementId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId) || !UUID.test(requirementId)) return fail(400, "project_id and requirement_id are required");
  const { data, error } = await db.rpc("test_generation_input", { p_project_id: projectId, p_requirement_id: requirementId, p_ac_ids: null });
  if (error) return mapDbError(error);
  const input = (Array.isArray(data) ? data[0] : data) as { eligible: boolean; reason: string | null; snapshot: TestGenerationInput | null } | undefined;
  const { data: runs } = await db.from("test_generation_runs")
    .select("id, status, trigger, retry_of_run_id, ac_ids, requested_by_name, queued_at, started_at, completed_at, attempt_count, model, prompt_version, proposal_count, issue_count, needs_review_count, warnings_count, error_category, error_message")
    .eq("project_id", projectId).eq("requirement_id", requirementId).order("queued_at", { ascending: false }).limit(20);
  const acs = (input?.snapshot?.acceptance_criteria ?? []).map((a) => ({ id: a.id, ref: a.ref, criterion: a.criterion, origin: a.origin, criterion_type: a.criterion_type }));
  return {
    status: 200,
    body: { eligibility: { eligible: input?.eligible === true, reason: input?.reason ?? null }, acceptance_criteria: acs, runs: runs ?? [], configured_model: await configuredAnalysisModel(db) },
  };
}

/** Manager/Admin: queue test generation for a Requirement and (optionally) a subset of its ACs, or retry a failed run. */
export async function queueTestGeneration(db: SupabaseClient, actor: Actor, body: Record<string, unknown>): Promise<ServiceResult> {
  const projectId = text(body.project_id), requirementId = text(body.requirement_id), retryOf = text(body.retry_of_run_id);
  if (!UUID.test(projectId) || !UUID.test(requirementId)) return fail(400, "project_id and requirement_id are required");
  if (retryOf && !UUID.test(retryOf)) return fail(400, "retry_of_run_id is invalid");
  const acIds = body.ac_ids === undefined || body.ac_ids === null ? null : ids(body.ac_ids);
  if (acIds !== null && (acIds.length === 0 || acIds.length > 50)) return fail(400, "Choose between 1 and 50 acceptance criteria");
  const model = await configuredAnalysisModel(db);
  const { data, error } = await db.rpc("queue_test_generation_run", {
    p_project_id: projectId, p_requirement_id: requirementId, p_ac_ids: acIds, p_model: model,
    p_user_id: actor.userId, p_user_name: actor.displayName, p_retry_of_run_id: retryOf || null,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { run_id: string; trigger: "manual" | "retry" };
  const { data: run } = await db.from("test_generation_runs").select("*").eq("id", row.run_id).maybeSingle();
  const r = run as RunRow | null;
  const n = r?.ac_ids.length ?? 0;
  const auditWarning = await audit(db, actor.userId, actor.displayName, {
    project_id: projectId, entity_id: row.run_id, entity_name: runLabel(r?.input_snapshot),
    old_value: row.trigger === "retry" ? "Failed" : null,
    new_value: `${row.trigger === "retry" ? "Queued (retry" : "Queued ("}${n} acceptance criteri${n === 1 ? "on" : "a"}, model ${model})`,
  });
  return { status: 200, body: { run, ...(auditWarning ? { audit_warning: auditWarning } : {}) } };
}

/**
 * Manager/Admin: one run with its proposed tests, issues, the exact fragments
 * it was given — plus the Phase 1H review context: what still blocks each
 * open proposal, similar existing canonical tests (advisory), the source
 * ACs' current canonical state (to show changes since generation), sibling
 * runs and the review history.
 */
export async function getTestGenerationRun(db: SupabaseClient, projectId: string, runId: string): Promise<ServiceResult> {
  if (!UUID.test(projectId) || !UUID.test(runId)) return fail(400, "project_id and run_id are required");
  const { data: run } = await db.from("test_generation_runs").select("*").eq("id", runId).eq("project_id", projectId).maybeSingle();
  if (!run) return fail(404, "Test generation run not found in this project");
  const r = run as RunRow;
  const [proposals, issues, fragments, siblings, requirement, currentAcs] = await Promise.all([
    db.from("test_case_proposals").select("*").eq("generation_run_id", runId).order("sequence", { ascending: true }),
    db.from("test_generation_issues").select("*").eq("generation_run_id", runId).order("sequence", { ascending: true }),
    r.allowed_fragment_ids.length ? db.from("source_fragments").select(FRAGMENT_COLUMNS).in("id", r.allowed_fragment_ids).order("sequence", { ascending: true }) : Promise.resolve({ data: [] }),
    db.from("test_generation_runs").select("id, status, queued_at, prompt_version, proposal_count").eq("project_id", projectId).eq("requirement_id", r.requirement_id).order("queued_at", { ascending: false }).limit(20),
    db.from("requirements").select("id, requirement_ref, title, status").eq("id", r.requirement_id).maybeSingle(),
    db.from("acceptance_criteria").select("id, ac_ref, criterion, description, criterion_type, given_text, when_text, then_text, status").eq("project_id", projectId).in("id", r.ac_ids),
  ]);
  const props = (proposals.data ?? []) as ReviewedTestProposal[];
  const open = props.filter((p) => ["Proposed", "Needs Review", "Approved"].includes(p.review_status));
  const blockers: Record<string, string[]> = {};
  await Promise.all(open.map(async (p) => {
    const { data } = await db.rpc("test_approval_blockers", { p_proposal_id: p.id, p_confirmed: true, p_accept: false });
    blockers[p.id] = (data ?? []) as string[];
  }));
  const similar = Object.fromEntries(await similarExistingTests(db, projectId, open));
  const entityIds = [runId, ...props.map((p) => p.id), ...props.map((p) => p.promoted_test_id).filter((x): x is string => Boolean(x))];
  const { data: history } = await db.from("audit_log").select("id, entity_type, entity_name, action_type, field_name, old_value, new_value, changed_by_name, changed_at")
    .eq("project_id", projectId).in("entity_id", entityIds).order("changed_at", { ascending: false }).limit(300);
  return {
    status: 200,
    body: {
      run, proposals: props, issues: issues.data ?? [], fragments: fragments.data ?? [], sibling_runs: siblings.data ?? [],
      latest_run_id: (siblings.data?.[0] as { id?: string } | undefined)?.id ?? runId,
      requirement: requirement.data, current_acceptance_criteria: currentAcs.data ?? [], approval_blockers: blockers, similar_tests: similar, history: history ?? [],
    },
  };
}

// ── Worker protocol ─────────────────────────────────────────────────────────

/**
 * Claims the oldest queued run. Returns the run's fixed input — never more:
 * the Requirement, its ACs and their governed context (from the snapshot),
 * the allowed fragments, plus earlier validated stage results that may be
 * reused (this run's, and the failed runs it retries, same model and prompt).
 */
export async function workerTestGenerationClaim(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const promptVersion = text(body.test_prompt_version), promptSha = text(body.test_prompt_sha256), schemaVersion = text(body.test_schema_version);
  if (!VERSION.test(promptVersion) || !/^[0-9a-f]{64}$/.test(promptSha) || !VERSION.test(schemaVersion)) {
    return fail(400, "test_prompt_version, test_prompt_sha256 and test_schema_version are required");
  }
  const { data, error } = await db.rpc("claim_test_generation_run", {
    p_worker_id: worker.id, p_worker_name: worker.name, p_worker_version: text(body.worker_version).slice(0, 40) || null,
    p_prompt_version: promptVersion, p_prompt_sha256: promptSha, p_schema_version: schemaVersion, p_lease_seconds: TEST_GENERATION_LEASE_SECONDS,
  });
  if (error) return mapDbError(error);
  const run = (Array.isArray(data) ? data[0] : data) as RunRow | undefined;
  if (!run?.id) return { status: 200, body: { run: null } };

  // Provenance must still be intact: every allowed fragment present in one of the run's extraction jobs.
  let fragments: unknown[] = [];
  if (run.allowed_fragment_ids.length) {
    const { data: rows, error: fragError } = await db.from("source_fragments").select(FRAGMENT_COLUMNS)
      .in("id", run.allowed_fragment_ids).in("extraction_job_id", run.extraction_job_ids).order("sequence", { ascending: true });
    fragments = rows ?? [];
    if (fragError || fragments.length !== new Set(run.allowed_fragment_ids).size) {
      await db.rpc("fail_test_generation_run", { p_run_id: run.id, p_worker_id: worker.id, p_category: "validation_failed", p_message: "The acceptance criteria's source provenance could not be loaded intact, so no tests were generated.", p_model_digest: null, p_diagnostics: null });
      await audit(db, null, `Analysis worker (${worker.name})`, { project_id: run.project_id, entity_id: run.id, entity_name: runLabel(run.input_snapshot), old_value: "Running", new_value: "Failed — validation_failed (source provenance)" });
      return { status: 200, body: { run: null } };
    }
  }

  const chain = [run.id];
  let cursor = run.retry_of_run_id;
  while (cursor && chain.length < 6) {
    const { data: prior } = await db.from("test_generation_runs").select("id, retry_of_run_id, model, prompt_version, requirement_id").eq("id", cursor).maybeSingle();
    const p = prior as { id: string; retry_of_run_id: string | null; model: string; prompt_version: string | null; requirement_id: string } | null;
    if (!p || p.requirement_id !== run.requirement_id) break;
    if (p.model === run.model && p.prompt_version === promptVersion) chain.push(p.id);
    cursor = p.retry_of_run_id;
  }
  const { data: stages } = await db.from("test_generation_stage_results").select("generation_run_id, stage, chunk_key, input_hash, output, model, prompt_version").in("generation_run_id", chain);
  const reusable = ((stages ?? []) as { generation_run_id: string; stage: string; chunk_key: string; input_hash: string; output: unknown; model: string; prompt_version: string }[])
    .filter((s) => s.model === run.model && s.prompt_version === promptVersion)
    .map((s) => ({ run_id: s.generation_run_id, stage: s.stage, chunk_key: s.chunk_key, input_hash: s.input_hash, output: s.output }));

  const s = run.input_snapshot;
  return {
    status: 200,
    body: {
      run: { id: run.id, project_id: run.project_id, model: run.model, attempt_count: run.attempt_count, lease_seconds: TEST_GENERATION_LEASE_SECONDS },
      requirement: s.requirement, acceptance_criteria: s.acceptance_criteria, fragments,
      human_clarifications: s.human_clarifications ?? [], analysis_clarifications: s.analysis_clarifications ?? [], scope_notes: s.scope_notes ?? [],
      resolved_questions: s.resolved_questions ?? [], open_questions: s.open_questions ?? [], reusable_stages: reusable,
    },
  };
}

export async function workerTestGenerationStage(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id), stage = text(body.stage), chunkKey = text(body.chunk_key), inputHash = text(body.input_hash);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  if (!(TEST_GENERATION_STAGES as readonly string[]).includes(stage)) return fail(400, "stage is invalid");
  if (!/^[A-Za-z0-9:._-]{1,80}$/.test(chunkKey)) return fail(400, "chunk_key is invalid");
  if (!/^[0-9a-f]{64}$/.test(inputHash)) return fail(400, "input_hash is invalid");
  const output = body.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || JSON.stringify(output).length > MAX_STAGE_OUTPUT_CHARS) return fail(400, "output must be a JSON object (≤ 250 KB)");
  const reusedFrom = text(body.reused_from);
  const { data, error } = await db.rpc("record_test_generation_stage", {
    p_run_id: runId, p_worker_id: worker.id, p_stage: stage, p_chunk_key: chunkKey, p_input_hash: inputHash,
    p_attempts: Math.max(1, Math.min(10, Number(body.attempts) || 1)), p_reused_from: UUID.test(reusedFrom) ? reusedFrom : null,
    p_output: output, p_lease_seconds: TEST_GENERATION_LEASE_SECONDS,
  });
  if (error) return mapDbError(error);
  return { status: 200, body: { stored: data === true } };
}

export async function workerTestGenerationComplete(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const { data: run } = await db.from("test_generation_runs").select("*").eq("id", runId).maybeSingle();
  const r = run as RunRow | null;
  if (!r || r.status !== "Running" || r.worker_id !== worker.id) return fail(409, "This test generation run is not running for this worker");

  // Stage 5 on the server: provenance against the run's OWN allowed sets.
  const checked = validateTestGenerationSubmission(body.proposals, body.issues, {
    acs: new Set(r.ac_ids), fragments: new Set(r.allowed_fragment_ids), human: new Set(r.human_clarification_ids), clarifications: new Set(r.analysis_clarification_ids),
    resolved: new Set(r.resolved_issue_ids), scopeNotes: new Set(r.scope_note_ids), openQuestions: new Set(r.open_issue_ids),
  });
  if (!checked.ok) return fail(400, `Generated tests refused: ${checked.problems.slice(0, 5).join("; ")}`);
  const diagnostics = body.diagnostics && typeof body.diagnostics === "object" && !Array.isArray(body.diagnostics) && JSON.stringify(body.diagnostics).length <= 200_000 ? body.diagnostics : {};
  const { data, error } = await db.rpc("complete_test_generation_run", {
    p_run_id: runId, p_worker_id: worker.id, p_model_digest: text(body.model_digest).slice(0, 100) || null,
    p_proposals: checked.proposals, p_issues: checked.issues, p_diagnostics: diagnostics, p_with_warnings: body.with_warnings === true,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { project_id: string; status: string; proposal_count: number; issue_count: number; needs_review_count: number };
  await audit(db, null, `Analysis worker (${worker.name})`, {
    project_id: row.project_id, entity_id: runId, entity_name: runLabel(r.input_snapshot), old_value: "Running",
    new_value: `${row.status} — ${row.proposal_count} proposed test case${row.proposal_count === 1 ? "" : "s"}, ${row.needs_review_count} needing review, ${row.issue_count} test-design issue${row.issue_count === 1 ? "" : "s"} (model ${r.model}, test prompts ${r.prompt_version ?? "?"})`,
  });
  return { status: 200, body: { ok: true, status: row.status, proposal_count: row.proposal_count, issue_count: row.issue_count, needs_review_count: row.needs_review_count } };
}

export async function workerTestGenerationFail(db: SupabaseClient, worker: WorkerIdentity, body: Record<string, unknown>): Promise<ServiceResult> {
  const runId = text(body.run_id);
  if (!UUID.test(runId)) return fail(400, "run_id is required");
  const category = ERROR_CATEGORIES.has(text(body.error_category)) ? text(body.error_category) : "internal_error";
  // A short, plain message only — never document content or model output.
  const message = text(body.error_message).replace(/\s+/g, " ").slice(0, 500) || "Generation failed.";
  const raw = body.diagnostics && typeof body.diagnostics === "object" && !Array.isArray(body.diagnostics) ? body.diagnostics as Record<string, unknown> : null;
  const diagnostics = raw ? { stage_calls: Array.isArray(raw.stage_calls) ? raw.stage_calls.slice(0, 50) : undefined, warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 50).map((w) => String(w).slice(0, 300)) : undefined } : null;
  const { data, error } = await db.rpc("fail_test_generation_run", {
    p_run_id: runId, p_worker_id: worker.id, p_category: category, p_message: message,
    p_model_digest: text(body.model_digest).slice(0, 100) || null, p_diagnostics: diagnostics,
  });
  if (error) return mapDbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { project_id: string };
  const { data: run } = await db.from("test_generation_runs").select("input_snapshot").eq("id", runId).maybeSingle();
  await audit(db, null, `Analysis worker (${worker.name})`, {
    project_id: row.project_id, entity_id: runId, entity_name: runLabel((run as { input_snapshot?: TestGenerationInput } | null)?.input_snapshot), old_value: "Running", new_value: `Failed — ${category}`,
  });
  return { status: 200, body: { ok: true } };
}
