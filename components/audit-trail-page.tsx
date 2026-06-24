"use client";

import {
  Activity, ArrowRight, CalendarClock, CheckCircle2, CircleDot,
  Filter, Flame, Search, ShieldAlert, Trash2, TrendingDown,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadingState } from "@/components/data-state";
import { getAuditLog, formatAuditChange } from "@/lib/audit";
import { loadData } from "@/lib/supabase/data-store";
import { selectCanonicalProjects } from "@/lib/project-scope";
import type { AuditActionType, AuditFilter, AuditLog, Project } from "@/lib/types";
import { cn } from "@/lib/utils";

const ENTITY_LABELS: Record<string, string> = {
  projects: "Project",
  requirements: "Requirement",
  risks: "Risk",
  decisions: "Decision",
  actions: "Action",
  deliverables: "Deliverable",
  milestones: "Milestone",
  timeline_items: "Timeline",
  test_cases: "Test Case",
  email_settings: "Email Settings",
};

const ACTION_TYPES: AuditActionType[] = [
  "Create", "Delete", "Status Change", "Health Change",
  "Date Change", "Severity Change", "Progress Change", "Schedule Change",
];

const ACTION_COLORS: Record<AuditActionType, string> = {
  "Create": "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40",
  "Delete": "text-red-700 bg-red-50 dark:bg-red-950/40",
  "Status Change": "text-sky-700 bg-sky-50 dark:bg-sky-950/40",
  "Health Change": "text-amber-700 bg-amber-50 dark:bg-amber-950/40",
  "Date Change": "text-violet-700 bg-violet-50 dark:bg-violet-950/40",
  "Severity Change": "text-orange-700 bg-orange-50 dark:bg-orange-950/40",
  "Progress Change": "text-blue-700 bg-blue-50 dark:bg-blue-950/40",
  "Schedule Change": "text-rose-700 bg-rose-50 dark:bg-rose-950/40",
  "Update": "text-muted-foreground bg-muted",
};

const ACTION_ICONS: Record<AuditActionType, typeof Activity> = {
  "Create": CheckCircle2,
  "Delete": Trash2,
  "Status Change": CircleDot,
  "Health Change": Flame,
  "Date Change": CalendarClock,
  "Severity Change": ShieldAlert,
  "Progress Change": Activity,
  "Schedule Change": TrendingDown,
  "Update": ArrowRight,
};

function fmt(isoString: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(isoString));
}

