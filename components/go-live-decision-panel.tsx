"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Gavel, History, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { recordGoLiveDecision } from "@/lib/go-live-decision-client";
import { GO_LIVE_DECISION_REASON_MAX, type DeploymentTone } from "@/lib/go-live-decision";
import type { GoLiveDashboard } from "@/lib/go-live-readiness";
import type { GoLiveDecision, GoLiveDecisionValue, Project } from "@/lib/types";
import { cn } from "@/lib/utils";

const TONE: Record<DeploymentTone, { panel: string; text: string; icon: typeof CheckCircle2 }> = {
  neutral: { panel: "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40", text: "text-slate-700 dark:text-slate-200", icon: CircleDashed },
  amber: { panel: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30", text: "text-amber-700 dark:text-amber-300", icon: AlertTriangle },
  green: { panel: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30", text: "text-emerald-700 dark:text-emerald-300", icon: CheckCircle2 },
  red: { panel: "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30", text: "text-red-700 dark:text-red-300", icon: XCircle },
};

const DECISION_LABEL: Record<GoLiveDecisionValue, string> = { GO: "GO", NO_GO: "NO GO" };

function formatDecidedAt(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/London" }).format(new Date(iso));
}

function formatGoLiveDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function DecisionLine({ decision }: { decision: GoLiveDecision }) {
  return (
    <span>
      <strong className={decision.decision === "GO" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>{DECISION_LABEL[decision.decision]}</strong>
      {" — "}{decision.decided_by}{" — "}{formatDecidedAt(decision.decided_at)}
    </span>
  );
}

// Deliberate, user-only action. Nothing in the app records a decision on
// the user's behalf; the choice starts unselected and a rationale is required.
function RecordDecisionDialog({ project, recorder, onClose, onRecorded }: {
  project: Project;
  recorder: string;
  onClose: () => void;
  onRecorded: (decision: GoLiveDecision) => void;
}) {
  const [decision, setDecision] = useState<GoLiveDecisionValue | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const canSubmit = decision !== null && reason.trim().length > 0 && !saving;

  async function submit() {
    if (!decision || !reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      onRecorded(await recordGoLiveDecision({ project_id: project.id, decision, reason, localUser: recorder }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record decision.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="record-decision-title">
      <section className="w-full max-w-lg rounded-t-xl border bg-background p-5 shadow-2xl sm:rounded-xl">
        <h2 id="record-decision-title" className="text-lg font-semibold">Record Go/No-Go Decision</h2>
        <p className="mt-1 text-sm text-muted-foreground">{project.project_ref ? `${project.project_ref} · ` : ""}{project.name}</p>
        <div className="mt-4 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Decision">
          {(["GO", "NO_GO"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={decision === value}
              onClick={() => setDecision(value)}
              className={cn(
                "rounded-lg border-2 px-4 py-3 text-base font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                decision === value
                  ? value === "GO" ? "border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-red-600 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {DECISION_LABEL[value]}
            </button>
          ))}
        </div>
        <label htmlFor="decision-reason" className="mt-4 block text-xs font-semibold uppercase text-muted-foreground">Reason / rationale (required)</label>
        <textarea
          id="decision-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={GO_LIVE_DECISION_REASON_MAX}
          rows={4}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Why this decision is being made"
        />
        <p className="mt-3 text-xs text-muted-foreground">Recording as <span className="font-medium text-foreground">{recorder}</span> · {formatDecidedAt(now.toISOString())}</p>
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          This creates an auditable project decision in the Go/No-Go history. It cannot be edited or deleted — a later change of decision is recorded as a new entry. The current deployment status is then derived from this decision together with live readiness.
        </p>
        {error && <p className="mt-2 text-sm font-medium text-red-600" role="alert">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {saving ? "Recording…" : decision ? `Record ${DECISION_LABEL[decision]} decision` : "Choose GO or NO GO"}
          </Button>
        </div>
      </section>
    </div>
  );
}

export function DeploymentStatusPanel({ dashboard, project, canRecord, recorder, onRecorded }: {
  dashboard: GoLiveDashboard;
  project: Project;
  canRecord: boolean;
  recorder: string;
  onRecorded: (decision: GoLiveDecision) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const d = dashboard.deployment;
  const tone = TONE[d.tone];
  const Icon = tone.icon;
  const provider = dashboard.providerReadiness;
  const customerText: Record<typeof d.customerApproval, string> = {
    "Not Applicable": "Customer approval not yet required",
    Outstanding: "Customer approval outstanding",
    Complete: "Customer approval received",
    Waived: "Customer approval waived",
    Rejected: "Customer approval rejected",
  };

  return (
    <section className={cn("mt-5 rounded-lg border p-5 shadow-operational", tone.panel)} data-testid="deployment-status-panel">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Current deployment status</p>
          <div className="mt-1 flex items-center gap-2">
            <Icon className={cn("h-6 w-6 shrink-0", tone.text)} aria-hidden="true" />
            <h3 className={cn("text-2xl font-bold tracking-tight", tone.text)}>{d.label}</h3>
          </div>
          <p className="mt-2 text-sm font-medium text-foreground">
            Provider readiness: {provider.total > 0 ? `${provider.complete}/${provider.total} Complete` : "no evidence yet"}
            <span className="text-muted-foreground"> · {customerText[d.customerApproval]}</span>
          </p>
          {d.otherOutstandingCount > 0 && (
            <p className="mt-0.5 text-sm text-muted-foreground">{d.otherOutstandingCount} pre-deployment readiness item{d.otherOutstandingCount === 1 ? "" : "s"} outstanding</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
          <p className="text-sm font-semibold">{project.name}</p>
          {dashboard.goLiveDate && (
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Go-live: {formatGoLiveDate(dashboard.goLiveDate)}
              {dashboard.daysToGoLive !== null && (
                <span className={cn("ml-1 font-semibold", dashboard.daysToGoLive < 0 ? "text-red-600" : "text-foreground")}>
                  · {dashboard.daysToGoLive < 0 ? `${Math.abs(dashboard.daysToGoLive)} days overdue` : dashboard.daysToGoLive === 0 ? "today" : `${dashboard.daysToGoLive} day${dashboard.daysToGoLive === 1 ? "" : "s"}`}
                </span>
              )}
            </p>
          )}
          {canRecord && (
            <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-2">
              <Gavel className="h-4 w-4" aria-hidden="true" />
              Record Go/No-Go Decision
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Blockers", value: dashboard.blockerCount, alert: dashboard.blockerCount > 0 ? "red" : null },
          // High risks are a prominent warning (amber), never an automatic stop.
          { label: "Open Risks", value: dashboard.openRisks, alert: dashboard.openHighRisks.length > 0 ? "amber" : null },
          // Critical impact only — the automatic hard stop.
          { label: "Critical Risks", value: dashboard.openCriticalRisks, alert: dashboard.openCriticalRisks > 0 ? "red" : null },
          { label: "Tests Outstanding", value: dashboard.outstandingTesting, alert: null },
        ].map(({ label, value, alert }) => (
          <div key={label} className="rounded-md border bg-card/70 p-2 text-center">
            <p className={cn("text-xl font-bold tabular-nums", alert === "red" ? "text-red-600 dark:text-red-400" : alert === "amber" ? "text-amber-600 dark:text-amber-400" : "")}>{value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-1.5 text-sm">
        <p>
          <span className="text-muted-foreground">Recorded decision: </span>
          {dashboard.latestDecision ? <DecisionLine decision={dashboard.latestDecision} /> : <span className="font-medium">none recorded yet</span>}
          {dashboard.decisionHistory.length > 0 && (
            <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" aria-expanded={historyOpen}>
              <History className="h-3 w-3" aria-hidden="true" />
              {historyOpen ? "Hide" : "Show"} history ({dashboard.decisionHistory.length})
            </button>
          )}
        </p>
        {dashboard.latestDecision && <p className="text-xs text-muted-foreground">Reason: {dashboard.latestDecision.reason}</p>}
        {historyOpen && (
          <ol className="ml-1 space-y-1 border-l pl-3 text-xs" aria-label="Go/No-Go decision history">
            {dashboard.decisionHistory.map((h) => (
              <li key={h.id}><DecisionLine decision={h} /><span className="text-muted-foreground"> — {h.reason}</span></li>
            ))}
          </ol>
        )}
        {d.warnings.length > 0 && (
          <p className="flex items-start gap-1 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />Warning: {d.warnings.join("; ")}</p>
        )}
        {d.blockingItems.length > 0 && (
          <p className="font-medium text-red-700 dark:text-red-400">Blocking items: {d.blockingItems.join(", ")}</p>
        )}
        {d.outstandingItems.length > 0 && (
          <p className="text-amber-800 dark:text-amber-300">Outstanding readiness items: {d.outstandingItems.join(", ")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Overall checklist: {dashboard.completedItems}/{dashboard.totalItems} complete{dashboard.totalItems > 0 ? ` (${dashboard.readinessPercent}%)` : ""}
          {dashboard.excludedCount > 0 && <> · {dashboard.excludedCount} not yet applicable/assessed</>}
        </p>
      </div>

      {dialogOpen && (
        <RecordDecisionDialog project={project} recorder={recorder} onClose={() => setDialogOpen(false)} onRecorded={onRecorded} />
      )}
    </section>
  );
}
