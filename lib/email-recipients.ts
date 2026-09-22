// Shared recipient parsing/validation for the manual, ad-hoc Test Status
// report. This is the ONE canonical implementation — the Test Status
// preview panel uses it client-side for immediate feedback, and
// lib/email-delivery.ts re-validates with the exact same rules
// server-side, since browser validation alone is never trusted for a
// server-side send.
//
// These are one-off recipients for a single manual send — nothing here
// reads or writes email_settings, and no new recipient storage is
// introduced (see lib/email-delivery.ts's executeEmail, kind "Test Status").

export const MAX_RECIPIENTS = 10;
export const MAX_RECIPIENT_ADDRESS_LENGTH = 254; // RFC 5321 practical max
export const MAX_RECIPIENT_INPUT_LENGTH = 500;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The single canonical email-format check — email-delivery.ts's existing single-recipient validEmail() delegates here too, so there is exactly one regex. */
export function isValidEmailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export type RecipientValidation =
  | { ok: true; recipients: string[] }
  | { ok: false; error: string };

/**
 * Validates a pre-split list of candidate addresses: trims each, rejects
 * empty/oversized input, rejects any invalidly-formatted or over-length
 * address (naming every offender), de-duplicates case-insensitively
 * (normalising to lowercase, matching the existing single-recipient
 * behaviour), and enforces MAX_RECIPIENTS. This is the server-side
 * re-validation entry point — it must never be bypassable by a caller that
 * skips the client-side parsing step.
 */
export function validateRecipients(list: unknown): RecipientValidation {
  if (!Array.isArray(list)) return { ok: false, error: "Recipients must be a list of email addresses." };

  const raw = list.map((v) => String(v ?? ""));
  if (raw.join(",").length > MAX_RECIPIENT_INPUT_LENGTH) {
    return { ok: false, error: `Recipient input is too long (max ${MAX_RECIPIENT_INPUT_LENGTH} characters).` };
  }

  const trimmed = raw.map((v) => v.trim()).filter(Boolean);
  if (!trimmed.length) return { ok: false, error: "At least one recipient is required." };

  const tooLong = trimmed.filter((addr) => addr.length > MAX_RECIPIENT_ADDRESS_LENGTH);
  if (tooLong.length) return { ok: false, error: "One or more recipient addresses are too long." };

  const invalid = trimmed.filter((addr) => !isValidEmailAddress(addr));
  if (invalid.length) {
    return { ok: false, error: `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}` };
  }

  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const addr of trimmed) {
    const normalised = addr.toLowerCase();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    recipients.push(normalised);
  }

  if (recipients.length > MAX_RECIPIENTS) {
    return { ok: false, error: `Too many recipients (max ${MAX_RECIPIENTS}).` };
  }

  return { ok: true, recipients };
}

/**
 * Parses a raw, user-typed string (comma and/or semicolon separated) and
 * validates it via validateRecipients() — the single entry point the Test
 * Status preview's editable "Recipients" field uses on every keystroke.
 */
export function parseAndValidateRecipients(raw: string | null | undefined): RecipientValidation {
  const input = raw ?? "";
  if (input.length > MAX_RECIPIENT_INPUT_LENGTH) {
    return { ok: false, error: `Recipient input is too long (max ${MAX_RECIPIENT_INPUT_LENGTH} characters).` };
  }
  const parts = input.split(/[,;]+/);
  return validateRecipients(parts);
}
