"use client";

import { Edit2, Eye, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { FormDialog } from "@/components/form-dialog";
import { PriorityBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { DataStore } from "@/lib/data-store";
import type { ModuleConfig } from "@/lib/modules";
import { cn, isOverdue, nextRef } from "@/lib/utils";

type Row = Record<string, unknown>;

const SOURCE_BADGE: Record<string, { bg: string; color: string }> = {
  "Functional Specification":       { bg: "#dbeafe", color: "#1e40af" },
  "Technical Design":               { bg: "#e0e7ff", color: "#3730a3" },
  "Customer Workshop":              { bg: "#f3e8ff", color: "#6b21a8" },
  "Discovery Question":             { bg: "#fef3c7", color: "#92400e" },
  "Business Decision":              { bg: "#ffedd5", color: "#9a3412" },
  "Email":                          { bg: "#f1f5f9", color: "#475569" },
  "Existing Solution":              { bg: "#dcfce7", color: "#166534" },
  "Current Process Documentation":  { bg: "#ccfbf1", color: "#134e4a" },
  "Test Strategy":                  { bg: "#e0e7ff", color: "#312e81" },
  "SIT":                            { bg: "#fee2e2", color: "#991b1b" },
  "UAT":                            { bg: "#fce7f3", color: "#9d174d" },
  "Customer Request":               { bg: "#fdf4ff", color: "#7e22ce" },
  "Other":                          { bg: "#f1f5f9", color: "#475569" },
};

function displayValue(value: unknown, type?: string) {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "date") return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(String(value)));
  return String(value);
}

const IMPACT_SCORE: Record<string, number> = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const PROB_SCORE: Record<string, number> = { Low: 1, Medium: 2, High: 3 };

function exposureRating(impact: string, probability: string): { label: string; bg: string; color: string } {
  const score = (IMPACT_SCORE[impact] ?? 0) * (PROB_SCORE[probability] ?? 0);
  if (score >= 9) return { label: "Critical", bg: "#fee2e2", color: "#991b1b" };
  if (score >= 6) return { label: "High", bg: "#ffedd5", color: "#9a3412" };
  if (score >= 3) return { label: "Medium", bg: "#fef3c7", color: "#92400e" };
  if (score >= 1) return { label: "Low", bg: "#dcfce7", color: "#166534" };
  return { label: "—", bg: "#f1f5f9", color: "#475569" };
}

function readinessDot(statusValue: string): string {
  const s = statusValue ?? "";
  if (!s || s === "Not Started") return "#d1d5db";
  if (s === "Blocked") return "#ef4444";
  if (s.includes("Complete") || s === "Deployed" || s === "Passed") return "#22c55e";
  return "#3b82f6";
}

