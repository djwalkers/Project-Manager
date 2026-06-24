"use client";

import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Clock,
  GitBranch, ListChecks, Loader2, Plus, Trash2, XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteRecord, saveRecord } from "@/lib/supabase/data-store";

function GoLiveSelect({ value, onChange, children, className, disabled }: { value: string; onChange: (v: string) => void; children: React.ReactNode; className?: string; disabled?: boolean }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  );
}
import { createId } from "@/lib/data-store";
import {
  buildGoLiveDashboard,
  GO_LIVE_CATEGORIES,
  GO_LIVE_CHECKLIST_STATUSES,
  CUTOVER_STEP_STATUSES,
  type GoLiveDashboard,
  type GoLiveStatus,
} from "@/lib/go-live-readiness";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import type { CutoverStep, GoLiveChecklist, GoLiveChecklistCategory, GoLiveChecklistStatus } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";

// ── Status colours ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<GoLiveStatus, { bg: string; border: string; badge: string }> = {
  Green: { bg: "bg-emerald-50 dark:bg-emerald-950/30", border: "border-emerald-300 dark:border-emerald-800", badge: "bg-emerald-600 text-white" },
  Amber: { bg: "bg-amber-50 dark:bg-amber-950/30", border: "border-amber-300 dark:border-amber-800", badge: "bg-amber-500 text-white" },
  Red: { bg: "bg-red-50 dark:bg-red-950/30", border: "border-red-300 dark:border-red-800", badge: "bg-red-600 text-white" },
};

const CHECKLIST_STATUS_COLORS: Record<GoLiveChecklistStatus, string> = {
  "Not Started": "bg-muted text-muted-foreground",
  "In Progress": "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  "Complete": "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  "Blocked": "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  "Waived": "bg-muted text-muted-foreground line-through",
};

// ── Readiness Gauge ────────────────────────────────────────────────────────────

