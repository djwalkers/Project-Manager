// Deterministic extraction tests (Phase 1B) — real PDF/DOCX bytes built by
// tests/fixtures.mjs, parsed by the real libraries. No network, no AI.
import assert from "node:assert/strict";
import { EXTRACTOR_VERSION, ExtractionError, LIMITS, PDF_MIME, DOCX_MIME, buildFragments, extractSourceDocument, isSectionLabel, sha256Hex } from "../extract.js";
import { CR_CONTENT, TRACKER_TEXT, crDocx, crPdf, makeDocx, makePdf, specPdf, trackerPdf } from "./fixtures.mjs";

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
  assert.deepEqual(types, [["text", "4.2"], ["table", "4.2"], ["text", "4.3"]], "a section's paragraph and list items share one fragment");
  const table = r.fragments.find((f) => f.fragment_type === "table");
  assert.deepEqual(table.metadata.table.rows, [["Temperature", "Priority"], ["Frozen", "1"], ["Chilled", "2"]]);
  assert.equal(table.metadata.table.columns, 2);
  assert.equal(table.text, "Temperature | Priority\nFrozen | 1\nChilled | 2");
  assert.deepEqual(table.section_path, ["4 Replenishment", "4.2 Replenishment Processing"]);
  assert.equal(r.fragments[0].text, "The job runs every 15 minutes.\n\n• Frozen before Chilled\n• Skip unavailable pick faces");
  assert.deepEqual(r.diagnostics.heading_sources, { style: 3, outline: 0, formatting: 0 });
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

// ── DOCX with visually formatted headings (the real PL10 CR shape) ─────────

await run("DOCX without heading styles: outline-level and bold section headings become sections", async () => {
  const r = await extractSourceDocument(await crDocx(), DOCX_MIME);
  assert.equal(r.outcome, "completed", JSON.stringify(r.diagnostics.warnings));
  const paths = r.fragments.map((f) => f.section_path.join(" › "));
  assert.deepEqual(paths, [
    "Requirements (consolidated) › Global / Master Data",
    "Requirements (consolidated) › Plant Behaviour Rules",
    "Requirements (consolidated) › Execution Apps (Mobile) › Pick Execution",
    "Requirements (consolidated) › Execution Apps (Mobile) › Marshalling Execution",
    "Requirements (consolidated) › Temperature Priorities",
  ]);
  assert.deepEqual(r.diagnostics.heading_sources, { style: 0, outline: 5, formatting: 2 }, "subsections come from the formatting fallback");
  assert.equal(r.fragments.find((f) => f.section_heading === "Temperature Priorities").fragment_type, "table");
  assert.match(r.fragments[1].text, /^\d+\. Dashboard apps: the plant field shall be selectable/, "a bold lead-in inside a list item is not a heading");
  assert.ok(r.fragments.length <= 6, `section-aware chunking, not one fragment per paragraph (${r.fragments.length})`);
});

await run("list numbers follow Word's lists: a shared list keeps counting, a new list restarts", async () => {
  const shared = await extractSourceDocument(await crDocx(), DOCX_MIME);
  assert.match(shared.fragments[0].text, /^1\. Add temperature[\s\S]*\n2\. The temperature value/);
  assert.match(shared.fragments[1].text, /^3\. Dashboard apps/, "same Word list (numId) continues across the heading");
  const separate = await extractSourceDocument(await makeDocx([
    { bold: "First Area" }, { numbered: "Alpha requirement text is here.", numId: 3 }, { numbered: "Beta requirement text is here.", numId: 3 },
    { bold: "Second Area" }, { numbered: "Gamma requirement text is here and is long enough to count.", numId: 4 },
    { p: "Closing paragraph with enough words to make the document meaningful for the extractor tests here." },
  ]), DOCX_MIME);
  assert.match(separate.fragments[1].text, /^1\. Gamma/, "a new Word list restarts at 1");
});

