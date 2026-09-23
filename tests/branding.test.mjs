// Test Manager rebrand: canonical brand module, browser metadata and icon
// assets, email/report branding, and a repository scan proving no
// user-facing "Project Manager" / "Control Centre" product branding remains.
// (fixture loader copied from test-status-email.test.mjs)
// Manual "Email Test Status" report (buildTestStatusEmail, lib/email-content.ts).
//
// Business rule: this is a MANUAL, project-scoped report. It must reuse the
// canonical Requirement -> AC -> Test verification calculation
// (lib/lifecycle/test-verification.ts) rather than re-deriving it, and must
// use ONLY the explicitly-passed project's own data (scopeProjectData) —
// never selectActiveProject(), never inferred by name.
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const target = path.join(root, request.slice(2));
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts"), target]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

Module._extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};

const req = Module.createRequire(import.meta.url);
const { buildTestStatusEmail, buildAutomatedDailyBrief, buildAutomatedWeeklySummary, buildManagerSummaryEmail, buildTestEmail } = req("../lib/email-content.ts");
const { buildDailyBrief } = req("../lib/daily-brief.ts");
const { BRAND, brandLockupPrintHtml } = req("../lib/brand.ts");
const { seedData } = req("../lib/seed-data.ts");


function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function project(id, overrides = {}) {
  return { ...seedData.projects[0], id, project_ref: id.toUpperCase(), owner: null, status: "In Progress", ...overrides };
}



function testCase(projectId, ref, status, overrides = {}) {
  const id = overrides.id ?? uid("test");
  return {
    id, project_id: projectId, test_ref: ref, scenario: `Scenario for ${ref}`,
    expected_result: null, actual_result: null, status, owner: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides, id,
  };
}


function baseDataStore() {
  return {
    ...structuredClone(seedData),
    projects: [], requirements: [], acceptance_criteria: [], test_cases: [], artefact_links: [],
    deliverables: [], risks: [], decisions: [], actions: [], dependencies: [], discovery_questions: [],
    milestones: [], timeline_items: [], meetings: [], documents: [], activity_log: [],
    project_snapshots: [], evidence: [], requirement_sign_offs: [],
    meeting_intelligence: [], meeting_suggestions: [], go_live_checklists: [], cutover_plan: [],
    go_live_readiness_overrides: [],
  };
}


