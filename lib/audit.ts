"use client";

import { supabase } from "@/lib/supabase/client";
import type { AuditActionType, AuditFilter, AuditLog, EntityName } from "@/lib/types";

// ── Current user store ────────────────────────────────────────────────────────
// Set by AuthProvider so audit never needs an async getUser() call.
let _auditUser: { id: string; name: string } | null = null;

export function setAuditUser(user: { id: string; name: string } | null) {
  _auditUser = user;
}

// ── Auditable tables ──────────────────────────────────────────────────────────
export const AUDITABLE_TABLES = new Set<EntityName>([
  "projects",
  "requirements",
  "risks",
  "decisions",
  "actions",
  "deliverables",
  "milestones",
  "timeline_items",
  "test_cases",
  "email_settings",
]);

// ── Tracked fields per table ──────────────────────────────────────────────────
const TRACKED_FIELDS: Partial<Record<EntityName, string[]>> = {
  projects: ["name", "status", "health", "planned_start_date", "planned_end_date", "schedule_variance"],
  requirements: ["title", "status", "priority", "owner"],
  risks: ["description", "status", "impact", "probability", "mitigation", "owner"],
  decisions: ["question", "status", "due_date", "decision_date", "decision"],
  actions: ["description", "status", "due_date", "owner"],
  deliverables: [
    "title", "status", "development_status", "sit_status",
    "uat_status", "deployment_status", "planned_completion_date", "owner",
  ],
  milestones: ["title", "status", "target_date", "owner"],
  timeline_items: ["phase_name", "status", "progress_percent", "start_date", "end_date"],
  test_cases: ["scenario", "status", "owner"],
  email_settings: ["daily_brief_enabled", "weekly_summary_enabled", "recipient_email"],
};

// ── Field → action type mapping ───────────────────────────────────────────────
const FIELD_ACTION_TYPES: Record<string, AuditActionType> = {
  status: "Status Change",
  health: "Health Change",
  schedule_health: "Health Change",
  impact: "Severity Change",
  probability: "Severity Change",
  planned_start_date: "Date Change",
  planned_end_date: "Date Change",
  planned_completion_date: "Date Change",
  target_date: "Date Change",
  start_date: "Date Change",
  end_date: "Date Change",
  decision_date: "Date Change",
  due_date: "Date Change",
  progress_percent: "Progress Change",
  schedule_variance: "Schedule Change",
  development_status: "Status Change",
  sit_status: "Status Change",
  uat_status: "Status Change",
  deployment_status: "Status Change",
};

// ── Entity display name extraction ───────────────────────────────────────────
const ENTITY_NAME_FIELDS: Partial<Record<EntityName, string[]>> = {
  projects: ["name"],
  requirements: ["requirement_ref", "title"],
  risks: ["risk_ref", "description"],
  decisions: ["decision_ref", "question"],
  actions: ["action_ref", "description"],
  deliverables: ["deliverable_ref", "title"],
  milestones: ["milestone_ref", "title"],
  timeline_items: ["phase_ref", "phase_name"],
  test_cases: ["test_ref", "scenario"],
  email_settings: [],
};

export function getEntityName(table: EntityName, record: Record<string, unknown>): string {
  if (table === "email_settings") return "Email Settings";
  const fields = ENTITY_NAME_FIELDS[table] ?? [];
  return fields.map((f) => String(record[f] ?? "")).find(Boolean) ?? String(record.id ?? "unknown");
}

// ── Change detection ──────────────────────────────────────────────────────────
export type FieldChange = {
  fieldName: string;
  oldValue: string;
  newValue: string;
  actionType: AuditActionType;
};

export function detectChanges(
  table: EntityName,
  oldRecord: Record<string, unknown>,
  newRecord: Record<string, unknown>,
): FieldChange[] {
  const tracked = TRACKED_FIELDS[table] ?? [];
  const changes: FieldChange[] = [];

  for (const field of tracked) {
    const oldVal = oldRecord[field];
    const newVal = newRecord[field];
    const oldStr = oldVal === null || oldVal === undefined ? "" : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? "" : String(newVal);
    if (oldStr === newStr) continue;

    changes.push({
      fieldName: field,
      oldValue: oldStr,
      newValue: newStr,
      actionType: FIELD_ACTION_TYPES[field] ?? "Update",
    });
  }

  return changes;
}

