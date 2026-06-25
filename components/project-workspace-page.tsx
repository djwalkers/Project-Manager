"use client";

import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  CircleHelp,
  Flag,
  PackageCheck,
  Plus,
  Rocket,
  ShieldAlert,
  ShieldQuestion,
  Users,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { FormDialog } from "@/components/form-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { WorkspaceEmpty, WorkspaceMetric, WorkspaceSection } from "@/components/workspace-components";
import type { DataStore } from "@/lib/data-store";
import { moduleByKey, type ModuleConfig } from "@/lib/modules";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import { buildProjectIntelligence } from "@/lib/project-intelligence";
import { buildGoLiveDashboard } from "@/lib/go-live-readiness";
import { buildProjectWorkspace, type WorkspaceActionColumn } from "@/lib/project-workspace";
import { formatScheduleDate } from "@/lib/schedule";
import { createRecord, saveRecord } from "@/lib/supabase/data-store";
import type { ActionItem, ActivityLog, EntityMap, EntityName } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";
import { cn, isOverdue } from "@/lib/utils";

type Row = Record<string, unknown>;
type WorkspaceDialog = { config: ModuleConfig; record: Row } | null;

const quickActions: Array<{ key: "actions" | "decisions" | "discovery_questions" | "risks" | "requirements" | "deliverables"; label: string; icon: typeof Plus; defaults: Row }> = [
  { key: "deliverables", label: "Add Deliverable", icon: PackageCheck, defaults: { status: "Not Started", priority: "Medium", development_status: "Not Started", sit_status: "Not Started", uat_status: "Not Started", deployment_status: "Not Started" } },
  { key: "actions", label: "Add Action", icon: ClipboardCheck, defaults: { status: "Open" } },
  { key: "decisions", label: "Add Decision", icon: ShieldQuestion, defaults: { status: "Open" } },
  { key: "discovery_questions", label: "Add Discovery Question", icon: CircleHelp, defaults: { status: "Open", category: "Business Rule" } },
  { key: "risks", label: "Add Risk", icon: ShieldAlert, defaults: { status: "Open", impact: "Medium", probability: "Medium" } },
  { key: "requirements", label: "Add Requirement", icon: Flag, defaults: { status: "Open", priority: "Medium", category: "Business Rule" } },
];

const actionStatuses: WorkspaceActionColumn[] = ["Open", "In Progress", "Complete"];

function mergeRecord<K extends EntityName>(data: DataStore, table: K, saved: EntityMap[K]): DataStore {
  const rows = data[table] as EntityMap[K][];
  const exists = rows.some((row) => row.id === saved.id);
  return { ...data, [table]: exists ? rows.map((row) => row.id === saved.id ? saved : row) : [saved, ...rows] } as DataStore;
}

function recordLabel(table: EntityName, record: Row) {
  const fields: Partial<Record<EntityName, string[]>> = {
    actions: ["action_ref", "description"],
    decisions: ["decision_ref", "question"],
    discovery_questions: ["question_ref", "question"],
    risks: ["risk_ref", "description"],
    requirements: ["requirement_ref", "title"],
    deliverables: ["deliverable_ref", "title"],
  };
  return fields[table]?.map((field) => String(record[field] ?? "")).find(Boolean) ?? "record";
}

function displayDate(value?: string | null) {
  return value ? formatScheduleDate(value) : "Not set";
}

