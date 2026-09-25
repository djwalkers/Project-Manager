// Manual "Email Test Status" orchestration (lib/email-delivery.ts's
// executeEmail("Test Status", ...)) — reuses the existing Resend
// transport/activity-logging pipeline (no second email architecture), is
// project-scoped by an EXPLICIT project_id (never selectActiveProject(),
// never inferred by name), is manual-only (no GET/cron/scheduled path
// exists for this kind), and accepts a one-off, user-typed list of
// recipients (payload.recipients) that is re-validated server-side —
// never trusting client-side validation alone.
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
const { executeEmail } = req("../lib/email-delivery.ts");
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

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function project(id, overrides = {}) {
  return { ...seedData.projects[0], id, project_ref: id.toUpperCase(), owner: null, status: "In Progress", ...overrides };
}

function testCase(pid, ref, status) {
  return {
    id: `test-${ref}`, project_id: pid, test_ref: ref, scenario: `Scenario ${ref}`,
    expected_result: null, actual_result: null, status, owner: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function baseSettings() {
  return { id: "s1", daily_brief_enabled: false, weekly_summary_enabled: false, manager_summary_enabled: false, recipient_email: "andrew.walker@bluestonex.com", manager_recipient_email: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
}

function twoProjectDataStore() {
  const projA = project("proj-a", { name: "Project A" });
  const projB = project("proj-b", { name: "Project B" });
  return {
    ...structuredClone(seedData),
    projects: [projA, projB],
    requirements: [], acceptance_criteria: [], artefact_links: [],
    test_cases: [testCase(projA.id, "TST-A01", "Passed"), testCase(projB.id, "TST-B01", "Failed")],
    deliverables: [], risks: [], decisions: [], actions: [], dependencies: [], discovery_questions: [],
    milestones: [], timeline_items: [], meetings: [], documents: [], activity_log: [],
    project_snapshots: [], evidence: [], requirement_sign_offs: [],
    meeting_intelligence: [], meeting_suggestions: [], go_live_checklists: [], cutover_plan: [],
    go_live_readiness_overrides: [],
    email_settings: [baseSettings()],
  };
}

function withFakeResendSuccess(fn) {
  return async () => {
    const originalFetch = global.fetch;
    let capturedBody = null;
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: "fake-resend-id" }) };
    };
    process.env.RESEND_API_KEY = "test-key";
    try {
      await fn(() => capturedBody);
    } finally {
      global.fetch = originalFetch;
      delete process.env.RESEND_API_KEY;
    }
  };
}

// ── Project resolution: explicit project_id only, never inferred ──────────

await runAsync("missing project_id is rejected before any content is built or sent — never falls back to any project", async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", { data, recipients: ["andrew.walker@bluestonex.com"] });
  assert.equal(result.ok, true, "a validation skip is still ok:true (matches every other skip() path in this module)");
  assert.equal(result.skipped, true);
  assert.match(result.message, /project/i);
});

await runAsync("an invalid/unknown project_id is rejected, never silently falling back to a sibling project", async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", { data, project_id: "does-not-exist", recipients: ["andrew.walker@bluestonex.com"] });
  assert.equal(result.skipped, true);
  assert.match(result.message, /project/i);
});

await runAsync("a valid project_id resolves that exact project's own data — content build reaches the send step using project A's tests only", withFakeResendSuccess(async (getCapturedBody) => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", { data, project_id: "proj-a", recipients: ["andrew.walker@bluestonex.com"] });
  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  const capturedBody = getCapturedBody();
  assert.ok(capturedBody, "Resend must have been called");
  assert.match(capturedBody.subject, /PROJ-A/i);
  assert.match(capturedBody.html, /TST-A01/);
  assert.doesNotMatch(capturedBody.html, /TST-B01/, "project B's test must never appear in project A's sent email");
}));

// ── Recipients: multiple, validated, passed through to Resend as a list ────

await runAsync("multiple recipients are all passed to Resend's 'to' field as an array", withFakeResendSuccess(async (getCapturedBody) => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", {
    data, project_id: "proj-a", recipients: ["a@example.com", "b@example.com"],
  });
  assert.equal(result.status, "sent");
  const capturedBody = getCapturedBody();
  assert.deepEqual(capturedBody.to, ["a@example.com", "b@example.com"]);
}));

await runAsync("recipients are de-duplicated case-insensitively before being sent", withFakeResendSuccess(async (getCapturedBody) => {
  const data = twoProjectDataStore();
  await executeEmail("Test Status", "Manual", {
    data, project_id: "proj-a", recipients: ["A@Example.com", "a@example.com"],
  });
  const capturedBody = getCapturedBody();
  assert.deepEqual(capturedBody.to, ["a@example.com"]);
}));

await runAsync("an empty recipients list is rejected with skipped_no_recipient, never silently sent anywhere", async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", { data, project_id: "proj-a", recipients: [] });
  assert.equal(result.status, "skipped_no_recipient");
});

await runAsync("an invalid recipient is rejected server-side with skipped_no_recipient, never silently sent anywhere", async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", {
    data, project_id: "proj-a", recipients: ["not-an-email"],
  });
  assert.equal(result.status, "skipped_no_recipient");
  assert.match(result.message, /not-an-email/);
});

await runAsync("server-side validation cannot be bypassed — a direct API-style call with an invalid recipient mixed into an otherwise-valid list is still rejected", async () => {
  // Simulates a caller that skips the client's own parseAndValidateRecipients
  // entirely and posts straight to the endpoint/orchestration.
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", {
    data, project_id: "proj-a", recipients: ["good@example.com", "<script>alert(1)</script>"],
  });
  assert.equal(result.status, "skipped_no_recipient");
});

