// Local extraction worker (Phase 1B).
//
// Runs on this Mac, alongside (but separate from) the local AI gateway. It
// polls Test Manager for queued extraction jobs, downloads each claimed file
// through a short-lived signed URL, verifies its size and SHA-256, extracts
// text deterministically (extract.js — no AI, no external services), and
// posts the fragments back. Document text only ever goes to Test Manager's
// own backend; it is never sent to any AI provider.
//
// Security:
//   * authenticates with a narrow worker token (config.json, gitignored)
//     that is valid ONLY on /api/worker/* — claim, fragments, complete,
//     fail, heartbeat. It is not a browser session and holds no Supabase
//     credentials; the server can revoke it at any time (System Health).
//   * never logs the token or any document content — only job ids, counts
//     and categories.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTRACTOR_VERSION, ExtractionError, extractSourceDocument } from "./extract.js";

export const WORKER_VERSION = "0.1.0";
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
  };
}

export function createApi({ apiBaseUrl, workerToken, requestTimeoutMs = 60_000, fetchImpl = fetch }) {
  return async function post(route, body) {
    const res = await fetchImpl(`${apiBaseUrl}/api/worker/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({ worker_version: WORKER_VERSION, ...body }),
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

async function main() {
  const config = loadConfig();
  const api = createApi(config);
  const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
  let stopping = false;
  const stop = () => { stopping = true; log("stopping after the current job…"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log(`Test Manager extraction worker ${WORKER_VERSION} (extractor ${EXTRACTOR_VERSION}) → ${config.apiBaseUrl}`);
  const beat = async () => { try { await api("heartbeat", {}); } catch (error) { log(`heartbeat failed: ${safeMessage(error)}`); } };
  await beat();
  const heartbeat = setInterval(beat, config.heartbeatIntervalMs);

  while (!stopping) {
    try {
      const done = await runOnce({ api, log });
      if (done) continue; // look for more work straight away
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
