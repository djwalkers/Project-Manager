// Deterministic extraction tests (Phase 1B) — real PDF/DOCX bytes built by
// tests/fixtures.mjs, parsed by the real libraries. No network, no AI.
import assert from "node:assert/strict";
import { EXTRACTOR_VERSION, ExtractionError, LIMITS, PDF_MIME, DOCX_MIME, buildFragments, extractSourceDocument, sha256Hex } from "../extract.js";
import { makeDocx, makePdf, specPdf } from "./fixtures.mjs";

async function run(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

await run("PDF: text is extracted with page boundaries, numbered headings and section provenance", async () => {
  const r = await extractSourceDocument(specPdf(), PDF_MIME);
  assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics.warnings));
  assert.equal(r.diagnostics.page_count, 2);
  const s42 = r.fragments.find((f) => f.section_number === "4.2");
  assert.ok(s42, JSON.stringify(r.fragments.map((f) => [f.section_heading, f.page_start, f.page_end])));
  assert.equal(s42.section_heading, "4.2 Replenishment Processing");
  assert.deepEqual(s42.section_path, ["4 Replenishment", "4.2 Replenishment Processing"], "the level-1 chapter replaces the level-1 document title");
  assert.equal(s42.page_start, 1);
  assert.equal(s42.page_end, 2, "section 4.2 continues onto page 2");
  assert.match(s42.text, /runs every 15 minutes for each plant and creates transfer requirements/, "wrapped lines are joined into one paragraph");
  assert.match(s42.text, /without failing\.$/);
  const s43 = r.fragments.find((f) => f.section_number === "4.3");
  assert.deepEqual([s43.page_start, s43.page_end], [2, 2]);
  assert.match(s43.text, /^An exception is raised/);
});

await run("fragments are ordered, contiguous and carry SHA-256 hashes of their exact text", async () => {
  const r = await extractSourceDocument(specPdf(), PDF_MIME);
  assert.deepEqual(r.fragments.map((f) => f.sequence), r.fragments.map((_, i) => i + 1));
  for (const f of r.fragments) {
    assert.equal(f.text_hash, sha256Hex(f.text));
    assert.equal(f.char_count, f.text.length);
  }
  assert.equal(r.extractor_version, EXTRACTOR_VERSION);
});

await run("extraction is deterministic: the same bytes give identical fragments and hashes", async () => {
  const a = await extractSourceDocument(specPdf(), PDF_MIME);
  const b = await extractSourceDocument(specPdf(), PDF_MIME);
  assert.deepEqual(a, b);
  const docx = await makeDocx([{ heading: 1, text: "Scope" }, { p: "Covers PL10." }]);
  assert.deepEqual(await extractSourceDocument(docx, DOCX_MIME), await extractSourceDocument(docx, DOCX_MIME));
});

await run("image-only / unreadable PDF is NOT reported as success (ocr_required)", async () => {
  const r = await extractSourceDocument(makePdf([{ imageOnly: true }, { imageOnly: true }]), PDF_MIME);
  assert.equal(r.outcome, "ocr_required");
  assert.equal(r.diagnostics.meaningful_text, false);
  assert.equal(r.diagnostics.empty_page_count, 2);
  assert.equal(r.fragments.length, 0);
});

await run("a PDF with some empty pages completes with warnings naming the pages", async () => {
  const pages = [{ lines: [{ text: "1 Introduction", size: 14, y: 720 }, ...Array.from({ length: 6 }, (_, i) => ({ text: `Line ${i} of the introduction describing the scope of the replenishment change in detail.`, size: 10, y: 690 - i * 13 }))] }, { imageOnly: true }];
  const r = await extractSourceDocument(makePdf(pages), PDF_MIME);
  assert.equal(r.outcome, "completed_with_warnings");
  assert.deepEqual(r.diagnostics.empty_pages, [2]);
  assert.match(r.diagnostics.warnings.join(" "), /1 of 2 pages had no extractable text \(page 2\)/);
});

