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
import JSZip from "jszip";
import mammoth from "mammoth";

// 1.1.0 — DOCX: headings from Word outline levels and a conservative
// formatting fallback; text and list items of one section chunked together.
export const EXTRACTOR_VERSION = "1.1.0";

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
//
// Walks mammoth's document model (not its HTML), because real specifications
// often format headings visually instead of using Word heading styles.
// Heading detection, in order of trust:
//   1. a Word Heading/Title style;
//   2. a Word outline level (w:outlineLvl) on the paragraph or its style —
//      real structural metadata that drives Word's navigation pane;
//   3. a conservative formatting fallback (see isFormattingHeading).
// Anything else is text or a list item. DOCX has no fixed pages, so page
// provenance is null.

export const DOCX_HEADING_RULES = {
  maxChars: 100,
  maxWords: 12,
  /** A non-bold paragraph counts only if at least this much larger than body text. */
  sizeRatio: 1.25,
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (value) => value.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});
const xmlText = (xml) => decode([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));

/** Outline levels from the raw XML (mammoth does not expose them). */
async function readOutlineLevels(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const stylesXml = (await zip.file("word/styles.xml")?.async("string")) ?? "";
  const byStyle = new Map();
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:type="paragraph"[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const level = /<w:outlineLvl w:val="(\d)"/.exec(m[2]);
    if (level && Number(level[1]) < 9) byStyle.set(m[1], Number(level[1]) + 1);
  }
  const defaultSize = /<w:docDefaults>[\s\S]*?<w:sz w:val="(\d+)"/.exec(stylesXml);
  // Paragraph-level outline levels and list membership, in document order,
  // keyed by their text (matched to mammoth's paragraphs in order).
  const direct = [];
  const lists = [];
  for (const p of documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p[1])?.[1] ?? "";
    const text = normaliseText(xmlText(p[1]));
    const level = /<w:outlineLvl w:val="(\d)"/.exec(pPr);
    if (level && Number(level[1]) < 9) direct.push({ text, level: Number(level[1]) + 1 });
    const numId = /<w:numId w:val="(\d+)"/.exec(pPr)?.[1];
    if (numId && numId !== "0") lists.push({ text, numId, ilvl: Number(/<w:ilvl w:val="(\d)"/.exec(pPr)?.[1] ?? 0) });
  }
  return { byStyle, direct, lists, defaultSize: defaultSize ? Number(defaultSize[1]) / 2 : 11 };
}

function paragraphInfo(paragraph, defaultSize) {
  const runs = [];
  const walk = (node, inherited) => {
    for (const child of node.children ?? []) {
      if (child.type === "run") walk(child, child);
      else if (child.type === "text") runs.push({ text: child.value, bold: Boolean(inherited?.isBold), size: inherited?.fontSize ?? defaultSize });
      else if (child.type === "tab") runs.push({ text: " ", bold: Boolean(inherited?.isBold), size: inherited?.fontSize ?? defaultSize });
      else if (child.type === "break") runs.push({ text: "\n", bold: Boolean(inherited?.isBold), size: inherited?.fontSize ?? defaultSize });
      else if (child.children) walk(child, inherited);
    }
  };
  walk(paragraph, null);
  const visible = runs.filter((r) => r.text.trim());
  return {
    text: normaliseText(runs.map((r) => r.text).join("")),
    allBold: visible.length > 0 && visible.every((r) => r.bold),
    size: visible.reduce((max, r) => Math.max(max, r.size), 0),
    weightBySize: visible.map((r) => [r.size, r.text.length]),
  };
}

function styleHeadingLevel(paragraph) {
  const name = String(paragraph.styleName ?? "");
  const byName = /^heading\s*([1-9])$/i.exec(name) ?? /^Heading([1-9])$/.exec(String(paragraph.styleId ?? ""));
  if (byName) return Number(byName[1]);
  if (/^title$/i.test(name)) return 1;
  return null;
}

/**
 * The conservative fallback: a standalone paragraph that looks like a title,
 * not a sentence. Every condition must hold — a false heading would split a
 * section and mislabel its content, which is worse than missing one.
 */
export function isFormattingHeading(info, bodySize, { isListItem, hasFollowingContent }) {
  if (isListItem || !hasFollowingContent) return false;
  const text = info.text;
  if (!text || text.includes("\n") || text.length > DOCX_HEADING_RULES.maxChars) return false;
  if (text.split(/\s+/).length > DOCX_HEADING_RULES.maxWords) return false;
  if (/[.,;:!?]$/.test(text)) return false; // sentences / lead-ins end with punctuation
  if (!/^[A-Z0-9]/.test(text)) return false;
  const larger = bodySize > 0 && info.size >= bodySize * DOCX_HEADING_RULES.sizeRatio;
  return info.allBold || larger;
}

/**
 * Extracts headings, paragraphs, list items and tables from a DOCX.
 */
