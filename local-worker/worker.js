// Local extraction + analysis worker (Phase 1B / 1C).
//
// Runs on this Mac, alongside (but separate from) the local AI gateway. It
// polls Test Manager for queued extraction jobs, downloads each claimed file
// through a short-lived signed URL, verifies its size and SHA-256, extracts
// text deterministically (extract.js — no AI, no external services), and
// posts the fragments back.
//
// When no extraction is waiting it takes queued ANALYSIS runs (Phase 1C):
// it receives the fragments of that run's one extraction job, analyses them
// with the LOCAL Ollama model the run names (analysis/ — staged, schema-
// validated, provenance-checked), and posts the proposals back. Document
// text only ever goes to Test Manager's own backend and to Ollama on this
// Mac (loopback only); it is never sent to any external AI provider.
//
// Lowest priority (Phase 1E): Acceptance Criteria GENERATION for one
// promoted Requirement at a time — only when neither extraction nor
// requirement analysis is waiting. It receives exactly that Requirement's
// fixed input (its promoted proposal's source fragments, human
// clarifications, open questions and acknowledged scope notes) and posts
// back non-authoritative AC proposals for human review.
//
// Security:
//   * authenticates with a narrow worker token (config.json, gitignored)
//     that is valid ONLY on /api/worker/* — extraction claim, fragments,
//     complete, fail, heartbeat; analysis claim, stage, complete, fail. It
//     is not a browser session, holds no Supabase credentials and grants no
//     Requirements (or any other project data) access; the server can
//     revoke it at any time (System Health).
//   * never logs the token or any document content — only job ids, counts
//     and categories.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTRACTOR_VERSION, ExtractionError, extractSourceDocument } from "./extract.js";
import { OllamaError, assertLoopbackUrl, createOllama } from "./analysis/ollama.js";
import { AnalysisError, runAnalysis } from "./analysis/pipeline.js";
import { ANALYSIS_SCHEMA_VERSION, PROMPT_VERSION, promptFingerprint } from "./analysis/prompts.js";
import { AcGenerationError, runAcGeneration } from "./ac-generation/pipeline.js";
import { AC_PROMPT_VERSION, AC_SCHEMA_VERSION, acPromptFingerprint } from "./ac-generation/prompts.js";

