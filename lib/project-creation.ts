import type { Project } from "@/lib/types";

// Pure validation/record-building for the "Create New Project" workflow,
// shared by the client-side creation dialog and the server-side
// app/api/projects route so neither re-derives the other's rules.

export type NewProjectInput = {
  project_ref: string;
  name: string;
  customer: string;
  workstream: string;
  owner?: string | null;
  description?: string | null;
  status?: string | null;
  planned_start_date?: string | null;
  planned_end_date?: string | null;
  go_live_date?: string | null;
  uat_complete_date?: string | null;
  hypercare_start_date?: string | null;
  hypercare_end_date?: string | null;
};

const REQUIRED_FIELDS: Array<{ key: "project_ref" | "name" | "customer" | "workstream"; label: string }> = [
  { key: "project_ref", label: "Project reference" },
  { key: "name", label: "Project name" },
  { key: "customer", label: "Customer" },
  { key: "workstream", label: "Workstream" },
];

// Only checks the fields a new project genuinely can't do without.
// Lifecycle dates (planned/go-live/UAT/hypercare) are deliberately never
// required here — they usually aren't known yet when a project is first
// created (see buildNewProjectRecord, which leaves them null rather than
// inventing a value).
export function validateNewProjectInput(input: Partial<NewProjectInput>): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (!String(input[field.key] ?? "").trim()) return `${field.label} is required`;
  }
  return null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

export type ProjectConflict = { field: "name" | "project_ref"; value: string };

// The database's unique index on `name` (and the new one on `project_ref`)
// only catches an exact byte-for-byte duplicate — this codebase already has
// near-duplicate CR028 project rows differing only by case/whitespace (see
// supabase/migrations/004's reconciliation logic), which the plain index
// never blocked. This check normalises both sides so a create request gets
// a clear, friendly conflict before ever reaching the database.
export function findConflictingProject(
  existing: Array<Pick<Project, "name" | "project_ref">>,
  input: Pick<NewProjectInput, "name" | "project_ref">,
): ProjectConflict | null {
  const name = normalise(input.name ?? "");
  const ref = input.project_ref ? normalise(input.project_ref) : null;

  for (const project of existing) {
    if (name && normalise(project.name) === name) return { field: "name", value: input.name };
    if (ref && project.project_ref && normalise(project.project_ref) === ref) {
      return { field: "project_ref", value: input.project_ref as string };
    }
  }
  return null;
}

const LIFECYCLE_DATE_FIELDS = [
  "planned_start_date",
  "planned_end_date",
  "go_live_date",
  "uat_complete_date",
  "hypercare_start_date",
  "hypercare_end_date",
] as const;

// Builds the exact insert payload. Every lifecycle date defaults to null,
// never a manufactured/guessed value — a genuinely new project usually
// hasn't planned most of these yet. health/schedule_variance/id are
// intentionally never set here; the database's own defaults own them.
export function buildNewProjectRecord(input: NewProjectInput): Record<string, unknown> {
  const record: Record<string, unknown> = {
    project_ref: input.project_ref.trim(),
    name: input.name.trim(),
    customer: input.customer.trim(),
    workstream: input.workstream.trim(),
    owner: input.owner?.trim() || null,
    description: input.description?.trim() || null,
    status: input.status?.trim() || "Discovery",
  };

  for (const field of LIFECYCLE_DATE_FIELDS) {
    const value = input[field];
    record[field] = value && value.trim() ? value : null;
  }

  return record;
}