function AuditRow({ entry }: { entry: AuditLog }) {
  const Icon = ACTION_ICONS[entry.action_type] ?? ArrowRight;
  const color = ACTION_COLORS[entry.action_type] ?? ACTION_COLORS["Update"];

  return (
    <tr className="border-t hover:bg-muted/30">
      <td className="px-4 py-3">
        <span className={cn("inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium", color)}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {entry.action_type}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
          {ENTITY_LABELS[entry.entity_type] ?? entry.entity_type}
        </span>
      </td>
      <td className="max-w-xs px-4 py-3 text-sm">
        <p className="truncate font-medium">{entry.entity_name}</p>
        {entry.field_name && (
          <p className="truncate text-xs text-muted-foreground">{formatAuditChange(entry)}</p>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">{entry.changed_by_name}</td>
      <td className="whitespace-nowrap px-4 py-3 text-sm text-muted-foreground">{fmt(entry.changed_at)}</td>
    </tr>
  );
}

function Select({ value, onChange, children, className }: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </select>
  );
}

const PAGE_SIZE = 50;

export function AuditTrailPage() {
  const [entries, setEntries] = useState<AuditLog[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [filterProject, setFilterProject] = useState("");
  const [filterEntity, setFilterEntity] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let active = true;
    loadData().then((data) => {
      if (!active) return;
      setProjects(selectCanonicalProjects(data));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const filter: AuditFilter = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (filterProject) filter.projectId = filterProject;
    if (filterEntity) filter.entityType = filterEntity;
    if (filterAction) filter.actionType = filterAction as AuditActionType;
    if (filterFrom) filter.from = filterFrom;
    if (filterTo) filter.to = filterTo + "T23:59:59Z";

    getAuditLog(filter).then((data) => {
      if (active) { setEntries(data); setLoading(false); }
    });

    return () => { active = false; };
  }, [filterProject, filterEntity, filterAction, filterFrom, filterTo, page]);

  // Reset page on filter change
  function applyFilter(setter: (v: string) => void) {
    return (v: string) => { setter(v); setPage(0); };
  }

  const filtered = useMemo(() => {
    if (!searchText.trim()) return entries;
    const q = searchText.toLowerCase();
    return entries.filter(
      (e) =>
        e.entity_name.toLowerCase().includes(q) ||
        e.changed_by_name.toLowerCase().includes(q) ||
        (e.old_value ?? "").toLowerCase().includes(q) ||
        (e.new_value ?? "").toLowerCase().includes(q),
    );
  }, [entries, searchText]);

  const hasFilters = filterProject || filterEntity || filterAction || filterFrom || filterTo;

  function clearFilters() {
    setFilterProject(""); setFilterEntity(""); setFilterAction("");
    setFilterFrom(""); setFilterTo(""); setSearchText(""); setPage(0);
  }

  return (
    <AppShell>
      <div>
        <p className="text-sm font-medium text-primary">Governance</p>
        <h2 className="mt-1 text-2xl font-semibold">Audit Trail</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Complete change history — who changed what, when, and from which value.
          Use for project governance, root cause analysis, and management reporting.
        </p>
      </div>

      {/* Filters */}
      <div className="mt-5 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Search */}
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              placeholder="Search entity name, user…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {/* Project */}
          <Select value={filterProject} onChange={applyFilter(setFilterProject)} className="min-w-[160px]">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>

          {/* Entity type */}
          <Select value={filterEntity} onChange={applyFilter(setFilterEntity)}>
            <option value="">All entity types</option>
            {Object.entries(ENTITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>

          {/* Action type */}
          <Select value={filterAction} onChange={applyFilter(setFilterAction)}>
            <option value="">All actions</option>
            {ACTION_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>

          {/* Date range */}
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => { applyFilter(setFilterFrom)(e.target.value); }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="From date"
          />
          <input
            type="date"
            value={filterTo}
            onChange={(e) => { applyFilter(setFilterTo)(e.target.value); }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="To date"
          />

          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm text-muted-foreground hover:bg-muted"
            >
              <Filter className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="mt-4 rounded-lg border bg-card shadow-operational">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium text-muted-foreground">
            {loading ? "Loading…" : `${filtered.length} entries`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-muted"
            >
              Previous
            </button>
            <span className="text-xs text-muted-foreground">Page {page + 1}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={entries.length < PAGE_SIZE || loading}
              className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-muted"
            >
              Next
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-6"><LoadingState /></div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <Activity className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">No audit entries found</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {hasFilters ? "Try adjusting the filters." : "Changes will appear here once data is saved."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Entity Type</th>
                  <th className="px-4 py-3">What Changed</th>
                  <th className="px-4 py-3">Changed By</th>
                  <th className="px-4 py-3">When</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manager Exception Summary */}
      <ManagerExceptionSummary entries={filtered} />
    </AppShell>
  );
}

function ManagerExceptionSummary({ entries }: { entries: AuditLog[] }) {
  const exceptions = useMemo(() => {
    const healthChanges = entries.filter((e) => e.action_type === "Health Change");
    const dateChanges = entries.filter((e) =>
      e.action_type === "Date Change" &&
      ["milestones", "projects"].includes(e.entity_type),
    );
    const riskEscalations = entries.filter((e) =>
      e.action_type === "Severity Change" && e.entity_type === "risks" &&
      ["High", "Critical"].includes(e.new_value ?? ""),
    );
    const scheduleChanges = entries.filter((e) => e.action_type === "Schedule Change");
    return { healthChanges, dateChanges, riskEscalations, scheduleChanges };
  }, [entries]);

  const hasAny =
    exceptions.healthChanges.length +
    exceptions.dateChanges.length +
    exceptions.riskEscalations.length +
    exceptions.scheduleChanges.length > 0;

  if (!hasAny) return null;

  return (
    <section
      className="mt-4 rounded-lg border bg-card p-4 shadow-operational"
      aria-labelledby="exception-summary-title"
    >
      <h3 id="exception-summary-title" className="mb-3 font-semibold">Manager Exception Summary</h3>
      <p className="mb-4 text-sm text-muted-foreground">
        Governance-critical changes only — filtered from the current result set.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ExceptionCard
          label="Health changes"
          count={exceptions.healthChanges.length}
          color="text-amber-700 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900"
          entries={exceptions.healthChanges}
        />
        <ExceptionCard
          label="Milestone / project date changes"
          count={exceptions.dateChanges.length}
          color="text-violet-700 bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-900"
          entries={exceptions.dateChanges}
        />
        <ExceptionCard
          label="Risk escalations to High / Critical"
          count={exceptions.riskEscalations.length}
          color="text-rose-700 bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
          entries={exceptions.riskEscalations}
        />
        <ExceptionCard
          label="Schedule variance changes"
          count={exceptions.scheduleChanges.length}
          color="text-orange-700 bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-900"
          entries={exceptions.scheduleChanges}
        />
      </div>
    </section>
  );
}

function ExceptionCard({
  label, count, color, entries,
}: {
  label: string;
  count: number;
  color: string;
  entries: AuditLog[];
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className={cn("rounded-lg border p-3", color)}>
      <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{count}</p>
      {entries.length > 0 && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-2 text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
        >
          {open ? "Hide" : "Show details"}
        </button>
      )}
      {open && (
        <ul className="mt-2 space-y-1">
          {entries.slice(0, 5).map((e) => (
            <li key={e.id} className="text-xs">
              {formatAuditChange(e)}
            </li>
          ))}
          {entries.length > 5 && (
            <li className="text-xs opacity-70">+{entries.length - 5} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
