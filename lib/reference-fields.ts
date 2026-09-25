import type { ModuleConfig } from "@/lib/modules";

// "reference" module fields (e.g. an Acceptance Criterion's Requirement).
// Shared by components/form-dialog.tsx and components/data-table.tsx so the
// rules — current-project choices only, required on create, read-only once
// set (no reassignment), editable only to repair a record that has none —
// live in one place.

type Row = Record<string, unknown>;
type Field = ModuleConfig["fields"][number];
export type ReferenceOption = { value: string; label: string };

export function referenceLabel(row: Row): string {
  const ref = row.requirement_ref ?? row.ref;
  const title = row.title ?? row.name;
  return [ref, title].filter((part) => part !== undefined && part !== null && part !== "").map(String).join(" — ") || String(row.id);
}

/**
 * Choices for each reference field. `data` must be the page's project-scoped
 * DataStore (scopeProjectData), so only the current project's records appear.
 */
export function buildReferenceOptions(config: ModuleConfig, data: Record<string, unknown>): Record<string, ReferenceOption[]> {
  const options: Record<string, ReferenceOption[]> = {};
  for (const field of config.fields) {
    if (field.type !== "reference" || !field.references) continue;
    options[field.key] = ((data[field.references] ?? []) as Row[])
      .map((row) => ({ value: String(row.id), label: referenceLabel(row) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  return options;
}

/** A saved record that already has a value shows it read-only — no reassignment. */
export function isReferenceLocked(field: Field, record: Row | null | undefined): boolean {
  return Boolean(field.lockWhenSet && record?.id && record[field.key]);
}

/** The first reference problem in `form`, as a user-facing message, or null. */
export function referenceFieldError(
  config: ModuleConfig,
  form: Row,
  record: Row | null | undefined,
  options: Record<string, ReferenceOption[]> | undefined,
): string | null {
  for (const field of config.fields) {
    if (field.type !== "reference" || isReferenceLocked(field, record)) continue;
    const value = String(form[field.key] ?? "");
    if (!value) {
      if (field.required) return `Select the ${field.label.toLowerCase()} this ${config.singular.toLowerCase()} belongs to.`;
      continue;
    }
    if (!(options?.[field.key] ?? []).some((option) => option.value === value)) {
      return `The selected ${field.label.toLowerCase()} is not in the current project. Choose one from the list.`;
    }
  }
  return null;
}
