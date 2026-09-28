// Deterministic source-document extraction (Phase 1B). No AI, no network.
//
//   PDF  → pdfjs-dist text content per page → lines → paragraphs/headings
//   DOCX → mammoth (Word styles → h1..h6, p, lists, tables) → blocks
//   blocks → section-aware fragments with provenance + SHA-256 text hashes
//
// The same input bytes always produce the same fragments (same order, text
// and hashes): no randomness, no clocks, no model calls. Bump
// EXTRACTOR_VERSION whenever the output for a given file could change, so
// results stay attributable to the code that produced them.

import { createHash } from "node:crypto";
import mammoth from "mammoth";

export const EXTRACTOR_VERSION = "1.0.0";

export const LIMITS = {
  /** A text fragment is closed once it reaches this size at a block boundary. */
  fragmentTargetChars: 1500,
  /** Hard cap for one fragment; longer paragraphs/tables are split. */
  fragmentMaxChars: 3000,
  /** Below this many characters the file is treated as having no usable text. */
  minMeaningfulChars: 200,
  /** A PDF page with fewer characters than this counts as empty. */
  emptyPageChars: 20,
};

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export class ExtractionError extends Error {
  constructor(category, message) {
    super(message);
    this.name = "ExtractionError";
    this.category = category;
  }
}

export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** Canonical text form used for fragments and hashes. */
export function normaliseText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\u0000/g, "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,3}){0,5})\.?\s+(\S.*)$/;

// ── PDF ─────────────────────────────────────────────────────────────────────

async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/**
 * Extracts text blocks from a PDF, one page at a time. Headings are
 * detected deterministically: a short standalone line that is either
 * numbered ("4.2 Replenishment Processing") or set noticeably larger than
 * the document's body text.
 */
export async function extractPdf(bytes) {
  const pdfjs = await loadPdfjs();
  let doc;
  let task;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      // Parse only — never run PDF JavaScript, never eval font programs.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (error) {
    await task?.destroy();
    const message = String(error?.message ?? error);
    if (/password/i.test(message)) throw new ExtractionError("encrypted", "The PDF is password-protected and cannot be read.");
    throw new ExtractionError("parse_error", `The PDF could not be parsed: ${message.slice(0, 200)}`);
  }

  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      pages.push({ number: n, lines: pdfLines(content.items) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  // Body font size = the size carrying the most characters.
  const weight = new Map();
  for (const page of pages) for (const line of page.lines) weight.set(line.size, (weight.get(line.size) ?? 0) + line.text.length);
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;

  const blocks = [];
  const pageChars = [];
  for (const page of pages) {
    pageChars.push({ page: page.number, chars: page.lines.reduce((sum, l) => sum + l.text.length, 0) });
    let paragraph = null;
    const flush = () => {
      if (paragraph) blocks.push({ type: "paragraph", text: normaliseText(paragraph.text), page: page.number });
      paragraph = null;
    };
    page.lines.forEach((line, index) => {
      const previous = page.lines[index - 1];
      const gap = previous ? previous.y - line.y : 0;
      const isolated = !previous || gap > line.size * 1.6;
      const next = page.lines[index + 1];
      const standalone = !next || line.y - next.y > line.size * 1.6 || next.size !== line.size;
      const heading = pdfHeading(line, bodySize, isolated && standalone);
      if (heading) {
        flush();
        blocks.push({ type: "heading", level: heading.level, number: heading.number, text: normaliseText(line.text), page: page.number });
        return;
      }
      if (!paragraph || isolated) {
        flush();
        paragraph = { text: line.text };
      } else {
        paragraph.text += paragraph.text.endsWith("-") ? line.text : ` ${line.text}`;
      }
    });
    flush();
  }
  return { kind: "pdf", pageCount: pages.length, pageChars, blocks: blocks.filter((b) => b.text), warnings: [] };
}

function pdfLines(items) {
  const rows = [];
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const text = item.str;
    if (!text.trim() && !item.hasEOL) continue;
    const [, , , d, x, y] = item.transform;
    const size = Math.round(Math.abs(item.height || d) * 10) / 10;
    // Same line when the baseline is within 40% of the font size.
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(size, r.size) * 0.4);
    if (!row) { row = { y, size, parts: [] }; rows.push(row); }
    row.size = Math.max(row.size, size);
    row.parts.push({ x, text });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => ({
      y: row.y,
      size: row.size,
      text: row.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(" ").replace(/\s+/g, " ").trim(),
    }))
    .filter((line) => line.text);
}

