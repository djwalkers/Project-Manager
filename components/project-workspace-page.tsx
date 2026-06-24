"use client";

import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CalendarClock,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  FileQuestion,
  Flag,
  Gauge,
  GitPullRequestArrow,
  ListChecks,
  MessageSquareText,
  PackageCheck,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldQuestion,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { FormDialog } from "@/components/form-dialog";
import { IntelligenceFindingCard } from "@/components/intelligence-components";
import { PriorityBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { WorkspaceEmpty, WorkspaceMetric, WorkspaceSection } from "@/components/workspace-components";
import type { DataStore } from "@/lib/data-store";
import { moduleByKey, type ModuleConfig } from "@/lib/modules";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import { buildProjectIntelligence } from "@/lib/project-intelligence";
import { buildProjectWorkspace, type WorkspaceActionColumn } from "@/lib/project-workspace";
import { RecentChangesPanel } from "@/components/recent-changes-panel";
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
  { key: "requirements", label: "Add Requirement", icon: ListChecks, defaults: { status: "Open", priority: "Medium", category: "Business Rule" } },
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

  function openEdit(table: "decisions" | "discovery_questions", record: Row) {
    const config = moduleByKey.get(table);
    if (config) setDialog({ config, record });
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

  const topFindings = [...intelligence.critical, ...intelligence.warnings].slice(0, 3);

  return (
    <AppShell>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div><p className="text-sm font-medium text-primary">Single-project delivery control</p><h2 className="mt-1 text-2xl font-semibold">Project Workspace</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Manage the selected project’s delivery signals, decisions, actions and next commitments from one operational view.</p></div>
        <label className="w-full text-sm font-medium sm:w-80"><span className="mb-2 block">Selected project</span><Select value={project.id} onChange={(event) => chooseProject(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      </div>

      {operationMessage ? <div className="mt-4 rounded-md border bg-card p-3 text-sm" role="status">{operationMessage}</div> : null}

      <section className="mt-5 overflow-hidden rounded-lg border bg-card shadow-operational" aria-labelledby="workspace-project-summary">
        <div className="border-b bg-primary/[0.04] p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div><p className="text-sm font-medium text-primary">{project.customer} / {project.workstream}</p><h3 id="workspace-project-summary" className="mt-1 text-2xl font-semibold">{project.name}</h3><p className="mt-2 max-w-3xl text-sm text-muted-foreground">{project.description || "Operational project summary and live delivery controls."}</p></div><div className="flex flex-wrap gap-2"><StatusBadge value={workspace.projectHealth} /><StatusBadge value={workspace.scheduleHealth} /></div></div>
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
        <div className="border-t p-4"><p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick actions</p><div className="flex flex-wrap gap-2">{quickActions.map((action) => { const Icon = action.icon; return <Button key={action.key} variant="outline" onClick={() => openCreate(action)}><Icon className="h-4 w-4" aria-hidden="true" />{action.label}</Button>; })}</div></div>
      </section>

      {workspace.warnings.length ? <section className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" aria-labelledby="workspace-health-checks"><div className="flex items-center gap-2"><CircleAlert className="h-5 w-5" aria-hidden="true" /><h3 id="workspace-health-checks" className="font-semibold">Workspace Health Checks</h3></div><ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">{workspace.warnings.map((warning) => <li key={warning} className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />{warning}</li>)}</ul></section> : null}

      <WorkspaceSection id="workspace-intelligence" title="Project Intelligence" description="Top deterministic findings from the current project control data." icon={BrainCircuit} className="mt-5" action={<Link href="/project-intelligence" className="inline-flex min-h-10 items-center rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">View intelligence</Link>}>
        {topFindings.length ? <div className="grid gap-3 lg:grid-cols-3">{topFindings.map((item) => <IntelligenceFindingCard key={item.id} finding={item} compact />)}</div> : <WorkspaceEmpty>No critical or warning findings detected.</WorkspaceEmpty>}
      </WorkspaceSection>

      <WorkspaceSection id="workspace-delivery" title="Delivery Readiness" description="Solution deliverables moving through development, SIT, UAT and deployment." icon={PackageCheck} className="mt-5" action={<Link href="/deliverables" className="inline-flex min-h-10 items-center rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Manage deliverables</Link>}>
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]"><div className="rounded-md border bg-muted/30 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Completed Deliverables</p><p className="mt-2 text-3xl font-semibold tabular-nums">{workspace.deliveryReadiness.completed} / {workspace.deliveryReadiness.total}</p><div className="mt-3 h-3 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Delivery readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={workspace.deliveryReadiness.percent}><div className="h-full rounded-full bg-primary" style={{ width: `${workspace.deliveryReadiness.percent}%` }} /></div><p className="mt-2 text-sm font-medium">{workspace.deliveryReadiness.percent}% ready</p></div><div>{workspace.deliverableAttention.length ? <div className="grid gap-3 md:grid-cols-2">{workspace.deliverableAttention.slice(0, 6).map((item) => <article key={item.id} className="rounded-md border bg-card p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-muted-foreground">{item.deliverable.deliverable_ref}</p><StatusBadge value={item.severity} /></div><p className="mt-2 text-sm font-semibold">{item.deliverable.title}</p><p className="mt-1 text-sm text-muted-foreground">{item.reason}</p><p className="mt-2 text-xs">{item.recommendation}</p></article>)}</div> : <WorkspaceEmpty>No deliverables currently require attention.</WorkspaceEmpty>}</div></div>
      </WorkspaceSection>

      <div className="mt-5 grid min-w-0 gap-5 xl:grid-cols-2">
        <WorkspaceSection id="workspace-timeline" title="Timeline Overview" description="Current delivery phase, near-term work and schedule performance." icon={GitPullRequestArrow}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><WorkspaceMetric label="Schedule Variance" value={workspace.schedule.variance === null ? "Review" : `${workspace.schedule.variance > 0 ? "+" : ""}${workspace.schedule.variance}%`} /><WorkspaceMetric label="Planned Progress" value={workspace.schedule.plannedProgress === null ? "Review" : `${workspace.schedule.plannedProgress}%`} /><WorkspaceMetric label="Actual Progress" value={workspace.schedule.actualProgress === null ? "Review" : `${workspace.schedule.actualProgress}%`} /></div>
          <div className="mt-4"><div className="flex items-center justify-between gap-3 text-sm"><span className="font-medium">Actual project progress</span><span className="font-semibold tabular-nums">{workspace.schedule.actualProgress ?? 0}%</span></div><div className="mt-2 h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, workspace.schedule.actualProgress ?? 0))}%` }} /></div></div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">{[["Active", workspace.schedule.active], ["Upcoming", workspace.schedule.upcoming.slice(0, 4)], ["At risk", [...workspace.schedule.atRisk, ...workspace.schedule.blocked]]].map(([label, items]) => <div key={String(label)} className="rounded-md border bg-muted/20 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{String(label)}</p><div className="mt-2 space-y-2">{(items as typeof workspace.schedule.active).length ? (items as typeof workspace.schedule.active).map((item) => <div key={item.id}><p className="text-sm font-medium">{item.phase_name}</p><p className="text-xs text-muted-foreground">{item.progress_percent}% · {displayDate(item.end_date)}</p></div>) : <p className="text-sm text-muted-foreground">None</p>}</div></div>)}</div>
        </WorkspaceSection>

        <WorkspaceSection id="workspace-attention" title="Attention Required" description="Severity-sorted blockers, overdue items and aged discovery questions." icon={AlertTriangle}>
          {workspace.attention.length ? <div className="space-y-3">{workspace.attention.map((item) => <article key={item.id} className="rounded-md border bg-muted/30 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{item.kind}</p><StatusBadge value={item.severity} /></div><p className="mt-2 text-sm font-medium">{item.title}</p><p className="mt-1 text-xs text-muted-foreground">{item.meta}</p></article>)}</div> : <WorkspaceEmpty>No current blockers or overdue items require attention.</WorkspaceEmpty>}
        </WorkspaceSection>

        <WorkspaceSection id="workspace-decisions" title="Open Decisions" description="Outstanding business and design decisions requiring closure." icon={ShieldQuestion}>
          {workspace.openDecisions.length ? <div className="space-y-2">{workspace.openDecisions.map((item) => <article key={item.id} className={cn("flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between", isOverdue(item.due_date, item.status) && "border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20")}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-muted-foreground">{item.decision_ref}</span><StatusBadge value={item.status} /></div><p className="mt-2 text-sm font-medium">{item.question}</p><p className="mt-1 text-xs text-muted-foreground">Due {displayDate(item.due_date)}</p></div><Button variant="outline" size="icon" onClick={() => openEdit("decisions", item as unknown as Row)} aria-label={`Edit decision ${item.decision_ref}`}><Pencil className="h-4 w-4" aria-hidden="true" /></Button></article>)}</div> : <WorkspaceEmpty>No open decisions.</WorkspaceEmpty>}
        </WorkspaceSection>

        <WorkspaceSection id="workspace-questions" title="Open Discovery Questions" description="Unanswered questions still shaping project scope and acceptance." icon={FileQuestion}>
          {workspace.openQuestions.length ? <div className="space-y-2">{workspace.openQuestions.map((item) => <article key={item.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-muted-foreground">{item.question_ref}</span><StatusBadge value={item.status} /></div><p className="mt-2 text-sm font-medium">{item.question}</p><p className="mt-1 text-xs text-muted-foreground">{item.owner || "Unassigned"} · Due {displayDate(item.due_date)}</p></div><Button variant="outline" size="icon" onClick={() => openEdit("discovery_questions", item as unknown as Row)} aria-label={`Edit discovery question ${item.question_ref}`}><Pencil className="h-4 w-4" aria-hidden="true" /></Button></article>)}</div> : <WorkspaceEmpty>No open discovery questions.</WorkspaceEmpty>}
        </WorkspaceSection>
      </div>

      <WorkspaceSection id="workspace-actions" title="Actions Board" description="Move actions between Open, In Progress and Complete using the visible status controls." icon={ClipboardCheck} className="mt-5">
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">{actionStatuses.map((column) => <div key={column} className="min-w-0 rounded-md border bg-muted/20 p-3"><div className="flex items-center justify-between gap-2"><h4 className="font-semibold">{column}</h4><span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold tabular-nums">{workspace.actionColumns[column].length}</span></div><div className="mt-3 space-y-3">{workspace.actionColumns[column].length ? workspace.actionColumns[column].map((action) => <article key={action.id} className="rounded-md border bg-card p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-muted-foreground">{action.action_ref}</span><StatusBadge value={action.status} /></div><p className="mt-2 text-sm font-medium">{action.description}</p><p className="mt-1 text-xs text-muted-foreground">{action.owner || "Unassigned"} · {displayDate(action.due_date)}</p><div className="mt-3 grid grid-cols-3 gap-1" aria-label={`Change status for ${action.action_ref}`}>{actionStatuses.map((status) => <Button key={status} size="sm" variant={column === status ? "secondary" : "ghost"} className="h-auto min-h-10 px-1 text-[11px]" disabled={savingStatusId === action.id || column === status} onClick={() => changeActionStatus(action, status)}>{status}</Button>)}</div></article>) : <WorkspaceEmpty>No {column.toLowerCase()} actions.</WorkspaceEmpty>}</div></div>)}</div>
      </WorkspaceSection>

      <div className="mt-5 grid min-w-0 gap-5 xl:grid-cols-2">
        <WorkspaceSection id="workspace-risks" title="High Risks" description="High and critical exposure requiring active mitigation." icon={ShieldAlert}>
          {workspace.highRisks.length ? <div className="space-y-3">{workspace.highRisks.map((risk) => <article key={risk.id} className="rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold text-muted-foreground">{risk.risk_ref}</span><div className="flex gap-2"><PriorityBadge value={risk.impact} /><StatusBadge value={risk.probability} /></div></div><p className="mt-2 text-sm font-medium">{risk.description}</p><dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="font-semibold text-muted-foreground">Mitigation</dt><dd className="mt-1">{risk.mitigation || "Not recorded"}</dd></div><div><dt className="font-semibold text-muted-foreground">Owner</dt><dd className="mt-1">{risk.owner || "Unassigned"}</dd></div></dl></article>)}</div> : <WorkspaceEmpty>No open high risks.</WorkspaceEmpty>}
        </WorkspaceSection>

        <WorkspaceSection id="workspace-milestones" title="Upcoming Milestones" description="Incomplete milestones due within the next 14 days." icon={Flag}>
          {workspace.upcomingMilestones.length ? <div className="space-y-3">{workspace.upcomingMilestones.map((milestone) => <article key={milestone.id} className="flex items-start gap-3 rounded-md border p-3"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><CalendarClock className="h-5 w-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{milestone.title}</p><StatusBadge value={milestone.status} /></div><p className="mt-1 text-xs text-muted-foreground">{milestone.milestone_ref} · {displayDate(milestone.target_date)} · {milestone.owner || "Unassigned"}</p></div></article>)}</div> : <WorkspaceEmpty>No milestones are due within 14 days.</WorkspaceEmpty>}
        </WorkspaceSection>

        <WorkspaceSection id="workspace-activity" title="Recent Activity" description="Latest project updates, decisions, risks and delivery changes." icon={Activity}>
          {workspace.recentActivity.length ? <ol className="relative ml-2 border-l pl-5">{workspace.recentActivity.map((item) => <li key={item.id} className="relative pb-4 last:pb-0"><span className="absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-background bg-primary" /><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{item.activity_type}</p><p className="mt-1 text-sm">{item.description}</p><p className="mt-1 text-xs text-muted-foreground">{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at))}</p></li>)}</ol> : <WorkspaceEmpty>No recent activity has been recorded.</WorkspaceEmpty>}
        </WorkspaceSection>

        <WorkspaceSection id="workspace-narrative" title="Project Narrative" description="Automatically generated executive delivery summary." icon={MessageSquareText}>
          <div className="rounded-md border bg-primary/[0.04] p-4"><div className="flex items-start gap-3"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Gauge className="h-5 w-5" aria-hidden="true" /></span><div><p className="text-sm leading-7">{workspace.narrative}</p><div className="mt-4 flex flex-wrap gap-2"><StatusBadge value={workspace.projectHealth} /><StatusBadge value={workspace.scheduleHealth} />{workspace.schedule.projectComplete ? <StatusBadge value="Complete" /> : null}</div></div></div></div>
        </WorkspaceSection>
      </div>

      <div className="mt-5">
        <RecentChangesPanel projectId={project.id} limit={10} />
      </div>

      <FormDialog config={dialog?.config ?? moduleByKey.get("actions")!} record={dialog?.record ?? null} open={Boolean(dialog)} onClose={() => setDialog(null)} onSave={saveDialogRecord} />
    </AppShell>
  );
}