await runAsync("server-side validation rejects more recipients than the sensible maximum, even if a client-side cap were bypassed", async () => {
  const data = twoProjectDataStore();
  const many = Array.from({ length: 25 }, (_, i) => `user${i}@example.com`);
  const result = await executeEmail("Test Status", "Manual", { data, project_id: "proj-a", recipients: many });
  assert.equal(result.status, "skipped_no_recipient");
});

// ── Activity logging: joined representation, no schema change ──────────────

await runAsync("email_activity_log.recipient stores a joined representation of multiple recipients (no schema change)", withFakeResendSuccess(async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", {
    data, project_id: "proj-a", recipients: ["a@example.com", "b@example.com"],
  });
  assert.equal(typeof result.activity.recipient, "string");
  assert.match(result.activity.recipient, /a@example\.com/);
  assert.match(result.activity.recipient, /b@example\.com/);
}));

await runAsync("a rejected (missing project_id) request still logs an activity record for audit, marked unsuccessful", async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test Status", "Manual", { data, recipients: ["andrew.walker@bluestonex.com"] });
  assert.ok(result.activity);
  assert.equal(result.activity.email_type, "Test Status");
  assert.equal(result.activity.success, false);
  assert.equal(result.activity.trigger_type, "Manual");
});

// ── Safety: never mutates project delivery data or email_settings ──────────

await runAsync("executeEmail never mutates requirements/test_cases/acceptance_criteria/requirement_sign_offs on the data it was given", withFakeResendSuccess(async () => {
  const data = twoProjectDataStore();
  const before = structuredClone({
    requirements: data.requirements, test_cases: data.test_cases,
    acceptance_criteria: data.acceptance_criteria, requirement_sign_offs: data.requirement_sign_offs,
  });
  await executeEmail("Test Status", "Manual", { data, project_id: "proj-a", recipients: ["andrew.walker@bluestonex.com"] });
  assert.deepEqual(data.requirements, before.requirements);
  assert.deepEqual(data.test_cases, before.test_cases);
  assert.deepEqual(data.acceptance_criteria, before.acceptance_criteria);
  assert.deepEqual(data.requirement_sign_offs, before.requirement_sign_offs);
}));

await runAsync("one-off manual recipients are never written back to email_settings", withFakeResendSuccess(async () => {
  const data = twoProjectDataStore();
  const before = structuredClone(data.email_settings);
  await executeEmail("Test Status", "Manual", {
    data, project_id: "proj-a", recipients: ["someone-new@example.com", "another-new@example.com"],
  });
  assert.deepEqual(data.email_settings, before, "email_settings must be completely unchanged by a manual Test Status send");
}));

// ── Existing scheduled/manual email kinds remain unchanged ──────────────────

await runAsync("regression: Manager Summary (an existing kind) still sends to a single-element 'to' array, unaffected by the multi-recipient generalisation", withFakeResendSuccess(async (getCapturedBody) => {
  const data = twoProjectDataStore();
  // Manager Summary's existing (unchanged) precedence resolves the
  // recipient from payload.settings.recipient_email over the top-level
  // payload.recipient — matching components/manager-summary-page.tsx's own
  // sendNow(), which always posts `settings.recipient_email`, never a bare
  // `recipient` string.
  const result = await executeEmail("Manager Summary", "Manual", { data, settings: { recipient_email: "manager@example.com" } });
  assert.equal(result.status, "sent");
  const capturedBody = getCapturedBody();
  assert.deepEqual(capturedBody.to, ["manager@example.com"]);
}));

await runAsync("regression: Daily Brief's single-recipient resolution is unchanged — still resolves and sends to exactly one address", withFakeResendSuccess(async (getCapturedBody) => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Daily Brief", "Manual", { data, settings: { recipient_email: "brief@example.com" } });
  assert.equal(result.status, "sent");
  const capturedBody = getCapturedBody();
  assert.deepEqual(capturedBody.to, ["brief@example.com"]);
}));

await runAsync("regression: Test kind's skip semantics for a genuinely invalid recipient are unchanged", async () => {
  const data = twoProjectDataStore();
  const result = await executeEmail("Test", "Manual", { data, settings: { recipient_email: "not-an-email" } });
  assert.equal(result.status, "skipped_no_recipient");
});

// ── No cron/schedule path exists for this kind ──────────────────────────────

run("structural: app/api/email/test-status/route.ts is POST-only — no GET handler, so no cron/scheduled path can trigger it", () => {
  const source = fs.readFileSync(path.join(root, "app/api/email/test-status/route.ts"), "utf8");
  assert.match(source, /export async function POST/);
  assert.doesNotMatch(source, /export async function GET/, "a GET handler would give cron/scheduled callers a path to this manual-only report");
  assert.match(source, /executeEmail\("Test Status", "Manual"/, "the route must always invoke this kind with trigger \"Manual\"");
  assert.match(source, /await requireCanSendProjectEmail\(request\.headers\.get\("authorization"\)\)/, "must use the shared email-send guard (cron secret or Manager/Admin)");
});

run("structural: executeEmail re-validates Test Status recipients via the shared validateRecipients, not a re-implemented check", () => {
  const source = fs.readFileSync(path.join(root, "lib/email-delivery.ts"), "utf8");
  assert.match(source, /validateRecipients/, "must reuse the canonical lib/email-recipients.ts validator");
});

console.log("\nAll Test Status email delivery/orchestration tests passed.\n");
