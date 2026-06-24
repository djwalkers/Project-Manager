"use client";

import { loadData as loadLocalData } from "@/lib/data-store";
import { getAuditCount } from "@/lib/audit";
import { modules } from "@/lib/modules";
import { intelligenceEngineValidation } from "@/lib/project-intelligence";
import { schemaTables, schemaVersion } from "@/lib/schema";
import { seedData } from "@/lib/seed-data";
import { hasSupabaseConfig, supabase } from "@/lib/supabase/client";
import type { EntityName } from "@/lib/types";

export type EmailHealth = {
  dailyBriefEnabled: boolean;
  weeklySummaryEnabled: boolean;
  recipientConfigured: boolean;
  lastDailyBriefStatus: "Sent" | "Failed" | "Never";
  lastWeeklySummaryStatus: "Sent" | "Failed" | "Never";
  lastEmailSentTimestamp: string | null;
};

export type TableHealth = {
  name: EntityName;
  columnCount: number;
  rowCount: number | null;
  status: "Healthy" | "Mismatch" | "Local";
  error?: string;
};

export type AuditHealth = {
  enabled: boolean;
  recordCount: number;
};

export type SystemHealthReport = {
  schemaVersion: string;
  configured: boolean;
  connected: boolean;
  localMode: boolean;
  tables: TableHealth[];
  mismatches: string[];
  counts: Record<"projects" | "deliverables" | "requirements" | "risks" | "actions" | "decisions" | "timeline_items" | "project_snapshots", number>;
  intelligence: ReturnType<typeof intelligenceEngineValidation>;
  email: EmailHealth;
  audit: AuditHealth;
};

function emailHealth(settings: { daily_brief_enabled: boolean; weekly_summary_enabled: boolean; recipient_email: string } | undefined, activity: Array<{ email_type: string; success: boolean; sent_at: string }>): EmailHealth {
  const ordered = [...activity].sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const status = (type: string) => {
    const item = ordered.find((row) => row.email_type === type);
    return item ? (item.success ? "Sent" : "Failed") : "Never";
  };
  return {
    dailyBriefEnabled: settings?.daily_brief_enabled ?? false,
    weeklySummaryEnabled: settings?.weekly_summary_enabled ?? false,
    recipientConfigured: Boolean(settings?.recipient_email?.trim()),
    lastDailyBriefStatus: status("Daily Brief"),
    lastWeeklySummaryStatus: status("Weekly Summary"),
    lastEmailSentTimestamp: ordered[0]?.sent_at ?? null,
  };
}

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
    deliverables: values.deliverables ?? 0,
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
  const intelligence = intelligenceEngineValidation();
  intelligence.missingSources.forEach((source) => mismatches.push(`intelligence: missing source coverage for ${source}`));
  intelligence.duplicateRuleIds.forEach((ruleId) => mismatches.push(`intelligence: duplicate rule id ${ruleId}`));

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
      intelligence,
      email: emailHealth(data.email_settings[0], data.email_activity_log),
      audit: { enabled: false, recordCount: 0 },
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

  const [{ data: projectRows }, { data: timelineRows }, { data: emailSettings }, { data: emailActivity }] = await Promise.all([
    client.from("projects").select("id,name"),
    client.from("timeline_items").select("project_id,phase_ref"),
    client.from("email_settings").select("daily_brief_enabled,weekly_summary_enabled,recipient_email").limit(1),
    client.from("email_activity_log").select("email_type,success,sent_at").order("sent_at", { ascending: false }).limit(50),
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
  const auditRecordCount = await getAuditCount().catch(() => 0);

  // Validate audit_log table is accessible
  try {
    const { error: auditError } = await client.from("audit_log").select("id", { count: "exact", head: true }).limit(1);
    if (auditError) mismatches.push(`audit_log: ${auditError.message}`);
  } catch {
    mismatches.push("audit_log: table unreachable");
  }

  return {
    schemaVersion,
    configured: hasSupabaseConfig,
    connected: results.some((table) => table.status === "Healthy"),
    localMode: false,
    tables: results,
    mismatches,
    counts: requestedCounts(databaseCounts),
    intelligence,
    email: emailHealth(emailSettings?.[0], emailActivity ?? []),
    audit: { enabled: true, recordCount: auditRecordCount },
  };
}
