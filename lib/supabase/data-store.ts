"use client";

import {
  createId,
  loadData as loadLocalData,
  saveData as saveLocalData,
  type DataStore,
} from "@/lib/data-store";
import { projectId } from "@/lib/seed-data";
import { hasSupabaseConfig, supabase } from "@/lib/supabase/client";
import type { EntityMap, EntityName } from "@/lib/types";

type RecordValue = Record<string, unknown>;

const tableOrder: EntityName[] = [
  "projects",
  "requirements",
  "risks",
  "decisions",
  "actions",
  "dependencies",
  "test_cases",
  "meetings",
  "documents",
  "activity_log",
];

const writableColumns: Record<EntityName, string[]> = {
  projects: ["name", "customer", "workstream", "status", "description"],
  requirements: ["project_id", "requirement_ref", "title", "description", "priority", "status", "owner", "source", "notes"],
  risks: ["project_id", "risk_ref", "description", "impact", "probability", "mitigation", "owner", "status"],
  decisions: ["project_id", "decision_ref", "question", "decision", "owner", "status", "decision_date"],
  actions: ["project_id", "action_ref", "description", "owner", "due_date", "status", "notes"],
  dependencies: ["project_id", "name", "owner", "status", "notes"],
  test_cases: ["project_id", "test_ref", "scenario", "expected_result", "actual_result", "status", "owner"],
  meetings: ["project_id", "meeting_date", "title", "attendees", "notes", "decisions", "actions"],
  documents: ["project_id", "document_name", "document_type", "storage_path", "notes"],
  activity_log: ["project_id", "activity_type", "description"],
};

function cleanRecord(table: EntityName, record: RecordValue) {
  return Object.fromEntries(
    writableColumns[table]
      .filter((column) => record[column] !== undefined)
      .map((column) => [column, record[column] === "" && column.endsWith("_date") ? null : record[column]]),
  );
}

function prepareLocalRecord(table: EntityName, record: RecordValue, existing?: RecordValue) {
  const now = new Date().toISOString();
  return {
    ...existing,
    ...record,
    id: existing?.id ?? record.id ?? createId(),
    ...(table === "projects" ? {} : { project_id: record.project_id ?? existing?.project_id ?? projectId }),
    ...(table === "documents"
      ? { uploaded_at: existing?.uploaded_at ?? record.uploaded_at ?? now }
      : { created_at: existing?.created_at ?? record.created_at ?? now }),
    ...(!["documents", "activity_log"].includes(table) ? { updated_at: now } : {}),
  };
}

function errorMessage(action: string, error: { message?: string } | null) {
  return new Error(`${action}: ${error?.message ?? "Unknown Supabase error"}`);
}

export { hasSupabaseConfig };

export async function loadData(): Promise<DataStore> {
  const client = supabase;
  if (!client) return loadLocalData();

  const results = await Promise.all(
    tableOrder.map(async (table) => {
      const orderColumn = table === "documents" ? "uploaded_at" : "created_at";
      const { data, error } = await client.from(table).select("*").order(orderColumn, { ascending: true });
      if (error) throw errorMessage(`Failed to load ${table}`, error);
      return [table, data ?? []] as const;
    }),
  );

  return Object.fromEntries(results) as DataStore;
}

export async function createRecord<K extends EntityName>(table: K, record: RecordValue): Promise<EntityMap[K]> {
  const value = record;

  if (!supabase) {
    const data = loadLocalData();
    const created = prepareLocalRecord(table, value) as EntityMap[K];
    saveLocalData({ ...data, [table]: [created, ...data[table]] });
    return created;
  }

  const { data, error } = await supabase.from(table).insert(cleanRecord(table, value)).select().single();
  if (error) throw errorMessage(`Failed to create ${table}`, error);
  return data as EntityMap[K];
}

export async function updateRecord<K extends EntityName>(table: K, record: RecordValue & { id: string }): Promise<EntityMap[K]> {
  const value = record;

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

  const { data, error } = await supabase
    .from(table)
    .update(cleanRecord(table, value))
    .eq("id", record.id)
    .select()
    .single();
  if (error) throw errorMessage(`Failed to update ${table}`, error);
  return data as EntityMap[K];
}

export async function saveRecord<K extends EntityName>(table: K, record: RecordValue): Promise<EntityMap[K]> {
  return record.id
    ? updateRecord(table, record as RecordValue & { id: string })
    : createRecord(table, record);
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

  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw errorMessage(`Failed to delete ${table}`, error);
}
