"use client";

// Executive Timeline — read-only executive reporting view.
//
// This is NOT a second scheduling engine and NOT a replacement for
// /timeline (which remains the editable phase/date entry point). Every
// fact shown here is read directly from ProjectState, lib/schedule.ts's
// positioning helpers, and lib/executive-timeline.ts's pure viewport
// windowing — nothing here recomputes health, confidence, readiness,
// variance, or the Go-Live date. There is no dependency graph, critical
// path, drag-and-drop, editing, baseline, or auto-scheduling in this MVP
// — none of that data exists yet (see the approved design doc), and this
// file must not fake it.
import {
  AlertTriangle, CalendarClock, ClipboardCheck, Flag, Lightbulb,
  PackageCheck, Rocket, ShieldAlert, Target,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { StatusBadge } from "@/components/status-badge";
import { barTone, phaseDaysLabel, phaseRowTone } from "@/components/timeline-schedule";
import { Select } from "@/components/ui/input";
import {
  buildTimelineIntelligence, monthTicks, weekendRanges, weekTicks, zoomWindow,
  TIMELINE_ZOOMS, type TimelineWindow, type TimelineZoom,
} from "@/lib/executive-timeline";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import { buildProjectState, type ProjectState } from "@/lib/project-state";
import { dateRangePosition, datePosition, formatScheduleDate, parseScheduleDate, todayPosition } from "@/lib/schedule";
import type { Milestone, Requirement, RequirementSignOff, TimelineItem } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";

const TRACK_MIN_WIDTH = 720;
const LABEL_COLUMN = "220px";

// ── Header strip ─────────────────────────────────────────────────────────────

function HeaderStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function TimelineHeaderStrip({ state }: { state: ProjectState }) {
  const { project, schedule, phase, goLiveDate, goLive, confidence } = state;
  return (
    <div className="rounded-lg border bg-card p-4 shadow-operational">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
        <div>
          <h2 className="text-xl font-semibold">{project.name}</h2>
          <p className="text-sm text-muted-foreground">{project.customer} · {project.workstream}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        <HeaderStat label="Project Health"><StatusBadge value={state.projectHealth} /></HeaderStat>
        <HeaderStat label="Schedule Health"><StatusBadge value={schedule.health ?? "Review"} /></HeaderStat>
        <HeaderStat label="Delivery Confidence">
          <span className="text-sm font-semibold tabular-nums">{confidence.score}%</span>{" "}
          <StatusBadge value={confidence.rag} />
        </HeaderStat>
        <HeaderStat label="Go-Live Readiness">
          <span className="text-sm font-semibold tabular-nums">{goLive.readinessPercent}%</span>{" "}
          <StatusBadge value={goLive.status} />
        </HeaderStat>
        <HeaderStat label="Days to Planned End">
          <span className="text-sm font-semibold tabular-nums">{schedule.daysRemaining ?? "Review"}</span>
        </HeaderStat>
        <HeaderStat label="Authoritative Go-Live Date">
          <span className="text-sm font-semibold tabular-nums">{goLiveDate.date ? formatScheduleDate(goLiveDate.date) : "Not set"}</span>
          {goLiveDate.date && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {goLiveDate.source === "milestone" ? `Milestone: ${goLiveDate.milestoneTitle}` : goLiveDate.source === "go_live_date" ? "Project go-live date" : "Planned end date"}
            </p>
          )}
        </HeaderStat>
        <HeaderStat label="Current Phase">
          <span className="text-sm font-semibold">{phase.phase}</span>
          <p className="mt-0.5 text-xs text-muted-foreground">{phase.confidence}% confidence · {phase.source}</p>
        </HeaderStat>
      </div>
    </div>
  );
}

// ── Zoom / navigation controls ───────────────────────────────────────────────