function ReadinessGauge({ percent, status }: { percent: number; status: GoLiveStatus }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <svg className="h-28 w-28 -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/30" />
          <circle
            cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 50}`}
            strokeDashoffset={`${2 * Math.PI * 50 * (1 - percent / 100)}`}
            className={status === "Green" ? "text-emerald-500" : status === "Amber" ? "text-amber-500" : "text-red-600"}
          />
        </svg>
        <div className="absolute text-center">
          <span className="text-2xl font-bold tabular-nums">{percent}%</span>
        </div>
      </div>
      <span className={cn("rounded px-2.5 py-1 text-xs font-bold uppercase tracking-wide", STATUS_COLORS[status].badge)}>
        {status === "Green" ? "Go" : status === "Amber" ? "Caution" : "No Go"}
      </span>
    </div>
  );
}

// ── WMS Readiness Check ────────────────────────────────────────────────────────

function ReadinessCheckRow({ check }: { check: GoLiveDashboard["wmsChecks"][0] }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        {check.complete || check.waived
          ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          : check.blocked
            ? <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            : <div className="h-4 w-4 shrink-0 rounded-full border-2 border-muted-foreground/40" aria-hidden="true" />
        }
        <span className={cn(check.waived && "text-muted-foreground line-through")}>{check.label}</span>
      </div>
      <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", check.complete ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" : check.waived ? "bg-muted text-muted-foreground" : check.blocked ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400" : "bg-muted text-muted-foreground")}>
        {check.checklistItem?.status ?? "Not recorded"}
      </span>
    </div>
  );
}

// ── Checklist Table ─────────────────────────────────────────────────────────────

type ChecklistTableProps = {
  items: GoLiveChecklist[];
  projectId: string;
  onSave: (item: GoLiveChecklist) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

function ChecklistTable({ items, projectId, onSave, onDelete }: ChecklistTableProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Partial<GoLiveChecklist>>({ category: "Requirements", status: "Not Started" });

  const grouped = useMemo(() => {
    const map = new Map<GoLiveChecklistCategory, GoLiveChecklist[]>();
    GO_LIVE_CATEGORIES.forEach((cat) => map.set(cat, []));
    items.forEach((item) => {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    });
    return map;
  }, [items]);

  async function saveDraft() {
    if (!draft.item?.trim()) return;
    const now = new Date().toISOString();
    const newItem: GoLiveChecklist = {
      id: createId(),
      project_id: projectId,
      category: (draft.category as GoLiveChecklistCategory) ?? "Requirements",
      item: draft.item.trim(),
      owner: draft.owner?.trim() || null,
      status: (draft.status as GoLiveChecklistStatus) ?? "Not Started",
      due_date: draft.due_date || null,
      completed_date: null,
      notes: null,
      created_at: now,
      updated_at: now,
    };
    await onSave(newItem);
    setAdding(false);
    setDraft({ category: "Requirements", status: "Not Started" });
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-operational">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
          <h3 className="font-semibold">Go-Live Checklist</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">{items.length}</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add Item
        </Button>
      </div>

      {adding && (
        <div className="border-b bg-muted/30 p-4">
          <p className="mb-3 text-xs font-semibold uppercase text-muted-foreground">New checklist item</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="text-xs font-medium">Category</label>
              <GoLiveSelect value={draft.category ?? "Requirements"} onChange={(v) => setDraft((d) => ({ ...d, category: v as GoLiveChecklistCategory }))} className="mt-1 text-sm">
                {GO_LIVE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </GoLiveSelect>
            </div>
            <div className="xl:col-span-2">
              <label className="text-xs font-medium">Item *</label>
              <Input value={draft.item ?? ""} onChange={(e) => setDraft((d) => ({ ...d, item: e.target.value }))} placeholder="Checklist item description" className="mt-1 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Owner</label>
              <Input value={draft.owner ?? ""} onChange={(e) => setDraft((d) => ({ ...d, owner: e.target.value }))} placeholder="Owner name" className="mt-1 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Status</label>
              <GoLiveSelect value={draft.status ?? "Not Started"} onChange={(v) => setDraft((d) => ({ ...d, status: v as GoLiveChecklistStatus }))} className="mt-1 text-sm">
                {GO_LIVE_CHECKLIST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </GoLiveSelect>
            </div>
            <div>
              <label className="text-xs font-medium">Due date</label>
              <Input type="date" value={draft.due_date ?? ""} onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value || null }))} className="mt-1 text-sm" />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={saveDraft} disabled={!draft.item?.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft({ category: "Requirements", status: "Not Started" }); }}>Cancel</Button>
          </div>
        </div>
      )}

      {items.length === 0 && !adding ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No checklist items yet. Add items to track go-live readiness.</div>
      ) : (
        <div className="overflow-x-auto">
          {GO_LIVE_CATEGORIES.filter((cat) => (grouped.get(cat)?.length ?? 0) > 0).map((category) => (
            <CategoryGroup
              key={category}
              category={category}
              items={grouped.get(category) ?? []}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryGroup({ category, items, onSave, onDelete }: { category: string; items: GoLiveChecklist[]; onSave: (item: GoLiveChecklist) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const completeCount = items.filter((i) => i.status === "Complete" || i.status === "Waived").length;

  return (
    <div className="border-b last:border-b-0">
      <button
        className="flex w-full items-center justify-between gap-2 bg-muted/40 px-4 py-2.5 text-left text-sm font-semibold hover:bg-muted/60"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          {category}
        </span>
        <span className="text-xs font-normal text-muted-foreground">{completeCount} / {items.length}</span>
      </button>
      {open && (
        <table className="w-full min-w-[540px] text-sm">
          <tbody>
            {items.map((item) => (
              <ChecklistRow key={item.id} item={item} onSave={onSave} onDelete={onDelete} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ChecklistRow({ item, onSave, onDelete }: { item: GoLiveChecklist; onSave: (i: GoLiveChecklist) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);

  async function changeStatus(status: string) {
    setSaving(true);
    const updated: GoLiveChecklist = { ...item, status: status as GoLiveChecklistStatus, updated_at: new Date().toISOString(), completed_date: status === "Complete" ? new Date().toISOString().split("T")[0] : item.completed_date };
    await onSave(updated);
    setSaving(false);
  }

  return (
    <tr className="border-t hover:bg-muted/20">
      <td className="w-full px-4 py-3">
        <p className="font-medium">{item.item}</p>
        {item.owner && <p className="mt-0.5 text-xs text-muted-foreground">{item.owner}</p>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{item.due_date ?? "—"}</td>
      <td className="px-4 py-3">
        <GoLiveSelect value={item.status} onChange={changeStatus} disabled={saving} className="min-w-[120px] text-xs">
          {GO_LIVE_CHECKLIST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </GoLiveSelect>
      </td>
      <td className="px-4 py-3">
        <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium", CHECKLIST_STATUS_COLORS[item.status])}>
          {item.status}
        </span>
      </td>
      <td className="px-2 py-3">
        <button onClick={() => onDelete(item.id)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="Delete item">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </td>
    </tr>
  );
}

// ── Cutover Plan Table ─────────────────────────────────────────────────────────

type CutoverTableProps = {
  steps: CutoverStep[];
  projectId: string;
  onSave: (step: CutoverStep) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

function CutoverTable({ steps, projectId, onSave, onDelete }: CutoverTableProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Partial<CutoverStep>>({ status: "Not Started", step_number: (steps.length + 1) });
  const sorted = useMemo(() => [...steps].sort((a, b) => a.step_number - b.step_number), [steps]);

  async function saveDraft() {
    if (!draft.activity?.trim()) return;
    const now = new Date().toISOString();
    const newStep: CutoverStep = {
      id: createId(),
      project_id: projectId,
      step_number: draft.step_number ?? sorted.length + 1,
      activity: draft.activity.trim(),
      owner: draft.owner?.trim() || null,
      planned_time: draft.planned_time?.trim() || null,
      actual_time: null,
      status: (draft.status as CutoverStep["status"]) ?? "Not Started",
      notes: null,
      created_at: now,
      updated_at: now,
    };
    await onSave(newStep);
    setAdding(false);
    setDraft({ status: "Not Started", step_number: sorted.length + 2 });
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-operational">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-primary" aria-hidden="true" />
          <h3 className="font-semibold">Cutover Plan</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">{steps.length}</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add Step
        </Button>
      </div>

      {adding && (
        <div className="border-b bg-muted/30 p-4">
          <p className="mb-3 text-xs font-semibold uppercase text-muted-foreground">New cutover step</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="text-xs font-medium">Step #</label>
              <Input type="number" value={draft.step_number ?? ""} onChange={(e) => setDraft((d) => ({ ...d, step_number: Number(e.target.value) || 1 }))} className="mt-1 text-sm" min={1} />
            </div>
            <div className="xl:col-span-2">
              <label className="text-xs font-medium">Activity *</label>
              <Input value={draft.activity ?? ""} onChange={(e) => setDraft((d) => ({ ...d, activity: e.target.value }))} placeholder="Cutover step description" className="mt-1 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Owner</label>
              <Input value={draft.owner ?? ""} onChange={(e) => setDraft((d) => ({ ...d, owner: e.target.value }))} placeholder="Owner name" className="mt-1 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Planned time</label>
              <Input value={draft.planned_time ?? ""} onChange={(e) => setDraft((d) => ({ ...d, planned_time: e.target.value }))} placeholder="e.g. 22:00 Fri" className="mt-1 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Status</label>
              <GoLiveSelect value={draft.status ?? "Not Started"} onChange={(v) => setDraft((d) => ({ ...d, status: v as CutoverStep["status"] }))} className="mt-1 text-sm">
                {CUTOVER_STEP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </GoLiveSelect>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={saveDraft} disabled={!draft.activity?.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft({ status: "Not Started" }); }}>Cancel</Button>
          </div>
        </div>
      )}

      {steps.length === 0 && !adding ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No cutover steps yet. Add steps to plan your go-live cutover.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[580px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-right">#</th>
                <th className="px-4 py-3">Activity</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Planned</th>
                <th className="px-4 py-3">Actual</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-2 py-3" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((step) => <CutoverRow key={step.id} step={step} onSave={onSave} onDelete={onDelete} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CutoverRow({ step, onSave, onDelete }: { step: CutoverStep; onSave: (s: CutoverStep) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [editingActual, setEditingActual] = useState(false);
  const [actualValue, setActualValue] = useState(step.actual_time ?? "");

  async function changeStatus(status: string) {
    setSaving(true);
    await onSave({ ...step, status: status as CutoverStep["status"], updated_at: new Date().toISOString() });
    setSaving(false);
  }

  async function saveActual() {
    await onSave({ ...step, actual_time: actualValue || null, updated_at: new Date().toISOString() });
    setEditingActual(false);
  }

  return (
    <tr className="border-t hover:bg-muted/20">
      <td className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground tabular-nums">{step.step_number}</td>
      <td className="w-full px-4 py-3 font-medium">{step.activity}</td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{step.owner ?? "—"}</td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{step.planned_time ?? "—"}</td>
      <td className="whitespace-nowrap px-4 py-3 text-xs">
        {editingActual ? (
          <div className="flex items-center gap-1">
            <Input value={actualValue} onChange={(e) => setActualValue(e.target.value)} className="h-7 w-24 text-xs" onBlur={saveActual} autoFocus />
          </div>
        ) : (
          <button className="text-muted-foreground hover:text-foreground" onClick={() => setEditingActual(true)}>{step.actual_time ?? "—"}</button>
        )}
      </td>
      <td className="px-4 py-3">
        <GoLiveSelect value={step.status} onChange={changeStatus} disabled={saving} className="min-w-[110px] text-xs">
          {CUTOVER_STEP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </GoLiveSelect>
      </td>
      <td className="px-2 py-3">
        <button onClick={() => onDelete(step.id)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="Delete step">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </td>
    </tr>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function GoLiveReadinessPage() {
  const { data, error, reload, setData } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProjectId(loadSelectedProjectId());
  }, []);

  const projects = useMemo(() => data ? selectCanonicalProjects(data) : [], [data]);
  const project = useMemo(() => data ? (selectedProjectId ? selectProjectById(data, selectedProjectId) : (projects[0] ?? null)) : null, [data, selectedProjectId, projects]);

  const dashboard: GoLiveDashboard | null = useMemo(() =>
    data && project ? buildGoLiveDashboard(data, project) : null, [data, project]);

  const checklists = useMemo(() =>
    (data?.go_live_checklists ?? []).filter((c) => c.project_id === project?.id), [data, project]);

  const cutoverSteps = useMemo(() =>
    (data?.cutover_plan ?? []).filter((c) => c.project_id === project?.id), [data, project]);

  const handleProjectChange = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
  }, []);

  async function saveChecklist(item: GoLiveChecklist) {
    const saved = await saveRecord("go_live_checklists", item);
    setData((prev) => {
      if (!prev) return prev;
      const existing = prev.go_live_checklists.some((c) => c.id === item.id);
      return {
        ...prev,
        go_live_checklists: existing
          ? prev.go_live_checklists.map((c) => c.id === item.id ? (saved ?? item) : c)
          : [saved ?? item, ...prev.go_live_checklists],
      };
    });
  }

  async function deleteChecklist(id: string) {
    await deleteRecord("go_live_checklists", id);
    setData((prev) => prev ? { ...prev, go_live_checklists: prev.go_live_checklists.filter((c) => c.id !== id) } : prev);
  }

  async function saveCutover(step: CutoverStep) {
    const saved = await saveRecord("cutover_plan", step);
    setData((prev) => {
      if (!prev) return prev;
      const existing = prev.cutover_plan.some((c) => c.id === step.id);
      return {
        ...prev,
        cutover_plan: existing
          ? prev.cutover_plan.map((c) => c.id === step.id ? (saved ?? step) : c)
          : [saved ?? step, ...prev.cutover_plan],
      };
    });
  }

  async function deleteCutover(id: string) {
    await deleteRecord("cutover_plan", id);
    setData((prev) => prev ? { ...prev, cutover_plan: prev.cutover_plan.filter((c) => c.id !== id) } : prev);
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  const cfg = dashboard ? STATUS_COLORS[dashboard.status] : null;
  const StatusIcon = dashboard ? (dashboard.status === "Green" ? CheckCircle2 : dashboard.status === "Amber" ? AlertTriangle : XCircle) : CheckCircle2;

  return (
    <AppShell>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Delivery</p>
          <h2 className="mt-1 text-2xl font-semibold">Go-Live Readiness</h2>
          <p className="mt-1 text-sm text-muted-foreground">Checklist, cutover plan, and go / no-go status.</p>
        </div>
        {projects.length > 1 && (
          <GoLiveSelect value={project?.id ?? ""} onChange={handleProjectChange} className="w-full sm:w-64">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </GoLiveSelect>
        )}
      </div>

      {!project ? (
        <div className="mt-8 text-center text-sm text-muted-foreground">No projects found. Create a project to track go-live readiness.</div>
      ) : dashboard ? (
        <>
          {/* Dashboard summary */}
          <div className={cn("mt-5 rounded-lg border p-5 shadow-operational", cfg?.bg, cfg?.border)}>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
              <div className="shrink-0">
                <ReadinessGauge percent={dashboard.readinessPercent} status={dashboard.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusIcon className={cn("h-5 w-5", dashboard.status === "Green" ? "text-emerald-600" : dashboard.status === "Amber" ? "text-amber-600" : "text-red-600")} aria-hidden="true" />
                  <h3 className="text-lg font-semibold">{project.name}</h3>
                  {dashboard.goLiveDate && (
                    <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> Go-live: {dashboard.goLiveDate}
                      {dashboard.daysToGoLive !== null && (
                        <span className={cn("ml-1 font-semibold", dashboard.daysToGoLive < 0 ? "text-red-600" : dashboard.daysToGoLive <= 7 ? "text-amber-600" : "text-emerald-600")}>
                          ({dashboard.daysToGoLive < 0 ? `${Math.abs(dashboard.daysToGoLive)}d overdue` : `${dashboard.daysToGoLive}d`})
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    { label: "Blockers", value: dashboard.blockerCount, alert: dashboard.blockerCount > 0 },
                    { label: "Open Risks", value: dashboard.openRisks, alert: dashboard.openCriticalRisks > 0 },
                    { label: "Critical Risks", value: dashboard.openCriticalRisks, alert: dashboard.openCriticalRisks > 0 },
                    { label: "Decisions", value: dashboard.outstandingDecisions, alert: dashboard.outstandingDecisions > 0 },
                    { label: "Deliverables", value: dashboard.outstandingDeliverables, alert: false },
                    { label: "Tests Outstanding", value: dashboard.outstandingTesting, alert: false },
                  ].map(({ label, value, alert }) => (
                    <div key={label} className="rounded-md border bg-card/70 p-2 text-center">
                      <p className={cn("text-xl font-bold tabular-nums", alert && value > 0 ? "text-red-600 dark:text-red-400" : "")}>{value}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* WMS/SAP Readiness Checks */}
          <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational">
            <div className="flex items-center gap-2 border-b pb-3">
              <ClipboardList className="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 className="font-semibold">WMS / SAP Readiness Checks</h3>
            </div>
            <div className="mt-2 divide-y">
              {dashboard.wmsChecks.map((check) => (
                <ReadinessCheckRow key={check.id} check={check} />
              ))}
            </div>
          </section>

          {/* Checklist and Cutover Plan */}
          <div className="mt-5 space-y-5">
            <ChecklistTable
              items={checklists}
              projectId={project.id}
              onSave={saveChecklist}
              onDelete={deleteChecklist}
            />
            <CutoverTable
              steps={cutoverSteps}
              projectId={project.id}
              onSave={saveCutover}
              onDelete={deleteCutover}
            />
          </div>
        </>
      ) : null}
    </AppShell>
  );
}
