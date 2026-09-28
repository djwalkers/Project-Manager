// Builds small, real PDF and DOCX files for the extraction tests.
import JSZip from "jszip";

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * pages: [{ lines: [{ text, size, x?, y }] } | { imageOnly: true }]
 * Uses the standard Helvetica font, so no font embedding is needed.
 */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids = [];
  for (const page of pages) {
    const ops = page.imageOnly
      ? "0.2 0.2 0.2 rg 72 72 450 650 re f"
      : page.lines.map((l) => `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf ${l.x ?? 72} ${l.y} Td (${esc(l.text)}) Tj ET`).join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;

// A run with direct formatting (bold / half-point size), as Word writes it.
const run = (text, { bold = false, size = null } = {}) =>
  `<w:r>${bold || size ? `<w:rPr>${bold ? "<w:b/><w:bCs/>" : ""}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;

/**
 * blocks:
 *   { heading: 1..3, text }            formal Word heading style
 *   { visual: text, size?, outline? }  direct formatting only: bold (+ size in half-points), optional outlineLvl
 *   { bold: text }                     a bold, body-size standalone paragraph (like "Pick Execution")
 *   { p: text } | { runs: [{ text, bold?, size? }] }
 *   { bullet: text } | { numbered: text, boldLead?: text }
 *   { table: [[cell, …], …] }
 */
export async function makeDocx(blocks) {
  const body = blocks.map((b) => {
    if (b.heading) return para(b.text, `Heading${b.heading}`);
    if (b.visual) return `<w:p><w:pPr>${b.outline != null ? `<w:outlineLvl w:val="${b.outline}"/>` : ""}</w:pPr>${run(b.visual, { bold: true, size: b.size ?? null })}</w:p>`;
    if (b.bold) return `<w:p>${run(b.bold, { bold: true })}</w:p>`;
    if (b.runs) return `<w:p>${b.runs.map((r) => run(r.text, r)).join("")}</w:p>`;
    if (b.table) return `<w:tbl>${b.table.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${para(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
    if (b.bullet) return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${xmlEsc(b.bullet)}</w:t></w:r></w:p>`;
    if (b.numbered) return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${b.numId ?? 2}"/></w:numPr></w:pPr>${b.boldLead ? run(b.boldLead, { bold: true }) : ""}${run(b.numbered)}</w:p>`;
    return para(b.p);
  }).join("");
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>${[1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`);
  zip.file("word/numbering.xml", `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

/** A realistic two-page specification PDF with numbered sections spanning pages. */
export function specPdf() {
  const body = (y, text) => ({ text, size: 10, y });
  return makePdf([
    { lines: [
      { text: "Replenishment Functional Specification", size: 18, y: 740 },
      { text: "4 Replenishment", size: 14, y: 700 },
      { text: "4.2 Replenishment Processing", size: 12, y: 670 },
      body(645, "The replenishment job runs every 15 minutes for each plant and"),
      body(632, "creates transfer requirements for pick faces below their minimum."),
      body(605, "Frozen pick faces are processed before Chilled pick faces so that the"),
      body(592, "most time-critical stock is replenished first on every run."),
    ] },
    { lines: [
      body(740, "When stock is unavailable the pick face is flagged for the supervisor"),
      body(727, "and the job continues with the next pick face without failing."),
      { text: "4.3 Exceptions", size: 12, y: 690 },
      body(665, "An exception is raised when a transfer requirement cannot be confirmed"),
      body(652, "within 30 minutes of creation, and it is shown on the dashboard."),
    ] },
  ]);
}

/**
 * The same short CR as specPdf-style content, written the way the real
 * PL10 DOCX was: no heading styles; title/sections bold + larger with an
 * outline level; subsections bold at body size; requirements as numbered
 * items (some with a bold lead-in); plus a table.
 */
export const CR_CONTENT = {
  title: "Requirements (consolidated)",
  sections: [
    { heading: "Global / Master Data", items: ["Add temperature to the user/plant table.", "The temperature value maintained in the user/plant table shall act as the default temperature in all apps."] },
    { heading: "Plant Behaviour Rules", items: ["the plant field shall be selectable and the user shall be able to choose any plant.", "the plant shall remain a strict one-to-one relationship between the user and the plant."] },
    { heading: "Execution Apps (Mobile)", subsections: [
      { heading: "Pick Execution", items: ["Add a plant filter, fixed to the value maintained in the plant/user table."] },
      { heading: "Marshalling Execution", items: ["Add a plant filter, fixed to the value maintained in the plant/user table.", "Sort suggested moves by temperature: frozen first, then chilled."] },
    ] },
    { heading: "Temperature Priorities", table: [["Temperature", "Priority"], ["Frozen", "1"], ["Chilled", "2"]] },
  ],
};

export async function crDocx() {
  const blocks = [{ visual: CR_CONTENT.title, size: 48, outline: 0 }];
  for (const s of CR_CONTENT.sections) {
    blocks.push({ visual: s.heading, size: 36, outline: 1 });
    for (const [i, item] of (s.items ?? []).entries()) blocks.push(i === 0 && s.heading === "Plant Behaviour Rules" ? { numbered: ` ${item}`, boldLead: "Dashboard apps:" } : { numbered: item });
    for (const sub of s.subsections ?? []) {
      blocks.push({ bold: sub.heading });
      for (const item of sub.items) blocks.push({ numbered: item });
    }
    if (s.table) blocks.push({ table: s.table });
  }
  return makeDocx(blocks);
}

export function crPdf() {
  const lines = [];
  let y = 750;
  // Headings get space above them, as in any real document.
  const add = (text, size, gap = 1.5) => { if (size > 10) y -= size; lines.push({ text, size, y }); y -= size * gap; };
  add(CR_CONTENT.title, 20, 2);
  CR_CONTENT.sections.forEach((s, i) => {
    add(`${i + 1} ${s.heading}`, 14, 2);
    for (const item of s.items ?? []) add(`${i === 1 && item === s.items[0] ? "Dashboard apps: " : ""}${item}`, 10, 2);
    (s.subsections ?? []).forEach((sub, j) => {
      add(`${i + 1}.${j + 1} ${sub.heading}`, 12, 2);
      for (const item of sub.items) add(item, 10, 2);
    });
    for (const row of s.table ?? []) add(row.join("  "), 10, 2);
  });
  return makePdf([{ lines }]);
}

/**
 * An issue-tracker "printable view" export, laid out like a real one: a
 * repeated printed header and URL footer with a page counter, a title in a
 * larger size, a left column of bold field labels with regular values (plus
 * a second label/value column), an evaluation field whose value holds bold
 * upper-case section labels — some left empty, as templates are — and on
 * page 2 a label/value table with a wrapped label beside a vertically
 * centred multi-line value, ending with a "Generated at …" export stamp.
 * Generic names only: nothing here is a real issue.
 */
export const TRACKER_TEXT = {
  requirements: [
    "On the order dashboard, the picker name must remain against the",
    "multi-order pick task and must not change on palletising.",
    "The same name must be shown in every reporting extract.",
  ],
  benefit: "It gives the warehouse real time traceability of pick tasks.",
  change: [
    "Currently the name against a pick task changes to the next user",
    "who handles the task once it is palletised on the order dashboard.",
    "We require the picker name to remain against the pick task on the",
    "dashboard after palletising, and the palletiser to be recorded",
    "against the new pallet task that palletising creates.",
  ],
  gains: [
    "Supervisors will see who picked each task in real time, giving",
    "better traceability for accuracy and performance on every shift.",
  ],
};

export function trackerPdf() {
  const b = (text, x, y, size = 8) => ({ text, size, x, y, bold: true });
  const r = (text, x, y, size = 8) => ({ text, size, x, y });
  const chrome = (n) => [
    r("9/28/26, 10:15 AM", 24, 770), r("[#ABC-77] ABCCR01 - Pick tasks keep the picker name", 114, 770),
    r("https://tracker.example.com/browse/ABC-77", 24, 16), r(`${n}/2`, 577, 16),
  ];
  const t = TRACKER_TEXT;
  return makePdf([
    { lines: [
      ...chrome(1),
      r("[ABC-77] ABCCR01 - Pick tasks keep the picker name after palletising", 30, 720, 11),
      b("Status:", 30, 700), r("Open", 141, 700),
      b("Project:", 30, 686), r("ALPHA", 141, 686),
      b("Type:", 30, 672), r("Change Request", 141, 672), b("Priority:", 308, 672), r("Medium", 419, 672),
      b("Reporter:", 30, 658), r("Jo Bloggs", 141, 658), b("Assignee:", 308, 658), r("Sam Doe", 419, 658),
      b("Resolution:", 30, 644), r("Unresolved", 141, 644), b("Votes:", 308, 644), r("0", 419, 644),
      b("Labels:", 30, 630), r("None", 141, 630),
      b("Change Request", 30, 600), b("Evaluation:", 30, 588),
      b("ESTIMATED WORKDAYS", 144, 596),
      b("DETAILED REQUIREMENTS", 144, 566),
      r(t.requirements[0], 144, 552), r(t.requirements[1], 144, 540), r(t.requirements[2], 144, 528),
      b("WORK REQUIRED", 144, 500),
      b("BENEFIT VS IMPACT STATEMENT", 144, 472), r(t.benefit, 144, 458),
      b("RISKS / ISSUES / DEPENDENCIES", 144, 430),
      b("Sprint:", 30, 90),
    ] },
    { lines: [
      ...chrome(2),
      b("Description", 32, 742),
      b("Phase//Drop", 34, 722), r("Phase 2", 205, 722),
      b("WHO RAISED IT", 34, 706), r("A. Tester", 205, 706),
      ...t.change.map((line, i) => r(line, 205, 670 - i * 12)),
      b("CHANGE DESCRIPTION * (describe", 34, 652), b("requirement)", 34, 640),
      r("*ESTIMATED GAINS **", 34, 600), r(t.gains[0], 205, 600),
      b("(Productivity and/or Savings)", 34, 588), r(t.gains[1], 205, 588),
      b("Priority", 34, 570), r("High", 205, 570),
      r("Generated at Mon Sep 28 10:15:00 UTC 2026 by A. Tester using Tracker 9.1.", 28, 540),
      r("rev:0123abcd4567ef.", 28, 528),
    ] },
  ]);
}
