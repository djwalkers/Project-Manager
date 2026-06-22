"use client";

import { useMemo } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { DataTable } from "@/components/data-table";
import { resetData, type DataStore } from "@/lib/data-store";
import { moduleBySlug } from "@/lib/modules";
import {
  deleteRecord,
  hasSupabaseConfig,
  loadData,
  saveRecord,
} from "@/lib/supabase/data-store";
import { useProjectData } from "@/lib/use-project-data";

type Row = Record<string, unknown>;

export function ModulePageClient({ section }: { section: string }) {
  const { data, setData, error, reload } = useProjectData();
  const config = moduleBySlug.get(section);

  async function persistRecord(record: Row) {
    if (!config) throw new Error("Unknown module");
    const saved = await saveRecord(config.key, {
      ...record,
      ...(config.key === "projects" ? {} : { project_id: record.project_id ?? data?.projects[0]?.id }),
    });
    setData((current) => {
      if (!current) return current;
      const rows = current[config.key] as Row[];
      const exists = rows.some((row) => row.id === (saved as Row).id);
      return {
        ...current,
        [config.key]: exists
          ? rows.map((row) => (row.id === (saved as Row).id ? saved : row))
          : [saved, ...rows],
      } as DataStore;
    });
    return saved as Row;
  }

  async function removeRecord(record: Row) {
    if (!config || !record.id) throw new Error("Cannot delete a record without an ID");
    await deleteRecord(config.key, String(record.id));
    setData((current) => current
      ? { ...current, [config.key]: current[config.key].filter((item) => item.id !== record.id) } as DataStore
      : current);
  }

  if (!config) return null;
  if (error) return <AppShell><LoadErrorState onRetry={reload} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">CR028 Replenishment</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal">{config.title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{config.description}</p>
        </div>
        <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
          {data[config.key].length} total records
        </p>
      </div>
      {config.key === "documents" ? (
        <div className="mb-5 rounded-lg border bg-secondary p-4 text-sm font-medium text-secondary-foreground">
          Document upload will be added in v2.
        </div>
      ) : null}
      <DataTable config={config} data={data} onSaveRecord={persistRecord} onDeleteRecord={removeRecord} />
    </AppShell>
  );
}

export function SettingsPageClient() {
  const { data, setData, error, reload } = useProjectData();
  const counts = useMemo(() => {
    if (!data) return [];
    return Object.entries(data).map(([key, value]) => ({ key, count: value.length }));
  }, [data]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <section className="rounded-lg border bg-card p-5 shadow-operational">
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {hasSupabaseConfig
            ? "Supabase is configured and is the primary data source for this app."
            : "Supabase credentials can be added to .env.local. Until then, this app keeps a local browser copy."}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {counts.map((item) => (
            <div key={item.key} className="rounded-md border bg-muted/50 p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{item.key.replace("_", " ")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{item.count}</p>
            </div>
          ))}
        </div>
        {!hasSupabaseConfig ? (
          <button
            className="mt-5 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground"
            onClick={() => {
              resetData();
              loadData().then(setData);
            }}
          >
            Reset local data
          </button>
        ) : null}
      </section>
    </AppShell>
  );
}
