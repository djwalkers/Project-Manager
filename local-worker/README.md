# Local Extraction & Analysis Worker

A small standalone Node process that performs **deterministic text
extraction** of Test Manager source documents (PDF and DOCX) on this Mac,
and (Phase 1C) **requirement analysis** of completed extractions with a
**local Ollama model**.
It is not part of the Next.js/Vercel build, has its own `package.json`, and
is separate from the local AI gateway (`../local-gateway`), which never
holds credentials.

## What it does

1. Polls Test Manager for a queued extraction job (every new document
   version is queued automatically).
2. Downloads that one file through a 5-minute signed URL and checks its size
   and SHA-256 against the values recorded at upload.
3. Extracts text with **no AI** — `pdfjs-dist` for PDFs (page boundaries
   kept), `mammoth` for DOCX (headings, paragraphs, lists, tables kept).
   DOCX headings are taken, in order of trust, from Word heading styles,
   then Word outline levels, then a conservative formatting fallback
   (a short, standalone, bold or noticeably larger line that is not a
   sentence or list item and has content after it). List numbers follow
   Word's own lists; DOCX has no page numbers.
   PDF headings are numbered or larger standalone lines. Form-like PDF
   exports (issue trackers, templates) are read by weight and position
   instead: a column of bold field labels with values beside them becomes
   "Label: value" lines, a long field value becomes its own section, and
   bold upper-case / Title Case labels become sections; empty template
   sections produce no fragments. Repeated printed page headers, URL
   footers, page counters and a trailing "Generated at …" stamp are set
   aside as document chrome and listed in the job diagnostics.
4. Builds section-aware fragments with provenance (section, pages) and a
   SHA-256 per fragment, and posts them back in batches.
5. Marks the job **Completed**, **Completed with warnings**, or **Failed**
   (with a category such as `ocr_required` for scanned/image-only PDFs).

Document text is only ever sent to Test Manager's own backend and to Ollama
on this Mac. It is never sent to OpenAI, Gemini, Anthropic or any other
external service.

## Requirement analysis (Phase 1C)

When no extraction is waiting, the worker takes a queued analysis run
(Manager/Admin press **Analyse document** in Source Documents). A run
analyses exactly one completed extraction run — its fragments are the only
input; canonical Requirements are never read. Stages (`analysis/`):

1. **Classification** — each fragment: requirement, metadata, context,
   benefit, test information, template/admin or unknown.
2. **Requirement candidates** — from requirement fragments only; metadata is
   context (it may support a priority, never be a requirement). Each item
   has a statement type: behaviour, **constraint** (an explicit negative
   requirement such as "No X required" — kept as a requirement) or
   **no change** ("No change required" — kept as a scope/regression note,
   not a requirement). The decision is made on the source wording. Plans,
   status lines and dates are excluded. A **coverage** pass re-examines any
   statement no candidate covers.
3. **Ambiguities** — only questions whose answer could change
   implementation, tests, acceptance criteria, data migration, integration,
   scope or operations. Each needs a verbatim source trigger, an impact and
   a specific question; generic/speculative/vague questions are suppressed.
4. **Consolidation** — requirement groups are "duplicate" (the same rule;
   across applications only with the same wording, otherwise only for the
   same operated object) or "parts" of one requirement (one object; a
   data-model definition may join the rule that uses it). Merged
   descriptions keep **every distinct clause**. Issues asking the same
   question merge with all their sources, impacts and proposal links; a
   **source check** suppresses questions another fragment already answers
   (verified by a word-for-word quote; a question's own trigger sentence is
   never its answer).
5. **Validation** — deterministic: schema, fragment IDs exist in this run,
   every proposal/issue/note has provenance, Explicit claims quote the
   source verbatim (otherwise recorded as Inferred → Needs Review), enums,
   unique IDs.

Every model call uses Ollama structured output (JSON schema) and is
re-validated here; invalid output is retried (up to 3 attempts, with the
errors fed back) and a stage that still fails fails the run cleanly.
Fragments are shown to the model as short labels (`F<sequence>`) that are
mapped back to fragment IDs; any other label is treated as fabricated.
Validated stage results are saved, so a retried run reuses them. The server
repeats the provenance checks, and the database enforces them again.

Prompts are versioned (`analysis/prompts.js` `PROMPT_VERSION`; each run
records the version and a SHA-256 of the prompt text). Change the wording →
bump the version → pin the new fingerprint in `tests/analysis.test.mjs`.

The model is chosen by an Admin in System Health (default `qwen3:8b`) from
the models this worker reports as installed; nothing is downloaded
automatically. `ollamaUrl` must be loopback (`127.0.0.1`/`localhost`).

## Security model

- The worker authenticates with a **worker token** (`tmw_…`) that an Admin
  issues in **System Health → Local extraction worker**. Only its SHA-256 is
  stored server-side; issuing a new one revokes the old one immediately.
- The token is accepted **only** by `/api/worker/*`: claim a job, add
  fragments / complete / fail the job it claimed, and send a heartbeat; and
  for analysis, claim a run (receiving that run's fragments only), record
  stage results, and complete / fail that run. It cannot read or change any
  other project data (no Requirements access), and it is not a Supabase key
  — the worker never holds Supabase credentials.
- The database itself enforces that a worker can only write to the job it
  currently holds (with a lease), that fragment hashes match their text, and
  that completed extractions are immutable.
- Nothing is logged except job ids, counts and error categories — never the
  token or document content. No files are written to disk.

## Setup

```bash
cd local-worker
npm install
cp config.example.json config.json
```

Edit `config.json` (gitignored):

- `apiBaseUrl` — your production Test Manager origin (https). `http` is
  accepted only for `localhost` during development.
- `workerToken` — the token shown once in System Health (Admin).
- `analysisEnabled` (default `true`), `ollamaUrl` (default
  `http://127.0.0.1:11434`, loopback only), `ollamaTimeoutMs` (per model
  call, default 300000).

## Running

```bash
npm start
```

Leave it running while you want uploaded documents to be extracted and
analysed (Ollama must be running for analysis). If it
is stopped, jobs simply wait in the queue; a job interrupted mid-way is
re-queued automatically after its lease expires (and failed after three
attempts). System Health shows whether the worker has been seen recently.

## Tests

```bash
npm test
```

Builds real PDF/DOCX files in memory and runs them through the real
extractor and the worker protocol against a fake API — no network.

Real project documents are never committed. To re-check them locally
(matched by SHA-256; skipped when absent):

```bash
EXTRACT_REAL_DOCS_DIR=~/Downloads npm run test:real
```