export function DataTable({
  config,
  data,
  onSaveRecord,
  onDeleteRecord,
  defaultValues,
  selectable,
  onSelectionChange,
  selectionActions,
  detailFooter,
}: {
  config: ModuleConfig;
  data: DataStore;
  onSaveRecord: (record: Row) => Promise<Row>;
  onDeleteRecord: (record: Row) => Promise<void>;
  defaultValues?: Row;
  selectable?: boolean;
  onSelectionChange?: (rows: Row[]) => void;
  selectionActions?: React.ReactNode;
  detailFooter?: (row: Row) => React.ReactNode;
}) {
  const Icon = config.icon;
  const rows = data[config.key] as Row[];
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(() => searchParams?.get("q") ?? "");
  const [status, setStatus] = useState(() => searchParams?.get("status") ?? "All");
  const [filters, setFilters] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (config.filterFields) {
      for (const key of config.filterFields) {
        const v = searchParams?.get(key);
        if (v) init[key] = v;
      }
    }
    return init;
  });

  // Sync URL params on first mount when navigating from dashboard
  useEffect(() => {
    const urlStatus = searchParams?.get("status");
    if (urlStatus && urlStatus !== "All") setStatus(urlStatus);
    const urlQ = searchParams?.get("q");
    if (urlQ) setQuery(urlQ);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [editing, setEditing] = useState<Row | null>(null);
  const [newDefaults, setNewDefaults] = useState<Row>({});
  const [selected, setSelected] = useState<Row | null>(rows[0] ?? null);
  const [checkedIds, setCheckedIds] = useState(new Set<string>());
  const [formOpen, setFormOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const values = rows.map((row) => String(row.status ?? "")).filter(Boolean);
    return ["All", ...Array.from(new Set(values))];
  }, [rows]);

  // Per-field unique values for multi-filter dropdowns
  const filterOptions = useMemo(() => {
    if (!config.filterFields) return {};
    return Object.fromEntries(
      config.filterFields.map((key) => {
        const values = rows.map((row) => String(row[key] ?? "")).filter(Boolean);
        return [key, ["All", ...Array.from(new Set(values)).sort()]];
      }),
    );
  }, [config.filterFields, rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesStatus = config.filterFields
        ? config.filterFields.every((key) => !filters[key] || filters[key] === "All" || row[key] === filters[key])
        : status === "All" || row.status === status;
      const matchesQuery =
        !needle ||
        config.searchFields.some((field) => String(row[field] ?? "").toLowerCase().includes(needle));
      return matchesStatus && matchesQuery;
    });
  }, [config.filterFields, config.searchFields, filters, query, rows, status]);

  function toggleCheck(id: string, allFiltered: Row[]) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      onSelectionChange?.(allFiltered.filter((r) => next.has(String(r.id))));
      return next;
    });
  }

  function toggleAll(allFiltered: Row[]) {
    setCheckedIds((prev) => {
      const allChecked = allFiltered.every((r) => prev.has(String(r.id)));
      const next = allChecked ? new Set<string>() : new Set(allFiltered.map((r) => String(r.id)));
      onSelectionChange?.(allChecked ? [] : allFiltered);
      return next;
    });
  }

  function openNew() {
    setEditing(null);
    const autoRefs: Row = {};
    for (const field of config.fields) {
      if (field.refPrefix) {
        autoRefs[field.key] = nextRef(rows, field.key, field.refPrefix);
      }
    }
    setNewDefaults({ ...defaultValues, ...autoRefs });
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
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap">
            <label className="relative min-w-0 flex-1 sm:min-w-52">
              <span className="sr-only">Search {config.title}</span>
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input className="pl-9" placeholder={`Search ${config.title.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} onInput={(event) => setQuery(event.currentTarget.value)} />
            </label>
            {config.filterFields ? (
              config.filterFields.map((key) => (
                <label key={key} className="w-full sm:w-44">
                  <span className="sr-only">{key} filter</span>
                  <Select value={filters[key] ?? "All"} onChange={(event) => setFilters((prev) => ({ ...prev, [key]: event.target.value }))}>
                    {(filterOptions[key] ?? ["All"]).map((opt) => (
                      <option key={opt} value={opt}>{opt === "All" ? `All ${key}s` : opt}</option>
                    ))}
                  </Select>
                </label>
              ))
            ) : (
              <label className="w-full sm:w-52">
                <span className="sr-only">Status filter</span>
                <Select value={status} onChange={(event) => setStatus(event.target.value)}>
                  {statuses.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectable && checkedIds.size > 0 && selectionActions}
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add {config.singular}
            </Button>
          </div>
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
                  {selectable && (
                    <th className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={filtered.length > 0 && filtered.every((r) => checkedIds.has(String(r.id)))}
                        onChange={() => toggleAll(filtered)}
                        className="h-4 w-4 rounded border-muted-foreground/40"
                      />
                    </th>
                  )}
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
                      selectable && checkedIds.has(String(row.id)) && "bg-primary/5",
                    )}
                  >
                    {selectable && (
                      <td className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select row ${String(row.id)}`}
                          checked={checkedIds.has(String(row.id))}
                          onChange={() => toggleCheck(String(row.id), filtered)}
                          className="h-4 w-4 rounded border-muted-foreground/40"
                        />
                      </td>
                    )}
                    {config.columns.map((column) => (
                      <td key={column.key} className="max-w-[360px] px-4 py-3 align-top">
                        {column.type === "status" ? (
                          <StatusBadge value={String(row[column.key] ?? "")} />
                        ) : column.type === "priority" || column.type === "impact" ? (
                          <PriorityBadge value={String(row[column.key] ?? "")} />
                        ) : column.type === "exposure" ? (() => {
                          const { label, bg, color } = exposureRating(String(row.impact ?? ""), String(row.probability ?? ""));
                          return (
                            <span style={{ background: bg, color, padding: "2px 10px", borderRadius: "4px", fontWeight: 600, fontSize: "12px", display: "inline-block" }}>
                              {label}
                            </span>
                          );
                        })() : column.type === "readiness" ? (
                          <div className="flex gap-1.5 items-center" title="Dev · SIT · UAT · Deploy">
                            {(["development_status", "sit_status", "uat_status", "deployment_status"] as const).map((key) => (
                              <span
                                key={key}
                                title={String(row[key] ?? "Not Started")}
                                style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: readinessDot(String(row[key] ?? "")) }}
                              />
                            ))}
                          </div>
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
          <>
          <dl className="mt-4 space-y-3">
            {config.fields.map((field) => {
              const raw = selected[field.key];
              const strVal = String(raw ?? "");
              const isEmpty = raw === null || raw === undefined || raw === "";
              return (
                <div key={field.key} className="rounded-md bg-muted/60 p-3">
                  <dt className="text-xs font-semibold uppercase text-muted-foreground">{field.label}</dt>
                  <dd className="mt-1 text-sm">
                    {field.badge && !isEmpty ? (
                      <span
                        style={{
                          background: SOURCE_BADGE[strVal]?.bg ?? "#f1f5f9",
                          color: SOURCE_BADGE[strVal]?.color ?? "#475569",
                          padding: "2px 10px",
                          borderRadius: "4px",
                          fontWeight: 600,
                          fontSize: "12px",
                          display: "inline-block",
                        }}
                      >
                        {strVal}
                      </span>
                    ) : (
                      <span className="whitespace-pre-wrap">{displayValue(raw, field.type)}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {detailFooter ? (
            <div className="mt-4 border-t pt-4">{detailFooter(selected)}</div>
          ) : null}
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Select a row to inspect details.</p>
        )}
      </aside>

      <FormDialog config={config} record={editing ?? (formOpen && !editing ? newDefaults : null)} open={formOpen} onClose={() => setFormOpen(false)} onSave={saveRecord} existingRecords={rows} />
    </div>
  );
}
