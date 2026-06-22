"use client";

import { Edit2, Eye, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { FormDialog } from "@/components/form-dialog";
import { PriorityBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { DataStore } from "@/lib/data-store";
import type { ModuleConfig } from "@/lib/modules";
import { cn, isOverdue } from "@/lib/utils";

type Row = Record<string, unknown>;

function displayValue(value: unknown, type?: string) {
  if (!value) return "—";
  if (type === "date") return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(String(value)));
  return String(value);
}

export function DataTable({
  config,
  data,
  onSaveRecord,
  onDeleteRecord,
}: {
  config: ModuleConfig;
  data: DataStore;
  onSaveRecord: (record: Row) => Promise<Row>;
  onDeleteRecord: (record: Row) => Promise<void>;
}) {
  const Icon = config.icon;
  const rows = data[config.key] as Row[];
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [editing, setEditing] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Row | null>(rows[0] ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const values = rows.map((row) => String(row.status ?? "")).filter(Boolean);
    return ["All", ...Array.from(new Set(values))];
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesStatus = status === "All" || row.status === status;
      const matchesQuery =
        !needle ||
        config.searchFields.some((field) => String(row[field] ?? "").toLowerCase().includes(needle));
      return matchesStatus && matchesQuery;
    });
  }, [config.searchFields, query, rows, status]);

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  async function saveRecord(record: Row) {
    setOperationError(null);
    try {
      const saved = await onSaveRecord(record);
      setSelected(saved);
      setFormOpen(false);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : `Failed to save ${config.singular.toLowerCase()}`);
      throw error;
    }
  }

  async function deleteRecord(row: Row) {
    const label = String(row[config.columns[0].key] ?? config.singular);
    if (!window.confirm(`Delete ${label}?`)) return;
    setOperationError(null);
    try {
      await onDeleteRecord(row);
      const nextRows = rows.filter((item) => item.id !== row.id);
      setSelected(nextRows[0] ?? null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : `Failed to delete ${config.singular.toLowerCase()}`);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      {operationError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive xl:col-span-2">
          {operationError}
        </div>
      ) : null}
      <section className="min-w-0 rounded-lg border bg-card shadow-operational">
        <div className="flex flex-col gap-3 border-b p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search {config.title}</span>
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input className="pl-9" placeholder={`Search ${config.title.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label className="w-full sm:w-52">
              <span className="sr-only">Status filter</span>
              <Select value={status} onChange={(event) => setStatus(event.target.value)}>
                {statuses.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add {config.singular}
          </Button>
        </div>

        {filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No records found" description="Adjust the filters or add a new record for this workstream." icon={config.icon} action={openNew} />
          </div>
        ) : (
          <div className="table-scroll overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-muted/70 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  {config.columns.map((column) => (
                    <th key={column.key} className="px-4 py-3 font-semibold">
                      {column.label}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-semibold">Controls</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={String(row.id)}
                    className={cn(
                      "border-t transition-colors hover:bg-muted/50",
                      selected?.id === row.id && "bg-secondary/50",
                      isOverdue(String(row.due_date ?? ""), String(row.status ?? "")) && "bg-red-50/70 dark:bg-red-950/20",
                    )}
                  >
                    {config.columns.map((column) => (
                      <td key={column.key} className="max-w-[360px] px-4 py-3 align-top">
                        {column.type === "status" ? (
                          <StatusBadge value={String(row[column.key] ?? "")} />
                        ) : column.type === "priority" || column.type === "impact" ? (
                          <PriorityBadge value={String(row[column.key] ?? "")} />
                        ) : (
                          <span className="line-clamp-2">{displayValue(row[column.key], column.type)}</span>
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setSelected(row)} aria-label="View details">
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setEditing(row);
                            setFormOpen(true);
                          }}
                          aria-label="Edit record"
                        >
                          <Edit2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => deleteRecord(row)} aria-label="Delete record">
                          <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <aside className="rounded-lg border bg-card p-4 shadow-operational">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-base font-semibold">Detail View</h2>
        </div>
        {selected ? (
          <dl className="mt-4 space-y-3">
            {config.fields.map((field) => (
              <div key={field.key} className="rounded-md bg-muted/60 p-3">
                <dt className="text-xs font-semibold uppercase text-muted-foreground">{field.label}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm">{displayValue(selected[field.key], field.type)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Select a row to inspect details.</p>
        )}
      </aside>

      <FormDialog config={config} record={editing} open={formOpen} onClose={() => setFormOpen(false)} onSave={saveRecord} />
    </div>
  );
}
