// Phase D — browser-side client for the Local Ollama gateway.
//
// Every function here talks directly to the gateway's own loopback origin
// (e.g. http://127.0.0.1:8787) — never to a Vercel/Next.js API route. That
// is the whole point of the local-gateway/ architecture (see plan Part 2/9):
// inference never round-trips through this app's server.
//
// isLoopbackUrl is intentionally duplicated here rather than imported from
// app/ai-settings/page.tsx — Phase D must not modify AI Settings, and the
// two call sites already don't share code (same convention as
// local-gateway/'s own duplication of DTO-shape knowledge; see that
// directory's README).
"use client";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

export class GatewayClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayClientError";
    this.code = code;
  }
}

export type GatewayHealth = {
  ok: boolean;
  ollama: "up" | "down";
  models: string[];
  allowedModels: string[] | null;
};

/** GET {gatewayUrl}/health — straight from the browser to the gateway. */
export async function checkGatewayHealth(gatewayUrl: string): Promise<GatewayHealth> {
  const trimmed = gatewayUrl.trim().replace(/\/$/, "");
  if (!isLoopbackUrl(trimmed)) {
    throw new GatewayClientError("NON_LOOPBACK_URL", "The configured gateway URL is not a loopback address — refusing to send project data to it.");
  }
  let res: Response;
  try {
    res = await fetch(`${trimmed}/health`, { signal: AbortSignal.timeout(4000) });
  } catch {
    throw new GatewayClientError("GATEWAY_UNREACHABLE", "Could not reach the local gateway. Is it running on this Mac?");
  }
  if (!res.ok) {
    throw new GatewayClientError("GATEWAY_UNREACHABLE", `Gateway responded with HTTP ${res.status}.`);
  }
  return res.json() as Promise<GatewayHealth>;
}

// ── Readiness classification (Phase D requirement 3) ─────────────────────────
// Pure and independently testable — the component only ever renders one of
// these five states (plus its own "not-ollama-provider" case layered on top,
// since that's about AI Settings, not the gateway itself).
export type GatewayReadiness = "checking" | "gateway-unavailable" | "ollama-unavailable" | "model-unavailable" | "ready";

export function classifyGatewayReadiness(params: {
  checking: boolean;
  health: GatewayHealth | null;
  hadError: boolean;
  model: string;
}): GatewayReadiness {
  if (params.checking) return "checking";
  if (params.hadError || !params.health) return "gateway-unavailable";
  if (params.health.ollama !== "up") return "ollama-unavailable";
  const model = params.model.trim();
  if (!model) return "model-unavailable";
  const installed = params.health.models.includes(model);
  const allowListed = params.health.allowedModels === null || params.health.allowedModels.includes(model);
  if (!installed || !allowListed) return "model-unavailable";
  return "ready";
}

// ── Streaming protocol (Phase D requirement 7) ───────────────────────────────

export type TokenEvent = { type: "token"; text: string };
export type DoneEvent = {
  type: "done";
  status: "ok" | "truncated" | "error";
  answerType: string;
  validatedSources: string[];
  unverifiedCitations: string[];
};
export type ErrorEvent = { type: "error"; code: string; message: string };
export type StreamEvent = TokenEvent | DoneEvent | ErrorEvent;

/**
 * Splits a growing text buffer into complete NDJSON lines plus whatever
 * partial line is left over. Malformed lines are skipped (never thrown) —
 * one bad line must not take down the rest of the stream. Exported for unit
 * testing partial-chunk buffering independently of any real network call.
 */
export function parseNdjsonLines(buffer: string): { events: StreamEvent[]; remainder: string } {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const events: StreamEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as StreamEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // Malformed line — skip it rather than aborting the whole stream.
    }
  }
  return { events, remainder };
}

export type StreamHandlers = {
  onToken?: (text: string) => void;
  onDone?: (event: DoneEvent) => void;
  onError?: (event: ErrorEvent) => void;
};

/**
 * POST {gatewayUrl}/project-assistant, streaming the NDJSON response.
 * Throws only for an aborted request (DOMException "AbortError") — callers
 * should catch that separately from onError to distinguish an intentional
 * cancellation from a genuine failure. Every other failure (bad request,
 * gateway-reported error mid-stream, connection loss before `done`) is
 * reported via handlers.onError, never thrown.
 */
export async function streamProjectAssistant(
  params: { gatewayUrl: string; model: string; question: string; dto: unknown; signal?: AbortSignal },
  handlers: StreamHandlers,
): Promise<void> {
  const trimmed = params.gatewayUrl.trim().replace(/\/$/, "");
  if (!isLoopbackUrl(trimmed)) {
    handlers.onError?.({ type: "error", code: "NON_LOOPBACK_URL", message: "The configured gateway URL is not a loopback address — refusing to send project data to it." });
    return;
  }

  const res = await fetch(`${trimmed}/project-assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: params.model, question: params.question, dto: params.dto }),
    signal: params.signal,
  });

  if (!res.ok) {
    let code = "INVALID_REQUEST";
    let message = `The local gateway rejected the request (HTTP ${res.status}).`;
    try {
      const body = await res.json() as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the generic message above.
    }
    handlers.onError?.({ type: "error", code, message });
    return;
  }

  if (!res.body) {
    handlers.onError?.({ type: "error", code: "STREAM_UNAVAILABLE", message: "The gateway did not return a readable response stream." });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;

  const dispatch = (event: StreamEvent) => {
    if (event.type === "token") handlers.onToken?.(event.text);
    else if (event.type === "done") { sawTerminalEvent = true; handlers.onDone?.(event); }
    else if (event.type === "error") { sawTerminalEvent = true; handlers.onError?.(event); }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseNdjsonLines(buffer);
      buffer = remainder;
      events.forEach(dispatch);
    }
    // Flush a final line that never received a trailing newline.
    if (buffer.trim()) {
      const { events } = parseNdjsonLines(`${buffer}\n`);
      events.forEach(dispatch);
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawTerminalEvent) {
    handlers.onError?.({
      type: "error",
      code: "STREAM_ENDED_EARLY",
      message: "The connection closed before the response finished — the answer may be incomplete.",
    });
  }
}

// ── Error messages (Phase D requirement 11) ──────────────────────────────────
export const GATEWAY_ERROR_MESSAGES: Record<string, string> = {
  ORIGIN_NOT_ALLOWED: "This app's origin isn't allowed by the local gateway's configuration (local-gateway/config.json's allowedOrigins).",
  INVALID_REQUEST: "The request to the local gateway was invalid.",
  MODEL_NOT_ALLOWED: "The selected model isn't currently installed in Ollama, or isn't allow-listed on the gateway.",
  PAYLOAD_TOO_LARGE: "The question and project context were too large for the gateway to accept.",
  OLLAMA_UNREACHABLE: "Ollama isn't reachable on this Mac. Make sure it's running.",
  TIMEOUT: "The request to Ollama timed out.",
  CONCURRENCY_LIMIT: "The local gateway is busy with another request — try again shortly.",
  GATEWAY_UNREACHABLE: "Could not reach the local gateway. Make sure it's running on this Mac — and if Chrome just asked for Local Network Access, click Allow.",
  NON_LOOPBACK_URL: "The configured gateway URL is not a loopback address, so this app refused to send it any project data.",
  STREAM_UNAVAILABLE: "The gateway did not return a readable response stream.",
  STREAM_ENDED_EARLY: "The connection closed before the response finished — the answer may be incomplete.",
};

export function describeGatewayError(code: string): string {
  return GATEWAY_ERROR_MESSAGES[code] ?? "Something went wrong talking to the local gateway.";
}
