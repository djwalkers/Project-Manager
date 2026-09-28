// Deterministic source-document extraction (Phase 1B). No AI, no network.
//
//   PDF  → pdfjs-dist text content per page → lines → paragraphs/headings/fields
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
// 1.2.0 — PDF: repeated page headers/footers and export stamps set aside as
// document chrome; label/value and bold section-label layouts recognised
// when a PDF has no numbered or larger headings.
export const EXTRACTOR_VERSION = "1.2.0";

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
//
// Two passes over the same text items, both deterministic:
//
//   1. Document chrome is set aside first: lines repeated at the same place
//      in the top/bottom margin of most pages (printed headers, URL footers,
//      page counters) and a trailing "Generated at … by/using …" export
//      stamp. Each removed line is recorded in the diagnostics — never
//      dropped silently.
//   2. The flow pass (unchanged since 1.0.0): headings are short standalone
//      lines that are numbered ("4.2 Replenishment Processing") or set
//      noticeably larger than the body text.
//   3. The layout pass reads structure from font weight and position
//      instead — the way form-like exports (issue trackers, templates)
//      present it: a left column of bold field labels with values beside
//      them, and bold title-like section labels with regular body text
//      below. It replaces the flow pass only when a page has such a field
//      column (several rows sharing one label x and one value x), or when
//      the flow pass finds no heading at all.
//
// Page numbers are kept on every block, so provenance survives both passes.

export const PDF_LAYOUT_RULES = {
  /** Top/bottom share of the page height searched for repeated chrome. */
  chromeBand: 0.08,
  /** A chrome line must repeat on at least this share of the pages (and ≥ 2). */
  chromeRepeatShare: 0.6,
  /** Minimum label/value rows sharing one label x and one value x to call it a field column. */
  minFieldRows: 3,
  /** A second label/value column beside the first needs this many rows. */
  minSecondaryFieldRows: 2,
  /** A field value longer than this becomes its own section instead of a field line. */
  fieldValueMaxChars: 120,
  /** Bold section labels: at most this many characters / words. */
  labelMaxChars: 100,
  labelMaxWords: 12,
  /** Bold section labels are ignored when this share of the text is bold. */
  maxBoldShare: 0.5,
};

async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

// Real font names ("ABCDEF+Arial-BoldMT"); pdfjs's generic font family
// ("sans-serif") carries no weight.
const BOLD_FONT = /bold|black|heavy|semibold|demibold|extrabold/i;

/**
 * Extracts text blocks from a PDF, one page at a time.
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
      const fonts = await fontNames(page, content.items);
      pages.push({ number: n, height: page.view[3] - page.view[1], lines: pdfLines(content.items, fonts) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  const chrome = removeChrome(pages);

  // Body font size = the size carrying the most characters.
  const weight = new Map();
  for (const page of pages) for (const line of page.lines) weight.set(line.size, (weight.get(line.size) ?? 0) + line.text.length);
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;

  const pageChars = pages.map((page) => ({ page: page.number, chars: page.lines.reduce((sum, l) => sum + l.text.length, 0) }));
  const base = { kind: "pdf", pageCount: pages.length, pageChars, warnings: [], chrome };

  // A label/value field column is strong evidence of a form-like layout; bold
  // section labels alone are used only when the flow pass finds no headings.
  const flow = flowPass(pages, bodySize);
  const layout = layoutPass(pages, bodySize);
  const flowHasHeadings = flow.some((b) => b.type === "heading");
  if (layout && (layout.fieldPages > 0 || !flowHasHeadings) && layout.blocks.some((b) => b.type === "heading" || b.type === "field")) {
    return { ...base, layout: "label_value", headingSources: layout.sources, blocks: layout.blocks.filter((b) => b.text || b.type === "field") };
  }
  return { ...base, layout: "flow", blocks: flow };
}

/** The 1.0.0 flow pass: numbered or larger standalone lines are headings. */
function flowPass(pages, bodySize) {
  const blocks = [];
  for (const page of pages) {
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
  return blocks.filter((b) => b.text);
}

async function fontNames(page, items) {
  const names = new Map();
  try {
    await page.getOperatorList(); // loads the page's fonts into commonObjs
    for (const item of items) {
      if (!item.fontName || names.has(item.fontName)) continue;
      let name = "";
      try { name = String(page.commonObjs.get(item.fontName)?.name ?? ""); } catch { /* font not resolved */ }
      names.set(item.fontName, name);
    }
  } catch {
    // Weight is only supporting evidence: without font names the flow pass still runs.
  }
  return names;
}

function pdfLines(items, fonts = new Map()) {
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
    row.parts.push({ x, y, size, width: Math.max(0, Number(item.width) || 0), bold: BOLD_FONT.test(fonts.get(item.fontName) ?? ""), text });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const parts = row.parts.sort((a, b) => a.x - b.x);
      return {
        y: row.y,
        size: row.size,
        text: parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim(),
        parts: parts.filter((p) => p.text.trim()),
      };
    })
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

