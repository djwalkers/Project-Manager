"use client";

import { ArrowRight, CalendarClock, Code2, Eye, FileText, GitCompareArrows, Lightbulb, Mail, TrendingUp, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { InsightPanel } from "@/components/insight-panel";
import { IntelligenceFindingCard } from "@/components/intelligence-components";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { buildDailyBrief, type DailyBrief } from "@/lib/daily-brief";
import { persistSelectedProjectId } from "@/lib/project-selection";
import { formatScheduleDate } from "@/lib/schedule";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";

type PreviewMode = "rendered" | "html" | "plain";

function EmailPreview({ brief, onClose }: { brief: DailyBrief; onClose: () => void }) {
  const [mode, setMode] = useState<PreviewMode>("rendered");
  const tabs: { value: PreviewMode; label: string; icon: typeof Eye }[] = [
    { value: "rendered", label: "Rendered", icon: Eye },
    { value: "html", label: "HTML", icon: Code2 },
    { value: "plain", label: "Plain text", icon: FileText },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="email-preview-title">
      <section className="flex max-h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-xl border bg-background shadow-2xl sm:rounded-xl">
        <div className="flex items-start justify-between gap-4 border-b p-4 sm:p-5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">Email preparation</p>
            <h2 id="email-preview-title" className="mt-1 text-xl font-semibold">Daily Brief Email Preview</h2>
            <p className="mt-1 truncate text-sm text-muted-foreground">Subject: {brief.subject}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close email preview">
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 border-b p-3 sm:px-5" role="tablist" aria-label="Email preview format">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <Button key={tab.value} size="sm" variant={mode === tab.value ? "default" : "outline"} onClick={() => setMode(tab.value)} role="tab" aria-selected={mode === tab.value}>
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </Button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3 sm:p-5">
          {mode === "rendered" ? (
            <iframe title="Rendered daily brief email" srcDoc={brief.html} sandbox="" className="h-[620px] w-full rounded-md border bg-white" />
          ) : (
            <pre className="min-h-[520px] whitespace-pre-wrap break-words rounded-md border bg-card p-4 text-xs leading-6 text-foreground">{mode === "html" ? brief.html : brief.plainText}</pre>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t p-4 text-xs text-muted-foreground sm:px-5">
          <span>Preview only — no email will be sent.</span>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-muted/60 p-3">
      <dt className="text-xs font-semibold uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function SummaryList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <h4 className="text-sm font-semibold">{title}</h4>
      {items.length ? <ul className="mt-3 space-y-2 text-sm text-muted-foreground">{items.map((item) => <li key={item} className="border-l-2 border-primary/40 pl-3">{item}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

export function DailyBriefPage() {
  const { data, error, reload } = useProjectData();
  const [previewOpen, setPreviewOpen] = useState(false);
  const brief = useMemo(() => data ? buildDailyBrief(data) : null, [data]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data || !brief) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Management reporting</p>
          <h2 className="mt-1 text-2xl font-semibold">Daily Brief</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">A consolidated daily view of project health, delivery pressure and the next management priorities.</p>
        </div>
        <Button onClick={() => setPreviewOpen(true)}>
          <Mail className="h-4 w-4" aria-hidden="true" />
          Generate Email Preview
        </Button>
      </div>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="executive-summary-title">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><FileText className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <h3 id="executive-summary-title" className="font-semibold">Executive Summary</h3>
            <p className="mt-2 max-w-5xl text-sm leading-6 text-muted-foreground">{brief.executiveSummary}</p>
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="daily-recommendations-title">
        <div className="flex items-center gap-2"><Lightbulb className="h-5 w-5 text-primary" aria-hidden="true" /><h3 id="daily-recommendations-title" className="font-semibold">Today’s Recommendations</h3></div>
        <p className="mt-1 text-sm text-muted-foreground">Highest-priority deterministic management actions across all projects.</p>
        {brief.todaysRecommendations.length ? <div className="mt-4 grid gap-3 xl:grid-cols-2">{brief.todaysRecommendations.map((item) => <div key={item.finding.id}><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">{item.projectName}</p><IntelligenceFindingCard finding={item.finding} compact /></div>)}</div> : <div className="mt-4 rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">No management recommendations today.</div>}
      </section>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="since-yesterday-title">
        <div className="flex items-center gap-2"><GitCompareArrows className="h-5 w-5 text-primary" aria-hidden="true" /><h3 id="since-yesterday-title" className="font-semibold">Since Yesterday</h3></div>
        <p className="mt-1 text-sm text-muted-foreground">Changes between the two most recent daily snapshots.</p>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {brief.sinceYesterday.map((item) => (
            <article key={item.projectId} className="rounded-md border bg-muted/30 p-4">
              <h4 className="font-medium">{item.projectName}</h4>
              {item.available ? (
                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Progress changed" value={`${item.progressChange > 0 ? "+" : ""}${item.progressChange}%`} />
                  <Metric label="New / closed risks" value={`${item.newRisks} / ${item.closedRisks}`} />
                  <Metric label="New / completed actions" value={`${item.newActions} / ${item.completedActions}`} />
                  <Metric label="Health change" value={item.healthChange ?? "No change"} />
                  {item.milestoneChange ? <div className="col-span-2 rounded-md bg-muted/60 p-3 sm:col-span-4"><dt className="text-xs font-semibold uppercase text-muted-foreground">Milestone change</dt><dd className="mt-1 text-sm font-medium">{item.milestoneChange}</dd></div> : null}
                </dl>
              ) : <p className="mt-3 text-sm text-muted-foreground">Create another daily snapshot to unlock day-over-day comparison.</p>}
            </article>
          ))}
          {!brief.sinceYesterday.length ? <p className="text-sm text-muted-foreground">Snapshot history is still building.</p> : null}
        </div>
      </section>

      <div className="mt-5 grid gap-5 2xl:grid-cols-2">
        {brief.projects.map((item) => (
          <article key={item.project.id} className="min-w-0 rounded-lg border bg-card p-4 shadow-operational">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <p className="text-xs font-semibold uppercase text-primary">{item.project.customer} / {item.project.workstream}</p>
                <h3 className="mt-1 text-lg font-semibold">{item.project.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">Active phase: <span className="font-medium text-foreground">{item.activePhase}</span></p>
              </div>
              <div className="flex gap-2">
                <div><p className="mb-1 text-xs text-muted-foreground">Health</p><StatusBadge value={item.health} /></div>
                <div><p className="mb-1 text-xs text-muted-foreground">Schedule</p><StatusBadge value={item.scheduleHealth} /></div>
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium">Overall progress</span><strong className="tabular-nums">{item.progress}%</strong></div>
              <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${item.project.name} overall progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }} />
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Days remaining" value={item.daysRemaining ?? "Review"} />
              <Metric label="Open risks" value={item.openRisks} />
              <Metric label="Open decisions" value={item.openDecisions} />
              <Metric label="Overdue actions" value={item.overdueActions} />
            </dl>

            <div className={cn("mt-4 flex items-start gap-3 rounded-md border p-3", item.upcomingMilestone ? "bg-muted/40" : "border-dashed bg-muted/20")}>
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <div><p className="text-xs font-semibold uppercase text-muted-foreground">Upcoming milestone</p><p className="mt-1 text-sm font-medium">{item.upcomingMilestone?.title ?? "No milestone scheduled"}</p>{item.upcomingMilestone ? <p className="mt-1 text-xs text-muted-foreground">{formatScheduleDate(item.upcomingMilestone.target_date)} · {item.upcomingMilestone.owner ?? "Unassigned"}</p> : null}</div>
            </div>
            <div className="mt-4 flex justify-end"><Link href="/project-workspace" onClick={() => persistSelectedProjectId(item.project.id)} className="inline-flex min-h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open workspace<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></div>
          </article>
        ))}
      </div>

      {!brief.projects.length ? <div className="mt-5 rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">No projects are available for today’s brief.</div> : null}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <InsightPanel title="Attention Required" description="Cross-project blockers and overdue items, ordered by severity." items={brief.attention} emptyMessage="No items require management attention." />
        <InsightPanel title="Upcoming This Week" description="Actions, decisions and milestones due in the next seven days." items={brief.upcoming} emptyMessage="No items are due in the next seven days." />
      </div>

      <section className="mt-5 rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="weekly-summary-title">
        <div className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-primary" aria-hidden="true" /><h3 id="weekly-summary-title" className="font-semibold">Weekly Executive Summary</h3></div>
        <p className="mt-1 text-sm text-muted-foreground">Seven-day movement and forward delivery outlook from snapshot history.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <SummaryList title="What improved" items={brief.weeklySummary.improved} empty="No measured improvements yet." />
          <SummaryList title="What worsened" items={brief.weeklySummary.worsened} empty="No measured deterioration." />
          <SummaryList title="Upcoming milestones" items={brief.weeklySummary.upcomingMilestones} empty="No milestones scheduled." />
          <SummaryList title="Projects requiring attention" items={brief.weeklySummary.projectsRequiringAttention} empty="No projects require attention." />
        </div>
      </section>

      {previewOpen ? <EmailPreview brief={brief} onClose={() => setPreviewOpen(false)} /> : null}
    </AppShell>
  );
}