function SignalChip({ href, icon: Icon, label, count, variant = "default" }: { href: string; icon: typeof Flag; label: string; count: number; variant?: "default" | "warn" }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        variant === "warn" && count > 0 ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" : "bg-card",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
      <span className={cn("ml-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums", count > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{count}</span>
    </Link>
  );
}

function GoLiveStrip({ data, projectId }: { data: DataStore; projectId: string }) {
  const project = data.projects.find((p) => p.id === projectId) ?? data.projects[0];
  if (!project) return null;
  const dashboard = buildGoLiveDashboard(data, project);
  if (dashboard.readinessPercent === 0 && dashboard.totalItems === 0) return null;

  const statusColor = dashboard.status === "Green" ? "text-emerald-600" : dashboard.status === "Amber" ? "text-amber-600" : "text-red-600";
  const StatusIcon = dashboard.status === "Green" ? CheckCircle2 : dashboard.status === "Amber" ? AlertTriangle : XCircle;
  const bgColor = dashboard.status === "Green" ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20" : dashboard.status === "Amber" ? "border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20" : "border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/20";

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${bgColor}`}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1.5 font-semibold">
          <Rocket className="h-4 w-4 text-primary" aria-hidden="true" />
          Go-Live Readiness
        </div>
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-4 w-4 shrink-0 ${statusColor}`} aria-hidden="true" />
          <span className={`font-semibold ${statusColor}`}>{dashboard.status === "Green" ? "Go" : dashboard.status === "Amber" ? "Caution" : "No Go"}</span>
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">{dashboard.readinessPercent}% ready ({dashboard.completedItems}/{dashboard.totalItems})</span>
        </div>
        {dashboard.blockerCount > 0 && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-400">{dashboard.blockerCount} blocker{dashboard.blockerCount !== 1 ? "s" : ""}</span>}
        {dashboard.daysToGoLive !== null && (
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${dashboard.daysToGoLive < 0 ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400" : dashboard.daysToGoLive <= 7 ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}>
            {dashboard.daysToGoLive < 0 ? `${Math.abs(dashboard.daysToGoLive)}d overdue` : `${dashboard.daysToGoLive}d to go-live`}
          </span>
        )}
      </div>
      <Link href="/go-live-readiness" className="inline-flex min-h-8 items-center rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted">View details</Link>
    </div>
  );
}

export function ProjectWorkspacePage() {
  const { data, setData, error, reload } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const [savingStatusId, setSavingStatusId] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const projects = useMemo(() => data ? selectCanonicalProjects(data) : [], [data]);
  const project = data ? selectProjectById(data, selectedProjectId) : null;
  const workspace = useMemo(() => data && project ? buildProjectWorkspace(data, project) : null, [data, project]);
  const intelligence = useMemo(() => data && project ? buildProjectIntelligence(data, project) : null, [data, project]);

  useEffect(() => {
    if (!projects.length) return;
    const stored = loadSelectedProjectId();
    const next = projects.some((item) => item.id === stored) ? stored : selectProjectById(data as DataStore, null)?.id ?? projects[0].id;
    setSelectedProjectId(next);
    if (next) persistSelectedProjectId(next);
  }, [data, projects]);

  function chooseProject(projectId: string) {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
    setOperationMessage(null);
  }

  function openCreate(action: typeof quickActions[number]) {
    if (!project) return;
    const config = moduleByKey.get(action.key);
    if (config) setDialog({ config, record: { ...action.defaults, project_id: project.id } });
  }

  async function persistWorkspaceRecord(table: EntityName, record: Row, activityType?: string) {
    if (!project || !data) throw new Error("Select a project before saving a record");
    setOperationMessage(null);
    const existed = Boolean(record.id);
    const saved = await saveRecord(table, { ...record, project_id: project.id });
    let activity: ActivityLog | null = null;
    try {
      activity = await createRecord("activity_log", {
        project_id: project.id,
        activity_type: activityType ?? (existed ? `${moduleByKey.get(table)?.singular ?? "Record"} updated` : `${moduleByKey.get(table)?.singular ?? "Record"} added`),
        description: `${recordLabel(table, saved as Row)} ${existed ? "was updated" : "was added"} in Project Workspace.`,
      });
    } catch {
      setOperationMessage("The record was saved, but its activity entry could not be created.");
    }
    setData((current) => {
      if (!current) return current;
      const withRecord = mergeRecord(current, table, saved);
      return activity ? mergeRecord(withRecord, "activity_log", activity) : withRecord;
    });
    if (activity) setOperationMessage(`${moduleByKey.get(table)?.singular ?? "Record"} saved.`);
  }

  async function saveDialogRecord(record: Row) {
    if (!dialog) return;
    await persistWorkspaceRecord(dialog.config.key, record);
    setDialog(null);
  }

  async function changeActionStatus(action: ActionItem, status: WorkspaceActionColumn) {
    if (action.status === status || (status === "Complete" && action.status === "Closed")) return;
    setSavingStatusId(action.id);
    try {
      await persistWorkspaceRecord("actions", { ...action, status }, "Status change");
    } catch (saveError) {
      setOperationMessage(saveError instanceof Error ? saveError.message : "Failed to update action status");
    } finally {
      setSavingStatusId(null);
    }
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!projects.length || !project || !workspace || !intelligence) return <AppShell><EmptyState title="No projects available" description="Add a project before opening the operational workspace." icon={Users} /></AppShell>;

  const findingCount = intelligence.critical.length + intelligence.warnings.length;
  const nextDeliverable = [...(data.deliverables ?? [])]
    .filter((d) => d.project_id === project.id && !["Deployed", "Complete"].includes(String(d.status ?? "")))
    .sort((a, b) => String(a.planned_completion_date ?? "9999").localeCompare(String(b.planned_completion_date ?? "9999")))[0] ?? null;

  return (
    <AppShell>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div><p className="text-sm font-medium text-primary">Workstream control centre</p><h2 className="mt-1 text-2xl font-semibold">Workspace</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Operational view for the selected project. Track delivery signals, actions and next commitments.</p></div>
        <label className="w-full text-sm font-medium sm:w-80"><span className="mb-2 block">Selected project</span><Select value={project.id} onChange={(event) => chooseProject(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      </div>

      {operationMessage ? <div className="mt-4 rounded-md border bg-card p-3 text-sm" role="status">{operationMessage}</div> : null}

      {/* Project summary */}
      <section className="mt-5 overflow-hidden rounded-lg border bg-card shadow-operational" aria-labelledby="workspace-project-summary">
        <div className="border-b bg-primary/[0.04] p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div><p className="text-sm font-medium text-primary">{project.customer} / {project.workstream}</p><h3 id="workspace-project-summary" className="mt-1 text-2xl font-semibold">{project.name}</h3><p className="mt-2 max-w-3xl text-sm text-muted-foreground">{project.description || "Operational project summary and live delivery controls."}</p></div>
            <div className="flex flex-wrap gap-2"><StatusBadge value={workspace.projectHealth} /><StatusBadge value={workspace.scheduleHealth} /></div>
          </div>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <WorkspaceMetric label="Project Health"><StatusBadge value={workspace.projectHealth} /></WorkspaceMetric>
          <WorkspaceMetric label="Schedule Health"><StatusBadge value={workspace.scheduleHealth} /></WorkspaceMetric>
          <WorkspaceMetric label="Progress" value={`${workspace.progress}%`} />
          <WorkspaceMetric label="Days Remaining" value={workspace.schedule.daysRemaining ?? "Review"} />
          <WorkspaceMetric label="Active Phase" value={<span className="text-base">{workspace.activePhase}</span>} />
          <WorkspaceMetric label="Next Milestone" value={<span className="text-base">{workspace.nextMilestone?.title ?? "None"}</span>} detail={workspace.nextMilestone ? displayDate(workspace.nextMilestone.target_date) : undefined} />
          <WorkspaceMetric label="Customer" value={<span className="text-base">{project.customer}</span>} />
          <WorkspaceMetric label="Workstream" value={<span className="text-base">{project.workstream}</span>} />
        </div>
        <div className="border-t p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick actions</p>
          <div className="flex flex-wrap gap-2">{quickActions.map((action) => { const Icon = action.icon; return <Button key={action.key} variant="outline" onClick={() => openCreate(action)}><Icon className="h-4 w-4" aria-hidden="true" />{action.label}</Button>; })}</div>
        </div>
      </section>

      {/* Health warnings */}
      {workspace.warnings.length ? (
        <section className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" aria-labelledby="workspace-health-checks">
          <div className="flex items-center gap-2"><CircleAlert className="h-5 w-5" aria-hidden="true" /><h3 id="workspace-health-checks" className="font-semibold">Workspace Health Checks</h3></div>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">{workspace.warnings.map((warning) => <li key={warning} className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />{warning}</li>)}</ul>
        </section>
      ) : null}

      {/* Delivery strip */}
      <section className="mt-5 overflow-hidden rounded-lg border bg-card shadow-operational" aria-labelledby="workspace-delivery">
        <div className="flex flex-col gap-4 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 id="workspace-delivery" className="font-semibold">Delivery Readiness</h3>
          </div>
          <Link href="/deliverables" className="inline-flex min-h-8 items-center rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted">Manage deliverables</Link>
        </div>
        <div className="grid gap-0 divide-x sm:grid-cols-3">
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Completed</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{workspace.deliveryReadiness.completed}<span className="ml-1 text-base font-normal text-muted-foreground">/ {workspace.deliveryReadiness.total}</span></p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Delivery readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={workspace.deliveryReadiness.percent}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${workspace.deliveryReadiness.percent}%` }} />
            </div>
          </div>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next Deliverable</p>
            <p className="mt-1 truncate text-sm font-semibold">{nextDeliverable ? String(nextDeliverable.title ?? "—") : "None outstanding"}</p>
            {nextDeliverable && <p className="mt-1 text-xs text-muted-foreground">{String(nextDeliverable.deliverable_ref ?? "")} · <StatusBadge value={String(nextDeliverable.status ?? "")} /></p>}
          </div>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due Date</p>
            <p className="mt-1 text-sm font-semibold">{nextDeliverable ? displayDate(String(nextDeliverable.planned_completion_date ?? "")) : "—"}</p>
            {nextDeliverable && isOverdue(String(nextDeliverable.planned_completion_date ?? ""), String(nextDeliverable.status ?? "")) && (
              <p className="mt-1 text-xs font-semibold text-red-600">Overdue</p>
            )}
          </div>
        </div>
      </section>

      {/* Go-Live strip */}
      <div className="mt-5">
        <GoLiveStrip data={data} projectId={project.id} />
      </div>

      {/* Attention required */}
      <WorkspaceSection id="workspace-attention" title="Attention Required" description="Severity-sorted blockers, overdue items and aged discovery questions." icon={AlertTriangle} className="mt-5">
        {workspace.attention.length ? (
          <div className="space-y-3">{workspace.attention.map((item) => (
            <article key={item.id} className="rounded-md border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{item.kind}</p><StatusBadge value={item.severity} /></div>
              <p className="mt-2 text-sm font-medium">{item.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.meta}</p>
            </article>
          ))}</div>
        ) : <WorkspaceEmpty>No current blockers or overdue items require attention.</WorkspaceEmpty>}
      </WorkspaceSection>

      {/* Actions board */}
      <WorkspaceSection id="workspace-actions" title="Actions Board" description="Move actions between Open, In Progress and Complete using the visible status controls." icon={ClipboardCheck} className="mt-5">
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">{actionStatuses.map((column) => (
          <div key={column} className="min-w-0 rounded-md border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2"><h4 className="font-semibold">{column}</h4><span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold tabular-nums">{workspace.actionColumns[column].length}</span></div>
            <div className="mt-3 space-y-3">{workspace.actionColumns[column].length ? workspace.actionColumns[column].map((action) => (
              <article key={action.id} className="rounded-md border bg-card p-3">
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-muted-foreground">{action.action_ref}</span><StatusBadge value={action.status} /></div>
                <p className="mt-2 text-sm font-medium">{action.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">{action.owner || "Unassigned"} · {displayDate(action.due_date)}</p>
                <div className="mt-3 grid grid-cols-3 gap-1" aria-label={`Change status for ${action.action_ref}`}>{actionStatuses.map((status) => (
                  <Button key={status} size="sm" variant={column === status ? "secondary" : "ghost"} className="h-auto min-h-10 px-1 text-[11px]" disabled={savingStatusId === action.id || column === status} onClick={() => changeActionStatus(action, status)}>{status}</Button>
                ))}</div>
              </article>
            )) : <WorkspaceEmpty>No {column.toLowerCase()} actions.</WorkspaceEmpty>}</div>
          </div>
        ))}</div>
      </WorkspaceSection>

      {/* Signal bar */}
      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Module quick links">
        <SignalChip href="/project-intelligence" icon={BrainCircuit} label="Intelligence" count={findingCount} variant="warn" />
        <SignalChip href="/risks" icon={ShieldAlert} label="High risks" count={workspace.highRisks.length} variant="warn" />
        <SignalChip href="/decisions" icon={ShieldQuestion} label="Open decisions" count={workspace.openDecisions.length} variant="warn" />
        <SignalChip href="/milestones" icon={Flag} label="Upcoming milestones" count={workspace.upcomingMilestones.length} />
        <SignalChip href="/discovery-questions" icon={CircleHelp} label="Open questions" count={workspace.openQuestions.length} />
      </nav>

      <FormDialog config={dialog?.config ?? moduleByKey.get("actions")!} record={dialog?.record ?? null} open={Boolean(dialog)} onClose={() => setDialog(null)} onSave={saveDialogRecord} />
    </AppShell>
  );
}
