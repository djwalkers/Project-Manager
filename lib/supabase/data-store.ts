"use client";

import {
  createId,
  loadData as loadLocalData,
  saveData as saveLocalData,
  type DataStore,
} from "@/lib/data-store";
import { AUDITABLE_TABLES, detectChanges, getEntityName, logAudit, logAuditEntries } from "@/lib/audit";
import { projectId } from "@/lib/seed-data";
import { schemaByTable, schemaTables, writableColumns } from "@/lib/schema";
import { hasSupabaseConfig, supabase } from "@/lib/supabase/client";
import type { EntityMap, EntityName } from "@/lib/types";

type RecordValue = Record<string, unknown>;

const tableOrder = schemaTables.map((table) => table.name);

// go_live_checklists, cutover_plan, and go_live_readiness_overrides are
// served through authenticated server routes (service-role client, no anon
// RLS access) rather than the anon-key client used for every other table —
// see supabase/migrations/023 and 025. go_live_readiness_overrides is only
// ever read through this map (loadData's GET dispatch below) — its route
// intentionally exposes POST-upsert/DELETE instead of the generic
// create/update split, so writes go through lib/go-live-readiness.ts's
// client helpers directly rather than createRecord/updateRecord.
const AUTH_ROUTED_TABLE_PATHS: Partial<Record<EntityName, string>> = {
  go_live_checklists: "/api/go-live/checklists",
  cutover_plan: "/api/go-live/cutover",
  go_live_readiness_overrides: "/api/go-live/overrides",
  // Append-only; written only via lib/go-live-decision-client.ts
  // (POST /api/go-live/decisions), never createRecord/updateRecord.
  go_live_decisions: "/api/go-live/decisions",
};