// ── Core log function (fire-and-forget — never throws) ────────────────────────
export function logAudit(
  table: EntityName,
  entityId: string,
  entityName: string,
  actionType: AuditActionType,
  projectId: string | null,
  fieldName?: string,
  oldValue?: string,
  newValue?: string,
): void {
  if (!supabase || !AUDITABLE_TABLES.has(table)) return;

  const entry: Omit<AuditLog, "id" | "changed_at"> = {
    project_id: projectId,
    entity_type: table,
    entity_id: entityId,
    entity_name: entityName,
    action_type: actionType,
    field_name: fieldName ?? null,
    old_value: oldValue ?? null,
    new_value: newValue ?? null,
    changed_by: _auditUser?.id ?? null,
    changed_by_name: _auditUser?.name ?? "System",
  };

  // Fire-and-forget — never await, never throw
  supabase.from("audit_log").insert(entry).then(({ error }) => {
    if (error && process.env.NODE_ENV === "development") {
      console.warn("[audit] Failed to log:", error.message);
    }
  });
}

// ── Query helpers ─────────────────────────────────────────────────────────────
export async function getAuditLog(filter: AuditFilter = {}): Promise<AuditLog[]> {
  if (!supabase) return [];

  let query = supabase
    .from("audit_log")
    .select("*")
    .order("changed_at", { ascending: false });

  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.entityType) query = query.eq("entity_type", filter.entityType);
  if (filter.actionType) query = query.eq("action_type", filter.actionType);
  if (filter.changedBy) query = query.eq("changed_by", filter.changedBy);
  if (filter.from) query = query.gte("changed_at", filter.from);
  if (filter.to) query = query.lte("changed_at", filter.to);
  if (filter.limit) query = query.limit(filter.limit);
  if (filter.offset) query = query.range(filter.offset, filter.offset + (filter.limit ?? 50) - 1);

  const { data, error } = await query;
  if (error) {
    console.warn("[audit] getAuditLog failed:", error.message);
    return [];
  }
  return (data ?? []) as AuditLog[];
}

// Recent meaningful changes (Status, Health, Date, Severity, Create, Delete)
const MEANINGFUL_ACTIONS: AuditActionType[] = [
  "Create", "Delete", "Status Change", "Health Change",
  "Date Change", "Severity Change", "Progress Change", "Schedule Change",
];

export async function getRecentChanges(projectId: string, limit = 10): Promise<AuditLog[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("project_id", projectId)
    .in("action_type", MEANINGFUL_ACTIONS)
    .order("changed_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as AuditLog[];
}

export async function getChangesSince(
  hours: number,
  projectIds: string[],
): Promise<AuditLog[]> {
  if (!supabase || !projectIds.length) return [];
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .in("project_id", projectIds)
    .in("action_type", MEANINGFUL_ACTIONS)
    .gte("changed_at", since)
    .order("changed_at", { ascending: false })
    .limit(200);
  if (error) return [];
  return (data ?? []) as AuditLog[];
}

export async function getAuditCount(): Promise<number> {
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("audit_log")
    .select("*", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}

// ── Display helpers ───────────────────────────────────────────────────────────
export function formatAuditChange(entry: AuditLog): string {
  const entityLabel = entry.entity_name || entry.entity_type;
  switch (entry.action_type) {
    case "Create":
      return `${entityLabel} created`;
    case "Delete":
      return `${entityLabel} deleted`;
    case "Status Change":
      return `${entityLabel} status: ${entry.old_value || "—"} → ${entry.new_value || "—"}`;
    case "Health Change":
      return `${entityLabel} health: ${entry.old_value || "—"} → ${entry.new_value || "—"}`;
    case "Date Change":
      return `${entityLabel} date changed: ${entry.old_value || "not set"} → ${entry.new_value || "not set"}`;
    case "Severity Change":
      return `${entityLabel} ${entry.field_name ?? "severity"}: ${entry.old_value || "—"} → ${entry.new_value || "—"}`;
    case "Progress Change":
      return `${entityLabel} progress: ${entry.old_value || "0"}% → ${entry.new_value || "0"}%`;
    case "Schedule Change":
      return `${entityLabel} schedule variance: ${entry.old_value || "0"} → ${entry.new_value || "0"}`;
    default:
      return `${entityLabel} ${entry.field_name ?? ""} updated`;
  }
}

export function relativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
