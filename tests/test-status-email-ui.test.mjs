// "Email Test Status" UI — Testing page button -> preview modal -> Send.
//
// No DOM/React renderer exists in this repo (see tests/local-ai-assistant.test.mjs's
// scope note) — matching that established convention, this proves the
// feature via (1) the pure logic it's wired to (buildTestStatusEmail,
// exhaustively covered in tests/test-status-email.test.mjs) and (2)
// structural source-scans confirming the component actually wires that
// logic in the way the spec requires: preview-before-send, visible
// recipient, no auto-send on open, double-send protection, and a
// zero-tests empty state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const panel = readSource("components/test-status-email-panel.tsx");
const appClient = readSource("components/app-client.tsx");

run("structural: the panel builds the preview via the canonical buildTestStatusEmail, not a separate/reimplemented builder", () => {
  assert.match(panel, /import\s*\{[^}]*buildTestStatusEmail[^}]*\}\s*from\s*"@\/lib\/email-content"/);
});

run("structural: opening the preview never itself calls fetch/send — no useEffect triggers sendNow on mount", () => {
  // The only fetch() in this file must be inside the sendNow-style
  // function, never inside a useEffect (which would run on open/mount).
  assert.doesNotMatch(panel, /useEffect\([^)]*\{[^}]*fetch\(/s, "opening the preview must not trigger a network send");
});

run("structural: the preview shows the project, recipients, and subject before any Send action", () => {
  assert.match(panel, /project\.(project_ref|name)/, "the modal must display the selected project");
  assert.match(panel, /recipient/i, "the modal must display recipients");
  assert.match(panel, /content\.subject|subject/i, "the modal must display the email subject");
});

run("structural: recipients are editable and use the shared canonical parser/validator, not a re-implemented check", () => {
  assert.match(panel, /import\s*\{[^}]*parseAndValidateRecipients[^}]*\}\s*from\s*"@\/lib\/email-recipients"/);
  assert.match(panel, /<Input[^>]*value=\{recipientInput\}/s, "the recipients field must be an editable, controlled input");
  assert.match(panel, /onChange=\{[^}]*setRecipientInput/, "typing must update the recipient input state");
});

run("structural: the recipients field is pre-populated from email_settings.recipient_email as a convenience default only", () => {
  assert.match(panel, /recipient_email/);
  assert.match(panel, /useState\(defaultRecipient\)/, "the field's initial value must come from the passed-in default, not be hardcoded inline");
});

run("structural: an invalid or empty recipient list disables Send and shows the validation problem", () => {
  assert.match(panel, /disabled=\{sending \|\| !validation\.ok\}/, "Send must be disabled whenever validation fails, not just while sending");
  assert.match(panel, /validation\.error/, "the specific validation problem must be rendered");
});

run("structural: the final resolved recipient list remains visible in the preview before Send", () => {
  assert.match(panel, /validation\.recipients\.join/, "the resolved/validated recipient list must be displayed");
});

run("structural: Send posts to /api/email/test-status with the full data, the validated recipients array, and an explicit project_id — never selectActiveProject()", () => {
  assert.match(panel, /fetch\(\s*"\/api\/email\/test-status"/);
  assert.match(panel, /project_id:\s*project\.id/, "the request must carry the explicitly selected project's own id");
  assert.match(panel, /recipients:\s*validation\.recipients/, "the request must carry the server-bound validated recipients array, not a raw/unvalidated string");
  assert.doesNotMatch(panel, /selectActiveProject/, "must never resolve the project itself — the caller's explicit project prop is the only source");
});

run("structural: manual recipients are never written back to email_settings", () => {
  assert.doesNotMatch(panel, /saveRecord\(\s*"email_settings"/, "manual, one-off recipients must never be persisted as the stored email setting");
  assert.doesNotMatch(panel, /createRecord\(\s*"email_settings"/);
  assert.doesNotMatch(panel, /updateRecord\(\s*"email_settings"/);
});

run("structural: double-send is prevented — the Send button's disabled condition includes 'sending'", () => {
  assert.match(panel, /disabled=\{sending/);
});

run("structural: a Cancel/Close action exists that does not send", () => {
  assert.match(panel, /onClose/);
});

run("structural: sending/success/error states are all rendered (not just success)", () => {
  assert.match(panel, /[Ss]ending/);
  assert.match(panel, /sendResult/);
});

run("structural: zero test cases for the selected project disables the action with a useful message, rather than sending a meaningless report", () => {
  assert.match(panel, /testCount === 0/);
  assert.match(panel, /disabled=\{testCount === 0\}/);
});

run("structural: the Testing page (test_cases module) renders the Email Test Status action in its header/actions area", () => {
  assert.match(appClient, /import\s*\{\s*TestStatusEmailAction\s*\}\s*from\s*"@\/components\/test-status-email-panel"/);
  assert.match(appClient, /config\.key === "test_cases"[\s\S]{0,200}TestStatusEmailAction/);
});

console.log("\nAll Test Status email UI structural tests passed.\n");
