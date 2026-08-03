// Pure, dependency-free logic shared by server.js and the test suite.
// Nothing here touches the network except fetchOllamaTags (which takes an
// injectable fetch implementation precisely so it can be tested without a
// real Ollama).
import fs from "node:fs";
import path from "node:path";

export function loadConfig({ dir, env = process.env } = {}) {
  const configPath = path.join(dir, "config.json");
  const fileConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};

  const envOrigins = env.GATEWAY_ALLOWED_ORIGINS;
  return {
    port: Number(env.GATEWAY_PORT ?? fileConfig.port ?? 8787),
    allowedOrigins: envOrigins
      ? envOrigins.split(",").map((s) => s.trim()).filter(Boolean)
      : (fileConfig.allowedOrigins ?? ["http://localhost:3000"]),
    // null = any model Ollama reports as installed is allowed. A configured
    // array further restricts that set — see isModelUsable.
    allowedModels: fileConfig.allowedModels ?? null,
    ollamaUrl: env.OLLAMA_URL ?? fileConfig.ollamaUrl ?? "http://127.0.0.1:11434",
    maxBodyBytes: fileConfig.maxBodyBytes ?? 256 * 1024,
    requestTimeoutMs: fileConfig.requestTimeoutMs ?? 90_000,
    maxConcurrent: fileConfig.maxConcurrent ?? 2,
  };
}

// Phase C — the real ProjectAssistantDTO's top-level keys (see
// lib/ai/project-assistant-dto.ts on the app side, which this list must be
// kept in sync with by hand — the two processes share no code). This is
// still only a cheap structural check (every key present, sourceRefs is an
// array) — not a full schema validator; see validateRequestBody below.
export const REQUIRED_DTO_KEYS = [
  "generatedAt", "project", "phase", "schedule", "goLiveDate", "projectHealth",
  "deliveryConfidence", "goLiveReadiness", "rollups", "recommendations",
  "openRisks", "openActions", "openDecisions", "openDependencies",
  "failedOrBlockedTests", "outstandingAcceptanceCriteria", "customerOwnedItems",
  "scheduleEvidence", "sourceRefs",
];
export const ALLOWED_TOP_LEVEL_KEYS = ["model", "question", "dto"];

// Returns an error message string, or null if the body is valid. Strict by
// design: unknown top-level fields are rejected outright (the browser can
// never smuggle in e.g. a systemPrompt override — see plan Part 3/9).
export function validateRequestBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.includes(k));
  if (unknownKeys.length) return `Unknown request field(s): ${unknownKeys.join(", ")}`;
  if (typeof body.model !== "string" || !body.model.trim()) return "model is required";
  if (typeof body.question !== "string" || !body.question.trim()) return "question is required";
  if (typeof body.dto !== "object" || body.dto === null || Array.isArray(body.dto)) return "dto is required";
  const missingDtoKeys = REQUIRED_DTO_KEYS.filter((k) => !(k in body.dto));
  if (missingDtoKeys.length) return `dto is missing required field(s): ${missingDtoKeys.join(", ")}`;
  if (!Array.isArray(body.dto.sourceRefs)) return "dto.sourceRefs must be an array";
  return null;
}

// A model is usable only if Ollama actually reports it installed AND (when
// a gateway-side allow-list is configured) it also appears in that list.
// Both checks run on every request, not just at settings-save time.
export function isModelUsable(model, installedModels, allowedModels) {
  const installed = installedModels.includes(model);
  const allowListed = allowedModels === null || allowedModels === undefined || allowedModels.includes(model);
  return installed && allowListed;
}

export function classifyAnswerType(question) {
  const q = question.toLowerCase();
  if (/\bdraft\b|\bwrite\b/.test(q)) return "draft";
  if (/achievable|feasible|by \d|likely to (hit|make)/.test(q)) return "feasibility";
  if (/\bsummar/.test(q)) return "summary";
  if (/\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b/.test(q)) return "comparison";
  if (/should i|recommend|what.*focus/.test(q)) return "recommendation";
  if (/\bwhy\b|\bexplain\b/.test(q)) return "explanation";
  return "unknown";
}

// Ref pattern matches the business-reference convention already used
// throughout the app (RSK-001, ACT-005, TEST-004, AC-012, DEL-006, ...).
export function extractRefs(text) {
  const matches = text.match(/\b[A-Z]{2,6}-\d{1,4}\b/g) ?? [];
  return [...new Set(matches)];
}

// The authoritative citation check — never trust the model's own claim.
export function splitCitations(refs, sourceRefs) {
  const sourceRefSet = new Set(Array.isArray(sourceRefs) ? sourceRefs : []);
  return {
    validatedSources: refs.filter((r) => sourceRefSet.has(r)),
    unverifiedCitations: refs.filter((r) => !sourceRefSet.has(r)),
  };
}

export async function fetchOllamaTags(ollamaUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { up: false, models: [] };
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name) : [];
    return { up: true, models };
  } catch {
    return { up: false, models: [] };
  }
}
