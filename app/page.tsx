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
  ListChecks,
  PackageCheck,
  ShieldCheck,
  Target,
  Timer,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ControlTowerKpi } from "@/components/control-tower-kpi";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { InsightPanel } from "@/components/insight-panel";
import { StatusBadge } from "@/components/status-badge";
import {
  buildManagementSummary,
  buildNeedsAttention,
  buildTodaysPriorities,
  buildUpcomingThisWeek,
  buildWaitingOnOthersGrouped,
  calculateProgress,
  calculateProjectHealth,
} from "@/lib/control-tower";
import { calculateSchedule, formatScheduleDate } from "@/lib/schedule";
import type { ProjectSnapshot } from "@/lib/types";
import { calculateDeliveryReadiness, deliverablesRequiringAttention } from "@/lib/delivery";
import { computeReadiness } from "@/components/requirement-readiness";
import { computeDeliveryConfidence } from "@/lib/delivery-confidence";
import { captureSnapshot, todaySnapshotExists } from "@/lib/snapshots";
import { ProjectTrendsPanel } from "@/components/trend-chart";
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
  emptyMessage = "No records to show.",
}: {
  items: unknown[];
  render: (item: Record<string, unknown>) => React.ReactNode;
  emptyMessage?: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
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
  const { data, setData, error, reload } = useProjectData();
  const [snapshotting, setSnapshotting] = useState(false);

  const takeSnapshot = useCallback(async (d: NonNullable<typeof data>) => {
    setSnapshotting(true);
    try {
      const saved = await captureSnapshot(d);
      if (saved) {
        setData((prev) => {
          if (!prev) return prev;
          const existing = (prev.project_snapshots ?? []).find((s) => s.id === saved.id);
          return {
            ...prev,
            project_snapshots: existing
              ? prev.project_snapshots.map((s) => (s.id === saved.id ? saved : s))
              : [...(prev.project_snapshots ?? []), saved],
          };
        });
      }
    } finally {
      setSnapshotting(false);
    }
  }, [setData]);

  // Auto-capture once per day when the page loads
  useEffect(() => {
    if (!data) return;
    const project = selectActiveProject(data);
    if (!project) return;
    if (!todaySnapshotExists(data, project.id)) {
      void takeSnapshot(data);
    }
  // Only run on initial data load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

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
      requirements: {
        total: data.requirements.length,
        discovery: data.requirements.filter((r) => r.status === "Discovery").length,
        inProgress: data.requirements.filter((r) => r.status === "In Progress").length,
        approved: data.requirements.filter((r) => r.status === "Approved").length,
        complete: data.requirements.filter((r) => ["Complete", "Closed"].includes(r.status)).length,
      },
      waitingOnOthers: buildWaitingOnOthersGrouped(data),
      todaysPriorities: buildTodaysPriorities(data),
      acceptance: (() => {
        const allAC = data.acceptance_criteria ?? [];
        const total = allAC.length;
        const met = allAC.filter((ac) => ac.status === "Met").length;
        const failed = allAC.filter((ac) => ac.status === "Failed").length;
        const outstanding = allAC.filter((ac) => !["Met", "Waived", "Failed"].includes(ac.status)).length;
        const pct = total > 0 ? Math.round((met / total) * 100) : 0;
        const reqs100 = data.requirements.filter((r) => {
          const acs = allAC.filter((ac) => ac.requirement_id === r.id);
          return acs.length > 0 && acs.every((ac) => ac.status === "Met" || ac.status === "Waived");
        }).length;
        const reqsFailed = data.requirements.filter((r) =>
          allAC.some((ac) => ac.requirement_id === r.id && ac.status === "Failed"),
        ).length;
        return { total, met, failed, outstanding, pct, reqs100, reqsFailed };
      })(),
      projectReadiness: computeReadiness(
        data.acceptance_criteria ?? [],
        data.evidence ?? [],
        data.requirement_sign_offs ?? [],
        data.test_cases ?? [],
      ),
      confidence: computeDeliveryConfidence(data),
      snapshots: (data.project_snapshots ?? [])
        .filter((s) => s.project_id === project.id)
        .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)),
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

  // Trend helpers — compare current value to the most recent prior snapshot
  const prevSnapshot = tower.snapshots.length >= 2
    ? tower.snapshots[tower.snapshots.length - 2]
    : tower.snapshots.length === 1
      ? tower.snapshots[0]
      : null;

  function snapTrend(
    current: number,
    prevKey: keyof ProjectSnapshot,
    higherIsBetter = true,
  ): { direction: "up" | "flat" | "down"; label: string } | undefined {
    if (!prevSnapshot) return undefined;
    const prev = Number(prevSnapshot[prevKey] ?? current);
    const diff = current - prev;
    if (diff === 0) return { direction: "flat", label: `Stable vs ${prevSnapshot.snapshot_date.slice(5)}` };
    const direction = diff > 0 ? "up" : "down";
    const sign = diff > 0 ? "+" : "";
    return {
      direction: higherIsBetter ? direction : (direction === "up" ? "down" : "up"),
      label: `${sign}${diff} vs ${prevSnapshot.snapshot_date.slice(5)}`,
    };
  }

  // Momentum: confidence delta over last 7 snapshots
  const momentum = (() => {
    const snaps = tower.snapshots.filter((s) => s.delivery_confidence != null);
    if (snaps.length < 2) return null;
    const recent = snaps[snaps.length - 1];
    const lookback = snaps.length >= 8 ? snaps[snaps.length - 8] : snaps[0];
    const delta = (recent.delivery_confidence ?? 0) - (lookback.delivery_confidence ?? 0);
    const label =
      delta > 0 ? "Improving" : delta < 0 ? "Declining" : "Stable";
    return { delta, label, since: lookback.snapshot_date.slice(5) };
  })();

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
          <ControlTowerKpi title="Open Risks" value={tower.openRisks} helper="Active risks across the project" icon={AlertTriangle} tone={tower.openRisks ? "danger" : "good"} trend={snapTrend(tower.openRisks, "open_risks", false)} href="/risks?status=Open" />
          <ControlTowerKpi title="Overdue Actions" value={tower.overdueActions} helper="Actions past their due date" icon={ClipboardCheck} tone={tower.overdueActions ? "danger" : "good"} trend={snapTrend(tower.overdueActions, "overdue_actions", false)} href="/actions?status=Blocked" />
          <ControlTowerKpi title="Overdue Decisions" value={tower.overdueDecisions} helper="Decisions past their due date" icon={CalendarClock} tone={tower.overdueDecisions ? "danger" : "good"} href="/decisions?status=Open" />
          <ControlTowerKpi title="Open Discovery Questions" value={tower.openQuestions} helper="Questions still awaiting an answer" icon={CircleHelp} tone={tower.openQuestions ? "warn" : "good"} trend={snapTrend(tower.openQuestions, "open_questions", false)} href="/discovery-questions?status=Awaiting Business" />
          <ControlTowerKpi title="Active Milestones" value={tower.activeMilestones} helper="In progress, at risk or blocked" icon={Flag} tone={tower.blockedMilestones ? "danger" : "neutral"} href="/milestones" />
          <ControlTowerKpi title="Overall Project Progress" value={`${progress.overall}%`} helper="Weighted across requirements, milestones, actions, testing and discovery" icon={Target} progress={progress.overall} trend={progress.trend} />
          <ControlTowerKpi title="Delivery Readiness" value={`${tower.deliveryReadiness.percent}%`} helper={`${tower.deliveryReadiness.completed} of ${tower.deliveryReadiness.total} deliverables deployed`} icon={PackageCheck} progress={tower.deliveryReadiness.percent} tone={tower.deliverableAttention.some((item) => item.severity === "Critical") ? "danger" : tower.deliverableAttention.length ? "warn" : "good"} />
          <ControlTowerKpi title="Acceptance Progress" value={tower.acceptance.total ? `${tower.acceptance.pct}%` : "—"} helper={`${tower.acceptance.met} of ${tower.acceptance.total} criteria met · ${tower.acceptance.failed} failed`} icon={ShieldCheck} progress={tower.acceptance.pct} trend={snapTrend(tower.acceptance.pct, "acceptance_complete")} tone={tower.acceptance.failed > 0 ? "danger" : tower.acceptance.pct === 100 ? "good" : tower.acceptance.total ? "neutral" : "neutral"} href="/acceptance-criteria" />
          <ControlTowerKpi title="Project Readiness" value={`${tower.projectReadiness.overall}%`} helper={tower.projectReadiness.dimensions.map((d) => `${d.label} ${d.pct}%`).join(" · ")} icon={ListChecks} progress={tower.projectReadiness.overall} trend={snapTrend(tower.projectReadiness.overall, "project_readiness")} tone={tower.projectReadiness.overall === 100 ? "good" : tower.projectReadiness.overall >= 70 ? "neutral" : tower.projectReadiness.overall >= 40 ? "warn" : "danger"} />
          <ControlTowerKpi
            title="Delivery Confidence"
            value={`${tower.confidence.score}%`}
            helper={tower.confidence.reasons.length ? tower.confidence.reasons.join(" · ") : "No confidence gaps detected."}
            icon={Target}
            progress={tower.confidence.score}
            trend={snapTrend(tower.confidence.score, "delivery_confidence")}
            tone={tower.confidence.rag === "Green" ? "good" : tower.confidence.rag === "Amber" ? "warn" : "danger"}
          />
        </div>

        {/* Part 4 — Delivery Confidence + Part 5 — Project Momentum */}
        <div className="mt-5 grid gap-5 xl:grid-cols-3">
          {/* Delivery Confidence reasoning */}
          <section className="col-span-2 rounded-lg border bg-card p-5 shadow-operational">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Delivery Confidence</h3>
              <span className={`text-3xl font-bold tabular-nums ${tower.confidence.rag === "Green" ? "text-green-700" : tower.confidence.rag === "Amber" ? "text-amber-600" : "text-red-600"}`}>
                {tower.confidence.score}%
              </span>
            </div>
            {tower.confidence.reasons.length === 0 ? (
              <p className="mt-3 text-sm text-green-700">All confidence checks passed — delivery is on track.</p>
            ) : (
              <div className="mt-3">
                <p className="text-sm text-muted-foreground">Confidence reduced because:</p>
                <ul className="mt-2 space-y-1.5">
                  {tower.confidence.reasons.map((reason) => (
                    <li key={reason} className="flex items-center gap-2 text-sm">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${tower.confidence.rag === "Green" ? "bg-green-600" : tower.confidence.rag === "Amber" ? "bg-amber-500" : "bg-red-500"}`}
                style={{ width: `${tower.confidence.score}%` }}
              />
            </div>
          </section>

          {/* Project Momentum */}
          <section className="rounded-lg border bg-card p-5 shadow-operational">
            <h3 className="text-base font-semibold">Project Momentum</h3>
            {momentum === null ? (
              <p className="mt-3 text-sm text-muted-foreground">Not enough snapshots yet — momentum calculates after 2+ daily captures.</p>
            ) : (
              <div className="mt-4 text-center">
                <p className={`text-sm font-semibold ${momentum.delta > 0 ? "text-green-700" : momentum.delta < 0 ? "text-red-600" : "text-muted-foreground"}`}>
                  {momentum.label}
                </p>
                <p className={`mt-1 text-5xl font-bold tabular-nums ${momentum.delta > 0 ? "text-green-700" : momentum.delta < 0 ? "text-red-600" : "text-muted-foreground"}`}>
                  {momentum.delta > 0 ? "+" : ""}{momentum.delta}%
                </p>
                <p className="mt-3 text-xs text-muted-foreground">Delivery Confidence change since {momentum.since}</p>
              </div>
            )}
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={snapshotting || !data}
                onClick={() => data && void takeSnapshot(data)}
                className="rounded-md border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {snapshotting ? "Saving…" : "Take Snapshot Now"}
              </button>
            </div>
          </section>
        </div>

        {/* Part 2 — Trend Charts */}
        {tower.snapshots.length >= 2 && (
          <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational">
            <ProjectTrendsPanel snapshots={tower.snapshots} />
          </section>
        )}

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
          <div className="mb-5">
            <Panel title="Today's Priorities" description="Automatically calculated from overdue work, blocked items, high risks and upcoming deadlines.">
              {tower.todaysPriorities.length === 0 ? (
                <p className="text-sm text-muted-foreground">No critical priorities identified — the project is on track.</p>
              ) : (
                <ol className="space-y-3">
                  {tower.todaysPriorities.map((p) => (
                    <li key={p.rank} className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{p.rank}</span>
                      <div>
                        <p className="text-sm font-semibold">{p.title}</p>
                        {p.detail && <p className="mt-1 text-xs text-muted-foreground">{p.detail}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>
          <div className="grid gap-5 xl:grid-cols-4">
            <Panel title="Requirements">
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm">
                  <span className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Total</span>
                  <strong className="tabular-nums">{tower.requirements.total}</strong>
                </div>
                <Link href="/requirements?status=Discovery" className="flex items-center justify-between rounded-md bg-amber-50 p-3 text-sm hover:bg-amber-100 dark:bg-amber-950/20 dark:hover:bg-amber-950/30">
                  <span>Discovery</span>
                  <strong className="tabular-nums text-amber-700 dark:text-amber-400">{tower.requirements.discovery}</strong>
                </Link>
                <div className="flex items-center justify-between rounded-md bg-blue-50 p-3 text-sm dark:bg-blue-950/20">
                  <span>In Progress</span>
                  <strong className="tabular-nums text-blue-700 dark:text-blue-400">{tower.requirements.inProgress}</strong>
                </div>
                <div className="flex items-center justify-between rounded-md bg-purple-50 p-3 text-sm dark:bg-purple-950/20">
                  <span>Approved</span>
                  <strong className="tabular-nums text-purple-700 dark:text-purple-400">{tower.requirements.approved}</strong>
                </div>
                <div className="flex items-center justify-between rounded-md bg-green-50 p-3 text-sm dark:bg-green-950/20">
                  <span>Complete</span>
                  <strong className="tabular-nums text-green-700 dark:text-green-400">{tower.requirements.complete}</strong>
                </div>
              </div>
            </Panel>
            <Panel title="Waiting on Others">
              {tower.waitingOnOthers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No outstanding items waiting on others.</p>
              ) : (
                <div className="space-y-3">
                  {tower.waitingOnOthers.map((group) => (
                    <div key={group.owner} className="rounded-md border bg-muted/40 p-3">
                      <p className="text-xs font-semibold text-muted-foreground">{group.owner}</p>
                      <div className="mt-2 space-y-1">
                        {group.items.map((item) => (
                          <Link key={item.href + item.label} href={item.href} className="flex items-center justify-between text-sm hover:text-primary">
                            <span>{item.label}</span>
                            <span className="text-xs text-muted-foreground">→</span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title="Recent Activity">
              <ListPanel emptyMessage="No recent activity logged." items={tower.recentActivity} render={(item) => (
                <>
                  <p className="font-medium">{String(item.activity_type)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{String(item.description)}</p>
                </>
              )} />
            </Panel>
            <Panel title="Open Decisions">
              <ListPanel emptyMessage="No open decisions — all decisions are resolved." items={tower.openDecisions} render={(item) => (
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