await run("formatting fallback is conservative: sentences, lead-ins, inline emphasis and long bold lines stay text", async () => {
  const body = "This paragraph is ordinary body text that describes the change in enough detail to be meaningful.";
  const r = await extractSourceDocument(await makeDocx([
    { bold: "Real Section" },
    { p: body },
    { bold: "Note that this is an emphasised sentence." },
    { bold: "Important:" },
    { runs: [{ text: "Key point", bold: true }, { text: " followed by normal text in the same paragraph" }] },
    { p: "Short plain line" },
    { bold: "this starts lower-case" },
    { bold: "A bold line that is far too long to be a plausible section heading in a specification document" },
    { numbered: "Numbered item that is bold should never be a heading", boldLead: "Bold" },
    { p: body },
    { bold: "Dangling Bold Line At End" },
  ]), DOCX_MIME);
  assert.equal(r.diagnostics.heading_count, 1, JSON.stringify(r.fragments.map((f) => f.section_heading)));
  assert.equal(r.fragments[0].section_heading, "Real Section");
  const text = r.fragments.map((f) => f.text).join("\n");
  for (const kept of ["Note that this is an emphasised sentence.", "Important:", "Key point followed by normal text", "Short plain line", "this starts lower-case", "far too long", "Dangling Bold Line At End"]) {
    assert.ok(text.includes(kept), `kept as text: ${kept}`);
  }
});

await run("a larger, non-bold standalone line is a heading; body-size plain text is not", async () => {
  const r = await extractSourceDocument(await makeDocx([
    { runs: [{ text: "Scope Of Change", size: 32 }] },
    { p: "The change covers the PL10 plant and the associated mobile and dashboard applications in scope." },
    { runs: [{ text: "Not A Heading", size: 24 }] },
    { p: "More body text follows here so that the document has plenty of meaningful extractable characters." },
  ]), DOCX_MIME);
  assert.deepEqual(r.fragments.map((f) => f.section_heading), ["Scope Of Change"]);
  assert.match(r.fragments[0].text, /Not A Heading/);
});

await run("formal Word heading styles still take precedence over the fallback", async () => {
  const r = await extractSourceDocument(await makeDocx([
    { heading: 1, text: "5 Interfaces" }, { bold: "Inbound" }, { p: "Inbound files arrive nightly from the host system and are validated before loading." },
  ]), DOCX_MIME);
  assert.deepEqual(r.fragments[0].section_path, ["5 Interfaces", "Inbound"]);
  assert.deepEqual(r.diagnostics.heading_sources, { style: 1, outline: 0, formatting: 1 });
});

// ── Cross-format quality ────────────────────────────────────────────────────

