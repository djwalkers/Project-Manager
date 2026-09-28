// Regression checks against real project documents, which are never
// committed. Point EXTRACT_REAL_DOCS_DIR at a folder holding the originals
// (matched by SHA-256, so file names do not matter); each check is skipped
// when its document is not there.
//
//   EXTRACT_REAL_DOCS_DIR=~/Downloads npm run test:real
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PDF_MIME, extractPdf, extractSourceDocument, sha256Hex } from "../extract.js";

const dir = process.env.EXTRACT_REAL_DOCS_DIR;
const byHash = new Map();
if (dir && fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf"))) {
    const bytes = fs.readFileSync(path.join(dir, name));
    byHash.set(sha256Hex(bytes), bytes);
  }
}

async function run(name, sha, fn) {
  const bytes = byHash.get(sha);
  if (!bytes) { console.log(`- ${name} (skipped: document not in EXTRACT_REAL_DOCS_DIR)`); return; }
  try { await fn(bytes); console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; }
}

// PL10 Addition to HANA.pdf — output must stay exactly as extractor 1.1.0 produced it.
await run("PL10 PDF: fragments identical to extractor 1.1.0", "6855df239d015fc1625777ebcb1f9bd80cf92f2f9a3e6de09a19be8bf24680d5", async (bytes) => {
  const r = await extractSourceDocument(bytes, PDF_MIME);
  assert.deepEqual(r.fragments.map((f) => [f.section_path.join(" > "), f.page_start, f.page_end, f.text_hash.slice(0, 16)]), [
    ["Global / Master Data", 1, 1, "84d6083b6d98d029"], ["Plant Behaviour Rules", 1, 1, "8d730b7936d22370"],
    ["User Maintenance App", 1, 1, "044515fdda075680"], ["Execution Apps (Mobile)", 1, 2, "882b7f52f95bc3d0"],
    ["Dashboard Apps", 2, 3, "2c55b6e88590ba92"], ["Dashboard Apps", 3, 3, "b303512310921331"],
  ]);
  assert.equal(r.diagnostics.layout, "flow");
  assert.equal(r.diagnostics.chrome_line_count, 0);
});

// SOMCR038 change request (issue-tracker PDF export).
await run("SOMCR038 PDF: structural fragments, chrome recorded, every word kept", "48d8789d39bbcb788aa4a236238392936823210ef21a96b9abca30810df9b9f6", async (bytes) => {
  const r = await extractSourceDocument(bytes, PDF_MIME);
  assert.equal(r.outcome, "completed");
  assert.equal(r.diagnostics.layout, "label_value");
  const headings = r.fragments.map((f) => f.section_heading);
  for (const h of ["DETAILED REQUIREMENTS", "BENEFIT VS IMPACT STATEMENT", "CHANGE DESCRIPTION * (describe requirement)", "*ESTIMATED GAINS ** (Productivity and/or Savings)"]) {
    assert.equal(headings.filter((x) => x === h).length, 1, h);
  }
  for (const empty of ["ESTIMATED WORDAYS", "ESTIMATED COSTS", "WORK REQUIRED", "OTHER SOLUTIONS, IF CONSIDERED", "RISKS / ISSUES / DEPENDENCIES / ASSUMPTIONS", "OUTCOME"]) {
    assert.ok(!headings.includes(empty), `${empty} is empty in this CR`);
  }
  const text = (h) => r.fragments.find((f) => f.section_heading === h).text;
  assert.match(text("DETAILED REQUIREMENTS"), /^On the Pick Admin Dashboard, .* MONO picks and FULL PALLET picks remain as they are\.$/);
  assert.match(text("CHANGE DESCRIPTION * (describe requirement)"), /^Currently, after a multi pick task has been palletised, .* for reporting\.$/);
  assert.deepEqual(r.fragments.filter((f) => f.section_heading === "DETAILED REQUIREMENTS").map((f) => f.page_start), [1]);
  assert.deepEqual(r.fragments.filter((f) => f.section_heading === "CHANGE DESCRIPTION * (describe requirement)").map((f) => f.page_start), [2]);
  assert.ok(r.fragments.some((f) => f.metadata.fields?.some((x) => x.label === "Status:" && x.value === "Open")));
  assert.ok(r.fragments.some((f) => f.text === "Priority: High" && f.page_start === 2));
  assert.deepEqual(r.diagnostics.chrome_lines.map((c) => [c.page, c.rule]), [
    [1, "repeated_header"], [1, "repeated_footer"], [2, "repeated_header"], [2, "repeated_footer"], [2, "generator_stamp"], [2, "generator_stamp"],
  ]);
  // Repeated wording across pages 1 and 2 is kept, not deduplicated.
  const all = r.fragments.map((f) => f.text).join("\n");
  assert.equal(all.match(/This detail would also need to be correct for any/g).length, 2);

  // Every word of the raw page text is in a block (heading, paragraph or
  // field) or in the recorded chrome — nothing is lost silently.
  const words = (t) => t.replace(/[():]/g, " ").split(/\s+/).filter(Boolean);
  const count = (list) => list.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const raw = [];
  for (let n = 1; n <= doc.numPages; n += 1) raw.push(...(await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str));
  await task.destroy();
  const extracted = await extractPdf(bytes);
  const kept = count(words([...extracted.blocks.map((b) => (b.type === "field" ? `${b.label} ${b.value}` : b.text)), ...extracted.chrome.map((c) => c.text)].join(" ")));
  const source = count(words(raw.join(" ")));
  const lost = [...source].filter(([w, c]) => (kept.get(w) ?? 0) < c);
  assert.deepEqual(lost, [], "every source word is kept");
  assert.ok([...source.values()].reduce((a, b) => a + b) > 400);
});

console.log("\nReal-document checks finished.\n");