async function fetchAuthRoutedTable(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Request to ${path} failed (${res.status})`);
  return body;
}

function cleanRecord(table: EntityName, record: RecordValue) {
  const columns = schemaByTable.get(table)?.columns ?? [];
  return Object.fromEntries(
    writableColumns[table]
      .filter((column) => record[column] !== undefined)
      .map((column) => {
        const type = columns.find((item) => item.name === column)?.type;
        const value = record[column];
        if (value === "" && (type === "date" || type === "timestamptz")) return [column, null];
        if ((type === "integer" || type === "numeric") && value !== "") return [column, Number(value)];
        return [column, value];
      }),
  );
}

function prepareLocalRecord(table: EntityName, record: RecordValue, existing?: RecordValue) {
  const now = new Date().toISOString();
  const globalTables: EntityName[] = ["email_settings", "email_activity_log"];
  return {
    ...existing,
    ...record,
    id: existing?.id ?? record.id ?? createId(),
    ...(table === "projects" || globalTables.includes(table) ? {} : { project_id: record.project_id ?? existing?.project_id ?? projectId }),
    ...(table === "documents"
      ? { uploaded_at: existing?.uploaded_at ?? record.uploaded_at ?? now }
      : { created_at: existing?.created_at ?? record.created_at ?? now }),
    ...(!["documents", "activity_log", "project_snapshots", "email_activity_log"].includes(table) ? { updated_at: now } : {}),
  };
}

function errorMessage(action: string, error: { message?: string; code?: string } | null) {
  // 42501 = refused by RLS / privileges — e.g. a Viewer (read-only) trying to write.
  if (error?.code === "42501") return new Error(`${action}: you do not have permission to make this change.`);
  const message = error?.message ?? "";
  // Integrity rules (migration 033) — explain them instead of echoing SQL.
  if (error?.code === "23503" && /on table "requirements"/.test(message) && /acceptance_criteria/.test(message)) {
    return new Error(`${action}: this requirement still has acceptance criteria. Delete those acceptance criteria first — a requirement with acceptance criteria cannot be deleted.`);
  }
  if (error?.code === "23503" && /on table "requirements"/.test(message) && /requirement_sign_offs/.test(message)) {
    return new Error(`${action}: this requirement has recorded sign-offs. Formal sign-off history is kept, so a signed-off requirement cannot be deleted.`);
  }
  if (error?.code === "23503" && /acceptance_criteria_requirement_same_project_fkey/.test(message)) {
    return new Error(`${action}: the selected requirement does not exist in this project. Choose a requirement from the current project.`);
  }
  if (error?.code === "23514" && /acceptance_criteria_requirement_required/.test(message)) {
    return new Error(`${action}: an acceptance criterion must belong to a requirement. Select its requirement and save again.`);
  }
  return new Error(`${action}: ${message || "Unknown Supabase error"}`);
}

export { hasSupabaseConfig };

export async function loadData(): Promise<DataStore> {
  const client = supabase;
  if (!client) return loadLocalData();

  const results = await Promise.all(
    tableOrder.map(async (table) => {
      const authRoutePath = AUTH_ROUTED_TABLE_PATHS[table];
      if (authRoutePath) {
        const data = await fetchAuthRoutedTable(authRoutePath);
        return [table, data ?? []] as const;
      }
      const orderColumn = table === "documents" ? "uploaded_at" : "created_at";
      const { data, error } = await client.from(table).select("*").order(orderColumn, { ascending: true });
      if (error) throw errorMessage(`Failed to load ${table}`, error);
      return [table, data ?? []] as const;
    }),
  );

  return Object.fromEntries(results) as DataStore;
}

export async function createRecord<K extends EntityName>(table: K, record: RecordValue): Promise<EntityMap[K]> {
  const value = cleanRecord(table, record);

  if (!supabase) {
    const data = loadLocalData();
    const created = prepareLocalRecord(table, value) as EntityMap[K];
    saveLocalData({ ...data, [table]: [created, ...data[table]] });
    return created;
  }

  const authRoutePath = AUTH_ROUTED_TABLE_PATHS[table];
  if (authRoutePath) {
    const data = await fetchAuthRoutedTable(authRoutePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return data as EntityMap[K];
  }

  const { data, error } = await supabase.from(table).insert(value).select().single();
  if (error) throw errorMessage(`Failed to create ${table}`, error);

  // Fire-and-forget audit — never blocks the save
  if (AUDITABLE_TABLES.has(table)) {
    const saved = data as RecordValue;
    logAudit(
      table, String(saved.id), getEntityName(table, saved),
      "Create",
      String(saved.project_id ?? record.project_id ?? null),
    );
  }

  return data as EntityMap[K];
}

export async function updateRecord<K extends EntityName>(table: K, record: RecordValue & { id: string }): Promise<EntityMap[K]> {
  const value = { ...cleanRecord(table, record), id: record.id };

  if (!supabase) {
    const data = loadLocalData();
    const current = data[table] as RecordValue[];
    const existing = current.find((item) => item.id === record.id);
    const updated = prepareLocalRecord(table, value, existing) as EntityMap[K];
    saveLocalData({
      ...data,
      [table]: current.map((item) => (item.id === record.id ? updated : item)),
    });
    return updated;
  }

  const authRoutePath = AUTH_ROUTED_TABLE_PATHS[table];
  if (authRoutePath) {
    const data = await fetchAuthRoutedTable(authRoutePath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return data as EntityMap[K];
  }

  // Fetch old record for change detection (only for auditable tables)
  let oldRecord: RecordValue | null = null;
  if (AUDITABLE_TABLES.has(table)) {
    const { data: old } = await supabase.from(table).select("*").eq("id", record.id).single();
    oldRecord = old as RecordValue | null;
  }

  // RLS never errors on a refused UPDATE — it matches zero rows. Detect that
  // (same as deleteRecord) instead of surfacing a cryptic single-row error.
  const { data: updatedRows, error } = await supabase
    .from(table)
    .update(cleanRecord(table, value))
    .eq("id", record.id)
    .select();
  if (error) throw errorMessage(`Failed to update ${table}`, error);
  const data = updatedRows?.[0];
  if (!data) {
    throw new Error(`Failed to update ${table}: the record was not updated — you may not have permission to change it, or it no longer exists.`);
  }

  // Fire-and-forget audit for each changed field
  if (AUDITABLE_TABLES.has(table) && oldRecord) {
    const saved = data as RecordValue;
    const entityName = getEntityName(table, saved);
    const projectId = String(saved.project_id ?? oldRecord.project_id ?? null);
    const changes = detectChanges(table, oldRecord, { ...oldRecord, ...record });

    // One request for all of this update's field changes.
    void logAuditEntries(changes.map((change) => ({
      table, entityId: String(record.id), entityName, actionType: change.actionType, projectId,
      fieldName: change.fieldName, oldValue: change.oldValue, newValue: change.newValue,
    })));
  }

  return data as EntityMap[K];
}

export async function saveRecord<K extends EntityName>(table: K, record: RecordValue): Promise<EntityMap[K]> {
  return record.id
    ? updateRecord(table, record as RecordValue & { id: string })
    : createRecord(table, record);
}

export async function upsertRecord<K extends EntityName>(table: K, record: RecordValue, conflictColumns: string[]): Promise<EntityMap[K]> {
  if (!supabase) {
    const data = loadLocalData();
    const existing = (data[table] as RecordValue[]).find((item) => conflictColumns.every((column) => item[column] === record[column]));
    return existing?.id
      ? updateRecord(table, { ...record, id: String(existing.id) })
      : createRecord(table, record);
  }

  const { data, error } = await supabase
    .from(table)
    .upsert(cleanRecord(table, record), { onConflict: conflictColumns.join(",") })
    .select()
    .single();
  if (error) throw errorMessage(`Failed to upsert ${table}`, error);
  return data as EntityMap[K];
}

export async function deleteRecord<K extends EntityName>(table: K, id: string) {
  if (!supabase) {
    const data = loadLocalData();
    saveLocalData({
      ...data,
      [table]: data[table].filter((record) => record.id !== id),
    });
    return;
  }

  const authRoutePath = AUTH_ROUTED_TABLE_PATHS[table];
  if (authRoutePath) {
    await fetchAuthRoutedTable(`${authRoutePath}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    return;
  }

  // Fetch before delete so we can log what was removed
  let deletedRecord: RecordValue | null = null;
  if (AUDITABLE_TABLES.has(table)) {
    const { data: found } = await supabase.from(table).select("*").eq("id", id).single();
    deletedRecord = found as RecordValue | null;
  }

  // RLS never errors on a refused DELETE — it simply matches zero rows. Ask
  // for the deleted id back so a refusal (or an already-missing row) is
  // detected: the caller then keeps the item and no Delete is audited.
  const { data: deleted, error } = await supabase.from(table).delete().eq("id", id).select("id");
  if (error) throw errorMessage(`Failed to delete ${table}`, error);
  if (!deleted || deleted.length === 0) {
    throw new Error(`Failed to delete ${table}: the record was not deleted — you may not have permission to delete it, or it no longer exists.`);
  }

  if (AUDITABLE_TABLES.has(table) && deletedRecord) {
    logAudit(
      table, id, getEntityName(table, deletedRecord),
      "Delete",
      String(deletedRecord.project_id ?? null),
    );
  }
}
