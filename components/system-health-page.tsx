"use client";

import { AlertTriangle, BrainCircuit, CheckCircle2, ClipboardCopy, Database, History, MailCheck, Server, ShieldCheck, Stethoscope, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadingState } from "@/components/data-state";
import { getSystemHealth, type SystemHealthReport } from "@/lib/system-health";
import { useAuth } from "@/contexts/auth-context";
import { hasSupabaseConfig } from "@/lib/supabase/client";

// ── MetricCard ──────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  state,
  mono,
  onCopy,
}: {
  label: string;
  value: string | number;
  state?: boolean;
  mono?: boolean;
  onCopy?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const Icon = state === undefined ? Database : state ? CheckCircle2 : XCircle;

  function handleCopy() {
    navigator.clipboard.writeText(String(value)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
    onCopy?.();
  }

  return (
    <section className="rounded-lg border bg-card p-4 shadow-operational">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className={`mt-2 break-all text-lg font-semibold leading-snug ${mono ? "font-mono text-sm" : ""}`}>
            {value}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onCopy && (
            <button
              onClick={handleCopy}
              aria-label={`Copy ${label}`}
              title={copied ? "Copied!" : `Copy ${label}`}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <Icon
            className={
              state === false
                ? "h-5 w-5 text-destructive"
                : state === true
                  ? "h-5 w-5 text-emerald-600"
                  : "h-5 w-5 text-primary"
            }
            aria-hidden="true"
          />
        </div>
      </div>
    </section>
  );
}

// ── SectionHeader ───────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title, subtitle }: { icon: React.ElementType; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div>
        <h3 className="font-semibold">{title}</h3>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}

// ── SystemHealthPage ────────────────────────────────────────────────────────

export function SystemHealthPage() {
  const [report, setReport] = useState<SystemHealthReport | null>(null);
  const [resendConfigured, setResendConfigured] = useState(false);
  const [error, setError] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    let active = true;
    Promise.all([
      getSystemHealth(),
      fetch("/api/email/status").then((r) => r.json()).catch(() => ({ resendConfigured: false })),
    ]).then(([value, email]) => {
      if (!active) return;
      setReport(value);
      setResendConfigured(Boolean(email.resendConfigured));
    }).catch(() => active && setError(true));
    return () => { active = false; };
  }, []);

  if (!report && !error) return <AppShell><LoadingState /></AppShell>;

  if (!report) {
    return (
      <AppShell>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
          <XCircle className="mx-auto h-8 w-8 text-destructive" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-semibold">System health check failed</h2>
          <p className="mt-2 text-sm text-muted-foreground">The diagnostic report could not be generated.</p>
        </div>
      </AppShell>
    );
  }

  const healthyTables = report.tables.filter((t) => t.status !== "Mismatch").length;
  const { migration } = report;
  const isUpToDate = migration.outstandingMigrations.length === 0;

  return (
    <AppShell>
      {/* Page header */}
      <div>
        <p className="text-sm font-medium text-primary">Diagnostics</p>
        <h2 className="mt-1 text-2xl font-semibold">System Health</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Runtime alignment between the application contract, local fallback, and Supabase tables.
        </p>
      </div>

      {/* Authentication */}
      <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="auth-health-title">
        <SectionHeader icon={ShieldCheck} title="Authentication" subtitle="Session, access control, and role assignment." />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <MetricCard label="Auth Enabled" value={hasSupabaseConfig ? "Yes" : "No (local mode)"} state={hasSupabaseConfig} />
          <MetricCard label="Current User" value={user?.fullName ?? "—"} />
          <MetricCard
            label="Current Role"
            value={user?.role ?? "—"}
            state={user?.role === "Admin" || user?.role === "Manager" ? true : undefined}
          />
        </div>
      </section>

      {/* Audit Trail */}
      <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="audit-health-title">
        <div className="flex items-center gap-2 border-b pb-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <History className="h-5 w-5" aria-hidden="true" />
          </span>
          <h3 id="audit-health-title" className="font-semibold">Audit Trail</h3>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <MetricCard label="Audit Logging" value={report.audit.enabled ? "Enabled" : "Local mode (not tracking)"} state={report.audit.enabled} />
          <MetricCard label="Audit Records" value={report.audit.recordCount} />
        </div>
      </section>

      {/* Schema / Migration */}
      <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="migration-health-title">
        <SectionHeader
          icon={Stethoscope}
          title="Schema &amp; Migrations"
          subtitle="Application schema version and database migration status."
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Current Schema Version"
            value={migration.schemaVersion}
            mono
            onCopy={() => undefined}
            state={isUpToDate}
          />
          <MetricCard
            label="Latest Migration Available"
            value={migration.latestMigration}
            mono
          />
          <MetricCard
            label="Applied"
            value={`${migration.appliedCount} / ${migration.totalCount}`}
            state={isUpToDate}
          />
          <MetricCard
            label="Outstanding Migrations"
            value={isUpToDate ? "None" : String(migration.outstandingMigrations.length)}
            state={isUpToDate}
          />
        </div>
        {!isUpToDate && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
            <p className="font-semibold text-amber-800 dark:text-amber-300">Pending migrations</p>
            <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-amber-900 dark:text-amber-200">
              {migration.outstandingMigrations.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </div>
        )}
      </section>

      {/* Quick stats */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Database Tables" value={`${healthyTables} / ${report.tables.length}`} state={healthyTables === report.tables.length} />
        <MetricCard label="Migration Version" value={report.schemaVersion} mono onCopy={() => undefined} />
        <MetricCard label="Supabase Connected" value={report.connected ? "Yes" : "No"} state={report.connected} />
        <MetricCard label="Local Mode Active" value={report.localMode ? "Yes" : "No"} state={report.localMode} />
        <MetricCard label="Intelligence Engine" value={report.intelligence.valid ? "Healthy" : "Review"} state={report.intelligence.valid} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-8">
        <MetricCard label="Projects" value={report.counts.projects} />
        <MetricCard label="Deliverables" value={report.counts.deliverables} />
        <MetricCard label="Requirements" value={report.counts.requirements} />
        <MetricCard label="Risks" value={report.counts.risks} />
        <MetricCard label="Actions" value={report.counts.actions} />
        <MetricCard label="Decisions" value={report.counts.decisions} />
        <MetricCard label="Timeline Items" value={report.counts.timeline_items} />
        <MetricCard label="Snapshots" value={report.counts.project_snapshots} />
      </div>

      {/* Email Delivery Health */}
      <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="email-health-title">
        <SectionHeader icon={MailCheck} title="Email Delivery Health" subtitle="Server configuration, schedule preferences, and latest outcomes." />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Resend Configured" value={resendConfigured ? "Yes" : "No"} state={resendConfigured} />
          <MetricCard label="Recipient Configured" value={report.email.recipientConfigured ? "Yes" : "No"} state={report.email.recipientConfigured} />
          <MetricCard label="Daily Brief Enabled" value={report.email.dailyBriefEnabled ? "Yes" : "No"} state={report.email.dailyBriefEnabled} />
          <MetricCard label="Weekly Summary Enabled" value={report.email.weeklySummaryEnabled ? "Yes" : "No"} state={report.email.weeklySummaryEnabled} />
          <MetricCard label="Manager Summary Enabled" value={report.email.managerSummaryEnabled ? "Yes" : "No"} state={report.email.managerSummaryEnabled} />
          <MetricCard label="Last Daily Brief" value={report.email.lastDailyBriefStatus} state={report.email.lastDailyBriefStatus === "Never" ? undefined : report.email.lastDailyBriefStatus === "Sent"} />
          <MetricCard label="Last Weekly Summary" value={report.email.lastWeeklySummaryStatus} state={report.email.lastWeeklySummaryStatus === "Never" ? undefined : report.email.lastWeeklySummaryStatus === "Sent"} />
          <MetricCard label="Last Manager Summary" value={report.email.lastManagerSummaryStatus} state={report.email.lastManagerSummaryStatus === "Never" ? undefined : report.email.lastManagerSummaryStatus === "Sent"} />
          <div className="sm:col-span-2 xl:col-span-4">
            <MetricCard
              label="Last Email Sent"
              value={
                report.email.lastEmailSentTimestamp
                  ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(report.email.lastEmailSentTimestamp))
                  : "Never"
              }
            />
          </div>
        </div>
      </section>

      {/* Table Alignment + Schema Mismatch */}
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
        <section className="min-w-0 overflow-hidden rounded-lg border bg-card shadow-operational">
          <div className="border-b p-4">
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" aria-hidden="true" />
              <h3 className="font-semibold">Table Alignment</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-muted/70 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Table</th>
                  <th className="px-4 py-3 text-right">Columns</th>
                  <th className="px-4 py-3 text-right">Rows</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {report.tables.map((table) => (
                  <tr key={table.name} className="border-t">
                    <td className="max-w-[180px] px-4 py-3">
                      <span className="block truncate font-mono text-xs font-medium" title={table.name}>
                        {table.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{table.columnCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{table.rowCount ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={table.status === "Mismatch" ? "font-medium text-destructive" : "font-medium text-emerald-700 dark:text-emerald-300"}>
                        {table.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border bg-card p-4 shadow-operational">
          <div className="flex items-center gap-2">
            {report.mismatches.length ? (
              <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            )}
            <h3 className="font-semibold">Schema Mismatch</h3>
          </div>
          {report.mismatches.length ? (
            <ul className="mt-4 space-y-2 text-sm">
              {report.mismatches.map((m) => (
                <li key={m} className="break-words rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                  {m}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
              No schema mismatches detected.
              {report.localMode ? " Live database columns were not checked in local mode." : ""}
            </div>
          )}
        </section>
      </div>

      {/* Intelligence Engine */}
      <section className="mt-5 rounded-lg border bg-card p-4 shadow-operational" aria-labelledby="intelligence-validation-title">
        <SectionHeader
          icon={BrainCircuit}
          title="Intelligence Engine Validation"
          subtitle="Deterministic rule registry and project-data source coverage."
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Registered Rules</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{report.intelligence.ruleCount}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Covered Sources</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{report.intelligence.sourceCount}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Validation</p>
            <p className="mt-1 text-lg font-semibold">{report.intelligence.valid ? "Passed" : "Needs review"}</p>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