// ── PDF document chrome ─────────────────────────────────────────────────────

// Digits vary between pages ("1/2", "2/2", dates); the rest must match.
const chromeKey = (text) => text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const GENERATOR_STAMP = /^generated (?:at|on)\b.{3,200}\b(?:by|using)\b/i;
const REVISION_STAMP = /^rev(?:ision)?\s*[:#]?\s*[0-9a-f]{7,64}\.?$/i;

/**
 * Removes lines that are page furniture rather than document content and
 * returns what was removed, per page, with the rule that matched.
 */
export function removeChrome(pages) {
  const removed = [];
  const content = pages.filter((p) => p.lines.length);
  if (content.length >= 2) {
    const needed = Math.max(2, Math.ceil(content.length * PDF_LAYOUT_RULES.chromeRepeatShare));
    const band = (page, line) => {
      const margin = page.height * PDF_LAYOUT_RULES.chromeBand;
      return line.y >= page.height - margin ? "header" : line.y <= margin ? "footer" : null;
    };
    // key|position → pages it occurs on (once per page) and its baselines.
    const seen = new Map();
    for (const page of content) {
      for (const line of page.lines) {
        const position = band(page, line);
        if (!position) continue;
        const key = `${position}|${chromeKey(line.text)}`;
        const entry = seen.get(key) ?? { pages: new Set(), ys: [] };
        entry.pages.add(page.number);
        entry.ys.push(line.y);
        seen.set(key, entry);
      }
    }
    for (const page of content) {
      page.lines = page.lines.filter((line) => {
        const position = band(page, line);
        if (!position) return true;
        const entry = seen.get(`${position}|${chromeKey(line.text)}`);
        const steady = entry && Math.max(...entry.ys) - Math.min(...entry.ys) <= 3;
        if (!entry || entry.pages.size < needed || !steady) return true;
        removed.push({ page: page.number, position, rule: position === "header" ? "repeated_header" : "repeated_footer", text: line.text });
        return false;
      });
    }
  }
  // An export stamp is chrome only as the last thing on its page (optionally
  // followed by a bare revision hash) — never in the middle of content.
  for (const page of pages) {
    const n = page.lines.length;
    const last = page.lines[n - 1];
    const stampAt = last && GENERATOR_STAMP.test(last.text) ? n - 1
      : n >= 2 && REVISION_STAMP.test(last.text) && GENERATOR_STAMP.test(page.lines[n - 2].text) ? n - 2 : -1;
    if (stampAt < 0) continue;
    for (const line of page.lines.splice(stampAt)) removed.push({ page: page.number, position: "end", rule: "generator_stamp", text: line.text });
  }
  return removed.sort((a, b) => a.page - b.page);
}

// ── PDF layout pass (label/value and bold section labels) ──────────────────

const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance;
const sameSize = (a, b) => Math.max(a, b) <= Math.min(a, b) * 1.15;

/** Splits a line into cells at wide horizontal gaps or font-size changes. */
function segments(line) {
  const out = [];
  for (const part of line.parts) {
    const last = out[out.length - 1];
    const gap = last ? part.x - last.xEnd : 0;
    if (last && gap <= part.size * 1.5 && sameSize(last.size, part.size)) {
      last.text += gap > part.size * 0.1 && !last.text.endsWith(" ") ? ` ${part.text}` : part.text;
      last.xEnd = Math.max(last.xEnd, part.x + part.width);
      last.boldChars += part.bold ? part.text.length : 0;
      last.chars += part.text.length;
    } else {
      out.push({ x: part.x, xEnd: part.x + part.width, y: line.y, size: part.size, text: part.text, boldChars: part.bold ? part.text.length : 0, chars: part.text.length });
    }
  }
  return out.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim(), bold: s.boldChars > 0 && s.boldChars >= s.chars * 0.8 })).filter((s) => s.text);
}