export async function extractDocx(bytes) {
  let model;
  let outline;
  try {
    await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { transformDocument: (doc) => { model = doc; return doc; } });
    outline = await readOutlineLevels(Buffer.from(bytes));
  } catch (error) {
    throw new ExtractionError("parse_error", `The DOCX could not be read: ${String(error?.message ?? error).slice(0, 200)}`);
  }

  let images = 0;
  const countImages = (node) => { if (node.type === "image") images += 1; (node.children ?? []).forEach(countImages); };
  countImages(model);

  // Pass 1: flatten body into records.
  const records = [];
  const cellText = (cell) => normaliseText((cell.children ?? []).filter((c) => c.type === "paragraph").map((p) => paragraphInfo(p, outline.defaultSize).text).join("\n"));
  for (const node of model.children ?? []) {
    if (node.type === "paragraph") {
      const info = paragraphInfo(node, outline.defaultSize);
      if (!info.text) continue;
      records.push({ kind: "paragraph", node, info });
    } else if (node.type === "table") {
      const rows = (node.children ?? []).filter((r) => r.type === "tableRow")
        .map((row) => (row.children ?? []).filter((c) => c.type === "tableCell").map(cellText));
      const nonEmpty = rows.filter((r) => r.some((c) => c));
      if (nonEmpty.length) records.push({ kind: "table", rows: nonEmpty });
    }
  }

  // Body size = the (effective) font size carrying the most characters.
  const weight = new Map();
  for (const r of records) if (r.kind === "paragraph") for (const [size, n] of r.info.weightBySize) weight.set(size, (weight.get(size) ?? 0) + n);
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? outline.defaultSize;

  // Pass 2: classify. Outline levels are matched to paragraphs in order by exact text.
  let outlineIndex = 0;
  const blocks = [];
  const headingStack = []; // [{ level, size }] — used to nest formatting-inferred headings
  const sources = { style: 0, outline: 0, formatting: 0 };
  // Ordered-list numbers follow Word's own lists (numId + level), so a list
  // that continues across headings keeps counting; if an item cannot be
  // matched to its XML it gets a bullet rather than an invented number.
  let listIndex = 0;
  const counters = new Map();
  const markerFor = (text, ordered) => {
    const entry = outline.lists[listIndex];
    if (!entry || entry.text !== text) return "•";
    listIndex += 1;
    if (!ordered) return "•";
    for (const key of [...counters.keys()]) if (key.startsWith(`${entry.numId}:`) && Number(key.split(":")[1]) > entry.ilvl) counters.delete(key);
    const key = `${entry.numId}:${entry.ilvl}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
    return `${counters.get(key)}.`;
  };
  records.forEach((record, i) => {
    if (record.kind === "table") { blocks.push({ type: "table", rows: record.rows, page: null }); return; }
    const { node, info } = record;
    const isListItem = Boolean(node.numbering);
    let level = styleHeadingLevel(node);
    let source = level ? "style" : null;
    const next = outline.direct[outlineIndex];
    const outlineLevel = next && next.text === info.text ? next.level : null;
    if (outlineLevel) outlineIndex += 1;
    if (!level && !isListItem && (outlineLevel || outline.byStyle.get(node.styleId))) {
      level = outlineLevel ?? outline.byStyle.get(node.styleId);
      source = "outline";
    }
    if (!level && isFormattingHeading(info, bodySize, { isListItem, hasFollowingContent: i < records.length - 1 })) {
      // Nest under the nearest preceding heading set in a larger font. An
      // explicitly marked heading (style / outline level) is never displaced
      // by an inferred one — the inferred heading becomes its child.
      while (headingStack.length && headingStack[headingStack.length - 1].source === "formatting" && headingStack[headingStack.length - 1].size <= info.size) headingStack.pop();
      level = Math.min(6, (headingStack[headingStack.length - 1]?.level ?? 0) + 1);
      source = "formatting";
    }
    if (level) {
      if (outline.lists[listIndex]?.text === info.text) listIndex += 1;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, size: info.size, source });
      sources[source] += 1;
      const numbered = NUMBERED_HEADING.exec(info.text);
      blocks.push({ type: "heading", level, number: numbered ? numbered[1] : null, text: info.text, page: null, source });
      return;
    }
    if (isListItem) {
      const ordered = Boolean(node.numbering.isOrdered);
      blocks.push({ type: "list_item", text: info.text, ordered, marker: markerFor(info.text, ordered), page: null });
      return;
    }
    // A heading or plain paragraph that is also a Word list item still consumes its entry.
    if (outline.lists[listIndex]?.text === info.text) listIndex += 1;
    blocks.push({ type: "paragraph", text: info.text, page: null });
  });

  const warnings = images ? [`${images} image${images === 1 ? "" : "s"} not extracted (no OCR in this phase).`] : [];
  return { kind: "docx", pageCount: null, pageChars: [], blocks, warnings, headingSources: sources };
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
    // List items sit on consecutive lines; paragraphs are separated by a blank line.
    const text = chunk.parts.map((part, i) => (i === 0 ? "" : part.isList && chunk.parts[i - 1].isList ? "\n" : "\n\n") + part.text).join("");
    push(chunk.allList ? "list" : "text", text, chunk.pageStart, chunk.pageEnd, { block_count: chunk.parts.length });
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
    // Paragraphs and list items of the same section share a fragment (a
    // requirement list reads with its lead-in); the fragment is "list" only
    // when every block in it is a list item.
    const isList = block.type === "list_item";
    const text = isList ? `${block.marker ?? "•"} ${block.text}` : block.text;
    for (const piece of splitLong(text, LIMITS.fragmentMaxChars)) {
      // Same measure as before for text-only chunks: characters plus the "\n\n" separators.
      const size = chunk ? chunk.parts.reduce((n, part) => n + part.text.length, 0) + 2 * (chunk.parts.length - 1) : 0;
      if (chunk && (size >= LIMITS.fragmentTargetChars || size + piece.length > LIMITS.fragmentMaxChars)) flush();
      if (!chunk) chunk = { allList: true, parts: [], pageStart: null, pageEnd: null };
      chunk.allList = chunk.allList && isList;
      chunk.parts.push({ text: piece, isList });
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
      heading_sources: extracted.headingSources ?? null,
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