export const WORKER_VERSION = "0.4.0";
export const BATCH_MAX_FRAGMENTS = 200;
export const BATCH_MAX_CHARS = 2_000_000; // keeps each request well under Vercel's 4.5 MB body limit

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(file = path.join(here, "config.json")) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} — copy config.example.json and add the worker token from System Health.`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return validateConfig(raw);
}

export function validateConfig(raw) {
  const url = new URL(String(raw.apiBaseUrl ?? ""));
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("apiBaseUrl must be https (http is allowed only for localhost).");
  const token = String(raw.workerToken ?? "");
  if (!/^tmw_[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("workerToken is missing or malformed — issue one in System Health (Admin).");
  return {
    apiBaseUrl: url.origin,
    workerToken: token,
    pollIntervalMs: Math.max(5_000, Number(raw.pollIntervalMs ?? 15_000)),
    heartbeatIntervalMs: Math.max(15_000, Number(raw.heartbeatIntervalMs ?? 60_000)),
    requestTimeoutMs: Math.max(5_000, Number(raw.requestTimeoutMs ?? 60_000)),
    // Phase 1C: local Ollama only — a non-loopback URL is refused.
    analysisEnabled: raw.analysisEnabled !== false,
    ollamaUrl: assertLoopbackUrl(raw.ollamaUrl ?? "http://127.0.0.1:11434"),
    ollamaTimeoutMs: Math.max(30_000, Number(raw.ollamaTimeoutMs ?? 300_000)),
  };
}

export function createApi({ apiBaseUrl, workerToken, requestTimeoutMs = 60_000, fetchImpl = fetch }) {
  return async function post(route, body) {
    const res = await fetchImpl(`${apiBaseUrl}/api/worker/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${workerToken}` },
      // extractor_version lets the server offer re-extraction when this worker
      // runs a newer extractor than a version's last successful extraction.
      body: JSON.stringify({ worker_version: WORKER_VERSION, extractor_version: EXTRACTOR_VERSION, analysis_version: PROMPT_VERSION, ...body }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(`${route} failed (${res.status}): ${json?.error ?? "no details"}`);
      error.status = res.status;
      throw error;
    }
    return json;
  };
}

/** Splits fragments into request-sized batches, preserving order. */
export function batchFragments(fragments, maxCount = BATCH_MAX_FRAGMENTS, maxChars = BATCH_MAX_CHARS) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const fragment of fragments) {
    const cost = JSON.stringify(fragment).length;
    if (current.length && (current.length >= maxCount || size + cost > maxChars)) { batches.push(current); current = []; size = 0; }
    current.push(fragment);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

const safeMessage = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

/** Processes one claimed job end to end. Never throws; returns a summary. */
export async function processJob(claim, { api, fetchImpl = fetch, log = () => {} }) {
  const { job, download } = claim;
  const failJob = async (category, message, diagnostics = null) => {
    try {
      await api("fail", { job_id: job.id, error_category: category, error_message: message, extractor_version: EXTRACTOR_VERSION, diagnostics });
    } catch (error) {
      log(`job ${job.id}: could not report failure (${safeMessage(error)}); the lease will expire and the server will retry`);
    }
    log(`job ${job.id}: failed (${category})`);
    return { job_id: job.id, status: "Failed", category };
  };

  let bytes;
  try {
    const res = await fetchImpl(download.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return failJob("download_failed", `Download failed with HTTP ${res.status}.`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    return failJob("download_failed", `Download failed: ${safeMessage(error)}`);
  }
  if (bytes.length !== Number(job.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== job.sha256) {
    return failJob("integrity_mismatch", "The downloaded file does not match the size/SHA-256 recorded at upload.");
  }

  let result;
  try {
    result = await extractSourceDocument(bytes, job.content_type);
  } catch (error) {
    if (error instanceof ExtractionError) return failJob(error.category, error.message);
    return failJob("internal_error", `Unexpected extractor error: ${safeMessage(error)}`);
  }
  if (result.outcome === "ocr_required") {
    return failJob("ocr_required", "No meaningful extractable text was found (the document may be scanned images). OCR / manual review is required — no fragments were saved.", result.diagnostics);
  }

  try {
    for (const batch of batchFragments(result.fragments)) await api("fragments", { job_id: job.id, fragments: batch });
    await api("complete", {
      job_id: job.id, outcome: result.outcome, extractor_version: result.extractor_version,
      diagnostics: result.diagnostics, fragment_count: result.fragments.length,
    });
  } catch (error) {
    return failJob("upload_failed", `Saving the extracted fragments failed: ${safeMessage(error)}`);
  }
  log(`job ${job.id}: ${result.outcome} — ${result.fragments.length} fragments`);
  return { job_id: job.id, status: "Completed", outcome: result.outcome, fragments: result.fragments.length };
}

/** Claims and processes at most one job. Returns null when the queue is empty. */
export async function runOnce({ api, fetchImpl = fetch, log = () => {} }) {
  const claim = await api("claim", {});
  if (!claim?.job) return null;
  log(`job ${claim.job.id}: claimed (attempt ${claim.job.attempt}, ${claim.job.content_type === "application/pdf" ? "PDF" : "DOCX"})`);
  return processJob(claim, { api, fetchImpl, log });
}

// ── Analysis (Phase 1C) ────────────────────────────────────────────────────

export const ANALYSIS_IDENTITY = { prompt_version: PROMPT_VERSION, prompt_sha256: promptFingerprint(), analysis_schema_version: ANALYSIS_SCHEMA_VERSION };

/** Processes one claimed analysis run end to end. Never throws; returns a summary. */
export async function processAnalysisRun(claim, { api, ollama, log = () => {} }) {
  const { run, fragments, reusable_stages: reusable = [] } = claim;
  let modelDigest = null;
  const failRun = async (category, message, diagnostics = null) => {
    try {
      await api("analysis/fail", { run_id: run.id, error_category: category, error_message: message, model_digest: modelDigest, diagnostics });
    } catch (error) {
      log(`analysis ${run.id}: could not report failure (${safeMessage(error)}); the lease will expire and the server will retry`);
    }
    log(`analysis ${run.id}: failed (${category})`);
    return { run_id: run.id, status: "Failed", category };
  };

  const status = await ollama.status();
  if (!status.reachable) return failRun("ollama_unreachable", "Ollama is not reachable on the worker's Mac. Start Ollama and retry.");
  const installed = status.models.find((m) => m.name === run.model);
  if (!installed) return failRun("model_unavailable", `The analysis model "${run.model}" is not installed in Ollama on the worker's Mac. Install it or choose another model in System Health.`);
  modelDigest = installed.digest ? `${installed.digest.slice(0, 12)}${status.version ? ` (ollama ${status.version})` : ""}` : null;

  let numCtx = 16_384;
  let think = null;
  try {
    const info = await ollama.show(run.model);
    if (info.contextLength) numCtx = Math.min(numCtx, info.contextLength);
    if (info.capabilities.includes("thinking")) think = false; // structured output without a reasoning preamble
  } catch (error) {
    return failRun(error instanceof OllamaError ? error.category : "internal_error", safeMessage(error));
  }

  let result;
  try {
    result = await runAnalysis({
      run, fragments, reusable, log: (m) => log(`analysis ${run.id}: ${m}`),
      llm: { chat: ({ messages, schema }) => ollama.chat({ model: run.model, messages, schema, numCtx, think }) },
      onStage: (s) => api("analysis/stage", { run_id: run.id, ...s }),
    });
  } catch (error) {
    if (error instanceof AnalysisError) return failRun(error.category, safeMessage(error), error.diagnostics);
    if (error instanceof OllamaError) return failRun(error.category, safeMessage(error));
    return failRun(error?.status ? "upload_failed" : "internal_error", `Analysis stopped: ${safeMessage(error)}`);
  }

  try {
    await api("analysis/complete", {
      run_id: run.id, model_digest: modelDigest, proposals: result.proposals, issues: result.issues, scope_notes: result.scope_notes,
      diagnostics: result.diagnostics, with_warnings: result.withWarnings,
    });
  } catch (error) {
    return failRun("upload_failed", `Saving the analysis failed: ${safeMessage(error)}`, result.diagnostics);
  }
  log(`analysis ${run.id}: ${result.withWarnings ? "completed with warnings" : "completed"} — ${result.proposals.length} proposals, ${result.issues.length} issues, ${result.scope_notes.length} scope notes`);
  return { run_id: run.id, status: "Completed", proposals: result.proposals.length, issues: result.issues.length };
}