const toLine = (cells, alone = true) => ({
  y: cells[0].y,
  x: cells[0].x,
  size: Math.max(...cells.map((c) => c.size)),
  text: cells.map((c) => c.text).join(" "),
  bold: cells.every((c) => c.bold),
  alone,
});

/** One row as lines of reading text: cells of one font size stay together. */
function rowLines(cells) {
  const groups = [];
  for (const cell of cells) {
    const group = groups[groups.length - 1];
    if (group && sameSize(group[0].size, cell.size)) group.push(cell);
    else groups.push([cell]);
  }
  return groups.map((g) => toLine(g, groups.length === 1));
}

/**
 * A bold standalone label that reads as a section title: short, not a
 * sentence or list item, and upper-case or Title Case.
 */
export function isSectionLabel(text) {
  const t = text.trim();
  const words = t.split(/\s+/);
  if (!t || t.length > PDF_LAYOUT_RULES.labelMaxChars || words.length > PDF_LAYOUT_RULES.labelMaxWords) return false;
  if (/[.;,:!?]$/.test(t) || /^([•▪◦\-–*]|\(?[a-z0-9]{1,3}[.)])\s/i.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length / letters.length;
  if (upper >= 0.7) return true;
  const significant = words.filter((w) => /^[A-Za-z]{4,}/.test(w));
  return /^[A-Z]/.test(words[0]) && significant.every((w) => /^[A-Z]/.test(w));
}

/** Finds label/value column pairs from rows of "bold label · regular value". */
function fieldColumns(rows) {
  const pairs = [];
  for (const cells of rows) {
    for (let i = 0; i + 1 < cells.length; i += 1) {
      const [label, value] = [cells[i], cells[i + 1]];
      if (!label.bold || value.bold || !sameSize(label.size, value.size)) continue;
      if (label.text.length > 60 || label.text.split(/\s+/).length > 8) continue;
      pairs.push({ labelX: label.x, valueX: value.x, y: label.y, size: label.size });
    }
  }
  const clusters = [];
  for (const pair of pairs) {
    const cluster = clusters.find((c) => near(c.labelX, pair.labelX) && near(c.valueX, pair.valueX));
    if (cluster) cluster.rows.push(pair);
    else clusters.push({ labelX: pair.labelX, valueX: pair.valueX, rows: [pair] });
  }
  const primary = clusters
    .filter((c) => c.rows.length >= PDF_LAYOUT_RULES.minFieldRows)
    .sort((a, b) => a.labelX - b.labelX || b.rows.length - a.rows.length)[0];
  if (!primary) return null;
  const secondary = clusters.filter((c) => c !== primary && c.labelX > primary.valueX && c.rows.length >= PDF_LAYOUT_RULES.minSecondaryFieldRows);
  return { primary, secondary, top: Math.max(...primary.rows.map((r) => r.y)), size: primary.rows[0].size };
}

/**
 * Paragraphs and bold section labels from a run of lines (y descending).
 * Consecutive bold label lines are one wrapped label.
 */
function flowLayout(lines, page, bodySize, level, sources, allowBold) {
  const blocks = [];
  let paragraph = null;
  let label = null;
  const flushParagraph = () => {
    if (paragraph) blocks.push({ type: "paragraph", text: normaliseText(paragraph.text), page });
    paragraph = null;
  };
  const flushLabel = () => {
    if (label) blocks.push({ type: "heading", level: label.level, number: null, text: normaliseText(label.text), page });
    label = null;
  };
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    const isolated = !previous || previous.y - line.y > line.size * 1.6;
    const sized = bodySize > 0 && line.size >= bodySize * 1.2 && /[A-Za-z]/.test(line.text) && !/[.:;,]$/.test(line.text);
    // A larger title may wrap over several lines of the same size.
    if (sized && label?.sized && !isolated && sameSize(label.size, line.size)) { label.text += ` ${line.text}`; return; }
    if (sized && (isolated || label?.sized === false)) {
      flushParagraph(); flushLabel();
      label = { level: level === 2 ? 1 : level, text: line.text, size: line.size, sized: true };
      sources.size += 1;
      return;
    }
    // A bold label stands alone on its row; a directly following bold line
    // continues it when the two still read as one label (a wrapped label).
    if (allowBold && line.bold && line.alone && isSectionLabel(line.text)) {
      if (label && !label.sized && !isolated && isSectionLabel(`${label.text} ${line.text}`)) { label.text += ` ${line.text}`; return; }
      if (isolated || !previous?.bold) {
        flushParagraph(); flushLabel();
        label = { level, text: line.text, size: line.size, sized: false };
        sources.bold += 1;
        return;
      }
    }
    flushLabel();
    if (!paragraph || isolated) {
      flushParagraph();
      paragraph = { text: line.text };
    } else {
      paragraph.text += paragraph.text.endsWith("-") ? line.text : ` ${line.text}`;
    }
  });
  flushParagraph(); flushLabel();
  return blocks;
}

