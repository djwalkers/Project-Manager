// Shared recipient parsing/validation (lib/email-recipients.ts) — the ONE
// canonical implementation used by both the Test Status preview's
// client-side field (immediate feedback) and executeEmail's server-side
// re-validation (defense in depth — never trust the browser alone).
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
const {
  parseAndValidateRecipients, validateRecipients, isValidEmailAddress,
  MAX_RECIPIENTS, MAX_RECIPIENT_INPUT_LENGTH,
} = req("../lib/email-recipients.ts");

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// ── Single default recipient ────────────────────────────────────────────────

run("a single valid address parses to a one-item list", () => {
  const result = parseAndValidateRecipients("andrew.walker@bluestonex.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["andrew.walker@bluestonex.com"]);
});

// ── Multiple comma-separated ────────────────────────────────────────────────

run("comma-separated recipients all parse", () => {
  const result = parseAndValidateRecipients("a@example.com,b@example.com,c@example.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com", "c@example.com"]);
});

// ── Multiple semicolon-separated ────────────────────────────────────────────

run("semicolon-separated recipients all parse", () => {
  const result = parseAndValidateRecipients("a@example.com;b@example.com;c@example.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com", "c@example.com"]);
});

// ── Mixed separators ─────────────────────────────────────────────────────────

run("a mix of commas and semicolons parses correctly", () => {
  const result = parseAndValidateRecipients("a@example.com, b@example.com; c@example.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com", "c@example.com"]);
});

// ── Whitespace trimming ──────────────────────────────────────────────────────

run("leading/trailing/internal whitespace around each address is trimmed", () => {
  const result = parseAndValidateRecipients("  a@example.com  ,\tb@example.com\n ; c@example.com  ");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com", "c@example.com"]);
});

// ── Case-insensitive de-duplication ─────────────────────────────────────────

run("the same address in different cases is de-duplicated, keeping one lowercase entry", () => {
  const result = parseAndValidateRecipients("Andrew.Walker@BluestoneX.com, andrew.walker@bluestonex.com, ANDREW.WALKER@BLUESTONEX.COM");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["andrew.walker@bluestonex.com"]);
});

run("distinct addresses that only differ by case elsewhere are still each kept once, not merged with unrelated addresses", () => {
  const result = parseAndValidateRecipients("a@example.com, A@EXAMPLE.COM, b@example.com");
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com"]);
});

// ── Invalid address prevents send ───────────────────────────────────────────

run("an invalid address anywhere in the list is rejected, with a clear identifying message", () => {
  const result = parseAndValidateRecipients("a@example.com, not-an-email, b@example.com");
  assert.equal(result.ok, false);
  assert.match(result.error, /not-an-email/);
});

run("multiple invalid addresses are all named in the error", () => {
  const result = parseAndValidateRecipients("bad1, a@example.com, bad2");
  assert.equal(result.ok, false);
  assert.match(result.error, /bad1/);
  assert.match(result.error, /bad2/);
});

// ── Empty recipient list prevents send ──────────────────────────────────────

run("an empty string is rejected", () => {
  const result = parseAndValidateRecipients("");
  assert.equal(result.ok, false);
});

run("whitespace-only / separator-only input is rejected (not treated as one empty recipient)", () => {
  const result = parseAndValidateRecipients("   ,  ; ,, ");
  assert.equal(result.ok, false);
});

run("null/undefined input is rejected without throwing", () => {
  assert.doesNotThrow(() => parseAndValidateRecipients(undefined));
  assert.equal(parseAndValidateRecipients(undefined).ok, false);
  assert.equal(parseAndValidateRecipients(null).ok, false);
});

// ── Limits (sensible maximum recipient count / input length) ───────────────

run("more than MAX_RECIPIENTS distinct addresses is rejected", () => {
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `user${i}@example.com`).join(", ");
  const result = parseAndValidateRecipients(many);
  assert.equal(result.ok, false);
  assert.match(result.error, /many|max/i);
});

run("exactly MAX_RECIPIENTS distinct addresses is accepted", () => {
  const exactly = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `user${i}@example.com`).join(", ");
  const result = parseAndValidateRecipients(exactly);
  assert.equal(result.ok, true);
  assert.equal(result.recipients.length, MAX_RECIPIENTS);
});

run("raw input longer than MAX_RECIPIENT_INPUT_LENGTH is rejected before parsing", () => {
  const huge = "a@example.com".repeat(Math.ceil(MAX_RECIPIENT_INPUT_LENGTH / 10));
  assert.ok(huge.length > MAX_RECIPIENT_INPUT_LENGTH);
  const result = parseAndValidateRecipients(huge);
  assert.equal(result.ok, false);
  assert.match(result.error, /too long|length/i);
});

// ── Array-based validation (server-side re-validation path) ────────────────

run("validateRecipients accepts a pre-split array directly, applying the same rules", () => {
  const result = validateRecipients(["a@example.com", " B@Example.com "]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, ["a@example.com", "b@example.com"]);
});

run("validateRecipients rejects a non-array input without throwing", () => {
  assert.doesNotThrow(() => validateRecipients(undefined));
  assert.equal(validateRecipients(undefined).ok, false);
  assert.equal(validateRecipients("not-an-array").ok, false);
});

run("validateRecipients rejects an empty array", () => {
  const result = validateRecipients([]);
  assert.equal(result.ok, false);
});

run("validateRecipients rejects a single absurdly long address (defense against oversized payloads)", () => {
  const result = validateRecipients([`${"a".repeat(300)}@example.com`]);
  assert.equal(result.ok, false);
});

run("validateRecipients rejects more than MAX_RECIPIENTS even when called directly (bypassing any client-side cap)", () => {
  const many = Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => `user${i}@example.com`);
  const result = validateRecipients(many);
  assert.equal(result.ok, false);
});

// ── isValidEmailAddress — the single canonical format check ─────────────────

run("isValidEmailAddress matches the plain single-recipient format check used elsewhere in email-delivery.ts", () => {
  assert.equal(isValidEmailAddress("a@b.com"), true);
  assert.equal(isValidEmailAddress("not-an-email"), false);
  assert.equal(isValidEmailAddress(""), false);
});

console.log("\nAll email-recipients tests passed.\n");
