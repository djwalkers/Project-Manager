"use client";

import { FlaskConical, ListChecks, Loader2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ANALYSIS_ERROR_LABELS } from "@/lib/requirement-analysis";
import { isActiveTestGeneration, isCompletedTestGeneration, testGenerationSummary } from "@/lib/test-generation";
import { loadRequirementTestGeneration, queueTestGeneration, type RequirementTestGeneration } from "@/lib/test-generation-client";

// AI test case design for one canonical Requirement's Acceptance Criteria
// (Phase 1G). Manager/Admin only (the caller gates rendering; the routes
// enforce it). Generation only: the result is a set of TEST CASE PROPOSALS
// for later human review — nothing here creates or changes canonical Test
// Cases, Acceptance Criteria or links (review and promotion happen in the
// Phase 1H workspace). Works for manually-created ACs too.

const when = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

const linkButton = "inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function RequirementTestGenerationPanel({ projectId, requirementId, mayRun }: { projectId: string; requirementId: string; mayRun: boolean }) {
  const [state, setState] = useState<RequirementTestGeneration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const latest = state?.runs[0] ?? null;
  const active = isActiveTestGeneration(latest);

  useEffect(() => {
    let live = true;
    const load = () => loadRequirementTestGeneration(projectId, requirementId)
      .then((s) => { if (live) { setState(s); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load test generation."); });
    void load();
    const timer = active ? setInterval(load, 10_000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [projectId, requirementId, active, reloadKey]);

  const start = useCallback(async (opts: { acIds?: string[] | null; retryOfRunId?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await queueTestGeneration(projectId, requirementId, opts);
      setChoosing(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start test generation.");
    } finally {
      setBusy(false);
    }
  }, [projectId, requirementId]);

  if (!state && !error) return null;
  const acs = state?.acceptance_criteria ?? [];
  const chosen = selected ?? new Set(acs.map((a) => a.id));
  const status = latest ? latest.status : "Not generated";
  const reviewHref = latest && isCompletedTestGeneration(latest) ? `/test-generation-review/${latest.id}?project=${encodeURIComponent(projectId)}` : null;
  const lastCompleted = state?.runs.find(isCompletedTestGeneration) ?? null;

  return (
    <section aria-label="AI test cases" className="rounded-md border p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />AI test cases</p>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {state && !state.eligibility.eligible ? (
        <p className="mt-2 text-xs text-muted-foreground">{state.eligibility.reason}</p>
      ) : state ? (
        <>
          <p className="mt-2 text-sm">
            <span className="font-medium">{status}</span>
            {latest ? <span className="text-muted-foreground"> · {when(latest.completed_at ?? latest.started_at ?? latest.queued_at)} · {latest.model} · {latest.ac_ids.length} acceptance criteri{latest.ac_ids.length === 1 ? "on" : "a"}</span> : null}
          </p>
          {latest && isCompletedTestGeneration(latest) ? <p className="mt-1 text-sm">{testGenerationSummary(latest)}</p> : null}
          {latest?.status === "Failed" ? (
            <p className="mt-1 text-xs text-destructive">{latest.error_category ? ANALYSIS_ERROR_LABELS[latest.error_category] ?? latest.error_category : "Failed"}{latest.error_message ? ` — ${latest.error_message}` : ""}</p>
          ) : null}
          {choosing ? (
            <fieldset className="mt-2 space-y-1 rounded border p-2 text-xs">
              <legend className="px-1 font-medium">Acceptance criteria to design tests for</legend>
              {acs.map((a) => (
                <label key={a.id} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={chosen.has(a.id)}
                    onChange={(ev) => setSelected(() => { const n = new Set(chosen); if (ev.target.checked) n.add(a.id); else n.delete(a.id); return n; })} />
                  <span><span className="font-medium">{a.ref}</span> {a.criterion}{a.origin === "ai" ? <span className="text-muted-foreground"> · AI-promoted</span> : null}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {reviewHref ? <Link className={linkButton} href={reviewHref}><ListChecks className="h-3.5 w-3.5" aria-hidden="true" />Review generated tests</Link> : null}
            {!reviewHref && lastCompleted ? <Link className={linkButton} href={`/test-generation-review/${lastCompleted.id}?project=${encodeURIComponent(projectId)}`}><ListChecks className="h-3.5 w-3.5" aria-hidden="true" />Review last generation</Link> : null}
            {mayRun && latest?.status === "Failed" ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => start({ retryOfRunId: latest.id })}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Retry</Button>
            ) : null}
            {mayRun && !active && latest?.status !== "Failed" ? (
              choosing ? (
                <Button size="sm" disabled={busy || chosen.size === 0} onClick={() => start({ acIds: chosen.size === acs.length ? null : [...chosen] })}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />}Generate Tests ({chosen.size})
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setChoosing(true)}>
                  <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />{latest ? "Generate tests again" : "Generate Tests"}
                </Button>
              )
            ) : null}
            {choosing ? <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>Cancel</Button> : null}
            {active ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{status} on the local worker…</span> : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">AI proposals for review — approved tests are promoted one at a time from the review workspace. Existing tests are never shown to the model.</p>
        </>
      ) : null}
    </section>
  );
}
