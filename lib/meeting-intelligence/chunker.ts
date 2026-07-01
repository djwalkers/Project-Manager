/** Characters per chunk — tuned so system prompt + chunk fits comfortably in most models. */
export const CHUNK_SIZE = 5000;
/** Overlap carried into the next chunk to avoid losing context at boundaries. */
export const CHUNK_OVERLAP = 300;
/** Inputs at or below this length are sent as a single AI call even if above CHUNK_SIZE. */
export const SINGLE_CALL_THRESHOLD = 8000;

export interface MeetingChunk {
  text: string;
  /** 0-based index. */
  index: number;
  total: number;
}

/** Estimate chunk count for pre-analysis display. */
export function estimateChunkCount(textLength: number): number {
  if (textLength <= CHUNK_SIZE) return 1;
  return Math.ceil(textLength / (CHUNK_SIZE - CHUNK_OVERLAP));
}

// ── Splitting helpers ──────────────────────────────────────────────────────────

function splitAtMarkdownHeadings(text: string): string[] {
  // Split before each ## / ### / #### heading, keeping the heading with its section
  return text.split(/(?=^#{1,4}\s)/m).filter((s) => s.trim().length > 0);
}

function splitAtCapsHeadings(text: string): string[] {
  // Split before ALLCAPS lines that look like section headers
  return text.split(/(?=^[A-Z][A-Z ]{4,}(?::|$))/m).filter((s) => s.trim().length > 0);
}

function splitAtParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).filter((s) => s.trim().length > 0);
}

/** Group fine-grained pieces into chunks of approximately targetSize with overlap. */
function groupPieces(pieces: string[], targetSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length > targetSize && current.length > 0) {
      chunks.push(current.trim());
      const tail = current.slice(-overlap).trim();
      current = tail ? `${tail}\n\n${piece}` : piece;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Hard split at character boundaries, aligning to word edges. */
function hardSplit(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text.trim()];
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const wb = text.lastIndexOf(" ", end);
      if (wb > start + Math.floor(size / 2)) end = wb;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function chunkMeetingText(text: string): MeetingChunk[] {
  const trimmed = text.trim();

  if (trimmed.length <= CHUNK_SIZE) {
    return [{ text: trimmed, index: 0, total: 1 }];
  }

  // Choose splitting strategy based on what the document contains
  let pieces: string[];
  if (/^#{1,4}\s.+/m.test(trimmed)) {
    pieces = splitAtMarkdownHeadings(trimmed);
  } else if (/^[A-Z][A-Z ]{4,}(?::|$)/m.test(trimmed)) {
    pieces = splitAtCapsHeadings(trimmed);
  } else {
    pieces = splitAtParagraphs(trimmed);
  }

  // Any piece larger than CHUNK_SIZE gets hard-split so groupPieces never
  // receives an oversized piece when current is empty (which would bypass splitting).
  const finePieces = pieces.flatMap((p) =>
    p.length > CHUNK_SIZE ? hardSplit(p, CHUNK_SIZE, CHUNK_OVERLAP) : [p],
  );

  const rawChunks =
    finePieces.length > 0
      ? groupPieces(finePieces, CHUNK_SIZE, CHUNK_OVERLAP)
      : hardSplit(trimmed, CHUNK_SIZE, CHUNK_OVERLAP);

  const total = rawChunks.length;
  return rawChunks.map((chunkText, index) => ({ text: chunkText, index, total }));
}