function TimelineControls({
  zoom, onZoom, onFitToProject, onToday, onJumpToGoLive, fitted, hasGoLiveDate,
}: {
  zoom: TimelineZoom;
  onZoom: (z: TimelineZoom) => void;
  onFitToProject: () => void;
  onToday: () => void;
  onJumpToGoLive: () => void;
  fitted: boolean;
  hasGoLiveDate: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b p-3">
      <div className="flex items-center gap-1 rounded-md border p-0.5" role="group" aria-label="Zoom level">
        {TIMELINE_ZOOMS.map((z) => (
          <button
            key={z}
            onClick={() => onZoom(z)}
            aria-pressed={!fitted && zoom === z}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              !fitted && zoom === z ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {z}
          </button>
        ))}
      </div>
      <button onClick={onFitToProject} aria-pressed={fitted} className={cn("rounded-md border px-2.5 py-1 text-xs font-medium", fitted ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
        Fit to project
      </button>
      <button onClick={onToday} className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted">
        Today
      </button>
      <button onClick={onJumpToGoLive} disabled={!hasGoLiveDate} className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40">
        Jump to Go-Live
      </button>
    </div>
  );
}

// ── Hover card ────────────────────────────────────────────────────────────────

function HoverCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 hidden w-56 rounded-md border bg-popover p-3 text-xs shadow-lg group-hover:block group-focus-within:block">
      {children}
    </div>
  );
}

// ── Phase (TimelineItem) row ──────────────────────────────────────────────────

