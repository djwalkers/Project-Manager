// Worker orchestration tests — real extractor, fake Test Manager API and
// fake signed-URL download. Proves the worker's narrow protocol and that
// every failure path reports a categorised, content-free error.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EXTRACTOR_VERSION } from "../extract.js";
import { WORKER_VERSION, batchFragments, createApi, processJob, runOnce, validateConfig } from "../worker.js";
import { makePdf, specPdf } from "./fixtures.mjs";

async function run(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

const TOKEN = `tmw_${"a".repeat(43)}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function harness(bytes, { jobOverrides = {}, failRoute } = {}) {
  const calls = [];
  const job = { id: "job-1", project_id: "p", document_version_id: "v", content_type: "application/pdf", sha256: sha(bytes), size_bytes: bytes.length, original_filename: "spec.pdf", attempt: 1, ...jobOverrides };
  const fetchImpl = async (url, init) => {
    if (url === "https://storage.example/signed") return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const route = url.replace("https://app.example/api/worker/", "");
    const body = JSON.parse(init.body);
    calls.push({ route, body, headers: init.headers });
    if (route === failRoute) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    if (route === "claim") return { ok: true, status: 200, json: async () => ({ job, download: { url: "https://storage.example/signed", expires_in: 300 } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const api = createApi({ apiBaseUrl: "https://app.example", workerToken: TOKEN, fetchImpl });
  return { calls, api, fetchImpl, job };
}

await run("a claimed PDF is downloaded, verified, extracted and posted as fragments, then completed", async () => {
  const bytes = specPdf();
  const h = harness(bytes);
  const summary = await runOnce({ api: h.api, fetchImpl: h.fetchImpl });
  assert.equal(summary.status, "Completed");
  assert.deepEqual(h.calls.map((c) => c.route), ["claim", "fragments", "complete"]);
  const fragments = h.calls[1].body.fragments;
  assert.deepEqual(fragments.map((f) => f.sequence), fragments.map((_, i) => i + 1));
  const complete = h.calls[2].body;
  assert.equal(complete.fragment_count, fragments.length);
  assert.equal(complete.extractor_version, EXTRACTOR_VERSION);
  assert.equal(complete.outcome, "completed");
  assert.ok(h.calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}` && c.body.worker_version === WORKER_VERSION));
  assert.ok(h.calls.every((c) => c.body.extractor_version === EXTRACTOR_VERSION), "every call reports the extractor version (drives re-extraction eligibility)");
  assert.ok(h.calls.every((c) => !JSON.stringify(c.body).includes(TOKEN)), "the token is only ever sent as a header");
});

await run("an empty queue is a no-op", async () => {
  const calls = [];
  const api = async (route) => { calls.push(route); return { job: null }; };
  assert.equal(await runOnce({ api }), null);
  assert.deepEqual(calls, ["claim"]);
});

await run("an image-only PDF is reported as ocr_required (failed) — never completed, no fragments sent", async () => {
  const bytes = makePdf([{ imageOnly: true }]);
  const h = harness(bytes);
  const summary = await runOnce({ api: h.api, fetchImpl: h.fetchImpl });
  assert.deepEqual([summary.status, summary.category], ["Failed", "ocr_required"]);
  assert.deepEqual(h.calls.map((c) => c.route), ["claim", "fail"]);
  assert.equal(h.calls[1].body.error_category, "ocr_required");
  assert.equal(h.calls[1].body.diagnostics.meaningful_text, false);
});

await run("a file that does not match its recorded SHA-256 is refused (integrity_mismatch)", async () => {
  const bytes = specPdf();
  const h = harness(bytes, { jobOverrides: { sha256: "0".repeat(64) } });
  const summary = await runOnce({ api: h.api, fetchImpl: h.fetchImpl });
  assert.equal(summary.category, "integrity_mismatch");
  assert.ok(!h.calls.some((c) => c.route === "fragments"));
});

await run("an unparseable file fails with parse_error and a short message (no content, no stack)", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4 definitely not a pdf");
  const h = harness(bytes);
  await runOnce({ api: h.api, fetchImpl: h.fetchImpl });
  const failCall = h.calls.find((c) => c.route === "fail");
  assert.equal(failCall.body.error_category, "parse_error");
  assert.ok(failCall.body.error_message.length <= 300);
  assert.doesNotMatch(failCall.body.error_message, /\n\s+at /);
});

await run("if saving fragments fails the job is failed as upload_failed (not left half-done)", async () => {
  const bytes = specPdf();
  const h = harness(bytes, { failRoute: "fragments" });
  const summary = await runOnce({ api: h.api, fetchImpl: h.fetchImpl });
  assert.equal(summary.category, "upload_failed");
  assert.deepEqual(h.calls.map((c) => c.route), ["claim", "fragments", "fail"]);
});

await run("a failed download is reported as download_failed", async () => {
  const claim = { job: { id: "j", sha256: "x", size_bytes: 1, content_type: "application/pdf" }, download: { url: "https://storage.example/gone" } };
  const calls = [];
  const summary = await processJob(claim, { api: async (route, body) => { calls.push([route, body.error_category]); return {}; }, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(summary.category, "download_failed");
  assert.deepEqual(calls, [["fail", "download_failed"]]);
});

await run("fragments are batched in order under the count and size limits", () => {
  const frags = Array.from({ length: 450 }, (_, i) => ({ sequence: i + 1, text: "x".repeat(100) }));
  const batches = batchFragments(frags, 200, 2_000_000);
  assert.deepEqual(batches.map((b) => b.length), [200, 200, 50]);
  assert.deepEqual(batches.flat().map((f) => f.sequence), frags.map((f) => f.sequence));
  assert.ok(batchFragments(frags, 1000, 5_000).every((b) => JSON.stringify(b).length <= 5_200));
});

await run("config requires https (http only for localhost) and a well-formed worker token", () => {
  assert.equal(validateConfig({ apiBaseUrl: "https://app.example/x", workerToken: TOKEN }).apiBaseUrl, "https://app.example");
  assert.equal(validateConfig({ apiBaseUrl: "http://localhost:3000", workerToken: TOKEN }).apiBaseUrl, "http://localhost:3000");
  assert.throws(() => validateConfig({ apiBaseUrl: "http://app.example", workerToken: TOKEN }), /https/);
  assert.throws(() => validateConfig({ apiBaseUrl: "https://app.example", workerToken: "sk-service-role" }), /workerToken/);
});

console.log("\nAll worker tests passed.\n");