/** Groups consecutive lines (y descending) that sit within normal line spacing. */
function stack(lines, breakAfter = () => false) {
  const groups = [];
  for (const line of lines) {
    const group = groups[groups.length - 1];
    const last = group?.lines[group.lines.length - 1];
    if (group && last.y - line.y <= line.size * 1.6 && !breakAfter(last)) group.lines.push(line);
    else groups.push({ lines: [line] });
  }
  for (const g of groups) { g.top = g.lines[0].y; g.bottom = g.lines[g.lines.length - 1].y; g.centre = (g.top + g.bottom) / 2; }
  return groups;
}

const joinLines = (lines) => lines.reduce((text, l) => (!text ? l.text : text.endsWith("-") ? text + l.text : `${text} ${l.text}`), "");
const labelText = (text) => normaliseText(text).replace(/\s*:$/, "");

/**
 * Structure from weight and position (see the PDF section notes). Levels: 1 larger title, 2 bold section label, 3 a field whose
 * value is long enough to be a section, 4 a bold label inside that value.
 * Short fields become "Label: value" lines under the enclosing section.
 */
function layoutPass(pages, bodySize) {
  let chars = 0;
  let boldChars = 0;
  for (const page of pages) for (const line of page.lines) for (const p of line.parts) { chars += p.text.length; boldChars += p.bold ? p.text.length : 0; }
  if (!boldChars) return null;
  const allowBold = boldChars <= chars * PDF_LAYOUT_RULES.maxBoldShare;
  const sources = { size: 0, bold: 0, field_label: 0 };
  const blocks = [];
  let fieldPages = 0;

  for (const page of pages) {
    const rows = page.lines.map((line) => segments(line)).filter((cells) => cells.length);
    const grid = fieldColumns(rows);
    if (!grid) {
      blocks.push(...flowLayout(rows.flatMap(rowLines), page.number, bodySize, 2, sources, allowBold));
      continue;
    }
    fieldPages += 1;
    const tolerance = grid.size * 0.5;
    const before = rows.filter((cells) => cells[0].y > grid.top + tolerance);
    blocks.push(...flowLayout(before.flatMap(rowLines), page.number, bodySize, 2, sources, allowBold));

    // Split each grid row into its left-column label, its value, and any
    // label/value pairs of a second column beside it.
    const labels = [];
    const values = [];
    const extras = [];
    for (const cells of rows.filter((c) => c[0].y <= grid.top + tolerance)) {
      const left = [];
      const right = [];
      let extra = null;
      for (const cell of cells) {
        const column = cell.bold && grid.secondary.find((c) => near(c.labelX, cell.x));
        if (column) { extra = { y: cell.y, label: cell.text, value: [], column }; extras.push(extra); continue; }
        if (extra && cell.x >= extra.column.valueX - 3) { extra.value.push(cell.text); continue; }
        (cell.x < grid.primary.valueX - 3 ? left : right).push(cell);
      }
      if (left.length) labels.push(toLine(left));
      if (right.length) values.push(toLine(right));
    }

    const labelGroups = stack(labels, (line) => /:$/.test(line.text));
    const owned = new Map(labelGroups.map((g) => [g, []]));
    const orphans = [];
    for (const group of stack(values)) {
      const inside = labelGroups.filter((l) => l.centre <= group.top + tolerance && l.centre >= group.bottom - tolerance);
      if (inside.length === 1) { owned.get(inside[0]).push(...group.lines); continue; }
      if (inside.length > 1) {
        for (const line of group.lines) owned.get(inside.reduce((a, b) => (Math.abs(b.centre - line.y) < Math.abs(a.centre - line.y) ? b : a))).push(line);
        continue;
      }
      // Top-aligned rows: the value belongs to the nearest label at or above it.
      const above = labelGroups.filter((l) => l.top >= group.top - tolerance);
      if (above.length) owned.get(above[above.length - 1]).push(...group.lines);
      else orphans.push(...group.lines);
    }
    if (orphans.length) blocks.push(...flowLayout(orphans, page.number, bodySize, 3, sources, false));

    for (const group of labelGroups) {
      const label = normaliseText(joinLines(group.lines));
      const valueLines = owned.get(group).sort((a, b) => b.y - a.y || a.x - b.x);
      const value = normaliseText(joinLines(valueLines));
      if (value.length > PDF_LAYOUT_RULES.fieldValueMaxChars) {
        blocks.push({ type: "heading", level: 3, number: null, text: labelText(label), page: page.number });
        sources.field_label += 1;
        blocks.push(...flowLayout(valueLines, page.number, bodySize, 4, sources, allowBold));
      } else {
        blocks.push({ type: "field", level: 3, label, value, text: fieldText(label, value), page: page.number });
      }
      for (const extra of extras.filter((e) => !e.done && group.lines.some((l) => near(l.y, e.y, tolerance)))) blocks.push(extraField(extra, page.number));
    }
    for (const extra of extras.filter((e) => !e.done)) blocks.push(extraField(extra, page.number));
  }
  return { blocks, sources, fieldPages };
}

