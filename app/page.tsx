"use client";

import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  Flag,
  Lightbulb,
  Plus,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { buildTodaysPriorities } from "@/lib/control-tower";
import { computeDeliveryConfidence } from "@/lib/delivery-confidence";
import { buildRecommendations, type Recommendation } from "@/lib/recommendations";
import { selectActiveProject } from "@/lib/project-scope";
import { useProjectData } from "@/lib/use-project-data";
import { useAuth } from "@/contexts/auth-context";
import { isOverdue } from "@/lib/utils";
import { cn } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function greeting(name: string) {
  const h = new Date().getHours();
  if (h < 12) return `Good morning, ${name.split(" ")[0]}`;
  if (h < 17) return `Good afternoon, ${name.split(" ")[0]}`;
  return `Good evening, ${name.split(" ")[0]}`;
}

function urgencyColor(urgency: Recommendation["urgency"]) {
  return {
    critical: "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-950/20",
    high: "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20",
    medium: "border-blue-200 bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/20",
    low: "border-muted bg-muted/40",
  }[urgency];
}

function urgencyDot(urgency: Recommendation["urgency"]) {
  return {
    critical: "bg-red-500",
    high: "bg-amber-500",
    medium: "bg-blue-500",
    low: "bg-muted-foreground/40",
  }[urgency];
}

function urgencyLabel(urgency: Recommendation["urgency"]) {
  return { critical: "Critical", high: "High", medium: "Medium", low: "Low" }[urgency];
}

type RecTypeIcon = Recommendation["type"];
const TYPE_ICONS: Record<RecTypeIcon, React.ElementType> = {
  action: ClipboardCheck,
  risk: AlertTriangle,
  decision: Flag,
  milestone: Flag,
  question: CircleHelp,
  meeting: CalendarDays,
  intelligence: Sparkles,
};

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  href,
  tone = "neutral",
  icon: Icon,
}: {
  label: string;
  value: number | string;
  href: string;
  tone?: "danger" | "warn" | "good" | "neutral";
  icon: React.ElementType;
}) {
  const colorMap = {
    danger: "text-red-600 dark:text-red-400",
    warn: "text-amber-600 dark:text-amber-400",
    good: "text-green-700 dark:text-green-400",
    neutral: "text-foreground",
  };
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border bg-card p-4 shadow-sm transition-colors hover:bg-muted/50">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </span>
      <div>
        <p className={cn("text-2xl font-bold tabular-nums leading-none", colorMap[tone])}>{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{label}</p>
      </div>
    </Link>
  );
}

// ── Quick Create ──────────────────────────────────────────────────────────────

