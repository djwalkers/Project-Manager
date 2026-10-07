"use client";

import { AlertTriangle, FileText, ListChecks, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { loadTestCaseProvenance, type TestCaseProvenance } from "@/lib/test-generation-client";

// Structure and source provenance of a canonical Test Case (Phase 1H).
// Shows the structured fields (objective, preconditions, steps, type) when a
// test has them, and — for a test promoted from an AI proposal — test →
// proposal → generation run → the acceptance criteria exactly as approved →
// their own provenance → Requirement → source document, plus a warning when
// a source AC has materially changed since promotion (the test is never
// rewritten). Read-only and shown to every role (authoritative facts only —
// no working AI content).

const when = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const pagesOf = (f: { page_start: number | null; page_end: number | null }) =>
  f.page_start == null ? null : f.page_end != null && f.page_end !== f.page_start ? `pp. ${f.page_start}–${f.page_end}` : `p. ${f.page_start}`;
const ORIGIN: Record<string, string> = { ai: "AI test proposal", split: "test proposal split by a reviewer", merge: "test proposal merged by a reviewer", manual: "human-authored test proposal" };

export function TestCaseProvenancePanel({ projectId, testId }: { projectId: string; testId: string }) {
  const [data, setData] = useState<TestCaseProvenance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadTestCaseProvenance(projectId, testId)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the test's provenance."); });
    return () => { live = false; };
  }, [projectId, testId]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!data) return null;
  const { structure: s, provenance: p, source_changes: changes } = data;
  const structured = Boolean(s.objective || s.steps?.length || s.preconditions?.length);

  return (
    <div className="space-y-3">
      {changes.length ? (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />Possibly stale — a source acceptance criterion changed after this test was promoted</p>
          <ul className="mt-1 space-y-1">
            {changes.map((c) => (
              <li key={c.ac_id}><span className="font-medium">{c.ac_ref}</span> {c.change === "Deleted" ? "has been deleted." : <>was “{c.approved_criterion}”, now “{c.current_criterion}”.</>}</li>
            ))}
          </ul>
          <p className="mt-1">The test has not been changed. Review it against the current wording.</p>
        </div>
      ) : null}
      {structured ? (
        <section aria-label="Test structure" className="space-y-2 rounded-md border p-3 text-xs">
          <p className="flex items-center gap-1.5 font-semibold uppercase text-muted-foreground"><ListChecks className="h-3.5 w-3.5" aria-hidden="true" />Test design{s.test_type ? ` · ${s.test_type}` : ""}</p>
          {s.objective ? <p><span className="font-medium">Objective:</span> {s.objective}</p> : null}
          {s.preconditions?.length ? <div><p className="font-medium">Preconditions</p><ul className="list-disc pl-5">{s.preconditions.map((c) => <li key={c}>{c}</li>)}</ul></div> : null}
          {s.steps?.length ? (
            <table className="w-full text-left">
              <thead><tr className="text-muted-foreground"><th className="w-8 py-1">#</th><th className="py-1">Action</th><th className="py-1">Expected</th></tr></thead>
              <tbody>{s.steps.map((st) => <tr key={st.step} className="border-t align-top"><td className="py-1">{st.step}</td><td className="py-1 pr-2">{st.action}</td><td className="py-1">{st.expected ?? "—"}</td></tr>)}</tbody>
            </table>
          ) : null}
        </section>
      ) : null}
      {p ? (
        <section aria-label="Source provenance" className="space-y-2 rounded-md border p-3 text-xs">
          <p className="flex items-center gap-1.5 font-semibold uppercase text-muted-foreground"><FileText className="h-3.5 w-3.5" aria-hidden="true" />Source provenance</p>
          <p>
            Promoted from {ORIGIN[p.proposal.origin] ?? "proposal"} #{p.proposal.sequence} for <span className="font-medium">{p.requirement?.requirement_ref ?? "Requirement"}</span> by {p.proposal.promoted_by_name ?? "—"}, {when(p.proposal.promoted_at)}
            {p.proposal.confirmed_by_name ? ` · reviewed and confirmed by ${p.proposal.confirmed_by_name}` : ""}
          </p>
          <p className="text-muted-foreground">
            {p.requirement_provenance?.document?.document_name ?? "Requirement created manually"}{p.requirement_provenance?.version ? ` v${p.requirement_provenance.version.version_number}` : ""}{p.generation_run ? ` · designed by ${p.generation_run.model}, test prompts ${p.generation_run.prompt_version ?? "—"}` : ""}
          </p>
          <p>
            <span className={`rounded px-1.5 py-0.5 font-medium ${p.proposal.basis === "Explicit" ? "bg-muted" : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"}`}>{p.proposal.basis}</span>
            {p.accepted_inferences.length ? <> Reviewer accepted {p.accepted_inferences.map((t) => `“${t}”`).join(", ")} (not stated by the acceptance criteria){p.inference_reason ? `: ${p.inference_reason}` : ""}.</> : null}
          </p>
          <div>
            <p className="font-medium">Acceptance criteria as approved</p>
            <ul className="mt-1 space-y-1">
              {p.approved_acceptance_criteria.map((a) => {
                const acp = p.ac_provenance[a.id];
                return (
                  <li key={a.id}>
                    <ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden="true" /><span className="font-medium">{a.ref}</span> {a.criterion}
                    <span className="text-muted-foreground"> — {acp ? `promoted from AC proposal #${acp.proposal.sequence}, ${acp.fragments.length} source fragment${acp.fragments.length === 1 ? "" : "s"}` : "created manually"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          {p.fragments.length ? (
            <ul className="space-y-1">
              {p.fragments.map((f) => <li key={f.id} className="rounded border bg-muted/30 p-2"><span className="font-medium">{f.section_path?.length ? f.section_path.join(" › ") : f.section_heading ?? "Document start"}</span> <span className="text-muted-foreground">{pagesOf(f) ?? ""}</span><p className="mt-1 line-clamp-2 text-muted-foreground">{f.text}</p></li>)}
            </ul>
          ) : null}
          <p className="text-muted-foreground">This test was created from an approved AI proposal, so it cannot be deleted — its promotion history must be preserved. Change its status instead.</p>
        </section>
      ) : null}
    </div>
  );
}
