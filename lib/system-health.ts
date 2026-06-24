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
  counts: Record<"projects" | "requirements" | "risks" | "actions" | "decisions" | "timeline_items" | "project_snapshots", number>;
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
    project_snapshots: values.project_snapshots ?? 0,
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
  const timelineHealth = results.find((table) => table.name === "timeline_items");
  if (timelineHealth?.status === "Healthy" && timelineHealth.rowCount === 0 && seedData.timeline_items.length > 0) {
    mismatches.push("timeline_items: the anon client can see 0 rows although the CR028 seed defines 6; check RLS/table grants and run migration 004");
  }

  const [{ data: projectRows }, { data: timelineRows }] = await Promise.all([
    client.from("projects").select("id,name"),
    client.from("timeline_items").select("project_id,phase_ref"),
  ]);
  const cr028Projects = (projectRows ?? []).filter((project) => String(project.name).toLowerCase().includes("cr028"));
  if (cr028Projects.length > 1) {
    mismatches.push(`projects: ${cr028Projects.length} CR028 project rows are visible; active selection will use the project with the strongest control-data ownership`);
  }
  const visibleProjectIds = new Set((projectRows ?? []).map((project) => project.id));
  const unmatchedTimelineRows = (timelineRows ?? []).filter((item) => !visibleProjectIds.has(item.project_id)).length;
  if (unmatchedTimelineRows) {
    mismatches.push(`timeline_items: ${unmatchedTimelineRows} rows reference a project not visible to the anon client`);
  }
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
