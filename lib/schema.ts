import type { EntityName } from "@/lib/types";

export const schemaVersion = "003_timeline_schedule";

export type SchemaColumn = {
  name: string;
  type: "uuid" | "text" | "integer" | "numeric" | "date" | "timestamptz";
  required: boolean;
  managed?: boolean;
  foreignKey?: string;
};

export type SchemaTable = {
  name: EntityName;
  columns: SchemaColumn[];
  seedKey?: string[];
};

const id: SchemaColumn = { name: "id", type: "uuid", required: true, managed: true };
const projectId: SchemaColumn = { name: "project_id", type: "uuid", required: true, foreignKey: "projects.id" };
const createdAt: SchemaColumn = { name: "created_at", type: "timestamptz", required: true, managed: true };
const updatedAt: SchemaColumn = { name: "updated_at", type: "timestamptz", required: true, managed: true };

export const schemaTables: SchemaTable[] = [
  {
    name: "projects",
    seedKey: ["name"],
    columns: [
      id,
      { name: "name", type: "text", required: true },
      { name: "customer", type: "text", required: true },
      { name: "workstream", type: "text", required: true },
      { name: "status", type: "text", required: true },
      { name: "health", type: "text", required: true },
      { name: "schedule_variance", type: "numeric", required: true },
      { name: "planned_start_date", type: "date", required: false },
      { name: "planned_end_date", type: "date", required: false },
      { name: "description", type: "text", required: false },
      createdAt,
      updatedAt,
    ],
  },
  {
    name: "requirements",
    seedKey: ["project_id", "requirement_ref"],
    columns: [
      id, projectId,
      { name: "requirement_ref", type: "text", required: true },
      { name: "title", type: "text", required: true },
      { name: "description", type: "text", required: false },
      { name: "priority", type: "text", required: true },
      { name: "category", type: "text", required: true },
      { name: "status", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "source", type: "text", required: false },
      { name: "notes", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "risks",
    seedKey: ["project_id", "risk_ref"],
    columns: [
      id, projectId,
      { name: "risk_ref", type: "text", required: true },
      { name: "description", type: "text", required: true },
      { name: "impact", type: "text", required: true },
      { name: "probability", type: "text", required: true },
      { name: "mitigation", type: "text", required: false },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "text", required: true },
      createdAt, updatedAt,
    ],
  },
  {
    name: "decisions",
    seedKey: ["project_id", "decision_ref"],
    columns: [
      id, projectId,
      { name: "decision_ref", type: "text", required: true },
      { name: "question", type: "text", required: true },
      { name: "decision", type: "text", required: false },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "text", required: true },
      { name: "decision_date", type: "date", required: false },
      { name: "due_date", type: "date", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "actions",
    seedKey: ["project_id", "action_ref"],
    columns: [
      id, projectId,
      { name: "action_ref", type: "text", required: true },
      { name: "description", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "due_date", type: "date", required: false },
      { name: "status", type: "text", required: true },
      { name: "notes", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "dependencies",
    seedKey: ["project_id", "name"],
    columns: [
      id, projectId,
      { name: "name", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "text", required: true },
      { name: "notes", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "discovery_questions",
    seedKey: ["project_id", "question_ref"],
    columns: [
      id, projectId,
      { name: "question_ref", type: "text", required: true },
      { name: "question", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "category", type: "text", required: true },
      { name: "status", type: "text", required: true },
      { name: "due_date", type: "date", required: false },
      { name: "answer", type: "text", required: false },
      { name: "notes", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "milestones",
    seedKey: ["project_id", "milestone_ref"],
    columns: [
      id, projectId,
      { name: "milestone_ref", type: "text", required: true },
      { name: "title", type: "text", required: true },
      { name: "target_date", type: "date", required: false },
      { name: "status", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "notes", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "timeline_items",
    seedKey: ["project_id", "phase_ref"],
    columns: [
      id, projectId,
      { name: "phase_ref", type: "text", required: true },
      { name: "phase_name", type: "text", required: true },
      { name: "start_date", type: "date", required: true },
      { name: "end_date", type: "date", required: true },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "text", required: true },
      { name: "progress_percent", type: "integer", required: true },
      { name: "notes", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "test_cases",
    seedKey: ["project_id", "test_ref"],
    columns: [
      id, projectId,
      { name: "test_ref", type: "text", required: true },
      { name: "scenario", type: "text", required: true },
      { name: "expected_result", type: "text", required: false },
      { name: "actual_result", type: "text", required: false },
      { name: "status", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "meetings",
    seedKey: ["project_id", "meeting_date", "title"],
    columns: [
      id, projectId,
      { name: "meeting_date", type: "date", required: true },
      { name: "title", type: "text", required: true },
      { name: "attendees", type: "text", required: false },
      { name: "notes", type: "text", required: false },
      { name: "decisions", type: "text", required: false },
      { name: "actions", type: "text", required: false },
      createdAt, updatedAt,
    ],
  },
  {
    name: "documents",
    seedKey: ["project_id", "document_name"],
    columns: [
      id, projectId,
      { name: "document_name", type: "text", required: true },
      { name: "document_type", type: "text", required: false },
      { name: "storage_path", type: "text", required: false },
      { name: "notes", type: "text", required: false },
      { name: "uploaded_at", type: "timestamptz", required: true, managed: true },
    ],
  },
  {
    name: "activity_log",
    seedKey: ["project_id", "activity_type", "description"],
    columns: [
      id, projectId,
      { name: "activity_type", type: "text", required: true },
      { name: "description", type: "text", required: true },
      createdAt,
    ],
  },
];

export const schemaByTable = new Map(schemaTables.map((table) => [table.name, table]));

export const writableColumns = Object.fromEntries(
  schemaTables.map((table) => [
    table.name,
    table.columns.filter((column) => !column.managed).map((column) => column.name),
  ]),
) as Record<EntityName, string[]>;
