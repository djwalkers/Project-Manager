// Phase D — deterministic tests for the Local AI Assistant.
//
// No Ollama or real gateway required — global.fetch is mocked throughout.
// Scope note: this repo has no React rendering harness (no jsdom/RTL), so
// UI-only behaviour (badge rendering, warning banners, disabled attributes
// in the DOM) is covered here via the pure logic it's wired to, plus static
// source-scans confirming the component actually wires that logic in —
// not a full component render. The live smoke test (Phase D validation
// step) is what exercises the real rendered page end-to-end.
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const target = path.join(root, request.slice(2));
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts"), target]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

Module._extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

const req = Module.createRequire(import.meta.url);
const gatewayClient = req("../lib/ai/local-gateway-client.ts");
const {
  parseNdjsonLines, streamProjectAssistant, checkGatewayHealth,
  classifyGatewayReadiness, describeGatewayError, isLoopbackUrl,
} = gatewayClient;
const { parseFeasibilityAnswer } = req("../lib/ai/feasibility-answer.ts");
const { sourceRefHref } = req("../lib/ai/source-refs.ts");
const { canSendQuestion, shouldResetConversation, resolveAssistantReadiness } = req("../lib/ai/assistant-state.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// ── Fetch mocking helpers ────────────────────────────────────────────────────

function ndjsonResponse(lines, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "application/x-ndjson" } });
}

function withMockFetch(impl, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length - 1);
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = original; });
}

const GATEWAY_URL = "http://127.0.0.1:8787";

// ── 1. Health state mapping / installed-model validation ───────────────────

run("classifyGatewayReadiness: checking takes priority over everything else", () => {
  assert.equal(classifyGatewayReadiness({ checking: true, health: null, hadError: false, model: "qwen3:8b" }), "checking");
});

run("classifyGatewayReadiness: an error or missing health reads as gateway-unavailable", () => {
  assert.equal(classifyGatewayReadiness({ checking: false, health: null, hadError: true, model: "qwen3:8b" }), "gateway-unavailable");
  assert.equal(classifyGatewayReadiness({ checking: false, health: null, hadError: false, model: "qwen3:8b" }), "gateway-unavailable");
});

run("classifyGatewayReadiness: Ollama reported down reads as ollama-unavailable", () => {
  const health = { ok: true, ollama: "down", models: [], allowedModels: null };
  assert.equal(classifyGatewayReadiness({ checking: false, health, hadError: false, model: "qwen3:8b" }), "ollama-unavailable");
});

run("classifyGatewayReadiness: installed-model validation — not installed, not allow-listed, and empty model all read as model-unavailable", () => {
  const health = { ok: true, ollama: "up", models: ["qwen3:4b"], allowedModels: null };
  assert.equal(classifyGatewayReadiness({ checking: false, health, hadError: false, model: "qwen3:8b" }), "model-unavailable", "not installed");
  assert.equal(classifyGatewayReadiness({ checking: false, health, hadError: false, model: "" }), "model-unavailable", "no model configured");

  const restricted = { ok: true, ollama: "up", models: ["qwen3:8b"], allowedModels: ["qwen3:4b"] };
  assert.equal(classifyGatewayReadiness({ checking: false, health: restricted, hadError: false, model: "qwen3:8b" }), "model-unavailable", "installed but not allow-listed");
});

run("classifyGatewayReadiness: installed and (allow-listed or no allow-list) reads as ready", () => {
  const open = { ok: true, ollama: "up", models: ["qwen3:8b"], allowedModels: null };
  assert.equal(classifyGatewayReadiness({ checking: false, health: open, hadError: false, model: "qwen3:8b" }), "ready");
  const restricted = { ok: true, ollama: "up", models: ["qwen3:8b"], allowedModels: ["qwen3:8b"] };
  assert.equal(classifyGatewayReadiness({ checking: false, health: restricted, hadError: false, model: "qwen3:8b" }), "ready");
});

// ── 2. Local Ollama provider required for page readiness ───────────────────

run("resolveAssistantReadiness: a non-Ollama provider always reads not-ollama-provider, regardless of gateway health", () => {
  assert.equal(resolveAssistantReadiness(false, "ready"), "not-ollama-provider");
  assert.equal(resolveAssistantReadiness(false, "gateway-unavailable"), "not-ollama-provider");
});

run("resolveAssistantReadiness: Ollama selected passes through the gateway's own readiness", () => {
  assert.equal(resolveAssistantReadiness(true, "ready"), "ready");
  assert.equal(resolveAssistantReadiness(true, "model-unavailable"), "model-unavailable");
});

// ── 3. Project change clears conversation ───────────────────────────────────

