"use client";

import { ArrowDown, ArrowRight, ArrowUp, BrainCircuit, BriefcaseBusiness, Camera, History, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { TrendChart } from "@/components/trend-chart";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { selectCanonicalProjects } from "@/lib/project-scope";
import { buildProjectIntelligence } from "@/lib/project-intelligence";
import { buildTrendAnalysis, type TrendChange } from "@/lib/project-trends";
import { formatScheduleDate } from "@/lib/schedule";
import { saveDailySnapshots } from "@/lib/snapshot-service";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";

function ChangeCard({ label, change, inverse = false, suffix = "" }: { label: string; change: TrendChange; inverse?: boolean; suffix?: string }) {
  const Icon = change.direction === "up" ? ArrowUp : change.direction === "down" ? ArrowDown : ArrowRight;
  const positive = inverse ? change.value < 0 : change.value > 0;
  const negative = inverse ? change.value > 0 : change.value < 0;
  return (
    <section className="rounded-lg border bg-card p-4 shadow-operational">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-center gap-2"><p className="text-3xl font-semibold tabular-nums">{change.value > 0 ? "+" : ""}{change.value}{suffix}</p><Icon className={cn("h-5 w-5", positive ? "text-emerald-600" : negative ? "text-destructive" : "text-muted-foreground")} aria-hidden="true" /></div>
      <p className="mt-2 text-xs text-muted-foreground">Change across the available 7-day window</p>
    </section>
  );
}

export function ProjectTrendsPage() {
  const { data, error, reload } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const projects = useMemo(() => data ? selectCanonicalProjects(data) : [], [data]);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const trend = useMemo(() => selectedProject && data ? buildTrendAnalysis(selectedProject, data.project_snapshots) : null, [data, selectedProject]);
  const intelligence = useMemo(() => selectedProject && data ? buildProjectIntelligence(data, selectedProject) : null, [data, selectedProject]);

  async function takeSnapshot() {
    if (!data) return;
    setSaving(true);
    setMessage(null);
    try {
      const snapshots = await saveDailySnapshots(data);
      setMessage(`${snapshots.length} daily ${snapshots.length === 1 ? "snapshot" : "snapshots"} saved. Existing records for today were updated, not duplicated.`);
      reload();
    } catch (snapshotError) {
      setMessage(snapshotError instanceof Error ? snapshotError.message : "Failed to save daily snapshots");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!projects.length || !selectedProject || !trend || !intelligence) return <AppShell><EmptyState title="No projects found" description="Add a project before creating snapshot history." icon={BriefcaseBusiness} /></AppShell>;

  const points = <K extends "progress_percent" | "open_risks" | "open_actions" | "open_decisions" | "schedule_variance">(field: K) => trend.snapshots.map((snapshot) => ({ date: snapshot.snapshot_date, value: Number(snapshot[field]) }));

  return (
    <AppShell>
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div><p className="text-sm font-medium text-primary">Historical control</p><h2 className="mt-1 text-2xl font-semibold">Project Trends</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Track whether project delivery is improving or deteriorating from daily control snapshots.</p></div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="min-w-64 text-sm font-medium"><span className="sr-only">Selected project</span><Select value={selectedProject.id} onChange={(event) => setSelectedProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>
          <Button onClick={takeSnapshot} disabled={saving}><Camera className="h-4 w-4" aria-hidden="true" />{saving ? "Saving snapshot…" : "Take Daily Snapshot"}</Button>
        </div>
      </div>

      {message ? <div className="mt-4 rounded-md border bg-card p-3 text-sm" role="status">{message}</div> : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ChangeCard label="Progress Change (7 days)" change={trend.progressChange} suffix="%" />
        <ChangeCard label="Risk Change (7 days)" change={trend.riskChange} inverse />
        <ChangeCard label="Action Change (7 days)" change={trend.actionChange} inverse />
        <ChangeCard label="Decision Change (7 days)" change={trend.decisionChange} inverse />
      </div>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="project-trend-narrative">
        <div className="flex items-start gap-3"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><RefreshCw className="h-5 w-5" aria-hidden="true" /></span><div><h3 id="project-trend-narrative" className="font-semibold">Project Narrative</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{trend.narrative}</p></div></div>
      </section>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="intelligence-trend-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-3"><span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><BrainCircuit className="h-5 w-5" aria-hidden="true" /></span><div><h3 id="intelligence-trend-title" className="font-semibold">Intelligence Trend</h3><p className="mt-1 text-sm text-muted-foreground">{intelligence.trend.detail}</p></div></div><div className="flex flex-wrap gap-2"><span className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-semibold">{intelligence.trend.direction}</span><span className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{intelligence.critical.length} critical · {intelligence.warnings.length} warnings</span></div></div>
      </section>

      <div className="mt-5 grid min-w-0 gap-5 xl:grid-cols-2">
        <TrendChart title="Progress Trend" description="Overall weighted project progress by snapshot day." points={points("progress_percent")} suffix="%" />
        <TrendChart title="Risk Trend" description="Open risks over time." points={points("open_risks")} color="#dc2626" />
        <TrendChart title="Action Trend" description="Open actions over time." points={points("open_actions")} color="#0891b2" />
        <TrendChart title="Decision Trend" description="Open decisions over time." points={points("open_decisions")} color="#7c3aed" />
        <div className="min-w-0 xl:col-span-2"><TrendChart title="Schedule Variance Trend" description="Actual progress minus planned progress." points={points("schedule_variance")} color="#d97706" suffix="%" /></div>
      </div>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="health-timeline-title">
        <div className="flex items-center gap-2"><History className="h-5 w-5 text-primary" aria-hidden="true" /><h3 id="health-timeline-title" className="font-semibold">Health Timeline</h3></div>
        {trend.snapshots.length ? <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">{trend.snapshots.map((snapshot) => <li key={snapshot.id} className="rounded-md border bg-muted/30 p-3"><p className="text-xs font-medium text-muted-foreground">{formatScheduleDate(snapshot.snapshot_date)}</p><StatusBadge value={snapshot.project_health} className="mt-2" /><p className="mt-2 text-xs text-muted-foreground">Schedule: {snapshot.schedule_health}</p></li>)}</ol> : <div className="mt-4 rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">No health history yet. Take the first daily snapshot to establish a baseline.</div>}
      </section>
    </AppShell>
  );
}