function extraField(extra, page) {
  extra.done = true;
  const label = normaliseText(extra.label);
  const value = normaliseText(extra.value.join(" "));
  return { type: "field", level: 3, label, value, text: fieldText(label, value), page };
}

const fieldText = (label, value) => (!value ? label : /[:?]$/.test(label) ? `${label} ${value}` : `${label}: ${value}`);

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
    // List items and fields sit on consecutive lines; paragraphs are separated by a blank line.
    const text = chunk.parts.map((part, i) => (i === 0 ? "" : part.tight && chunk.parts[i - 1].tight ? "\n" : "\n\n") + part.text).join("");
    const fields = chunk.parts.filter((part) => part.field).map((part) => part.field);
    push(chunk.allList ? "list" : "text", text, chunk.pageStart, chunk.pageEnd, fields.length ? { block_count: chunk.parts.length, fields } : { block_count: chunk.parts.length });
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
    // A field ("Status: Open") closes any deeper section it follows: it
    // belongs to the section that encloses the field column.
    if (block.type === "field" && stack.length && stack[stack.length - 1].level >= block.level) {
      flush();
      while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
    }
    // Paragraphs, list items and fields of the same section share a fragment
    // (a requirement list reads with its lead-in); the fragment is "list"
    // only when every block in it is a list item.
    const isList = block.type === "list_item";
    const field = block.type === "field" ? { label: block.label, value: block.value, page: block.page ?? null } : null;
    const text = isList ? `${block.marker ?? "•"} ${block.text}` : block.text;
    for (const piece of splitLong(text, LIMITS.fragmentMaxChars)) {
      // Same measure as before for text-only chunks: characters plus the "\n\n" separators.
      const size = chunk ? chunk.parts.reduce((n, part) => n + part.text.length, 0) + 2 * (chunk.parts.length - 1) : 0;
      if (chunk && (size >= LIMITS.fragmentTargetChars || size + piece.length > LIMITS.fragmentMaxChars)) flush();
      if (!chunk) chunk = { allList: true, parts: [], pageStart: null, pageEnd: null };
      chunk.allList = chunk.allList && isList;
      chunk.parts.push({ text: piece, isList, tight: isList || Boolean(field), field });
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
  const fieldCount = extracted.blocks.filter((b) => b.type === "field").length;
  if (headingCount === 0 && fieldCount === 0 && fragments.length) warnings.push("No headings were detected; fragments follow document order without section provenance.");
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
      ...(extracted.kind === "pdf" ? {
        layout: extracted.layout,
        field_count: fieldCount,
        // Page furniture set aside before structure detection (deterministic
        // document-chrome filtering) — recorded so nothing disappears silently.
        chrome_line_count: extracted.chrome.length,
        chrome_lines: extracted.chrome.map((c) => ({ ...c, text: c.text.slice(0, 300) })),
      } : {}),
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