/** Claims and processes at most one analysis run. Returns null when none is queued. */
export async function runAnalysisOnce({ api, ollama, log = () => {}, state = {} }) {
  let claim;
  try {
    claim = await api("analysis/claim", { ...ANALYSIS_IDENTITY });
  } catch (error) {
    // A Test Manager deployment without Phase 1C has no analysis routes yet.
    if (error.status !== 404) throw error;
    if (!state.noAnalysisLogged) log("the server does not offer analysis yet (no /api/worker/analysis routes) — extraction continues");
    state.noAnalysisLogged = true;
    return null;
  }
  state.noAnalysisLogged = false;
  if (!claim?.run) return null;
  log(`analysis ${claim.run.id}: claimed (attempt ${claim.run.attempt_count}, model ${claim.run.model}, ${claim.fragments.length} fragments)`);
  return processAnalysisRun(claim, { api, ollama, log });
}

// ── Acceptance Criteria generation (Phase 1E) ───────────────────────────────

export const AC_IDENTITY = { ac_prompt_version: AC_PROMPT_VERSION, ac_prompt_sha256: acPromptFingerprint(), ac_schema_version: AC_SCHEMA_VERSION };

/** Model digest, context window and thinking mode for one installed model; or a failure category. */
async function prepareModel(ollama, model) {
  const status = await ollama.status();
  if (!status.reachable) return { fail: ["ollama_unreachable", "Ollama is not reachable on the worker's Mac. Start Ollama and retry."] };
  const installed = status.models.find((m) => m.name === model);
  if (!installed) return { fail: ["model_unavailable", `The model "${model}" is not installed in Ollama on the worker's Mac. Install it or choose another model in System Health.`] };
  const digest = installed.digest ? `${installed.digest.slice(0, 12)}${status.version ? ` (ollama ${status.version})` : ""}` : null;
  try {
    const info = await ollama.show(model);
    return { digest, numCtx: Math.min(16_384, info.contextLength ?? 16_384), think: info.capabilities.includes("thinking") ? false : null };
  } catch (error) {
    return { digest, fail: [error instanceof OllamaError ? error.category : "internal_error", safeMessage(error)] };
  }
}

