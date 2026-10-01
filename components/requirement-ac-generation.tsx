"use client";

import { ListChecks, Loader2, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { acGenerationSummary, isActiveAcGeneration, isCompletedAcGeneration } from "@/lib/ac-generation";
import { loadRequirementAcGeneration, queueAcGeneration, type RequirementAcGeneration } from "@/lib/ac-generation-client";
import { ANALYSIS_ERROR_LABELS } from "@/lib/requirement-analysis";

// AI Acceptance Criteria generation for one canonical Requirement (Phase 1E).
// Manager/Admin only (the caller gates rendering; the routes enforce it).
// Generation only: the result is a set of AC PROPOSALS for human review —
// nothing here creates or changes canonical Acceptance Criteria. Renders
// nothing for manually-created Requirements (not eligible in Phase 1E).

const when = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

const linkButton = "inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function RequirementAcGenerationPanel({ projectId, requirementId, mayRun }: { projectId: string; requirementId: string; mayRun: boolean }) {
  const [state, setState] = useState<RequirementAcGeneration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const latest = state?.runs[0] ?? null;
  const active = isActiveAcGeneration(latest);

  useEffect(() => {
    let live = true;
    const load = () => loadRequirementAcGeneration(projectId, requirementId)
      .then((s) => { if (live) { setState(s); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load acceptance criteria generation."); });
    void load();
    const timer = active ? setInterval(load, 10_000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [projectId, requirementId, active, reloadKey]);

  const start = useCallback(async (retryOf?: string) => {
    setBusy(true);
    setError(null);
    try {
      await queueAcGeneration(projectId, requirementId, retryOf);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start generation.");
    } finally {
      setBusy(false);
    }
  }, [projectId, requirementId]);

  if (!state && !error) return null;
  if (state && !state.eligibility.promoted) return null;

  const status = latest ? latest.status : "Not generated";
  const reviewHref = latest && isCompletedAcGeneration(latest) ? `/acceptance-criteria-review/${latest.id}?project=${encodeURIComponent(projectId)}` : null;
  const lastCompleted = state?.runs.find(isCompletedAcGeneration) ?? null;

  return (
    <section aria-label="AI acceptance criteria" className="rounded-md border p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />AI acceptance criteria</p>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {state && !state.eligibility.eligible ? (
        <p className="mt-2 text-xs text-muted-foreground">{state.eligibility.reason}</p>
      ) : state ? (
        <>
          <p className="mt-2 text-sm">
            <span className="font-medium">{status}</span>
            {latest ? <span className="text-muted-foreground"> · {when(latest.completed_at ?? latest.started_at ?? latest.queued_at)} · {latest.model}</span> : null}
          </p>
          {latest && isCompletedAcGeneration(latest) ? <p className="mt-1 text-sm">{acGenerationSummary(latest)}</p> : null}
          {latest?.status === "Failed" ? (
            <p className="mt-1 text-xs text-destructive">{latest.error_category ? ANALYSIS_ERROR_LABELS[latest.error_category] ?? latest.error_category : "Failed"}{latest.error_message ? ` — ${latest.error_message}` : ""}</p>
          ) : null}
          {!latest && state.context ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Uses this Requirement&apos;s source provenance{state.context.clarifications ? `, ${state.context.clarifications} human clarification${state.context.clarifications === 1 ? "" : "s"}` : ""}
              {state.context.scope_notes ? `, ${state.context.scope_notes} acknowledged scope note${state.context.scope_notes === 1 ? "" : "s"}` : ""}
              {state.context.open_questions ? ` and ${state.context.open_questions} open question${state.context.open_questions === 1 ? "" : "s"} (never treated as fact)` : ""}. Runs on the local model.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {reviewHref ? <Link className={linkButton} href={reviewHref}><ListChecks className="h-3.5 w-3.5" aria-hidden="true" />Review Acceptance Criteria</Link> : null}
            {!reviewHref && lastCompleted ? <Link className={linkButton} href={`/acceptance-criteria-review/${lastCompleted.id}?project=${encodeURIComponent(projectId)}`}><ListChecks className="h-3.5 w-3.5" aria-hidden="true" />Review last generation</Link> : null}
            {mayRun && latest?.status === "Failed" ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => start(latest.id)}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Retry</Button>
            ) : null}
            {mayRun && !active && latest?.status !== "Failed" ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => start()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
                {latest ? "Generate again" : "Generate Acceptance Criteria"}
              </Button>
            ) : null}
            {active ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{status} on the local worker…</span> : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">AI proposals only — no canonical Acceptance Criteria are created.</p>
        </>
      ) : null}
    </section>
  );
}