run("shouldResetConversation: true only on a genuine change away from a real previous project", () => {
  assert.equal(shouldResetConversation(null, "p1"), false, "initial mount must not reset");
  assert.equal(shouldResetConversation("p1", "p1"), false, "same project must not reset");
  assert.equal(shouldResetConversation("p1", "p2"), true, "switching projects must reset");
  assert.equal(shouldResetConversation("p1", null), true, "deselecting a project must reset");
});

// ── 4. Send disabled in invalid states ──────────────────────────────────────

run("canSendQuestion: disabled unless ready, a project is selected, the question is non-empty, and nothing is already in flight", () => {
  const base = { readiness: "ready", projectId: "p1", question: "hi", sending: false };
  assert.equal(canSendQuestion(base), true);
  assert.equal(canSendQuestion({ ...base, readiness: "gateway-unavailable" }), false, "not ready");
  assert.equal(canSendQuestion({ ...base, projectId: null }), false, "no project");
  assert.equal(canSendQuestion({ ...base, question: "   " }), false, "blank question");
  assert.equal(canSendQuestion({ ...base, sending: true }), false, "already sending");
});

// ── 5. Partial NDJSON buffering ─────────────────────────────────────────────

run("parseNdjsonLines: only complete lines are parsed; a trailing partial line is carried over as the remainder", () => {
  const chunk1 = '{"type":"token","text":"Hel';
  const { events: events1, remainder: remainder1 } = parseNdjsonLines(chunk1);
  assert.deepEqual(events1, []);
  assert.equal(remainder1, chunk1);

  const chunk2 = `${remainder1}lo"}\n{"type":"token","text":" there"}\n{"type":"do`;
  const { events: events2, remainder: remainder2 } = parseNdjsonLines(chunk2);
  assert.deepEqual(events2, [{ type: "token", text: "Hello" }, { type: "token", text: " there" }]);
  assert.equal(remainder2, '{"type":"do');
});

run("parseNdjsonLines: a malformed line is skipped, not thrown, and doesn't take down the rest of the buffer", () => {
  const buffer = '{"type":"token","text":"ok"}\nnot json at all\n{"type":"done","status":"ok","answerType":"unknown","validatedSources":[],"unverifiedCitations":[]}\n';
  const { events } = parseNdjsonLines(buffer);
  assert.deepEqual(events.map((e) => e.type), ["token", "done"]);
});

// ── 6. Token streaming / done finalisation ──────────────────────────────────

await runAsync("streamProjectAssistant: streams token events incrementally and finalises only on done, with validatedSources/unverifiedCitations from the done event", async () => {
  await withMockFetch(
    () => ndjsonResponse([
      `${JSON.stringify({ type: "token", text: "The " })}\n`,
      `${JSON.stringify({ type: "token", text: "answer is RSK-001." })}\n`,
      `${JSON.stringify({ type: "done", status: "ok", answerType: "explanation", validatedSources: ["RSK-001"], unverifiedCitations: [] })}\n`,
    ]),
    async (calls) => {
      const tokens = [];
      let doneEvent = null;
      await streamProjectAssistant(
        { gatewayUrl: GATEWAY_URL, model: "qwen3:8b", question: "Why?", dto: { sourceRefs: ["RSK-001"] } },
        { onToken: (t) => tokens.push(t), onDone: (e) => { doneEvent = e; } },
      );
      assert.equal(calls[0].url, `${GATEWAY_URL}/project-assistant`, "must fetch the gateway directly, not a Vercel API route");
      assert.equal(tokens.join(""), "The answer is RSK-001.");
      assert.deepEqual(doneEvent.validatedSources, ["RSK-001"]);
      assert.deepEqual(doneEvent.unverifiedCitations, []);
    },
  );
});

// ── 7. Gateway error mapping ─────────────────────────────────────────────────

run("describeGatewayError covers every documented gateway error code with a distinct, friendly message", () => {
  const codes = ["ORIGIN_NOT_ALLOWED", "INVALID_REQUEST", "MODEL_NOT_ALLOWED", "PAYLOAD_TOO_LARGE", "OLLAMA_UNREACHABLE", "TIMEOUT", "CONCURRENCY_LIMIT", "GATEWAY_UNREACHABLE"];
  const messages = new Set();
  for (const code of codes) {
    const message = describeGatewayError(code);
    assert.ok(message && message.length > 0, `${code} must have a message`);
    assert.doesNotMatch(message, /\bat\s+\S+\.(js|ts):\d+/, "must never look like a raw stack trace");
    messages.add(message);
  }
  assert.equal(messages.size, codes.length, "every code must have a distinct message");
  assert.equal(describeGatewayError("SOMETHING_UNKNOWN"), describeGatewayError("also-unknown"), "unknown codes fall back to the same generic message");
});

