// Local Ollama client for batch analysis (Phase 1C). Document text is sent
// ONLY to an Ollama instance on this Mac: the URL must be loopback, checked
// at construction, so a misconfiguration cannot route content off-machine.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertLoopbackUrl(raw) {
  const url = new URL(String(raw));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ollamaUrl must be http(s)");
  if (!LOOPBACK.has(url.hostname)) throw new Error("ollamaUrl must point at this Mac (localhost / 127.0.0.1) — document content never leaves the machine");
  return url.origin;
}

export class OllamaError extends Error {
  constructor(category, message) { super(message); this.category = category; }
}

export function createOllama({ ollamaUrl = "http://127.0.0.1:11434", timeoutMs = 300_000, fetchImpl = fetch } = {}) {
  const base = assertLoopbackUrl(ollamaUrl);

  async function request(path, body, timeout = 5_000) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, body === undefined
        ? { signal: AbortSignal.timeout(timeout) }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new OllamaError("model_timeout", `The local model did not respond within ${Math.round(timeout / 1000)}s.`);
      throw new OllamaError("ollama_unreachable", `Ollama is not reachable on this Mac (${String(error?.message ?? error).slice(0, 120)}).`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = String(json?.error ?? `HTTP ${res.status}`).slice(0, 200);
      throw new OllamaError(/not found|pull/i.test(detail) ? "model_unavailable" : "ollama_unreachable", `Ollama refused the request: ${detail}`);
    }
    return json;
  }

  return {
    /** {reachable, version, models:[{name, digest, family, parameter_size}]} — never throws. */
    async status() {
      try {
        const [tags, version] = await Promise.all([request("/api/tags"), request("/api/version").catch(() => ({}))]);
        const models = (Array.isArray(tags?.models) ? tags.models : []).slice(0, 50).map((m) => ({
          name: String(m.name ?? ""), digest: String(m.digest ?? "").slice(0, 64),
          family: m.details?.family ? String(m.details.family) : null, parameter_size: m.details?.parameter_size ? String(m.details.parameter_size) : null,
        })).filter((m) => m.name);
        return { reachable: true, version: version?.version ? String(version.version) : null, models };
      } catch {
        return { reachable: false, version: null, models: [] };
      }
    },

    /** Capabilities and context length of one installed model. */
    async show(model) {
      const info = await request("/api/show", { model }, 30_000);
      const ctxKey = Object.keys(info?.model_info ?? {}).find((k) => k.endsWith(".context_length"));
      return { capabilities: Array.isArray(info?.capabilities) ? info.capabilities : [], contextLength: ctxKey ? Number(info.model_info[ctxKey]) : null };
    },

    /** One non-streaming, schema-constrained chat call. Returns the raw content string. */
    async chat({ model, messages, schema, numCtx = 16_384, think = false, seed = 42 }) {
      const body = { model, messages, stream: false, format: schema, options: { temperature: 0, seed, num_ctx: numCtx } };
      if (think !== null) body.think = think;
      const json = await request("/api/chat", body, timeoutMs);
      const content = json?.message?.content;
      if (typeof content !== "string") throw new OllamaError("invalid_model_output", "Ollama returned no message content.");
      return { content, evalCount: Number(json.eval_count ?? 0), promptEvalCount: Number(json.prompt_eval_count ?? 0), durationMs: Math.round(Number(json.total_duration ?? 0) / 1e6) };
    },
  };
}
