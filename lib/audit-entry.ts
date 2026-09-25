import type { AuditActionType } from "@/lib/types";

// ── Audit entry validation (shared by POST /api/audit and its tests) ────────
//
// The client proposes WHAT changed; the server decides WHO changed it.
// changed_by / changed_by_name are never accepted from the request — the
// route stamps them from the authenticated session.

export const AUDIT_ACTION_TYPES: readonly AuditActionType[] = [
  "Create", "Update", "Delete", "Status Change", "Health Change",
  "Date Change", "Severity Change", "Progress Change", "Schedule Change",
];

export const MAX_AUDIT_ENTRIES_PER_REQUEST = 100;
const MAX_TEXT = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** What a client may send for one audit row. */
export type AuditEntryInput = {
  entity_type: string;
  entity_id: string;
  entity_name: string;
  action_type: AuditActionType;
  project_id: string | null;
  field_name?: string | null;
  old_value?: string | null;
  new_value?: string | null;
};

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, MAX_TEXT);
}

/**
 * Validates and normalises a batch. project_id is kept only when it is a
 * real uuid (callers historically send the string "null" for tables with no
 * project, which Postgres rejects); the route further nulls ids of projects
 * that no longer exist, so a project's own Delete entry still persists.
 */
export function normaliseAuditEntries(
  body: unknown,
  auditableTables: ReadonlySet<string>,
): { entries: AuditEntryInput[]; error: null } | { entries: null; error: string } {
  const raw = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(raw) || raw.length === 0) return { entries: null, error: "entries must be a non-empty array" };
  if (raw.length > MAX_AUDIT_ENTRIES_PER_REQUEST) return { entries: null, error: `at most ${MAX_AUDIT_ENTRIES_PER_REQUEST} entries per request` };

  const entries: AuditEntryInput[] = [];
  for (const [i, item] of raw.entries()) {
    const e = item as Record<string, unknown>;
    if (typeof e?.entity_type !== "string" || !auditableTables.has(e.entity_type)) return { entries: null, error: `entries[${i}].entity_type is not an auditable table` };
    if (!isUuid(e.entity_id)) return { entries: null, error: `entries[${i}].entity_id must be a uuid` };
    if (typeof e.action_type !== "string" || !(AUDIT_ACTION_TYPES as readonly string[]).includes(e.action_type)) return { entries: null, error: `entries[${i}].action_type is invalid` };
    entries.push({
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      entity_name: String(e.entity_name ?? "").slice(0, MAX_TEXT),
      action_type: e.action_type as AuditActionType,
      project_id: isUuid(e.project_id) ? e.project_id : null,
      field_name: optionalText(e.field_name),
      old_value: optionalText(e.old_value),
      new_value: optionalText(e.new_value),
    });
  }
  return { entries, error: null };
}
