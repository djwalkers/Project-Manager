# Local AI Gateway

A small, standalone, **loopback-only** HTTP server that lets the Project
Manager web app (hosted on Vercel) talk to a local [Ollama](https://ollama.com)
instance running on this same Mac. It is **not** part of the Next.js/Vercel
build — it never ships to Vercel, has its own `package.json`, and shares no
code with the main app.

## Why this exists

The web app is served over HTTPS from Vercel. Ollama only exists on your
Mac. This gateway is the bridge: the browser calls it directly at
`http://127.0.0.1:<port>` (never through the Vercel server), and it forwards
validated requests to Ollama.

## Security model

- **Binds to `127.0.0.1` only.** Nothing off this Mac can reach this process
  at all, regardless of headers or tokens — that is the primary security
  boundary, not a password.
- **CORS is not authentication.** The origin allow-list below is a real,
  independent, server-side check (not just a browser courtesy), but it is a
  second layer on top of the loopback bind, not a substitute for it. No
  gateway secret/token is added in v1 — the boundary is "not reachable off
  this Mac," not "reachable but password-protected."
- Exactly two endpoints exist (`GET /health`, `POST /project-assistant`) —
  no passthrough proxy to arbitrary Ollama routes.
- The gateway owns the system prompt (see `prompt.js`) — the browser can
  never send one; any unrecognised request field is rejected outright.
- No Supabase credentials of any kind ever reach this process. It only ever
  sees `{ model, question, dto }` — a model name, a question, and a
  compact, pre-scrubbed project-facts object built by the app.
- No logging of prompt/DTO/answer content by default. No writes to disk by
  default.

## Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com) installed and running (`ollama serve`, or the
  Ollama.app menu-bar app)
- At least one model pulled — `ollama pull qwen3:8b` is the recommended
  starting model for project reasoning (configurable; any installed model
  works)

## Setup

```bash
cd local-gateway
cp config.example.json config.json
```

Edit `config.json`:

- `allowedOrigins` — must include your **exact** production Vercel origin
  (e.g. `https://your-app.vercel.app`) and, for local development,
  `http://localhost:3000`. No preview-deployment URLs, no wildcards.
- `allowedModels` — leave `null` to allow any model Ollama reports as
  installed, or set an array to further restrict which models this gateway
  will use.
- `port` / `ollamaUrl` / size, timeout, and concurrency limits — sensible
  defaults are already set; only change these if you know you need to.

`config.json` is gitignored — it's expected to hold your real production
URL and is never committed.

## Running

```bash
npm start
```

You should see:

```
Local AI gateway listening on http://127.0.0.1:8787
Allowed origins: http://localhost:3000, https://your-app.vercel.app
Ollama URL: http://127.0.0.1:11434
```

Leave this running in a terminal tab whenever you want to use the assistant.
There's no auto-start-at-login in v1 — start it manually before use.

## The first time you use it in Chrome

The **first** time the deployed app (from its real HTTPS origin) reaches
this gateway, Chrome will show a **Local Network Access** permission
prompt — something like *"`your-app.vercel.app` wants to find and connect to
devices on your local network."* This is a normal Chrome security feature
(unrelated to this app), not an error. Click **Allow**. Chrome remembers
this per-site, the same way it remembers camera/microphone permissions —
you should only see it once. You can review or revoke it later at
`chrome://settings/content/localNetworkAccess`.

## Endpoints

### `GET /health`

Returns what's actually installed in Ollama right now — never guessed:

```json
{ "ok": true, "ollama": "up", "models": ["qwen3:8b", "..."], "allowedModels": null }
```

### `POST /project-assistant`

Body: `{ "model": string, "question": string, "dto": ProjectAssistantDTO }`
— exactly these three fields; anything else is rejected. There is
deliberately no `systemPrompt` field: the gateway owns the fixed, versioned
grounding/safety instructions (`prompt.js`) and combines them with the
validated `dto` itself.

Response: newline-delimited JSON (`application/x-ndjson`), one event per
line:

```
{"type":"token","text":"..."}
...
{"type":"done","status":"ok","answerType":"explanation","validatedSources":["RSK-001"],"unverifiedCitations":[]}
```

`validatedSources`/`unverifiedCitations` are computed by the gateway after
the full answer is assembled, cross-checked against `dto.sourceRefs` — the
model's own claimed citations are never trusted as-is.

On failure, a single `{"type":"error","code":"...","message":"..."}` line
replaces the `done` event. Request-level failures (bad input, disallowed
origin/model, etc.) are plain JSON error responses instead:
`{ "error": { "code": "...", "message": "..." } }`.

| Code | Meaning |
|---|---|
| `ORIGIN_NOT_ALLOWED` | The calling page's origin isn't in `allowedOrigins` |
| `INVALID_REQUEST` | Malformed body, unknown field, or missing/invalid field |
| `MODEL_NOT_ALLOWED` | The model isn't both installed in Ollama and allow-listed |
| `PAYLOAD_TOO_LARGE` | Request body exceeded `maxBodyBytes` |
| `OLLAMA_UNREACHABLE` | Ollama didn't respond or rejected the request |
| `TIMEOUT` | The request exceeded `requestTimeoutMs` |
| `CONCURRENCY_LIMIT` | Too many requests already in flight (`maxConcurrent`) |

## Status

**Phase A2** — the gateway foundation (this README, the fixed versioned
prompt, strict validation, the full protocol, and the test suite). It still
uses a stub DTO contract (`{ generatedAt, project: { name }, sourceRefs }`)
— the real `ProjectAssistantDTO` (phase, schedule, Go-Live readiness,
rollups, customer-ownership tiers, etc.) lands in Phase C, at which point
only the *content* of `dto` changes — the protocol, validation, and prompt
structure documented here stay the same.

## Tests

```bash
node tests/gateway.test.mjs
```

Fully deterministic — no real Ollama required. A fake Ollama double
(a plain `http` server) stands in for the real one, so these test the
gateway's own logic (validation, CORS, concurrency, timeouts, citation
checking) without depending on your local model or its output wording.