const norm = (s) => s.toLowerCase().replace(/^\d+(\.\d+)*\.?\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

await run("equivalent PDF and DOCX preserve the same sections, order, requirement text and table content", async () => {
  const pdf = await extractSourceDocument(crPdf(), PDF_MIME);
  const docx = await extractSourceDocument(await crDocx(), DOCX_MIME);
  const headings = (r) => [...new Set(r.fragments.flatMap((f) => f.section_path.map(norm)))];
  // Same sections in the same order. Path depth may differ: Word's outline
  // levels nest the sections under the document title, while in the PDF a
  // numbered chapter replaces an equally ranked title — so the title is the
  // only heading allowed to appear in just one format.
  const title = norm(CR_CONTENT.title);
  assert.deepEqual(headings(pdf).filter((h) => h !== title), headings(docx).filter((h) => h !== title), "same headings in the same order");
  assert.ok(headings(pdf).length >= 6);
  const sectionOf = (r, needle) => r.fragments.find((f) => norm(f.text).includes(norm(needle)))?.section_heading;
  const items = CR_CONTENT.sections.flatMap((s) => [...(s.items ?? []), ...(s.subsections ?? []).flatMap((x) => x.items)]);
  for (const item of items) {
    const a = sectionOf(pdf, item), b = sectionOf(docx, item);
    assert.ok(a && b, `requirement found in both: ${item}`);
    assert.equal(norm(a), norm(b), `same section for: ${item}`);
  }
  for (const cell of CR_CONTENT.sections.find((s) => s.table).table.flat()) {
    assert.ok(pdf.fragments.some((f) => f.text.includes(cell)) && docx.fragments.some((f) => f.text.includes(cell)), `table cell in both: ${cell}`);
  }
  assert.equal(docx.fragments.find((f) => f.fragment_type === "table")?.metadata.table.rows.length, 3, "DOCX keeps the table structure");
  assert.equal(docx.fragments.every((f) => f.page_start === null), true, "DOCX has no page provenance");
});

await run("PDF extraction is unchanged by the DOCX work", async () => {
  const r = await extractSourceDocument(specPdf(), PDF_MIME);
  assert.deepEqual(r.fragments.map((f) => [f.section_number, f.page_start, f.page_end, f.fragment_type]), [["4.2", 1, 2, "text"], ["4.3", 2, 2, "text"]]);
  assert.equal(r.diagnostics.heading_sources, null);
});


// ── 1.2.0: form-like PDF exports (label/value columns, bold labels, chrome) ──

const tracker = await extractSourceDocument(trackerPdf(), PDF_MIME);
const bySection = (r, heading) => r.fragments.filter((f) => f.section_heading === heading);

await run("PDF layout: bold upper-case section labels become sections under their field; empty template sections produce no fragments", async () => {
  assert.equal(tracker.outcome, "completed", JSON.stringify(tracker.diagnostics.warnings));
  assert.equal(tracker.diagnostics.layout, "label_value");
  const req = bySection(tracker, "DETAILED REQUIREMENTS");
  assert.equal(req.length, 1);
  assert.deepEqual(req[0].section_path.slice(1), ["Change Request Evaluation", "DETAILED REQUIREMENTS"], "the label sits inside the value of the wrapped \"Change Request Evaluation:\" field");
  assert.equal(req[0].text, TRACKER_TEXT.requirements.join(" "));
  assert.equal(req[0].page_start, 1);
  assert.equal(bySection(tracker, "BENEFIT VS IMPACT STATEMENT")[0].text, TRACKER_TEXT.benefit);
  for (const empty of ["ESTIMATED WORKDAYS", "WORK REQUIRED", "RISKS / ISSUES / DEPENDENCIES"]) {
    assert.equal(bySection(tracker, empty).length, 0, `${empty} is an empty template section`);
    assert.ok(!tracker.fragments.some((f) => f.text.includes(empty)), `${empty} does not leak into another fragment as text`);
  }
  assert.equal(tracker.diagnostics.empty_section_count, 2, "ESTIMATED WORKDAYS and WORK REQUIRED (RISKS is followed by a field, not a heading)");
});

await run("PDF layout: label/value rows become field lines (second column kept beside its row) under the enclosing section", async () => {
  const meta = tracker.fragments[0];
  assert.equal(meta.section_path.length, 1, "document title only — field rows do not invent a hierarchy");
  assert.match(meta.section_heading, /^\[ABC-77\] ABCCR01 - Pick tasks keep/);
  assert.equal(meta.text, ["Status: Open", "Project: ALPHA", "Type: Change Request", "Priority: Medium", "Reporter: Jo Bloggs", "Assignee: Sam Doe", "Resolution: Unresolved", "Votes: 0", "Labels: None"].join("\n"));
  assert.deepEqual(meta.metadata.fields.slice(0, 4).map((f) => [f.label, f.value]), [["Status:", "Open"], ["Project:", "ALPHA"], ["Type:", "Change Request"], ["Priority:", "Medium"]]);
  const sprint = tracker.fragments.find((f) => f.text === "Sprint:");
  assert.ok(sprint, "a field after the evaluation returns to the title section");
  assert.deepEqual(sprint.section_path, meta.section_path);
});

await run("PDF layout: a wrapped label beside a vertically centred multi-line value keeps the whole value, on page 2", async () => {
  const change = bySection(tracker, "CHANGE DESCRIPTION * (describe requirement)");
  assert.equal(change.length, 1);
  assert.equal(change[0].text, TRACKER_TEXT.change.join(" "), "no label words interleaved into the value");
  assert.deepEqual(change[0].section_path.slice(1), ["Description", "CHANGE DESCRIPTION * (describe requirement)"]);
  assert.deepEqual([change[0].page_start, change[0].page_end], [2, 2]);
  const gains = bySection(tracker, "*ESTIMATED GAINS ** (Productivity and/or Savings)");
  assert.equal(gains[0]?.text, TRACKER_TEXT.gains.join(" "), "a regular-weight label in the label column still labels its value");
  const page2 = tracker.fragments.filter((f) => f.page_start === 2).map((f) => f.text);
  assert.equal(page2[0], "Phase//Drop: Phase 2\nWHO RAISED IT: A. Tester");
  assert.equal(page2[page2.length - 1], "Priority: High");
});

await run("PDF chrome: repeated printed headers, URL footers with page counters and a trailing export stamp are set aside and recorded", async () => {
  const d = tracker.diagnostics;
  assert.equal(d.chrome_line_count, 6);
  assert.deepEqual(d.chrome_lines.map((c) => [c.page, c.position, c.rule]), [
    [1, "header", "repeated_header"], [1, "footer", "repeated_footer"],
    [2, "header", "repeated_header"], [2, "footer", "repeated_footer"],
    [2, "end", "generator_stamp"], [2, "end", "generator_stamp"],
  ]);
  assert.equal(d.chrome_lines[1].text, "https://tracker.example.com/browse/ABC-77 1/2", "the removed text is kept in the diagnostics");
  const all = tracker.fragments.map((f) => f.text).join("\n");
  for (const gone of ["tracker.example.com", "10:15 AM", "Generated at", "rev:"]) assert.ok(!all.includes(gone), gone);
});

await run("PDF chrome: nothing is removed from a single page, from mid-page repeats, or from a stamp followed by content", async () => {
  const header = (y) => ({ text: "Confidential - internal use", size: 9, y });
  const para = (y, text) => ({ text, size: 11, y });
  const single = await extractSourceDocument(makePdf([{ lines: [header(770), para(700, "Only one page, so the top line cannot be shown to repeat on every page."), para(686, "It therefore stays as content for the reader to judge.")] }]), PDF_MIME);
  assert.equal(single.diagnostics.chrome_line_count, 0);
  assert.match(single.fragments[0].text, /^Confidential - internal use/);
  const mid = await extractSourceDocument(makePdf([
    { lines: [para(700, "Repeated wording in the body of every page is document content."), para(430, "Generated at 10:00 by the nightly job using the planner, then reviewed."), para(400, "Check the stock level.")] },
    { lines: [para(700, "Page two carries the same instruction again in its body text."), para(400, "Check the stock level.")] },
  ]), PDF_MIME);
  assert.equal(mid.diagnostics.chrome_line_count, 0);
  const text = mid.fragments.map((f) => f.text).join("\n");
  assert.equal(text.match(/Check the stock level\./g).length, 2, "repeated wording is never deduplicated");
  assert.ok(text.includes("Generated at 10:00"), "a stamp-like line that is not last on its page is content");
});

await run("PDF layout: a normal PDF with inline bold and bold sentences is not misclassified", async () => {
  const r = await extractSourceDocument(makePdf([{ lines: [
    { text: "Note:", size: 11, x: 72, y: 700, bold: true }, { text: "the plant filter applies to all mobile apps from the next release.", size: 11, x: 102, y: 700 },
    { text: "Operators keep their existing default plant and temperature.", size: 11, y: 686 },
    { text: "This whole sentence is set in bold for emphasis.", size: 11, y: 660, bold: true },
    { text: "more detail follows in plain text for the supervisors.", size: 11, y: 646 },
    { text: "important for all users", size: 11, y: 620, bold: true },
    { text: "Supervisors review the change before it goes live in the warehouse.", size: 11, y: 606 },
  ] }]), PDF_MIME);
  assert.equal(r.diagnostics.layout, "flow");
  assert.equal(r.diagnostics.heading_count, 0);
  assert.equal(r.diagnostics.field_count, 0);
  assert.ok(r.diagnostics.warnings.some((w) => /No headings/.test(w)));
  assert.equal(isSectionLabel("This whole sentence is set in bold for emphasis."), false);
  assert.equal(isSectionLabel("important for all users"), false);
  assert.equal(isSectionLabel("1. Add a plant filter"), false);
  assert.equal(isSectionLabel("RISKS / ISSUES / DEPENDENCIES / ASSUMPTIONS"), true);
  assert.equal(isSectionLabel("Proposed Change"), true);
});

await run("PDF layout: bold Title Case labels without a field column give sections when there are no other headings", async () => {
  const r = await extractSourceDocument(makePdf([{ lines: [
    { text: "Background", size: 11, y: 720, bold: true },
    { text: "The current dashboard shows the last user to touch a pick task.", size: 11, y: 700 },
    { text: "Proposed Change", size: 11, y: 670, bold: true },
    { text: "Keep the picker name against the task after it is palletised.", size: 11, y: 650 },
    { text: "Show the palletiser against the new pallet task that is created.", size: 11, y: 636 },
  ] }]), PDF_MIME);
  assert.equal(r.diagnostics.layout, "label_value");
  assert.deepEqual(r.fragments.map((f) => [f.section_heading, f.text.slice(0, 20)]), [["Background", "The current dashboar"], ["Proposed Change", "Keep the picker name"]]);
  assert.deepEqual(r.diagnostics.heading_sources, { size: 0, bold: 2, field_label: 0 });
});

await run("PDF: numbered specification headings still use the flow pass, with a repeated footer removed", async () => {
  const footer = (n) => ({ text: `Replenishment specification v1.0 - page ${n} of 2`, size: 8, y: 30 });
  const body = (y, text) => ({ text, size: 11, y });
  const r = await extractSourceDocument(makePdf([
    { lines: [{ text: "4.2 Replenishment Processing", size: 12, y: 700, bold: true }, body(675, "The job runs every 15 minutes for each plant and each temperature."), body(662, "It creates transfer requirements for pick faces below minimum."), footer(1)] },
    { lines: [body(740, "Frozen pick faces are processed first on every run of the job."), { text: "4.3 Exceptions", size: 12, y: 700, bold: true }, body(675, "Unconfirmed transfers raise an exception after 30 minutes."), footer(2)] },
  ]), PDF_MIME);
  assert.equal(r.diagnostics.layout, "flow");
  assert.deepEqual(r.fragments.map((f) => [f.section_number, f.page_start, f.page_end]), [["4.2", 1, 2], ["4.3", 2, 2]]);
  assert.equal(r.diagnostics.chrome_line_count, 2);
  assert.ok(!r.fragments.some((f) => f.text.includes("page 1 of 2")));
});

await run("PDF: 1.1.0 output of the spec and PL10-style CR fixtures is unchanged (golden hashes)", async () => {
  const key = (r) => r.fragments.map((f) => [f.section_path.join(" > "), f.page_start, f.page_end, f.text_hash.slice(0, 12)]);
  assert.deepEqual(key(await extractSourceDocument(specPdf(), PDF_MIME)), [
    ["4 Replenishment > 4.2 Replenishment Processing", 1, 2, "93e06530e654"], ["4 Replenishment > 4.3 Exceptions", 2, 2, "e2401b18fb61"],
  ]);
  assert.deepEqual(key(await extractSourceDocument(crPdf(), PDF_MIME)), [
    ["1 Global / Master Data", 1, 1, "2808186101a1"], ["2 Plant Behaviour Rules", 1, 1, "2b1bb065de64"],
    ["3 Execution Apps (Mobile) > 3.1 Pick Execution", 1, 1, "004f2770d890"], ["3 Execution Apps (Mobile) > 3.2 Marshalling Execution", 1, 1, "66fdeaea7514"],
    ["4 Temperature Priorities", 1, 1, "48907ae1779e"],
  ]);
});

await run("PDF layout: extraction is deterministic", async () => {
  const again = await extractSourceDocument(trackerPdf(), PDF_MIME);
  assert.deepEqual(again, tracker);
});

console.log("\nAll extraction tests passed.\n");
