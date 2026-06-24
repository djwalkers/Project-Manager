"use client";

import { AlertTriangle, BrainCircuit, CheckCircle2, CircleAlert, Gauge, Lightbulb, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { IntelligenceFindingCard } from "@/components/intelligence-components";
import { Select } from "@/components/ui/input";
import { WorkspaceEmpty, WorkspaceMetric, WorkspaceSection } from "@/components/workspace-components";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import { buildProjectIntelligence, type IntelligenceCategory } from "@/lib/project-intelligence";
import { useProjectData } from "@/lib/use-project-data";

const categories: IntelligenceCategory[] = ["Schedule", "Risk", "Governance", "Delivery", "Testing", "Stakeholder"];

export function ProjectIntelligencePage() {
  const { data, error, reload } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projects = useMemo(() => data ? selectCanonicalProjects(data) : [], [data]);
  const project = data ? selectProjectById(data, selectedProjectId) : null;
  const report = useMemo(() => data && project ? buildProjectIntelligence(data, project) : null, [data, project]);

  useEffect(() => {
    if (!data || !projects.length) return;
    const stored = loadSelectedProjectId();
    const next = projects.some((item) => item.id === stored) ? stored : selectProjectById(data, null)?.id ?? projects[0].id;
    setSelectedProjectId(next);
    if (next) persistSelectedProjectId(next);
  }, [data, projects]);

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!project || !report) return <AppShell><EmptyState title="No projects available" description="Add project delivery data before running intelligence rules." icon={BrainCircuit} /></AppShell>;

  const TrendIcon = report.trend.direction === "Increasing" ? TrendingUp : report.trend.direction === "Decreasing" ? TrendingDown : Gauge;

  return (
    <AppShell>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div><p className="text-sm font-medium text-primary">Deterministic delivery analysis</p><h2 className="mt-1 text-2xl font-semibold">Project Intelligence</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Proactive schedule, risk, governance, delivery, testing and stakeholder findings generated from existing control data.</p></div>
        <label className="w-full text-sm font-medium sm:w-80"><span className="mb-2 block">Selected project</span><Select value={project.id} onChange={(event) => selectProject(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      </div>

      <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="intelligence-overview">
        <div className="flex items-start gap-3"><span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><BrainCircuit className="h-6 w-6" aria-hidden="true" /></span><div><h3 id="intelligence-overview" className="font-semibold">{project.name}</h3><p className="mt-1 text-sm text-muted-foreground">Rules ran locally against the current project dataset. No AI service or external API was used.</p></div></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><WorkspaceMetric label="Critical Findings" value={report.critical.length} /><WorkspaceMetric label="Warnings" value={report.warnings.length} /><WorkspaceMetric label="Recommendations" value={report.recommendations.length} /><WorkspaceMetric label="Average Confidence" value={`${report.averageConfidence}%`} /></div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="space-y-5">
          <WorkspaceSection id="critical-findings" title="Critical Findings" description="Conditions requiring immediate management attention." icon={CircleAlert}>
            {report.critical.length ? <div className="space-y-3">{report.critical.map((item) => <IntelligenceFindingCard key={item.id} finding={item} />)}</div> : <WorkspaceEmpty>No critical conditions detected.</WorkspaceEmpty>}
          </WorkspaceSection>
          <WorkspaceSection id="warning-findings" title="Warnings" description="Emerging concerns and governance gaps requiring review." icon={AlertTriangle}>
            {report.warnings.length ? <div className="space-y-3">{report.warnings.map((item) => <IntelligenceFindingCard key={item.id} finding={item} />)}</div> : <WorkspaceEmpty>No warning conditions detected.</WorkspaceEmpty>}
          </WorkspaceSection>
        </div>

        <div className="space-y-5">
          <WorkspaceSection id="intelligence-trend" title="Finding Trend" description="Direction of snapshot-derived delivery pressure." icon={TrendIcon}>
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-4"><div><p className="text-2xl font-semibold">{report.trend.direction}</p><p className="mt-1 text-sm text-muted-foreground">{report.trend.detail}</p></div><TrendIcon className="h-8 w-8 shrink-0 text-primary" aria-hidden="true" /></div>
          </WorkspaceSection>
          <WorkspaceSection id="category-coverage" title="Category Coverage" description="Actionable findings by intelligence domain." icon={Gauge}>
            <div className="space-y-3">{categories.map((category) => <div key={category}><div className="flex items-center justify-between text-sm"><span className="font-medium">{category} Insights</span><span className="font-semibold tabular-nums">{report.categoryCounts[category]}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, report.categoryCounts[category] * 20)}%` }} /></div></div>)}</div>
          </WorkspaceSection>
          <WorkspaceSection id="positive-signals" title="Positive Signals" description="Controls and delivery evidence currently working well." icon={CheckCircle2}>
            {report.positiveSignals.length ? <div className="space-y-3">{report.positiveSignals.map((item) => <IntelligenceFindingCard key={item.id} finding={item} compact showRecommendation={false} />)}</div> : <WorkspaceEmpty>No positive signals have enough evidence yet.</WorkspaceEmpty>}
          </WorkspaceSection>
        </div>
      </div>

      <WorkspaceSection id="intelligence-recommendations" title="Recommendations" description="Prioritised management actions derived directly from the findings above." icon={Lightbulb} className="mt-5">
        {report.recommendations.length ? <ol className="grid gap-3 lg:grid-cols-2">{report.recommendations.map((item, index) => <li key={item.id} className="flex gap-3 rounded-md border bg-muted/20 p-4"><span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{index + 1}</span><div><p className="text-sm font-semibold">{item.recommendation}</p><p className="mt-1 text-xs text-muted-foreground">{item.category} · {item.severity} · {item.confidence}% confidence</p></div></li>)}</ol> : <WorkspaceEmpty>No management recommendations are currently required.</WorkspaceEmpty>}
      </WorkspaceSection>
    </AppShell>
  );
}

