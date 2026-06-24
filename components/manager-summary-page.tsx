"use client";

import {
  AlertTriangle, CheckCircle2, Clock, Send, XCircle,
} from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { buildManagerExceptionReport, type ManagerProjectSummary, type ManagerRagStatus } from "@/lib/manager-summary";
import { useProjectData } from "@/lib/use-project-data";
import { cn } from "@/lib/utils";
import type { EmailActivity, EmailSettings } from "@/lib/types";
import type { DataStore } from "@/lib/data-store";

const STATUS_CONFIG: Record<ManagerRagStatus, { label: string; icon: typeof CheckCircle2; bg: string; border: string; badge: string; text: string }> = {
  Green: {
    label: "Green",
    icon: CheckCircle2,
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    border: "border-l-emerald-500",
    badge: "bg-emerald-600 text-white",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  Amber: {
    label: "Amber",
    icon: AlertTriangle,
    bg: "bg-amber-50 dark:bg-amber-950/30",
    border: "border-l-amber-500",
    badge: "bg-amber-500 text-white",
    text: "text-amber-700 dark:text-amber-400",
  },
  Red: {
    label: "Red",
    icon: XCircle,
    bg: "bg-red-50 dark:bg-red-950/30",
    border: "border-l-red-600",
    badge: "bg-red-600 text-white",
    text: "text-red-700 dark:text-red-400",
  },
};

function ProjectCard({ summary }: { summary: ManagerProjectSummary }) {
  const cfg = STATUS_CONFIG[summary.status];
  const Icon = cfg.icon;

  return (
    <div className={cn("rounded-lg border border-l-4 p-5 shadow-sm", cfg.bg, cfg.border)}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", cfg.text)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide", cfg.badge)}>
              {summary.status}
            </span>
            <h3 className="text-base font-semibold">{summary.project.name}</h3>
          </div>

          <p className="mt-2 text-sm leading-relaxed text-foreground/85">{summary.summary}</p>

          {summary.attentionRequired && (
            <div className="mt-3 rounded border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/40">
              <span className="font-semibold text-amber-800 dark:text-amber-300">Action required: </span>
              <span className="text-amber-900 dark:text-amber-200">{summary.attentionRequired}</span>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="font-medium">Date confidence:</span>{" "}
              <span className={
                summary.dateConfidence === "Delayed" ? "font-semibold text-red-600 dark:text-red-400"
                : summary.dateConfidence === "At Risk" ? "font-semibold text-amber-600 dark:text-amber-400"
                : "font-semibold text-emerald-600 dark:text-emerald-400"
              }>
                {summary.dateConfidence}
              </span>
            </span>
            <span>
              <span className="font-medium">Management action:</span>{" "}
              <span className={summary.managementAction === "Required" ? "font-semibold text-red-600 dark:text-red-400" : "font-semibold text-emerald-600 dark:text-emerald-400"}>
                {summary.managementAction}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ManagerSummaryPage() {
  const { data, error, reload } = useProjectData();
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);

  const report = data ? buildManagerExceptionReport(data) : null;

  const stored = data?.email_settings[0] as EmailSettings | undefined;
  const settings = stored ?? { recipient_email: "Andrew.Walker@bluestonex.com", manager_summary_enabled: false };

  async function sendNow() {
    if (!data) return;
    setSending(true);
    setSendResult(null);
    try {
      const response = await fetch("/api/email/manager-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: data as DataStore, recipient: settings.recipient_email }),
      });
      const result = await response.json() as { ok: boolean; message: string; activity?: EmailActivity };
      setSendResult({ ok: result.ok, text: result.message });
      if (!hasSupabaseConfig && result.activity) {
        // Log locally so the activity log shows
        import("@/lib/supabase/data-store").then(({ createRecord }) => {
          if (result.activity) {
            createRecord("email_activity_log", result.activity).catch(() => undefined);
          }
        });
        reload();
      }
    } catch (e) {
      setSendResult({ ok: false, text: e instanceof Error ? e.message : "Send failed." });
    } finally {
      setSending(false);
    }
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  const redCount = report?.projects.filter((p) => p.status === "Red").length ?? 0;
  const amberCount = report?.projects.filter((p) => p.status === "Amber").length ?? 0;
  const greenCount = report?.projects.filter((p) => p.status === "Green").length ?? 0;

  return (
    <AppShell>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Overview</p>
          <h2 className="mt-1 text-2xl font-semibold">Manager Exception Report</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Exceptions only. No KPIs, no percentages — just what needs management attention.
          </p>
        </div>
        <Button
          onClick={sendNow}
          disabled={sending}
          className="shrink-0 gap-2"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {sending ? "Sending…" : "Send Manager Summary Now"}
        </Button>
      </div>

      {sendResult && (
        <div className={cn(
          "mt-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm",
          sendResult.ok
            ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
        )}>
          {sendResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
          {sendResult.text}
        </div>
      )}

      {/* Scorecard */}
      <div className="mt-5 grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { label: "Red", count: redCount, color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900" },
          { label: "Amber", count: amberCount, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900" },
          { label: "Green", count: greenCount, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900" },
        ].map(({ label, count, color, bg }) => (
          <div key={label} className={cn("rounded-lg border p-4 text-center", bg)}>
            <p className={cn("text-3xl font-semibold tabular-nums", color)}>{count}</p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* Schedule */}
      <div className="mt-4 flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Clock className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span>
          Weekly schedule: <strong>Friday 16:00 London</strong>{" "}
          {(settings as EmailSettings & { manager_summary_enabled?: boolean }).manager_summary_enabled
            ? <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">Enabled</span>
            : <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">Disabled — enable in Email Settings</span>
          }
        </span>
      </div>

      {/* Project cards */}
      <div className="mt-5 space-y-4">
        {report?.projects.length === 0 ? (
          <div className="rounded-lg border bg-card p-10 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" aria-hidden="true" />
            <p className="mt-3 font-medium">No active projects</p>
            <p className="mt-1 text-sm text-muted-foreground">Add projects to see exception summaries.</p>
          </div>
        ) : (
          report?.projects.map((s) => <ProjectCard key={s.project.id} summary={s} />)
        )}
      </div>
    </AppShell>
  );
}