/** Processes one claimed AC-generation run end to end. Never throws; returns a summary. */
export async function processAcGenerationRun(claim, { api, ollama, log = () => {} }) {
  const { run } = claim;
  let modelDigest = null;
  const failRun = async (category, message, diagnostics = null) => {
    try {
      await api("ac-generation/fail", { run_id: run.id, error_category: category, error_message: message, model_digest: modelDigest, diagnostics });
    } catch (error) {
      log(`ac-generation ${run.id}: could not report failure (${safeMessage(error)}); the lease will expire and the server will retry`);
    }
    log(`ac-generation ${run.id}: failed (${category})`);
    return { run_id: run.id, status: "Failed", category };
  };
  const model = await prepareModel(ollama, run.model);
  modelDigest = model.digest ?? null;
  if (model.fail) return failRun(...model.fail);

  let result;
  try {
    result = await runAcGeneration({
      input: claim, reusable: claim.reusable_stages ?? [], log: (m) => log(`ac-generation ${run.id}: ${m}`),
      llm: { chat: ({ messages, schema }) => ollama.chat({ model: run.model, messages, schema, numCtx: model.numCtx, think: model.think }) },
      onStage: (s) => api("ac-generation/stage", { run_id: run.id, ...s }),
    });
  } catch (error) {
    if (error instanceof AcGenerationError) return failRun(error.category, safeMessage(error), error.diagnostics);
    if (error instanceof OllamaError) return failRun(error.category, safeMessage(error));
    return failRun(error?.status ? "upload_failed" : "internal_error", `Generation stopped: ${safeMessage(error)}`);
  }
  try {
    await api("ac-generation/complete", { run_id: run.id, model_digest: modelDigest, proposals: result.proposals, issues: result.issues, diagnostics: result.diagnostics, with_warnings: result.withWarnings });
  } catch (error) {
    return failRun("upload_failed", `Saving the generated criteria failed: ${safeMessage(error)}`, result.diagnostics);
  }
  log(`ac-generation ${run.id}: ${result.withWarnings ? "completed with warnings" : "completed"} — ${result.proposals.length} criteria, ${result.issues.length} issues`);
  return { run_id: run.id, status: "Completed", proposals: result.proposals.length, issues: result.issues.length };
}

/** Claims and processes at most one AC-generation run. Returns null when none is queued. */
export async function runAcGenerationOnce({ api, ollama, log = () => {}, state = {} }) {
  let claim;
  try {
    claim = await api("ac-generation/claim", { ...AC_IDENTITY });
  } catch (error) {
    // A Test Manager deployment without Phase 1E has no AC-generation routes yet.
    if (error.status !== 404) throw error;
    if (!state.noAcGenerationLogged) log("the server does not offer acceptance criteria generation yet — extraction and analysis continue");
    state.noAcGenerationLogged = true;
    return null;
  }
  state.noAcGenerationLogged = false;
  if (!claim?.run) return null;
  log(`ac-generation ${claim.run.id}: claimed (attempt ${claim.run.attempt_count}, model ${claim.run.model}, ${claim.fragments.length} fragments)`);
  return processAcGenerationRun(claim, { api, ollama, log });
}

async function main() {
  const config = loadConfig();
  const api = createApi(config);
  const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
  let stopping = false;
  const analysisState = {};
  const stop = () => { stopping = true; log("stopping after the current job…"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const ollama = createOllama({ ollamaUrl: config.ollamaUrl, timeoutMs: config.ollamaTimeoutMs });
  log(`Test Manager worker ${WORKER_VERSION} (extractor ${EXTRACTOR_VERSION}, analysis prompts ${PROMPT_VERSION}, AC prompts ${AC_PROMPT_VERSION}${config.analysisEnabled ? "" : " — disabled"}) → ${config.apiBaseUrl}`);
  // The heartbeat reports what this Mac's Ollama has installed (names/digests only) for System Health.
  const beat = async () => { try { await api("heartbeat", config.analysisEnabled ? { ollama: await ollama.status() } : {}); } catch (error) { log(`heartbeat failed: ${safeMessage(error)}`); } };
  await beat();
  const heartbeat = setInterval(beat, config.heartbeatIntervalMs);

  while (!stopping) {
    try {
      const done = await runOnce({ api, log });
      if (done) continue; // look for more work straight away
      // Deterministic priority: extraction → requirement analysis → AC generation.
      if (config.analysisEnabled && await runAnalysisOnce({ api, ollama, log, state: analysisState })) continue;
      if (config.analysisEnabled && await runAcGenerationOnce({ api, ollama, log, state: analysisState })) continue;
    } catch (error) {
      log(`poll failed: ${safeMessage(error)}${error.status === 401 ? " — the worker token is invalid or was revoked" : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  clearInterval(heartbeat);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(safeMessage(error)); process.exit(1); });
}
