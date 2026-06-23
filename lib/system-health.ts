"use client";

import { loadData as loadLocalData } from "@/lib/data-store";
import { modules } from "@/lib/modules";
import { schemaTables, schemaVersion } from "@/lib/schema";
import { seedData } from "@/lib/seed-data";
import { hasSupabaseConfig, supabase } from "@/lib/supabase/client";
import type { EntityName } from "@/lib/types";

export type TableHealth = {
  name: EntityName;
  columnCount: number;
  rowCount: number | null;
  status: "Healthy" | "Mismatch" | "Local";
  error?: string;
};

export type SystemHealthReport = {
  schemaVersion: string;
  configured: boolean;
  connected: boolean;
  localMode: boolean;
  tables: TableHealth[];
  mismatches: string[];
  counts: Record<"projects" | "requirements" | "risks" | "actions" | "decisions" | "timeline_items", number>;
};

function staticMismatches() {
  const mismatches: string[] = [];
  const seedTables = new Set(Object.keys(seedData));
  const schemaNames = new Set(schemaTables.map((table) => table.name));

  schemaTables.forEach((table) => {
    if (!seedTables.has(table.name)) mismatches.push(`${table.name}: missing from the local fallback model`);
  });
  seedTables.forEach((table) => {
    if (!schemaNames.has(table as EntityName)) mismatches.push(`${table}: local fallback table is missing from canonical schema`);
  });

  modules.forEach((module) => {
    const schema = schemaTables.find((table) => table.name === module.key);
    if (!schema) {
      mismatches.push(`${module.key}: CRUD module has no canonical table`);
      return;
    }
    const columns = new Set(schema.columns.map((column) => column.name));
    [...module.fields, ...module.columns].forEach((field) => {
      if (!columns.has(field.key)) mismatches.push(`${module.key}.${field.key}: UI field is missing from canonical schema`);
    });
  });

  return Array.from(new Set(mismatches));
}

function requestedCounts(values: Partial<Record<EntityName, number | null>>) {
  return {
    projects: values.projects ?? 0,
    requirements: values.requirements ?? 0,
    risks: values.risks ?? 0,
    actions: values.actions ?? 0,
    decisions: values.decisions ?? 0,
    timeline_items: values.timeline_items ?? 0,
  };
}

export async function getSystemHealth(): Promise<SystemHealthReport> {
  const mismatches = staticMismatches();

  if (!supabase) {
    const data = loadLocalData();
    const localCounts = Object.fromEntries(schemaTables.map((table) => [table.name, data[table.name].length]));
    return {
      schemaVersion,
      configured: hasSupabaseConfig,
      connected: false,
      localMode: true,
      mismatches,
      counts: requestedCounts(localCounts),
      tables: schemaTables.map((table) => ({
        name: table.name,
        columnCount: table.columns.length,
        rowCount: data[table.name].length,
        status: "Local",
      })),
    };
  }

  const client = supabase;
  const results = await Promise.all(schemaTables.map(async (table): Promise<TableHealth> => {
    const columns = table.columns.map((column) => column.name).join(",");
    const { count, error } = await client.from(table.name).select(columns, { count: "exact" }).limit(1);
    if (error) {
      return {
        name: table.name,
        columnCount: table.columns.length,
        rowCount: null,
        status: "Mismatch",
        error: error.message,
      };
    }
    return { name: table.name, columnCount: table.columns.length, rowCount: count ?? 0, status: "Healthy" };
  }));

  results.filter((table) => table.error).forEach((table) => {
    mismatches.push(`${table.name}: ${table.error}`);
  });
  const databaseCounts = Object.fromEntries(results.map((table) => [table.name, table.rowCount]));

  return {
    schemaVersion,
    configured: hasSupabaseConfig,
    connected: results.some((table) => table.status === "Healthy"),
    localMode: false,
    tables: results,
    mismatches,
    counts: requestedCounts(databaseCounts),
  };
}