function PhaseRow({ item, viewWindow }: { item: TimelineItem; viewWindow: TimelineWindow }) {
  const position = dateRangePosition(item.start_date, item.end_date, viewWindow.start, viewWindow.end);
  const { label: daysLabel, warn: daysWarn } = phaseDaysLabel(item);
  const blocked = item.status === "Blocked";

  return (
    <div className={cn("grid items-center gap-3 rounded-md px-1 py-1", phaseRowTone(item))} style={{ gridTemplateColumns: `${LABEL_COLUMN} minmax(480px,1fr)` }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">{item.phase_ref}</span>
          <StatusBadge value={item.status} />
        </div>
        <p className="mt-0.5 truncate text-sm font-medium" title={item.phase_name}>{item.phase_name}</p>
        {daysLabel && <p className={cn("mt-0.5 text-xs font-semibold tabular-nums", daysWarn ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{daysLabel}</p>}
      </div>
      <div className="relative h-9">
        {position ? (
          <button
            type="button"
            className={cn("group absolute top-1 flex h-7 items-center overflow-hidden rounded px-2 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", barTone[item.status])}
            style={{ left: `${position.left}%`, width: `${position.width}%` }}
            aria-label={`${item.phase_name}: ${item.start_date} to ${item.end_date}, ${item.progress_percent}% complete, status ${item.status}`}
          >
            {blocked && (
              <span
                aria-hidden="true"
                className="absolute inset-0 opacity-30"
                style={{ backgroundImage: "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.6) 4px, rgba(255,255,255,0.6) 8px)" }}
              />
            )}
            <span className="relative truncate">{item.progress_percent}%</span>
            <HoverCard>
              <p className="font-semibold">{item.phase_name}</p>
              <p className="mt-1 text-muted-foreground">{formatScheduleDate(item.start_date)} → {formatScheduleDate(item.end_date)}</p>
              <p className="mt-1">Progress: {item.progress_percent}% · <StatusBadge value={item.status} /></p>
              {item.owner && <p className="mt-1 text-muted-foreground">Owner: {item.owner}</p>}
            </HoverCard>
          </button>
        ) : (
          <span className="absolute inset-0 flex items-center px-2 text-xs text-muted-foreground">Outside current view</span>
        )}
      </div>
    </div>
  );
}

// ── Milestones lane ───────────────────────────────────────────────────────────

const MILESTONE_TONE: Record<Milestone["status"], string> = {
  "Not Started": "border-slate-400 bg-slate-400 dark:border-slate-500 dark:bg-slate-500",
  "In Progress": "border-amber-500 bg-amber-500",
  Complete: "border-emerald-600 bg-emerald-600 dark:border-emerald-500 dark:bg-emerald-500",
  "At Risk": "border-red-600 bg-red-600 dark:border-red-500 dark:bg-red-500",
  Blocked: "border-red-600 bg-red-600 dark:border-red-500 dark:bg-red-500",
};

function MilestonesRow({ milestones, viewWindow }: { milestones: Milestone[]; viewWindow: TimelineWindow }) {
  return (
    <div className="grid items-center gap-3 rounded-md px-1 py-1" style={{ gridTemplateColumns: `${LABEL_COLUMN} minmax(480px,1fr)` }}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Milestones
      </div>
      <div className="relative h-9">
        {milestones.map((m) => {
          const left = datePosition(m.target_date, viewWindow.start, viewWindow.end);
          if (left === null) return null;
          return (
            <button
              key={m.id}
              type="button"
              className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              style={{ left: `${left}%` }}
              aria-label={`Milestone ${m.milestone_ref}: ${m.title}, due ${m.target_date}, status ${m.status}`}
            >
              <span className={cn("block h-3.5 w-3.5 rotate-45 border-2", MILESTONE_TONE[m.status])} />
              <HoverCard>
                <p className="font-semibold">{m.milestone_ref} · {m.title}</p>
                <p className="mt-1 text-muted-foreground">Due {formatScheduleDate(m.target_date)}</p>
                <p className="mt-1"><StatusBadge value={m.status} /></p>
                {m.owner && <p className="mt-1 text-muted-foreground">Owner: {m.owner}</p>}
              </HoverCard>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Header scale (month ticks, week gridlines) ──────────────────────────────

function TimelineScale({ viewWindow }: { viewWindow: TimelineWindow }) {
  const months = useMemo(() => monthTicks(viewWindow.start, viewWindow.end), [viewWindow.start, viewWindow.end]);
  const weeks = useMemo(() => weekTicks(viewWindow.start, viewWindow.end), [viewWindow.start, viewWindow.end]);

  return (
    <div className="grid items-end gap-3 border-b pb-2" style={{ gridTemplateColumns: `${LABEL_COLUMN} minmax(480px,1fr)` }}>
      <span className="text-xs font-semibold uppercase text-muted-foreground">Phase</span>
      <div className="relative h-6">
        {weeks.map((w) => {
          const left = datePosition(w, viewWindow.start, viewWindow.end);
          if (left === null) return null;
          return <span key={w} aria-hidden="true" className="absolute top-0 h-full w-px bg-border" style={{ left: `${left}%` }} />;
        })}
        {months.map((tick) => {
          const left = datePosition(tick.date, viewWindow.start, viewWindow.end);
          if (left === null) return null;
          return (
            <span key={tick.date} aria-hidden="true" className="absolute top-0 -translate-x-px whitespace-nowrap text-xs font-semibold text-muted-foreground" style={{ left: `${left}%` }}>
              {tick.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Background overlay (weekend shading, hypercare band) + foreground (today, go-live) ──

function TimelineOverlays({
  viewWindow, todayLeft, goLiveLeft, hypercarePosition,
}: {
  viewWindow: TimelineWindow;
  todayLeft: number | null;
  goLiveLeft: number | null;
  hypercarePosition: { left: number; width: number } | null;
}) {
  const weekends = useMemo(() => weekendRanges(viewWindow.start, viewWindow.end), [viewWindow.start, viewWindow.end]);

  return (
    <>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {weekends.map((wknd) => {
          const position = dateRangePosition(wknd.start, wknd.end, viewWindow.start, viewWindow.end);
          if (!position) return null;
          return <div key={wknd.start} className="absolute inset-y-0 bg-muted/40" style={{ left: `${position.left}%`, width: `${position.width}%` }} />;
        })}
        {hypercarePosition && (
          <div className="absolute inset-y-0 bg-purple-200/40 dark:bg-purple-500/10" style={{ left: `${hypercarePosition.left}%`, width: `${hypercarePosition.width}%` }} />
        )}
      </div>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {todayLeft !== null && (
          <div className="absolute inset-y-0 w-px bg-foreground/70" style={{ left: `${todayLeft}%` }} title="Today" />
        )}
        {goLiveLeft !== null && (
          <div className="absolute inset-y-0 w-0.5 bg-violet-600 dark:bg-violet-400" style={{ left: `${goLiveLeft}%` }} title="Go-Live" />
        )}
      </div>
    </>
  );
}

// ── Timeline Intelligence panel ──────────────────────────────────────────────

function IntelligenceSection({ icon: Icon, title, children, empty }: { icon: React.ElementType; title: string; children: React.ReactNode; empty: boolean }) {
  return (
    <section>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {title}
      </div>
      <div className="mt-1.5">
        {empty ? <p className="text-xs text-muted-foreground">Nothing outstanding.</p> : children}
      </div>
    </section>
  );
}

function requirementLabel(signOff: RequirementSignOff, requirements: Requirement[]): string {
  const requirement = requirements.find((r) => r.id === signOff.requirement_id);
  return requirement ? `${requirement.requirement_ref}: ${signOff.sign_off_type} sign-off` : `${signOff.sign_off_type} sign-off`;
}

function TimelineIntelligencePanel({ state }: { state: ProjectState }) {
  const { scoped, confidence, recommendations, schedule, phase } = state;
  const { blockers, upcomingMilestones, openRisks, outstandingApprovals, blockedDeliverables } = useMemo(() => buildTimelineIntelligence(state), [state]);

  return (
    <aside className="space-y-4 rounded-lg border bg-card p-4 shadow-operational" aria-label="Timeline Intelligence">
      <div>
        <h3 className="text-sm font-semibold">Timeline Intelligence</h3>
        <p className="mt-1 text-xs text-muted-foreground">Read directly from ProjectState — the same facts every other page uses.</p>
      </div>

      <IntelligenceSection icon={Target} title="Current Phase" empty={false}>
        <p className="text-sm font-medium">{phase.phase}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{phase.detail}</p>
      </IntelligenceSection>

      <IntelligenceSection icon={CalendarClock} title="Schedule Variance" empty={false}>
        <p className="text-sm font-medium tabular-nums">{schedule.variance === null ? "Review" : `${schedule.variance > 0 ? "+" : ""}${schedule.variance}%`}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Actual progress minus planned progress · <StatusBadge value={schedule.health ?? "Review"} /></p>
      </IntelligenceSection>

      <IntelligenceSection icon={Lightbulb} title="Top Recommendations" empty={recommendations.length === 0}>
        <ol className="space-y-1.5">
          {recommendations.slice(0, 5).map((r) => (
            <li key={r.id} className="text-xs">
              <Link href={r.href} className="font-medium hover:underline">{r.title}</Link>
              <p className="text-muted-foreground">{r.reason}</p>
            </li>
          ))}
        </ol>
      </IntelligenceSection>

      <IntelligenceSection icon={Flag} title="Upcoming Milestones" empty={upcomingMilestones.length === 0}>
        <ul className="space-y-1.5">
          {upcomingMilestones.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{m.milestone_ref}: {m.title}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatScheduleDate(m.target_date)}</span>
            </li>
          ))}
        </ul>
      </IntelligenceSection>

      <IntelligenceSection icon={Rocket} title="Go-Live Blockers" empty={blockers.length === 0}>
        <ul className="space-y-1">
          {blockers.map((c) => <li key={c.key} className="text-xs">{c.label}</li>)}
        </ul>
      </IntelligenceSection>

      <IntelligenceSection icon={ShieldAlert} title="Open High/Critical Risks" empty={openRisks.length === 0}>
        <ul className="space-y-1">
          {openRisks.slice(0, 5).map((r) => <li key={r.id} className="text-xs">{r.risk_ref}: {r.description}</li>)}
        </ul>
      </IntelligenceSection>

      <IntelligenceSection icon={ClipboardCheck} title="Outstanding Approvals" empty={outstandingApprovals.length === 0}>
        <ul className="space-y-1">
          {outstandingApprovals.slice(0, 5).map((s) => (
            <li key={s.id} className="text-xs">{requirementLabel(s, scoped.requirements)} — {s.status}</li>
          ))}
        </ul>
      </IntelligenceSection>

      <IntelligenceSection icon={PackageCheck} title="Blocked Deliverables" empty={blockedDeliverables.length === 0}>
        <ul className="space-y-1">
          {blockedDeliverables.slice(0, 5).map((d) => <li key={d.id} className="text-xs">{d.deliverable_ref}: {d.title}</li>)}
        </ul>
      </IntelligenceSection>

      <IntelligenceSection icon={AlertTriangle} title="Delivery Confidence Reasons" empty={confidence.reasons.length === 0}>
        <ul className="space-y-1">
          {confidence.reasons.map((r) => <li key={r} className="text-xs">{r}</li>)}
        </ul>
      </IntelligenceSection>
    </aside>
  );
}

// ── Mobile card summary ───────────────────────────────────────────────────────

function MobilePhaseCards({ items }: { items: TimelineItem[] }) {
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const { label: daysLabel, warn: daysWarn } = phaseDaysLabel(item);
        return (
          <div key={item.id} className={cn("rounded-md border p-3", phaseRowTone(item))}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{item.phase_ref}</span>
              <StatusBadge value={item.status} />
            </div>
            <p className="mt-1 text-sm font-medium">{item.phase_name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatScheduleDate(item.start_date)} → {formatScheduleDate(item.end_date)} · {item.progress_percent}%</p>
            {daysLabel && <p className={cn("mt-0.5 text-xs font-semibold", daysWarn ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{daysLabel}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ExecutiveTimelinePage() {
  const { data, error, reload } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  useEffect(() => { setSelectedProjectId(loadSelectedProjectId()); }, []);

  const projects = useMemo(() => (data ? selectCanonicalProjects(data) : []), [data]);
  const project = useMemo(() => (data ? selectProjectById(data, selectedProjectId) : null), [data, selectedProjectId]);

  const handleProjectChange = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
  }, []);

  // One explicit buildProjectState call — every fact on this page comes from
  // this single object, never recomputed independently.
  const state = useMemo(() => (data && project ? buildProjectState(data, project) : null), [data, project]);

  const [zoom, setZoom] = useState<TimelineZoom>("Quarter");
  const [centerDate, setCenterDate] = useState<Date>(() => new Date());
  const [fitted, setFitted] = useState(false);

  const viewWindow = useMemo(() => {
    if (fitted && state?.schedule.projectStart && state?.schedule.projectEnd) {
      return { start: state.schedule.projectStart, end: state.schedule.projectEnd };
    }
    return zoomWindow(centerDate, zoom);
  }, [fitted, zoom, centerDate, state]);

  const handleZoom = useCallback((z: TimelineZoom) => { setZoom(z); setFitted(false); }, []);
  const handleFitToProject = useCallback(() => setFitted(true), []);
  const handleToday = useCallback(() => { setCenterDate(new Date()); setFitted(false); }, []);
  const handleJumpToGoLive = useCallback(() => {
    const goLive = state?.goLiveDate.date ? parseScheduleDate(state.goLiveDate.date) : null;
    if (goLive) { setCenterDate(goLive); setFitted(false); }
  }, [state]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!project || !state) {
    return <AppShell><div className="mt-8 text-center text-sm text-muted-foreground">No projects found. Add a project to use the Executive Timeline.</div></AppShell>;
  }

  const todayLeft = todayPosition(viewWindow.start, viewWindow.end);
  const goLiveLeft = state.goLiveDate.date ? datePosition(state.goLiveDate.date, viewWindow.start, viewWindow.end) : null;
  const hypercarePosition = project.hypercare_start_date && project.hypercare_end_date
    ? dateRangePosition(project.hypercare_start_date, project.hypercare_end_date, viewWindow.start, viewWindow.end)
    : null;

  return (
    <AppShell>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Intelligence</p>
          <h2 className="mt-1 text-2xl font-semibold">Executive Timeline</h2>
          <p className="mt-1 text-sm text-muted-foreground">Read-only executive view — for editing phase dates, use the Timeline page.</p>
        </div>
        {projects.length > 1 && (
          <Select value={project.id} onChange={(e) => handleProjectChange(e.target.value)} className="w-full sm:w-64" aria-label="Select project">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
      </div>

      <div className="mt-4">
        <TimelineHeaderStrip state={state} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 rounded-lg border bg-card shadow-operational">
          <TimelineControls
            zoom={zoom}
            onZoom={handleZoom}
            onFitToProject={handleFitToProject}
            onToday={handleToday}
            onJumpToGoLive={handleJumpToGoLive}
            fitted={fitted}
            hasGoLiveDate={Boolean(state.goLiveDate.date)}
          />

          {state.scoped.timeline_items.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No timeline phases have been added yet.</p>
          ) : (
            <>
              {/* Desktop/tablet chart */}
              <div className="hidden overflow-x-auto p-4 lg:block">
                <div className="relative" style={{ minWidth: TRACK_MIN_WIDTH }}>
                  <TimelineScale viewWindow={viewWindow} />
                  <div className="relative mt-2 space-y-1.5 py-1">
                    <TimelineOverlays viewWindow={viewWindow} todayLeft={todayLeft} goLiveLeft={goLiveLeft} hypercarePosition={hypercarePosition} />
                    <div className="relative space-y-1.5">
                      {state.scoped.timeline_items.map((item) => <PhaseRow key={item.id} item={item} viewWindow={viewWindow} />)}
                      <MilestonesRow milestones={state.scoped.milestones} viewWindow={viewWindow} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Mobile card summary — no horizontal miniature Gantt */}
              <div className="p-4 lg:hidden">
                <MobilePhaseCards items={state.scoped.timeline_items} />
              </div>
            </>
          )}
        </section>

        <TimelineIntelligencePanel state={state} />
      </div>
    </AppShell>
  );
}
