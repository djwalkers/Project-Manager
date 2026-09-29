// Section-aware grouping of one extraction run's fragments into model-sized
// chunks (Phase 1C). Deterministic: the same fragments always produce the
// same chunks, keys and text, so stage results can be reused on retry.
//
//   fragments ─(consecutive, same section_path)─▶ sections ─(pack ≤ budget)─▶ chunks
//
// A section is never split across chunks unless it alone exceeds the
// budget; then it is split at fragment boundaries, and a single oversized
// fragment is split at paragraph boundaries — every part keeps its section
// identity and its fragment ID ("[F3] (part 1/2)").

export const CHUNK_CHAR_BUDGET = 6000;

/** Short, run-local fragment label shown to the model: F<sequence>. */
export const aliasFor = (fragment) => `F${fragment.sequence}`;

export function sectionLabel(fragment) {
  const path = (fragment.section_path ?? []).filter(Boolean);
  if (path.length) return path.join(" › ");
  return fragment.section_heading || "(document start)";
}

function pagesLabel(fragments) {
  const pages = fragments.flatMap((f) => [f.page_start, f.page_end]).filter((p) => Number.isInteger(p));
  if (!pages.length) return "";
  const lo = Math.min(...pages), hi = Math.max(...pages);
  return lo === hi ? ` [page ${lo}]` : ` [pages ${lo}–${hi}]`;
}

/** Tables are given to the model as readable pipe rows, not flattened prose. */
export function fragmentBody(fragment) {
  const table = fragment.metadata?.table;
  if (fragment.fragment_type === "table" && table && Array.isArray(table.rows)) {
    const row = (cells) => `| ${cells.map((c) => String(c ?? "").replace(/\s+/g, " ").trim()).join(" | ")} |`;
    return [table.header?.length ? row(table.header) : null, ...table.rows.map(row)].filter(Boolean).join("\n");
  }
  return fragment.text;
}

function splitText(text, budget) {
  const paragraphs = text.split(/\n{2,}|\n/);
  const parts = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 1 > budget) { parts.push(current); current = ""; }
    if (p.length > budget) { for (let i = 0; i < p.length; i += budget) parts.push(p.slice(i, i + budget)); continue; }
    current = current ? `${current}\n${p}` : p;
  }
  if (current) parts.push(current);
  return parts;
}

/** Consecutive fragments sharing a section path form one logical section. */
export function groupSections(fragments) {
  const ordered = [...fragments].sort((a, b) => a.sequence - b.sequence);
  const sections = [];
  for (const fragment of ordered) {
    const label = sectionLabel(fragment);
    const last = sections.at(-1);
    if (last && last.label === label) last.fragments.push(fragment);
    else sections.push({ label, fragments: [fragment] });
  }
  return sections;
}

/** Renders entries ({fragment, text, part}) of one section as model input. */
function renderSection(label, entries) {
  const lines = [`### Section: ${label}${pagesLabel(entries.map((e) => e.fragment))}`];
  for (const e of entries) {
    const kind = e.fragment.fragment_type === "text" ? "" : ` (${e.fragment.fragment_type})`;
    lines.push(`[${aliasFor(e.fragment)}]${kind}${e.part ? ` (part ${e.part})` : ""}\n${e.text}`);
  }
  return lines.join("\n");
}

/**
 * Packs sections into chunks of at most `budget` characters of source text.
 * Returns [{ key, sections: [label], fragmentIds: [uuid], aliases: [F…], text }].
 */
export function buildChunks(fragments, budget = CHUNK_CHAR_BUDGET) {
  // Expand each section into budget-sized pieces that keep the section label.
  const pieces = [];
  for (const section of groupSections(fragments)) {
    const entries = section.fragments.flatMap((fragment) => {
      const body = fragmentBody(fragment);
      if (body.length <= budget) return [{ fragment, text: body, part: null }];
      const parts = splitText(body, budget);
      return parts.map((text, i) => ({ fragment, text, part: `${i + 1}/${parts.length}` }));
    });
    let current = [];
    let size = 0;
    for (const entry of entries) {
      if (current.length && size + entry.text.length > budget) { pieces.push({ label: section.label, entries: current, size }); current = []; size = 0; }
      current.push(entry);
      size += entry.text.length;
    }
    if (current.length) pieces.push({ label: section.label, entries: current, size });
  }

  const chunks = [];
  let current = null;
  for (const piece of pieces) {
    if (!current || current.size + piece.size > budget) {
      current = { pieces: [], size: 0 };
      chunks.push(current);
    }
    current.pieces.push(piece);
    current.size += piece.size;
  }
  return chunks.map((chunk, i) => {
    const fragmentsIn = [...new Map(chunk.pieces.flatMap((p) => p.entries.map((e) => [e.fragment.id, e.fragment]))).values()];
    return {
      key: `c${String(i + 1).padStart(2, "0")}`,
      sections: [...new Set(chunk.pieces.map((p) => p.label))],
      fragmentIds: fragmentsIn.map((f) => f.id),
      aliases: fragmentsIn.map(aliasFor),
      text: chunk.pieces.map((p) => renderSection(p.label, p.entries)).join("\n\n"),
    };
  });
}

export function documentOutline(fragments) {
  return groupSections(fragments).map((s) => `- ${s.label}`).join("\n");
}