await run("corrupt PDF and unsupported types fail with a categorised error", async () => {
  await assert.rejects(extractSourceDocument(new TextEncoder().encode("%PDF-1.4 garbage"), PDF_MIME), (e) => e instanceof ExtractionError && e.category === "parse_error");
  await assert.rejects(extractSourceDocument(new Uint8Array([1, 2, 3]), "image/png"), (e) => e instanceof ExtractionError && e.category === "unsupported_type");
  await assert.rejects(extractSourceDocument(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]), DOCX_MIME), (e) => e instanceof ExtractionError && e.category === "parse_error");
});

await run("DOCX: headings, paragraphs, list items and tables are preserved with structure", async () => {
  const docx = await makeDocx([
    { heading: 1, text: "4 Replenishment" },
    { heading: 2, text: "4.2 Replenishment Processing" },
    { p: "The job runs every 15 minutes." },
    { bullet: "Frozen before Chilled" },
    { bullet: "Skip unavailable pick faces" },
    { table: [["Temperature", "Priority"], ["Frozen", "1"], ["Chilled", "2"]] },
    { heading: 2, text: "4.3 Exceptions" },
    { p: "Unconfirmed transfer requirements raise an exception after 30 minutes." },
  ]);
  const r = await extractSourceDocument(docx, DOCX_MIME);
  const types = r.fragments.map((f) => [f.fragment_type, f.section_number]);
  assert.deepEqual(types, [["text", "4.2"], ["list", "4.2"], ["table", "4.2"], ["text", "4.3"]]);
  const table = r.fragments.find((f) => f.fragment_type === "table");
  assert.deepEqual(table.metadata.table.rows, [["Temperature", "Priority"], ["Frozen", "1"], ["Chilled", "2"]]);
  assert.equal(table.metadata.table.columns, 2);
  assert.equal(table.text, "Temperature | Priority\nFrozen | 1\nChilled | 2");
  assert.deepEqual(table.section_path, ["4 Replenishment", "4.2 Replenishment Processing"]);
  assert.equal(r.fragments.find((f) => f.fragment_type === "list").text, "• Frozen before Chilled\n\n• Skip unavailable pick faces");
  assert.equal(r.fragments[0].page_start, null, "DOCX has no fixed pages");
  assert.equal(r.diagnostics.table_count, 1);
  assert.equal(r.diagnostics.heading_count, 3);
});

await run("large tables are split by rows with the header repeated; long text is split under the cap", () => {
  const rows = [["Code", "Description"], ...Array.from({ length: 120 }, (_, i) => [`R${i}`, "x".repeat(60)])];
  const frags = buildFragments([{ type: "heading", level: 1, number: "5", text: "5 Codes", page: 3 }, { type: "table", rows, page: 3 }]);
  assert.ok(frags.length > 1);
  for (const f of frags) {
    assert.equal(f.fragment_type, "table");
    assert.deepEqual(f.metadata.table.rows[0], ["Code", "Description"]);
    assert.ok(f.char_count <= LIMITS.fragmentMaxChars + 200);
  }
  assert.equal(frags.reduce((n, f) => n + f.metadata.table.rows.length - 1, 0), 120, "every data row kept exactly once");
  const long = buildFragments([{ type: "paragraph", text: "Sentence number one is here. ".repeat(400), page: 1 }]);
  assert.ok(long.length > 1 && long.every((f) => f.char_count <= LIMITS.fragmentMaxChars));
});

await run("a fragment never spans two sections", async () => {
  const r = await extractSourceDocument(specPdf(), PDF_MIME);
  const sections = r.fragments.map((f) => f.section_number);
  assert.ok(!r.fragments.some((f) => /4\.3 Exceptions/.test(f.text) && f.section_number === "4.2"));
  assert.deepEqual([...new Set(sections)], sections.filter((s, i) => sections.indexOf(s) === i));
});

console.log("\nAll extraction tests passed.\n");
