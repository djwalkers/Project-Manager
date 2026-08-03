// Phase A2 — gateway foundation.
//
// Standalone, loopback-only gateway between the Project Manager web app
// and a local Ollama instance. Not part of the Next.js/Vercel build — run
// this on the same Mac as Ollama. Phase A1 proved the browser -> gateway ->
// Ollama -> browser path against the real production Vercel origin in
// Chrome; this phase hardens the gateway itself (fixed/versioned prompt,
// strict validation, the full NDJSON protocol, tests).
//
// DTO note: `dto` is the real ProjectAssistantDTO as of Phase C (see
// lib/ai/project-assistant-dto.ts on the app side). This file only ever
// treats it as an opaque, pre-validated object — see lib.js's
// REQUIRED_DTO_KEYS for the structural check and prompt.js for how it's
// embedded.
//
// Security model (see plan Part 9 / 15): CORS is not authentication. The
// primary boundary is binding to 127.0.0.1 only — nothing off this Mac can
// reach this process at all, regardless of what Origin header it sends.
// The origin allow-list below is a real, independent, server-side check on
// top of that (not just a browser courtesy), but it is not a substitute for
// the loopback bind, the fixed two-endpoint surface, and read-only
// behaviour — no gateway secret/token is added in v1.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  validateRequestBody,
  isModelUsable,
  classifyAnswerType,
  extractRefs,
  splitCitations,
  fetchOllamaTags,
} from "./lib.js";
import { buildSystemPrompt } from "./prompt.js";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) return; // already rejected — ignore remaining bytes, but let the connection close normally so the response can still be sent
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        reject(Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// Builds the HTTP server for a given config, without binding/listening —
// this lets tests exercise the exact real request-handling code against an
// ephemeral port and a fake Ollama, with no monkey-patching.
export function createGatewayServer(config) {
  let activeRequests = 0;

  // Sets CORS headers when the request's Origin is in the allow-list.
  // Returns whether it matched — callers use this to decide whether to
  // proceed (for OPTIONS) or to additionally reject cross-origin browser
  // requests from a disallowed origin.
  function applyCors(req, res) {
    const origin = req.headers.origin;
    const allowed = Boolean(origin) && config.allowedOrigins.includes(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    return allowed;
  }

  async function handleHealth(_req, res) {
    const { up, models } = await fetchOllamaTags(config.ollamaUrl);
    sendJson(res, 200, {
      ok: true,
      ollama: up ? "up" : "down",
      models,
      allowedModels: config.allowedModels,
    });
  }

  async function handleProjectAssistant(req, res) {
    // Increment synchronously, in the same tick as the check — no `await`
    // between them — so two requests arriving together can't both read
    // activeRequests as under the limit before either increments it. The
    // outer finally below decrements exactly once, on every return path.
    if (activeRequests >= config.maxConcurrent) {
      return sendError(res, 503, "CONCURRENCY_LIMIT", "Too many concurrent requests to the local gateway — try again shortly.");
    }
    activeRequests += 1;

    try {
      let raw;
      try {
        raw = await readBody(req, config.maxBodyBytes);
      } catch (err) {
        if (err && err.code === "PAYLOAD_TOO_LARGE") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body too large.");
        return sendError(res, 400, "INVALID_REQUEST", "Failed to read request body.");
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendError(res, 400, "INVALID_REQUEST", "Request body must be valid JSON.");
      }

      const validationError = validateRequestBody(body);
      if (validationError) return sendError(res, 400, "INVALID_REQUEST", validationError);

      const { up, models } = await fetchOllamaTags(config.ollamaUrl);
      if (!up) return sendError(res, 502, "OLLAMA_UNREACHABLE", "Ollama is not reachable on this Mac. Is it running?");

      if (!isModelUsable(body.model, models, config.allowedModels)) {
        return sendError(res, 400, "MODEL_NOT_ALLOWED", `Model "${body.model}" is not both installed in Ollama and allow-listed on this gateway.`);
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      let fullText = "";

      try {
        const upstream = await fetch(`${config.ollamaUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: body.model,
            stream: true,
            messages: [
              { role: "system", content: buildSystemPrompt(body.dto) },
              { role: "user", content: body.question },
            ],
          }),
          signal: controller.signal,
        });

        if (!upstream.ok || !upstream.body) {
          res.write(`${JSON.stringify({ type: "error", code: "OLLAMA_UNREACHABLE", message: "Ollama rejected the chat request." })}\n`);
          res.end();
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let chunk;
            try {
              chunk = JSON.parse(line);
            } catch {
              continue;
            }
            const token = chunk.message?.content ?? "";
            if (token) {
              fullText += token;
              res.write(`${JSON.stringify({ type: "token", text: token })}\n`);
            }
          }
        }

        const allRefs = extractRefs(fullText);
        const { validatedSources, unverifiedCitations } = splitCitations(allRefs, body.dto.sourceRefs);

        res.write(`${JSON.stringify({
          type: "done",
          status: "ok",
          answerType: classifyAnswerType(body.question),
          validatedSources,
          unverifiedCitations,
        })}\n`);
        res.end();
      } catch (err) {
        const code = controller.signal.aborted ? "TIMEOUT" : "OLLAMA_UNREACHABLE";
        const message = err instanceof Error ? err.message : "Unknown error contacting Ollama.";
        res.write(`${JSON.stringify({ type: "error", code, message })}\n`);
        res.end();
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      activeRequests -= 1;
    }
  }

  return http.createServer(async (req, res) => {
    const corsAllowed = applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed ? 204 : 403);
      res.end();
      return;
    }

    // Only enforce the origin allow-list against requests that actually
    // sent an Origin header (i.e. cross-origin browser requests — the real
    // threat model). A same-machine tool like curl sends no Origin header
    // at all; rejecting on absence would be security theatre, since
    // anything already running on this Mac can reach 127.0.0.1 regardless.
    if (req.headers.origin && !corsAllowed) {
      return sendError(res, 403, "ORIGIN_NOT_ALLOWED", "This origin is not permitted to use the local gateway.");
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      return sendError(res, 400, "INVALID_REQUEST", "Malformed request URL.");
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return handleHealth(req, res);
    }
    if (req.method === "POST" && url.pathname === "/project-assistant") {
      return handleProjectAssistant(req, res);
    }

    sendError(res, 404, "NOT_FOUND", "Unknown endpoint. Only GET /health and POST /project-assistant exist.");
  });
}

// Only bind/listen when this file is executed directly (`node server.js`)
// — importing it from the test suite must never open a real port.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig({ dir: path.dirname(fileURLToPath(import.meta.url)) });
  const server = createGatewayServer(config);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`Local AI gateway listening on http://127.0.0.1:${config.port}`);
    console.log(`Allowed origins: ${config.allowedOrigins.join(", ") || "(none configured)"}`);
    console.log(`Ollama URL: ${config.ollamaUrl}`);
  });
}
