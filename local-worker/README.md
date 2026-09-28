# Local Extraction Worker

A small standalone Node process that performs **deterministic text
extraction** of Test Manager source documents (PDF and DOCX) on this Mac.
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
4. Builds section-aware fragments with provenance (section, pages) and a
   SHA-256 per fragment, and posts them back in batches.
5. Marks the job **Completed**, **Completed with warnings**, or **Failed**
   (with a category such as `ocr_required` for scanned/image-only PDFs).

Document text is only ever sent to Test Manager's own backend. It is never
sent to OpenAI, Gemini, Anthropic or any other external service.

## Security model

- The worker authenticates with a **worker token** (`tmw_…`) that an Admin
  issues in **System Health → Local extraction worker**. Only its SHA-256 is
  stored server-side; issuing a new one revokes the old one immediately.
- The token is accepted **only** by `/api/worker/*`: claim a job, add
  fragments / complete / fail the job it claimed, and send a heartbeat. It
  cannot read or change any other project data, and it is not a Supabase
  key — the worker never holds Supabase credentials.
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

## Running

```bash
npm start
```

Leave it running while you want uploaded documents to be extracted. If it
is stopped, jobs simply wait in the queue; a job interrupted mid-way is
re-queued automatically after its lease expires (and failed after three
attempts). System Health shows whether the worker has been seen recently.

## Tests

```bash
npm test
```

Builds real PDF/DOCX files in memory and runs them through the real
extractor and the worker protocol against a fake API — no network.
