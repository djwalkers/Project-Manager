"use client";

import {
  Activity,
  AlertTriangle,
  BriefcaseBusiness,
  CalendarClock,
  CalendarRange,
  CircleHelp,
  ClipboardCheck,
  Flag,
  Gauge,
  HeartPulse,
  PackageCheck,
  Target,
  Timer,
} from "lucide-react";
import { useMemo } from "react";
import { AppShell } from "@/components/app-shell";
import { ControlTowerKpi } from "@/components/control-tower-kpi";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { InsightPanel } from "@/components/insight-panel";
import { StatusBadge } from "@/components/status-badge";
import {
  buildManagementSummary,
  buildNeedsAttention,
  buildUpcomingThisWeek,
  calculateProgress,
  calculateProjectHealth,
} from "@/lib/control-tower";
import { calculateSchedule, formatScheduleDate } from "@/lib/schedule";
import { calculateDeliveryReadiness, deliverablesRequiringAttention } from "@/lib/delivery";
import { selectActiveProject, selectTimelineItems } from "@/lib/project-scope";
import { useProjectData } from "@/lib/use-project-data";
import { isOverdue } from "@/lib/utils";

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-operational">
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ListPanel({
  items,
  render,
}: {
  items: unknown[];
  render: (item: Record<string, unknown>) => React.ReactNode;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No records to show.</p>;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={String((item as Record<string, unknown>).id)} className="rounded-md border bg-muted/40 p-3">
          {render(item as Record<string, unknown>)}
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { data, error, reload } = useProjectData();

  const tower = useMemo(() => {
    const project = data ? selectActiveProject(data) : null;
    if (!data || !project) return null;

    const timelineScope = selectTimelineItems(data, project);
    const schedule = calculateSchedule(project, timelineScope.items);
    const scheduleVariance = schedule.variance ?? -1;
    const overdueActions = data.actions.filter((item) => isOverdue(item.due_date, item.status)).length;
    const overdueDecisions = data.decisions.filter((item) => isOverdue(item.due_date, item.status)).length;
    const blockedMilestones = data.milestones.filter((item) => item.status === "Blocked").length + schedule.blocked.length;
    const overdueItems = overdueActions + overdueDecisions;
    const health = calculateProjectHealth(overdueItems, blockedMilestones, scheduleVariance);
    const scheduleHealth = schedule.health;
    const progress = calculateProgress(data, scheduleVariance);
    const projectDeliverables = data.deliverables.filter((item) => item.project_id === project.id);

    return {
      project,
      scheduleVariance,
      overdueActions,
      overdueDecisions,
      overdueItems,
      blockedMilestones,
      health,
      scheduleHealth,
      progress,
      deliveryReadiness: calculateDeliveryReadiness(projectDeliverables),
      deliverableAttention: deliverablesRequiringAttention(projectDeliverables),
      schedule,
      needsAttention: buildNeedsAttention(data),
      upcomingThisWeek: buildUpcomingThisWeek(data),
      summary: buildManagementSummary(project, health, data, overdueActions, schedule),
      openRisks: data.risks.filter((item) => !["Complete", "Closed"].includes(item.status)).length,
      openQuestions: data.discovery_questions.filter((item) => !["Answered", "Closed"].includes(item.status)).length,
      activeMilestones: data.milestones.filter((item) => ["In Progress", "At Risk", "Blocked"].includes(item.status)).length,
      recentActivity: data.activity_log.slice(0, 5),
      openDecisions: data.decisions.filter((item) => !["Approved", "Closed"].includes(item.status)).slice(0, 5),
    };
  }, [data]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!tower) {
    return (
      <AppShell>
        <EmptyState title="No projects found" description="Add a project before using the control tower." icon={BriefcaseBusiness} />
      </AppShell>
    );
  }

  const { project, progress, schedule } = tower;
  const varianceLabel = schedule.variance === null ? "Review" : schedule.variance > 0 ? `+${schedule.variance}%` : `${schedule.variance}%`;

  return (
    <AppShell>
      <section aria-labelledby="control-tower-title">
        <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
          <div>
            <p className="text-sm font-medium text-primary">Executive Control Tower</p>
            <h2 id="control-tower-title" className="mt-1 text-2xl font-semibold tracking-normal">Project Control Centre</h2>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {project.name} · {project.customer} · {project.workstream}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-lg border bg-card p-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground">Phase</p>
              <StatusBadge value={project.status} />
            </div>
            <div>
              <p className="text-muted-foreground">Auto Health</p>
              <StatusBadge value={tower.health} />
            </div>
            <div>
              <p className="text-muted-foreground">Schedule variance</p>
              <p className="font-semibold tabular-nums">{varianceLabel}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Project end</p>
              <p className="font-semibold tabular-nums">{formatScheduleDate(schedule.projectEnd)}</p>
            </div>
          </div>
        </div>

        <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="management-summary-title">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Activity className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3 id="management-summary-title" className="text-base font-semibold">Management Summary</h3>
              <p className="mt-2 max-w-5xl text-sm leading-6 text-muted-foreground">{tower.summary}</p>
            </div>
          </div>
        </section>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <ControlTowerKpi title="Project Health" rag={tower.health} helper="Calculated from overdue work, blockers and schedule variance" icon={HeartPulse} tone={tower.health === "Red" ? "danger" : tower.health === "Amber" ? "warn" : "good"} />
          <ControlTowerKpi title="Project End Date" value={schedule.valid ? formatScheduleDate(schedule.projectEnd) : "Review"} helper={schedule.valid ? "Editable planned delivery end date" : "Schedule dates need review"} icon={CalendarRange} tone={schedule.valid ? "neutral" : "warn"} />
          <ControlTowerKpi title="Days Remaining" value={schedule.daysRemaining ?? "Review"} helper={schedule.valid ? "Calendar days to planned project end" : "Schedule dates need review"} icon={CalendarClock} tone={schedule.daysRemaining === 0 && !schedule.projectComplete ? "danger" : "neutral"} />
          <ControlTowerKpi title="Planned Progress" value={schedule.plannedProgress === null ? "Review" : `${schedule.plannedProgress}%`} helper="Elapsed calendar days across the project baseline" icon={Target} progress={schedule.plannedProgress ?? undefined} />
          <ControlTowerKpi title="Actual Progress" value={schedule.actualProgress === null ? "Review" : `${schedule.actualProgress}%`} helper="Duration-weighted progress across timeline phases" icon={Gauge} progress={schedule.actualProgress ?? undefined} />
          <ControlTowerKpi title="Schedule Variance" value={schedule.variance === null ? "Review" : varianceLabel} helper="Actual progress minus planned progress" icon={Activity} tone={schedule.health === "Red" ? "danger" : schedule.health === "Amber" ? "warn" : "good"} />
          <ControlTowerKpi title="Schedule Health" rag={tower.scheduleHealth ?? undefined} value="Review" helper={schedule.valid ? `${varianceLabel} against the editable schedule` : "Schedule dates need review"} icon={Gauge} tone={tower.scheduleHealth === "Red" ? "danger" : tower.scheduleHealth === "Amber" ? "warn" : schedule.valid ? "good" : "warn"} />
          <ControlTowerKpi title="Open Risks" value={tower.openRisks} helper="Active risks across the project" icon={AlertTriangle} tone={tower.openRisks ? "danger" : "good"} />
          <ControlTowerKpi title="Overdue Actions" value={tower.overdueActions} helper="Actions past their due date" icon={ClipboardCheck} tone={tower.overdueActions ? "danger" : "good"} />
          <ControlTowerKpi title="Overdue Decisions" value={tower.overdueDecisions} helper="Decisions past their due date" icon={CalendarClock} tone={tower.overdueDecisions ? "danger" : "good"} />
          <ControlTowerKpi title="Open Discovery Questions" value={tower.openQuestions} helper="Questions still awaiting an answer" icon={CircleHelp} tone={tower.openQuestions ? "warn" : "good"} />
          <ControlTowerKpi title="Active Milestones" value={tower.activeMilestones} helper="In progress, at risk or blocked" icon={Flag} tone={tower.blockedMilestones ? "danger" : "neutral"} />
          <ControlTowerKpi title="Overall Project Progress" value={`${progress.overall}%`} helper="Weighted across requirements, milestones, actions, testing and discovery" icon={Target} progress={progress.overall} trend={progress.trend} />
          <ControlTowerKpi title="Delivery Readiness" value={`${tower.deliveryReadiness.percent}%`} helper={`${tower.deliveryReadiness.completed} of ${tower.deliveryReadiness.total} deliverables deployed`} icon={PackageCheck} progress={tower.deliveryReadiness.percent} tone={tower.deliverableAttention.some((item) => item.severity === "Critical") ? "danger" : tower.deliverableAttention.length ? "warn" : "good"} />
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
          <InsightPanel title="Needs Attention" description="Automatically prioritised by severity." items={tower.needsAttention} emptyMessage="No blockers or aged items need attention." />
          <InsightPanel title="Upcoming This Week" description="Actions, decisions and milestones due in the next seven days." items={tower.upcomingThisWeek} emptyMessage="Nothing is due in the next seven days." />
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <Panel title="Dashboard Timeline" description="Live phase position and duration-weighted schedule progress.">
            {!schedule.valid ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">Schedule dates need review</div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md bg-muted/60 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Active phases</p>
                <div className="mt-2 space-y-2">
                  {schedule.active.length ? schedule.active.map((phase) => (
                    <div key={phase.id}>
                      <p className="text-sm font-medium">{phase.phase_name}</p>
                      <StatusBadge value={phase.status} className="mt-1" />
                    </div>
                  )) : <p className="text-sm text-muted-foreground">No active phase</p>}
                </div>
              </div>
              <div className="rounded-md bg-muted/60 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Upcoming phases</p>
                <div className="mt-2 space-y-2">
                  {schedule.upcoming.slice(0, 3).map((phase) => <div key={phase.id}><p className="text-sm font-medium">{phase.phase_name}</p><p className="text-xs text-muted-foreground">Starts {formatScheduleDate(phase.start_date)}</p></div>)}
                  {!schedule.upcoming.length ? <p className="text-sm text-muted-foreground">No upcoming phase</p> : null}
                </div>
              </div>
              <div className="rounded-md bg-muted/60 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">At risk / blocked</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{schedule.atRisk.length} / {schedule.blocked.length}</p>
                <p className="mt-1 text-xs text-muted-foreground">At risk phases / blocked phases</p>
              </div>
              <div className="rounded-md bg-muted/60 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Planned vs actual</p>
                <p className="mt-2 text-lg font-semibold tabular-nums">{schedule.plannedProgress ?? "—"}% / {schedule.actualProgress ?? "—"}%</p>
                <p className="mt-1 text-xs text-muted-foreground">Variance {schedule.variance === null ? "needs review" : varianceLabel}</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              <div><div className="mb-1 flex justify-between text-xs"><span>Planned</span><span>{schedule.plannedProgress ?? 0}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-slate-500" style={{ width: `${schedule.plannedProgress ?? 0}%` }} /></div></div>
              <div><div className="mb-1 flex justify-between text-xs"><span>Actual</span><span>{schedule.actualProgress ?? 0}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${schedule.actualProgress ?? 0}%` }} /></div></div>
            </div>
          </Panel>

          <Panel title="Project Status Summary" description="Automatic status based on control-tower thresholds.">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 p-3">
              <div>
                <p className="text-sm font-medium">Current automatic status</p>
                <p className="mt-1 text-xs text-muted-foreground">{tower.overdueItems} overdue items · {tower.blockedMilestones} blocked milestones · {varianceLabel} schedule variance</p>
              </div>
              <StatusBadge value={tower.health} className="min-h-9 px-3 text-sm" />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-5">
              {progress.components.map((component) => (
                <div key={component.label} className="rounded-md bg-muted/60 p-3 text-center">
                  <p className="text-xs font-medium text-muted-foreground">{component.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{Math.round(component.score * 100)}%</p>
                  <p className="text-xs text-muted-foreground">Weight {component.weight}%</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="mt-5">
          <div className="mb-3 flex items-center gap-2">
            <Timer className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-lg font-semibold">Operational Detail</h2>
          </div>
          <div className="grid gap-5 xl:grid-cols-4">
            <Panel title="Recent Activity">
              <ListPanel items={tower.recentActivity} render={(item) => (
                <>
                  <p className="font-medium">{String(item.activity_type)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{String(item.description)}</p>
                </>
              )} />
            </Panel>
            <Panel title="Open Decisions">
              <ListPanel items={tower.openDecisions} render={(item) => (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{String(item.decision_ref)}</p>
                    <StatusBadge value={String(item.status)} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{String(item.question)}</p>
                  <p className="mt-2 text-xs font-medium">Due {String(item.due_date || "not set")} / {String(item.owner)}</p>
                </>
              )} />
            </Panel>
            <Panel title="Control Coverage">
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>Requirements</span><strong>{data.requirements.length}</strong></div>
                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>Planned tests</span><strong>{data.test_cases.length}</strong></div>
                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>Discovery questions</span><strong>{data.discovery_questions.length}</strong></div>
                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>Milestones</span><strong>{data.milestones.length}</strong></div>
                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>Deliverables</span><strong>{data.deliverables.length}</strong></div>
              </div>
            </Panel>
            <Panel title="Delivery Watch">
              {tower.deliverableAttention.length ? <div className="space-y-3">{tower.deliverableAttention.slice(0, 5).map((item) => <div key={item.id} className="rounded-md border bg-muted/40 p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-muted-foreground">{item.deliverable.deliverable_ref}</p><StatusBadge value={item.severity} /></div><p className="mt-2 text-sm font-medium">{item.deliverable.title}</p><p className="mt-1 text-xs text-muted-foreground">{item.reason}</p></div>)}</div> : <p className="text-sm text-muted-foreground">No deliverables require attention.</p>}
            </Panel>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