function pdfHeading(line, bodySize, standalone) {
  if (!standalone || line.text.length > 120 || /[.:;,]$/.test(line.text)) return null;
  const numbered = NUMBERED_HEADING.exec(line.text);
  if (numbered && /^[A-Z]/.test(numbered[2])) return { level: numbered[1].split(".").length, number: numbered[1] };
  if (bodySize > 0 && line.size >= bodySize * 1.2 && /[A-Za-z]/.test(line.text)) {
    return { level: line.size >= bodySize * 1.5 ? 1 : 2, number: null };
  }
  return null;
}

// ── DOCX ────────────────────────────────────────────────────────────────────

/**
 * Extracts headings, paragraphs, list items and tables from a DOCX via
 * mammoth's semantic HTML (Word heading styles → h1..h6; tables kept as
 * rows × cells). DOCX has no fixed pages, so page provenance is null.
 */
export async function extractDocx(bytes) {
  let result;
  try {
    result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { includeDefaultStyleMap: true, ignoreEmptyParagraphs: true });
  } catch (error) {
    throw new ExtractionError("parse_error", `The DOCX could not be read: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  const blocks = htmlBlocks(result.value);
  const images = (result.value.match(/<img\b/gi) ?? []).length;
  const warnings = images ? [`${images} image${images === 1 ? "" : "s"} not extracted (no OCR in this phase).`] : [];
  return { kind: "docx", pageCount: null, pageChars: [], blocks, warnings };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});
const stripTags = (html) => normaliseText(decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")));

/** Walks mammoth's (flat, well-formed) HTML into ordered blocks. */
export function htmlBlocks(html) {
  const blocks = [];
  const pattern = /<(h[1-6]|p|table|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const tag = match[1].toLowerCase();
    const inner = match[2];
    if (tag === "table") {
      const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
        [...row[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((cell) => stripTags(cell[2])));
      const nonEmpty = rows.filter((r) => r.some((c) => c));
      if (nonEmpty.length) blocks.push({ type: "table", rows: nonEmpty, page: null });
    } else if (tag === "ul" || tag === "ol") {
      for (const item of inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = stripTags(item[1]);
        if (text) blocks.push({ type: "list_item", text, ordered: tag === "ol", page: null });
      }
    } else {
      const text = stripTags(inner);
      if (!text) continue;
      if (tag === "p") blocks.push({ type: "paragraph", text, page: null });
      else {
        const numbered = NUMBERED_HEADING.exec(text);
        blocks.push({ type: "heading", level: Number(tag[1]), number: numbered ? numbered[1] : null, text, page: null });
      }
    }
  }
  return blocks;
}

// ── Fragments ───────────────────────────────────────────────────────────────

const tableText = (rows) => rows.map((row) => row.join(" | ")).join("\n");

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("; "));
    const at = cut > max * 0.5 ? cut + 1 : window.lastIndexOf(" ") > max * 0.5 ? window.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Groups blocks into section-aware fragments: a fragment never spans two
 * sections, text is chunked at block boundaries around the target size,
 * and each table (split by rows if large, header row repeated) is its own
 * fragment with its structure kept in metadata.
 */
export function buildFragments(blocks) {
  const fragments = [];
  const stack = []; // current heading path
  let chunk = null;
  const section = () => {
    const top = stack[stack.length - 1] ?? null;
    return {
      section_heading: top?.text ?? null,
      section_number: top?.number ?? null,
      section_path: stack.map((h) => h.text),
    };
  };
  const push = (type, text, pageStart, pageEnd, metadata) => {
    const clean = normaliseText(text);
    if (!clean) return;
    fragments.push({
      sequence: fragments.length + 1,
      fragment_type: type,
      ...section(),
      page_start: pageStart,
      page_end: pageEnd,
      text: clean,
      text_hash: sha256Hex(clean),
      char_count: clean.length,
      metadata,
    });
  };
  const flush = () => {
    if (!chunk) return;
    push(chunk.type, chunk.parts.join("\n\n"), chunk.pageStart, chunk.pageEnd, { block_count: chunk.parts.length });
    chunk = null;
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      flush();
      while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
      stack.push({ level: block.level, number: block.number ?? null, text: block.text });
      continue;
    }
    if (block.type === "table") {
      flush();
      const [header, ...body] = block.rows;
      const columns = Math.max(...block.rows.map((r) => r.length));
      let rows = [header];
      const emit = () => {
        push("table", tableText(rows), block.page, block.page, { table: { columns, header, rows } });
        rows = [header];
      };
      for (const row of body) {
        if (tableText([...rows, row]).length > LIMITS.fragmentMaxChars && rows.length > 1) emit();
        rows.push(row);
      }
      emit();
      continue;
    }
    const type = block.type === "list_item" ? "list" : "text";
    const text = block.type === "list_item" ? `• ${block.text}` : block.text;
    for (const piece of splitLong(text, LIMITS.fragmentMaxChars)) {
      const size = chunk ? chunk.parts.join("\n\n").length : 0;
      if (chunk && (chunk.type !== type || size >= LIMITS.fragmentTargetChars || size + piece.length > LIMITS.fragmentMaxChars)) flush();
      if (!chunk) chunk = { type, parts: [], pageStart: null, pageEnd: null };
      chunk.parts.push(piece);
      if (block.page != null) {
        chunk.pageStart = chunk.pageStart == null ? block.page : Math.min(chunk.pageStart, block.page);
        chunk.pageEnd = chunk.pageEnd == null ? block.page : Math.max(chunk.pageEnd, block.page);
      }
    }
  }
  flush();
  return fragments;
}

// ── Diagnostics and outcome ────────────────────────────────────────────────

/**
 * Deterministic quality checks. The outcome is "completed",
 * "completed_with_warnings", or "ocr_required" (no usable text — never
 * reported as a success).
 */
export function diagnose(extracted, fragments) {
  const charCount = fragments.reduce((sum, f) => sum + f.char_count, 0);
  const emptyPages = extracted.pageChars.filter((p) => p.chars < LIMITS.emptyPageChars).map((p) => p.page);
  const headingCount = extracted.blocks.filter((b) => b.type === "heading").length;
  const tableCount = extracted.blocks.filter((b) => b.type === "table").length;
  let emptySections = 0;
  extracted.blocks.forEach((b, i) => {
    if (b.type !== "heading") return;
    const next = extracted.blocks[i + 1];
    if (!next || (next.type === "heading" && next.level <= b.level)) emptySections += 1;
  });
  const warnings = [...extracted.warnings];
  if (extracted.kind === "pdf" && emptyPages.length) {
    warnings.push(`${emptyPages.length} of ${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"} had no extractable text (page${emptyPages.length === 1 ? "" : "s"} ${emptyPages.join(", ")}) — possibly scanned images; not OCR'd.`);
  }
  if (headingCount === 0 && fragments.length) warnings.push("No headings were detected; fragments follow document order without section provenance.");
  // Headings directly followed by a same-level heading (titles, cover pages)
  // are normal document structure: counted in diagnostics, not a warning.
  const meaningfulText = charCount >= LIMITS.minMeaningfulChars;
  const outcome = !meaningfulText ? "ocr_required" : warnings.length ? "completed_with_warnings" : "completed";
  return {
    outcome,
    diagnostics: {
      page_count: extracted.pageCount,
      fragment_count: fragments.length,
      char_count: charCount,
      heading_count: headingCount,
      table_count: tableCount,
      empty_page_count: emptyPages.length,
      empty_pages: emptyPages,
      empty_section_count: emptySections,
      meaningful_text: meaningfulText,
      warnings,
    },
  };
}

/** Full pipeline for one file. Throws ExtractionError on unreadable input. */
export async function extractSourceDocument(bytes, contentType) {
  const extracted = contentType === PDF_MIME ? await extractPdf(bytes)
    : contentType === DOCX_MIME ? await extractDocx(bytes)
      : (() => { throw new ExtractionError("unsupported_type", `Unsupported content type: ${contentType}`); })();
  const fragments = buildFragments(extracted.blocks);
  const { outcome, diagnostics } = diagnose(extracted, fragments);
  return { extractor_version: EXTRACTOR_VERSION, outcome, diagnostics, fragments };
}