function QuickCreate() {
  const items = [
    { label: "Action", href: "/actions", icon: ClipboardCheck },
    { label: "Risk", href: "/risks", icon: AlertTriangle },
    { label: "Decision", href: "/decisions", icon: Flag },
    { label: "Question", href: "/discovery-questions", icon: CircleHelp },
    { label: "Milestone", href: "/milestones", icon: Flag },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ label, href, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </Link>
      ))}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title,
  href,
  linkLabel = "View all",
  icon: Icon,
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  icon?: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-primary" aria-hidden="true" />}
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        {href && (
          <Link href={href} className="flex items-center gap-1 text-xs text-primary hover:underline">
            {linkLabel} <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

// ── Workbench page ────────────────────────────────────────────────────────────

export default function WorkbenchPage() {
  const { data, error, reload } = useProjectData();
  const { user } = useAuth();

  const wb = useMemo(() => {
    if (!data) return null;
    const project = selectActiveProject(data);
    if (!project) return null;

    const overdueActions = data.actions.filter(
      (a) => isOverdue(a.due_date, a.status),
    );
    const openRisks = data.risks.filter(
      (r) => !["Complete", "Closed"].includes(r.status),
    );
    const highRisks = openRisks.filter((r) => ["High", "Critical"].includes(r.impact));
    const awaitingQuestions = data.discovery_questions.filter((q) =>
      ["Awaiting Business", "Awaiting Development", "Awaiting Response"].includes(q.status),
    );
    const blockedMilestones = data.milestones.filter((m) => m.status === "Blocked");
    const upcomingMeetings = [...(data.meeting_intelligence ?? [])]
      .sort((a, b) => (b.meeting_date ?? "").localeCompare(a.meeting_date ?? ""))
      .slice(0, 5);
    const pendingSuggestions = (data.meeting_suggestions ?? []).filter(
      (s) => s.status === "Pending",
    );
    const confidence = computeDeliveryConfidence(data);
    const recommendations = buildRecommendations(data, 5);
    const priorities = buildTodaysPriorities(data);
    const recentActivity = data.activity_log.slice(0, 8);

    return {
      project,
      overdueActions,
      openRisks: openRisks.length,
      highRisks: highRisks.length,
      awaitingQuestions,
      blockedMilestones,
      upcomingMeetings,
      pendingSuggestions,
      confidence,
      recommendations,
      priorities,
      recentActivity,
    };
  }, [data]);

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;
  if (!wb) {
    return (
      <AppShell>
        <EmptyState title="No projects found" description="Add a project to use your workbench." icon={BriefcaseBusiness} />
      </AppShell>
    );
  }

  const name = user?.fullName ?? "there";

  return (
    <AppShell>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <p className="text-sm font-medium text-primary">My Workbench</p>
        <h1 className="mt-1 text-2xl font-semibold">{greeting(name)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {wb.project.name} · {wb.project.customer}
        </p>
      </div>

      {/* ── Quick-stat bar ───────────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Overdue Actions" value={wb.overdueActions.length} href="/actions" tone={wb.overdueActions.length > 0 ? "danger" : "good"} icon={ClipboardCheck} />
        <StatCard label="Open Risks" value={wb.openRisks} href="/risks" tone={wb.highRisks > 0 ? "warn" : "neutral"} icon={AlertTriangle} />
        <StatCard label="Awaiting Answers" value={wb.awaitingQuestions.length} href="/discovery-questions" tone={wb.awaitingQuestions.length > 0 ? "warn" : "good"} icon={CircleHelp} />
        <StatCard label="Blocked Milestones" value={wb.blockedMilestones.length} href="/milestones" tone={wb.blockedMilestones.length > 0 ? "danger" : "good"} icon={Flag} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* ── Left column ───────────────────────────────────────────────────── */}
        <div className="space-y-5">

          {/* Recommendations */}
          <Section title="Today's Recommendations" icon={Lightbulb}>
            {wb.recommendations.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                No critical items — the project is on track.
              </div>
            ) : (
              <ol className="space-y-2.5">
                {wb.recommendations.map((rec, i) => {
                  const Icon = TYPE_ICONS[rec.type];
                  return (
                    <li key={rec.id}>
                      <Link href={rec.href} className={cn("flex items-start gap-3 rounded-md border p-3 transition-colors hover:opacity-90", urgencyColor(rec.urgency))}>
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-bold text-foreground shadow-sm">
                          {i + 1}
                        </span>
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium leading-snug">{rec.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{rec.reason}</p>
                        </div>
                        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                          <span className={cn("h-1.5 w-1.5 rounded-full", urgencyDot(rec.urgency))} />
                          {urgencyLabel(rec.urgency)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          {/* Today's priorities */}
          {wb.priorities.length > 0 && (
            <Section title="Today's Priorities" icon={Zap}>
              <ol className="space-y-2">
                {wb.priorities.slice(0, 5).map((p) => (
                  <li key={p.rank} className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                      {p.rank}
                    </span>
                    <div>
                      <p className="text-sm font-semibold">{p.title}</p>
                      {p.detail && <p className="mt-0.5 text-xs text-muted-foreground">{p.detail}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {/* Overdue Actions */}
          {wb.overdueActions.length > 0 && (
            <Section title={`Overdue Actions (${wb.overdueActions.length})`} href="/actions" icon={ClipboardCheck}>
              <div className="space-y-2">
                {wb.overdueActions.slice(0, 6).map((a) => (
                  <div key={a.id} className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-red-700 dark:text-red-400">{a.action_ref}</span>
                        <StatusBadge value={a.status} />
                      </div>
                      <p className="mt-1 text-sm">{a.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Due {a.due_date} · {a.owner}</p>
                    </div>
                  </div>
                ))}
                {wb.overdueActions.length > 6 && (
                  <Link href="/actions" className="block text-center text-xs text-primary hover:underline">
                    +{wb.overdueActions.length - 6} more overdue actions
                  </Link>
                )}
              </div>
            </Section>
          )}

          {/* Questions awaiting response */}
          {wb.awaitingQuestions.length > 0 && (
            <Section title={`Questions Awaiting Response (${wb.awaitingQuestions.length})`} href="/discovery-questions" icon={CircleHelp}>
              <div className="space-y-2">
                {wb.awaitingQuestions.slice(0, 4).map((q) => (
                  <div key={q.id} className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-muted-foreground">{q.question_ref}</span>
                        <StatusBadge value={q.status} />
                      </div>
                      <p className="mt-1 text-sm">{q.question}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        {/* ── Right column ──────────────────────────────────────────────────── */}
        <div className="space-y-5">

          {/* Delivery Confidence */}
          <section className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-primary" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Delivery Confidence</h2>
              </div>
              <Link href="/control-tower" className="flex items-center gap-1 text-xs text-primary hover:underline">
                Full view <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="mt-4 text-center">
              <span className={cn("text-5xl font-bold tabular-nums", wb.confidence.rag === "Green" ? "text-green-700" : wb.confidence.rag === "Amber" ? "text-amber-600" : "text-red-600")}>
                {wb.confidence.score}%
              </span>
              <p className="mt-1 text-xs text-muted-foreground">{wb.confidence.rag} · {wb.confidence.reasons.length === 0 ? "All checks passed" : `${wb.confidence.reasons.length} gap${wb.confidence.reasons.length > 1 ? "s" : ""} detected`}</p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-[width] duration-500", wb.confidence.rag === "Green" ? "bg-green-600" : wb.confidence.rag === "Amber" ? "bg-amber-500" : "bg-red-500")}
                style={{ width: `${wb.confidence.score}%` }}
              />
            </div>
            {wb.confidence.reasons.length > 0 && (
              <ul className="mt-3 space-y-1">
                {wb.confidence.reasons.slice(0, 3).map((r) => (
                  <li key={r} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                    {r}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Quick Create */}
          <section className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <Plus className="h-4 w-4 text-primary" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Quick Create</h2>
            </div>
            <QuickCreate />
          </section>

          {/* Meeting Intelligence */}
          {wb.upcomingMeetings.length > 0 && (
            <Section title="Recent Meetings" href="/meeting-intelligence" icon={Sparkles}>
              <div className="space-y-2">
                {wb.upcomingMeetings.map((m) => (
                  <Link key={m.id} href={`/meeting-intelligence/${m.id}`} className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 hover:bg-muted/70 transition-colors">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-snug">{m.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{m.meeting_date ?? "No date"} · {m.processing_status}</p>
                    </div>
                  </Link>
                ))}
                {wb.pendingSuggestions.length > 0 && (
                  <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
                    {wb.pendingSuggestions.length} suggestion{wb.pendingSuggestions.length > 1 ? "s" : ""} pending review
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Recent Activity */}
          {wb.recentActivity.length > 0 && (
            <Section title="Recent Activity" icon={TrendingUp}>
              <div className="space-y-2">
                {wb.recentActivity.map((a) => (
                  <div key={a.id} className="rounded-md border bg-muted/40 p-3">
                    <p className="text-xs font-medium">{a.activity_type}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{a.description}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </AppShell>
  );
}
