"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DataTable } from "@/components/data-table";
import { loadData, resetData, saveData, type DataStore } from "@/lib/data-store";
import { moduleBySlug } from "@/lib/modules";

export function ModulePageClient({ section }: { section: string }) {
  const [data, setData] = useState<DataStore | null>(null);
  const config = moduleBySlug.get(section);

  useEffect(() => {
    setData(loadData());
  }, []);

  function changeData(next: DataStore) {
    setData(next);
    saveData(next);
  }

  if (!data || !config) return null;

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
      <DataTable config={config} data={data} onChange={changeData} />
    </AppShell>
  );
}

export function SettingsPageClient() {
  const [data, setData] = useState<DataStore | null>(null);
  const counts = useMemo(() => {
    if (!data) return [];
    return Object.entries(data).map(([key, value]) => ({ key, count: value.length }));
  }, [data]);

  useEffect(() => {
    setData(loadData());
  }, []);

  return (
    <AppShell>
      <section className="rounded-lg border bg-card p-5 shadow-operational">
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Supabase credentials can be added to .env.local. This v1 keeps a local browser copy so CR028 can be managed immediately.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {counts.map((item) => (
            <div key={item.key} className="rounded-md border bg-muted/50 p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{item.key.replace("_", " ")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{item.count}</p>
            </div>
          ))}
        </div>
        <button
          className="mt-5 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground"
          onClick={() => {
            resetData();
            setData(loadData());
          }}
        >
          Reset local data
        </button>
      </section>
    </AppShell>
  );
}