function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }
function pngSize(rel) {
  const b = fs.readFileSync(path.join(root, rel));
  assert.equal(b.subarray(1, 4).toString(), "PNG", `${rel} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20), b[25]];
}

run("brand module: canonical Test Manager name, pack palette, logo path", () => {
  assert.equal(BRAND.productName, "Test Manager");
  assert.equal(BRAND.productShortName, "Test Manager");
  assert.deepEqual(BRAND.colors, { blue: "#2563EB", cyan: "#0EA5FF", navy: "#0F172A" });
  assert.equal(BRAND.logo.mark, "/brand/test-manager-mark-192.png");
  assert.doesNotMatch(BRAND.productDescription, /control centre|project manager/i);
});

run("metadata: title default/template and applicationName come from BRAND; pages set bare section titles", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /title: \{ default: BRAND\.productName, template: `%s \| \$\{BRAND\.productName\}` \}/);
  assert.match(layout, /applicationName: BRAND\.productName/);
  assert.match(layout, /description: BRAND\.productDescription/);
  for (const [page, title] of [["app/go-live-readiness/page.tsx", "Go-Live Readiness"], ["app/executive-timeline/page.tsx", "Executive Timeline"], ["app/local-ai-assistant/page.tsx", "Local AI Assistant"]]) {
    assert.match(read(page), new RegExp(`title: "${title}",`), `${page} uses the template, not a hard-coded suffix`);
  }
});

run("icon assets: favicon.ico (multi-size), 32px icon.png, 180px apple-icon, transparent 192px mark", () => {
  const ico = fs.readFileSync(path.join(root, "app/favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1, "ICO type");
  assert.ok(ico.readUInt16LE(4) >= 2, "multi-size ICO");
  assert.deepEqual(pngSize("app/icon.png").slice(0, 2), [32, 32]);
  assert.deepEqual(pngSize("app/apple-icon.png").slice(0, 2), [180, 180]);
  const [w, h, colourType] = pngSize("public/brand/test-manager-mark-192.png");
  assert.deepEqual([w, h], [192, 192]);
  assert.equal(colourType, 6, "RGBA mark");
  assert.ok(!fs.existsSync(path.join(root, "app/icon.svg")), "no stray recreated SVG icon");
});

run("app shell and login use the brand logo, not the old Boxes placeholder or product text", () => {
  const sidebar = read("components/sidebar.tsx");
  assert.match(sidebar, /<BrandLogo size=\{32\}/);
  assert.doesNotMatch(sidebar, /Boxes|Project Manager|Control Centre/);
  const login = read("app/login/page.tsx");
  assert.match(login, /BRAND\.logo\.mark/);
  assert.match(login, /\{BRAND\.productName\}/);
  assert.doesNotMatch(login, /Boxes|Project Manager|Control Centre/);
  assert.match(read("components/brand-logo.tsx"), /BRAND\.productName/);
});

const now2 = new Date("2026-09-22T12:00:00Z");
function smallData() {
  const p = project("brand", { name: "Brand Project", project_ref: "BR1" });
  const data = baseDataStore();
  data.projects = [p];
  data.test_cases = [testCase(p.id, "TST-1", "Passed"), testCase(p.id, "TST-2", "Pending")];
  return { p, data };
}

run("Test Status email: restrained branding — project first, name-only footer, no images", () => {
  const { p, data } = smallData();
  const c = buildTestStatusEmail(data, p, now2);
  assert.ok(c.html.indexOf("Brand Project") < c.html.indexOf("Test Manager"), "the project leads; brand appears after");
  assert.match(c.html, /<strong style="color:#64748b">Test Manager<\/strong> · Test Status Report · Generated/);
  assert.match(c.text, /Test Manager · Test Status Report · Generated/);
  assert.doesNotMatch(c.html, /<img/, "no logo image in email (clients block data: images)");
  assert.equal((c.html.match(/Test Manager/g) ?? []).length, 1, "brand name appears once, in the footer");
  assert.match(c.subject, /^\[BR1\] Test Status - /, "subject still leads with the project");
});

run("Print / PDF: subtle logo lockup in the header plus footer name; structure unchanged", () => {
  const { p, data } = smallData();
  const c = buildTestStatusEmail(data, p, now2, { variant: "print" });
  assert.ok(c.html.includes(brandLockupPrintHtml(16)), "header lockup present");
  assert.match(c.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="16" height="16"/);
  assert.match(c.html, /Test Manager<\/strong> · Test Status Report · Generated/);
  const titles = [...c.html.matchAll(/<h2 class="rh"[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ["Executive Test Summary", "Requirement Verification Summary", "Exceptions &amp; Attention", "Full Test Status", "Appendix — Detailed Test Procedures"]);
});

run("other emails carry Test Manager product branding", () => {
  const { data } = smallData();
  const daily = buildAutomatedDailyBrief(data, now2);
  const weekly = buildAutomatedWeeklySummary(data, now2);
  const manager = buildManagerSummaryEmail(data, now2);
  const test = buildTestEmail(now2);
  const brief = buildDailyBrief(data, now2);
  assert.match(daily.subject, /^\[Test Manager\] Daily Brief/);
  assert.match(weekly.subject, /^\[Test Manager\] Weekly Executive Summary/);
  assert.match(test.subject, /^\[Test Manager\] Test Email/);
  assert.match(test.html + test.text, /Test Manager email delivery is working/);
  for (const [name, c] of [["daily", daily], ["weekly", weekly], ["manager", manager], ["test", test], ["brief", { html: brief.html, text: brief.plainText }]]) {
    assert.match(c.html, /Test Manager/, `${name} html`);
    assert.doesNotMatch(c.html + (c.text ?? ""), /Project Manager|Control Centre/, `${name} has no old branding`);
  }
  assert.match(daily.html, /Prepared by Test Manager/);
  assert.match(manager.html, /Prepared by Test Manager — exceptions only/);
  assert.match(brief.plainText, /Prepared by Test Manager$/);
});

run("default email sender display name is Test Manager", () => {
  assert.match(read("lib/email-delivery.ts"), /process\.env\.RESEND_FROM_EMAIL \|\| `\$\{BRAND\.productName\} <onboarding@resend\.dev>`/);
});

run("repository scan: no user-facing 'Project Manager' / 'Control Centre' product branding remains", () => {
  const scanRoots = ["app", "components", "lib", "contexts", "docs", "local-gateway"];
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); }
    else if (/\.(tsx?|mjs|js|json|md|css|html)$/.test(e.name)) files.push(rel);
  } };
  scanRoots.forEach(walk);
  files.push("README.md", ".env.local.example");
  const hits = files.flatMap((f) => read(f).split("\n").map((line, i) => [f, i + 1, line]).filter(([, , line]) => /Project Manager|Control Centre/.test(line)));
  assert.deepEqual(hits, [], JSON.stringify(hits));
  // Legitimate lowercase job-role use is preserved.
  assert.match(read("lib/meeting-intelligence/prompt.ts"), /expert project manager assistant/);
  // Storage keys are internal identifiers and must not change (would reset users' saved state).
  assert.match(read("components/theme-toggle.tsx"), /"project-manager-theme"/);
  assert.match(read("lib/project-selection.ts"), /"project-manager-selected-project-id"/);
});

console.log("\nAll Test Manager branding tests passed.\n");