await runAsync("streamProjectAssistant surfaces a gateway-reported request-level error (non-200) via onError, with the gateway's own code/message", async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({ error: { code: "MODEL_NOT_ALLOWED", message: "not installed" } }), { status: 400 }),
    async () => {
      let errorEvent = null;
      await streamProjectAssistant(
        { gatewayUrl: GATEWAY_URL, model: "not-a-model", question: "hi", dto: {} },
        { onError: (e) => { errorEvent = e; } },
      );
      assert.equal(errorEvent.code, "MODEL_NOT_ALLOWED");
      assert.equal(errorEvent.message, "not installed");
    },
  );
});

// ── 8. Aborted request handling ─────────────────────────────────────────────

await runAsync("streamProjectAssistant propagates an AbortError for an already-aborted signal, rather than reporting it via onError", async () => {
  await withMockFetch(
    (_url, init) => {
      if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return ndjsonResponse([]);
    },
    async () => {
      const controller = new AbortController();
      controller.abort();
      let onErrorCalled = false;
      await assert.rejects(
        streamProjectAssistant(
          { gatewayUrl: GATEWAY_URL, model: "qwen3:8b", question: "hi", dto: {}, signal: controller.signal },
          { onError: () => { onErrorCalled = true; } },
        ),
        (err) => err.name === "AbortError",
      );
      assert.equal(onErrorCalled, false, "a user-initiated cancellation must not also fire onError");
    },
  );
});

// ── 9. Stream ending without done ───────────────────────────────────────────

await runAsync("streamProjectAssistant reports STREAM_ENDED_EARLY when the connection closes before a done or error event", async () => {
  await withMockFetch(
    () => ndjsonResponse([`${JSON.stringify({ type: "token", text: "partial answer" })}\n`]),
    async () => {
      let errorEvent = null;
      await streamProjectAssistant(
        { gatewayUrl: GATEWAY_URL, model: "qwen3:8b", question: "hi", dto: {} },
        { onError: (e) => { errorEvent = e; } },
      );
      assert.equal(errorEvent.code, "STREAM_ENDED_EARLY");
    },
  );
});

// ── 10. Feasibility parser fallback ─────────────────────────────────────────

run("parseFeasibilityAnswer extracts all seven sections when the model follows the labelled format", () => {
  const text = [
    "Assessment: At Risk",
    "Confidence: Medium",
    "Supporting evidence: Two milestones are on track.",
    "Threats and dependencies: RSK-001 is still open.",
    "Assumptions: Assumes no further scope changes.",
    "Recommended next action: Close RSK-001 before the next checkpoint.",
    "Sources: RSK-001",
  ].join("\n");
  const parsed = parseFeasibilityAnswer(text);
  assert.equal(parsed.assessment, "At Risk");
  assert.equal(parsed.confidence, "Medium");
  assert.equal(parsed.sources, "RSK-001");
});

run("parseFeasibilityAnswer is case- and whitespace-tolerant", () => {
  const text = "assessment  :  Achievable\nconfidence:High\nsupporting evidence: fine\nthreats and dependencies: none\nassumptions: none\nrecommended next action: proceed\nsources: none";
  const parsed = parseFeasibilityAnswer(text);
  assert.equal(parsed.assessment, "Achievable");
  assert.equal(parsed.confidence, "High");
});

run("parseFeasibilityAnswer falls back to null (never throws) when a section is missing or out of order — the UI must render normal markdown instead", () => {
  assert.equal(parseFeasibilityAnswer("Just a plain paragraph answer with no structure at all."), null);
  const missingSources = "Assessment: Achievable\nConfidence: High\nSupporting evidence: x\nThreats and dependencies: x\nAssumptions: x\nRecommended next action: x";
  assert.equal(parseFeasibilityAnswer(missingSources), null, "missing a required section");
  const outOfOrder = "Confidence: High\nAssessment: Achievable\nSupporting evidence: x\nThreats and dependencies: x\nAssumptions: x\nRecommended next action: x\nSources: none";
  assert.equal(parseFeasibilityAnswer(outOfOrder), null, "sections out of order must not be trusted");
});

// ── 11. Validated source rendering (mapping logic) ──────────────────────────

run("sourceRefHref maps every documented prefix to its page, and leaves unknown prefixes unlinked", () => {
  assert.equal(sourceRefHref("RSK-001"), "/risks");
  assert.equal(sourceRefHref("ACT-005"), "/actions");
  assert.equal(sourceRefHref("DEC-002"), "/decisions");
  assert.equal(sourceRefHref("TEST-004"), "/testing");
  assert.equal(sourceRefHref("AC-012"), "/acceptance-criteria");
  assert.equal(sourceRefHref("DEL-006"), "/deliverables");
  assert.equal(sourceRefHref("REQ-001"), "/requirements");
  assert.equal(sourceRefHref("GLC-1"), "/go-live-readiness");
  assert.equal(sourceRefHref("UNKNOWN-9"), null, "an unmapped prefix must render unlinked, not guess a page");
});

// ── 12. Browser fetch targets the configured loopback gateway directly ─────

await runAsync("checkGatewayHealth calls the configured gateway's own /health endpoint, not a Vercel API route", async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({ ok: true, ollama: "up", models: ["qwen3:8b"], allowedModels: null }), { status: 200 }),
    async (calls) => {
      const health = await checkGatewayHealth(GATEWAY_URL);
      assert.equal(calls[0].url, `${GATEWAY_URL}/health`);
      assert.equal(health.ollama, "up");
    },
  );
});

run("isLoopbackUrl accepts only loopback hosts", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8787"), true);
  assert.equal(isLoopbackUrl("http://localhost:8787"), true);
  assert.equal(isLoopbackUrl("https://example.com"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});

run("checkGatewayHealth and streamProjectAssistant refuse a non-loopback gateway URL without ever calling fetch", async () => {
  let fetchCalled = false;
  const original = global.fetch;
  global.fetch = async () => { fetchCalled = true; throw new Error("must not be called"); };
  try {
    await assert.rejects(checkGatewayHealth("https://example.com"), /loopback/i);
    let errorEvent = null;
    await streamProjectAssistant({ gatewayUrl: "https://example.com", model: "m", question: "q", dto: {} }, { onError: (e) => { errorEvent = e; } });
    assert.equal(errorEvent.code, "NON_LOOPBACK_URL");
    assert.equal(fetchCalled, false, "a non-loopback URL must never reach fetch at all");
  } finally {
    global.fetch = original;
  }
});

// ── 13. No mutation imports / no Vercel inference route (static source scans) ──

const NEW_FILES = [
  "lib/ai/local-gateway-client.ts",
  "lib/ai/feasibility-answer.ts",
  "lib/ai/source-refs.ts",
  "lib/ai/assistant-state.ts",
  "components/local-ai-assistant-page.tsx",
  "app/local-ai-assistant/page.tsx",
];
const FORBIDDEN_MUTATION_IMPORTS = ["createRecord", "updateRecord", "saveRecord", "upsertRecord", "deleteRecord", "SUPABASE_SERVICE_ROLE_KEY"];

run("no assistant file imports a data-mutation helper or a service-role credential", () => {
  for (const file of NEW_FILES) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // Scan only actual import statements — doc comments are allowed to name
    // these helpers when explaining what's deliberately NOT imported (see
    // this file's own top-of-file comment).
    const importLines = [...source.matchAll(/^import\s+[^;]*;/gms)].map((m) => m[0]);
    for (const forbidden of FORBIDDEN_MUTATION_IMPORTS) {
      const pattern = new RegExp(`\\b${forbidden}\\b`);
      for (const importLine of importLines) {
        assert.doesNotMatch(importLine, pattern, `${file} must never import ${forbidden} — found in: ${importLine}`);
      }
    }
  }
});

run("lib/ai/local-gateway-client.ts never references a relative /api/ path — every fetch call targets the caller-supplied gateway URL directly", () => {
  const source = fs.readFileSync(path.join(root, "lib/ai/local-gateway-client.ts"), "utf8");
  assert.doesNotMatch(source, /["'`]\/api\//, "the gateway client must never call this app's own Next.js API routes for inference");
});

run("components/local-ai-assistant-page.tsx's only Next.js API route call is the existing, non-secret GET /api/ai-settings — never an inference route", () => {
  const source = fs.readFileSync(path.join(root, "components/local-ai-assistant-page.tsx"), "utf8");
  const apiCalls = [...source.matchAll(/fetch\(\s*["'`](\/api\/[^"'`]*)["'`]/g)].map((m) => m[1]);
  assert.ok(apiCalls.length > 0, "expected at least the AI Settings metadata fetch");
  for (const url of apiCalls) assert.equal(url, "/api/ai-settings", `unexpected Next.js API route call: ${url}`);
});

run("buildProjectAssistantDTO is always called with the explicitly resolved project — never with no project argument", () => {
  const source = fs.readFileSync(path.join(root, "components/local-ai-assistant-page.tsx"), "utf8");
  const calls = [...source.matchAll(/buildProjectAssistantDTO\(([^)]*)\)/g)];
  assert.ok(calls.length > 0, "expected at least one buildProjectAssistantDTO call");
  for (const call of calls) {
    assert.match(call[1], /\bproject\b/, "every call must pass the resolved project explicitly");
  }
});

console.log("\nAll Phase D Local AI Assistant tests passed.\n");
