"use client";

import { AlertTriangle, ArrowLeft, FileText, HelpCircle, Lock, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { RequirementProvenancePanel } from "@/components/requirement-provenance";
import { acGenerationSummary, isActiveAcGeneration, type AcceptanceCriterionProposal } from "@/lib/ac-generation";
import { loadAcGenerationRun, type AcGenerationRunDetail } from "@/lib/ac-generation-client";
import { useAuth } from "@/contexts/auth-context";
import { canViewRequirementAnalysis } from "@/lib/permissions";
import { ANALYSIS_ERROR_LABELS } from "@/lib/requirement-analysis";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";

// ── Acceptance Criteria review (Phase 1E — inspection only) ────────────────
// One AC-generation run for one promoted Requirement: the Requirement, its
// source provenance, the generated criteria (Positive / Negative /
// Regression, Explicit / Inferred, confidence, sources, Needs Review
// reasons), the generation issues, and exactly what the run was given
// (clarifications, open questions, acknowledged scope notes). These are AI
// proposals: nothing here creates canonical Acceptance Criteria, and there
// is no promotion yet. Manager/Admin only.

const when = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const pagesOf = (f: AnalysisFragment) =>
  f.page_start == null ? null : f.page_end != null && f.page_end !== f.page_start ? `pp. ${f.page_start}–${f.page_end}` : `p. ${f.page_start}`;
const sectionOf = (f: AnalysisFragment) => (f.section_path.length ? f.section_path.at(-1) : f.section_heading ?? "Document start");

function Pill({ children, tone = "muted", title }: { children: React.ReactNode; tone?: "muted" | "ok" | "warn" | "bad" | "info"; title?: string }) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
    bad: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
    info: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  };
  return <span title={title} className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

const RELATION_LABEL: Record<string, string> = {
  Blocking: "Blocking issue — affected criteria need review",
  "Additional Coverage": "Additional coverage question — does not block this criterion",
  Informational: "Related question — informational",
};

const typeTone = (t: string) => (t === "Regression" ? "info" : t === "Negative" ? "warn" : "ok");

export function AcGenerationReviewPage({ runId }: { runId: string }) {
  const { user } = useAuth();
  const projectId = useSearchParams().get("project") ?? "";
  const mayView = canViewRequirementAnalysis(user?.role);
  const [detail, setDetail] = useState<AcGenerationRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const active = isActiveAcGeneration(detail?.run);

  useEffect(() => {
    if (!mayView || !projectId) return;
    let live = true;
    const load = () => loadAcGenerationRun(projectId, runId).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the generated criteria."); });
    void load();
    const timer = active ? setInterval(load, 10_000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [mayView, projectId, runId, active, reloadKey]);

  const fragments = useMemo(() => new Map((detail?.fragments ?? []).map((f) => [f.id, f])), [detail?.fragments]);

  if (!user) return <AppShell><LoadingState /></AppShell>;
  if (!mayView) return <AppShell><EmptyState title="Manager or Admin access required" description="AI acceptance criteria proposals are not available to Viewers. Canonical Requirements and their source provenance remain available." icon={Lock} /></AppShell>;
  if (!projectId) return <AppShell><EmptyState title="No project" description="Open this from a Requirement." icon={AlertTriangle} /></AppShell>;
  if (error) return <AppShell><LoadErrorState onRetry={() => { setError(null); setReloadKey((k) => k + 1); }} detail={error} /></AppShell>;
  if (!detail) return <AppShell><LoadingState /></AppShell>;

  const { run, proposals, issues } = detail;
  const input = run.input_snapshot;
  const clarById = new Map(input.clarifications.map((c, i) => [c.id, { ...c, label: `C${i + 1}` }]));
  const openById = new Map(input.open_questions.map((q, i) => [q.id, { ...q, label: `Q${i + 1}` }]));
  const noteById = new Map(input.scope_notes.map((n, i) => [n.id, { ...n, label: `N${i + 1}` }]));
  const needsReview = proposals.filter((p) => p.review_status === "Needs Review").length;

  const Sources = ({ p }: { p: AcceptanceCriterionProposal }) => (
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
      {p.source_fragment_ids.map((id) => {
        const f = fragments.get(id);
        return <li key={id}><FileText className="mr-1 inline h-3 w-3" aria-hidden="true" />{f ? `${sectionOf(f)}${pagesOf(f) ? ` · ${pagesOf(f)}` : ""}` : "Source fragment"}</li>;
      })}
      {p.scope_note_ids.map((id) => <li key={id}><ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden="true" />Scope note {noteById.get(id)?.label}: {noteById.get(id)?.description}</li>)}
      {p.clarification_issue_ids.map((id) => <li key={id}><HelpCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />Relies on human clarification {clarById.get(id)?.label}: {clarById.get(id)?.resolution_note}</li>)}
      {p.open_issue_ids.map((id) => <li key={id} className="text-amber-800 dark:text-amber-200"><AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />Blocked by open question {openById.get(id)?.label}: {openById.get(id)?.question}</li>)}
    </ul>
  );

  return (
    <AppShell>
      <div className="space-y-5">
        <div>
          <Link href="/requirements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Requirements</Link>
          <h1 className="mt-2 flex items-center gap-2 text-xl font-semibold"><Sparkles className="h-5 w-5" aria-hidden="true" />AI acceptance criteria — {input.requirement.ref ?? "Requirement"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Proposals for human review. No canonical Acceptance Criteria have been created; review and promotion come later.</p>
        </div>

        <section className="rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={run.status === "Failed" ? "bad" : run.status === "Completed with warnings" ? "warn" : run.status === "Completed" ? "ok" : "info"}>{run.status}</Pill>
            {run.status === "Completed" || run.status === "Completed with warnings" ? <span className="text-sm font-medium">{acGenerationSummary(run)}</span> : null}
          </div>
          {run.status === "Failed" ? <p className="mt-2 text-sm text-destructive">{run.error_category ? ANALYSIS_ERROR_LABELS[run.error_category] ?? run.error_category : "Failed"}{run.error_message ? ` — ${run.error_message}` : ""}</p> : null}
          <h2 className="mt-3 text-base font-semibold">{input.requirement.title}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{input.requirement.description}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {[input.requirement.category, input.requirement.priority ? `${input.requirement.priority} priority` : null, input.requirement.status].filter(Boolean).join(" · ")}
            {" · "}from {input.document?.name ?? "source document"} v{input.version?.version_number ?? "?"} (proposal #{input.proposal.sequence}{input.proposal.edited ? ", edited by a reviewer" : ""})
          </p>
        </section>

        <RequirementProvenancePanel projectId={projectId} requirementId={run.requirement_id} />

        <section aria-label="Generated acceptance criteria">
          <h2 className="text-base font-semibold">Generated acceptance criteria ({proposals.length}{needsReview ? ` · ${needsReview} need review` : ""})</h2>
          {active ? <p className="mt-2 text-sm text-muted-foreground">Generation is {run.status.toLowerCase()} on the local worker…</p> : null}
          {!active && proposals.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No criteria were generated.</p> : null}
          <ol className="mt-3 space-y-3">
            {proposals.map((p) => (
              <li key={p.id} className={`rounded-lg border bg-card p-3 ${p.review_status === "Needs Review" ? "border-amber-300 dark:border-amber-700" : ""}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">#{p.sequence}</span>
                  <Pill tone={typeTone(p.criterion_type)}>{p.criterion_type}</Pill>
                  <Pill tone={p.basis === "Explicit" ? "muted" : "warn"}>{p.basis}</Pill>
                  <Pill>{p.confidence} confidence</Pill>
                  {p.review_status === "Needs Review" ? <Pill tone="warn">Needs Review</Pill> : null}
                  {p.consolidation?.merged ? <Pill title={(p.consolidation.members ?? []).map((m) => m.criterion).join("\n")}>Merged from {p.consolidation.member_count}</Pill> : null}
                </div>
                <p className="mt-2 text-sm font-medium">{p.criterion}</p>
                {p.given_text || p.when_text || p.then_text ? (
                  <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                    {p.given_text ? <><dt className="font-semibold text-muted-foreground">Given</dt><dd>{p.given_text}</dd></> : null}
                    {p.when_text ? <><dt className="font-semibold text-muted-foreground">When</dt><dd>{p.when_text}</dd></> : null}
                    {p.then_text ? <><dt className="font-semibold text-muted-foreground">Then</dt><dd>{p.then_text}</dd></> : null}
                  </dl>
                ) : null}
                {p.needs_review_reasons.length ? <ul className="mt-2 list-disc pl-5 text-xs text-amber-800 dark:text-amber-200">{p.needs_review_reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
                <Sources p={p} />
                {p.source_quote ? <p className="mt-2 border-l-2 pl-2 text-xs italic text-muted-foreground">“{p.source_quote}”</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">{p.rationale}</p>
              </li>
            ))}
          </ol>
        </section>

        {issues.length ? (
          <section aria-label="Generation issues">
            <h2 className="text-base font-semibold">Generation issues ({issues.length})</h2>
            <ul className="mt-3 space-y-2">
              {issues.map((i) => (
                <li key={i.id} className={`rounded-lg border bg-card p-3 text-sm ${i.relation === "Blocking" ? "border-amber-300 dark:border-amber-700" : ""}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={i.severity === "High" ? "bad" : i.severity === "Medium" ? "warn" : "muted"}>{i.severity}</Pill>
                    {i.relation ? <Pill tone={i.relation === "Blocking" ? "warn" : "info"}>{RELATION_LABEL[i.relation]}</Pill> : null}
                    <span className="font-medium">{i.issue_type}</span>
                  </div>
                  <p className="mt-1">{i.description}</p>
                  {i.obligation ? <p className="mt-1 text-xs text-muted-foreground">Obligation: {i.obligation}</p> : null}
                  {i.suggested_question ? <p className="mt-1 text-xs">Question: {i.suggested_question}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-label="Context supplied" className="rounded-lg border bg-card p-4 text-sm">
          <h2 className="text-base font-semibold">What the generation was given</h2>
          <p className="mt-1 text-xs text-muted-foreground">The Requirement, its promoted proposal&apos;s own {input.fragment_ids.length} source fragment{input.fragment_ids.length === 1 ? "" : "s"}, and:</p>
          <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">Human clarifications ({input.clarifications.length})</h3>
          {input.clarifications.length ? <ul className="mt-1 space-y-1">{input.clarifications.map((c, i) => <li key={c.id}><span className="font-medium">C{i + 1}</span> {c.question} — <span className="italic">{c.resolution_note}</span>{c.reviewed_by_name ? ` (${c.reviewed_by_name})` : ""}</li>)}</ul> : <p className="text-xs text-muted-foreground">None.</p>}
          <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">Open questions about this Requirement — not treated as fact ({input.open_questions.length})</h3>
          {input.open_questions.length ? <ul className="mt-1 space-y-1">{input.open_questions.map((q, i) => <li key={q.id}><span className="font-medium">Q{i + 1}</span> {q.question ?? q.description}</li>)}</ul> : <p className="text-xs text-muted-foreground">None.</p>}
          <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">Acknowledged scope notes ({input.scope_notes.length})</h3>
          {input.scope_notes.length ? <ul className="mt-1 space-y-1">{input.scope_notes.map((n, i) => <li key={n.id}><span className="font-medium">N{i + 1}</span> {n.area}: {n.description}</li>)}</ul> : <p className="text-xs text-muted-foreground">None.</p>}
          <p className="mt-3 text-xs text-muted-foreground">
            Queued {when(run.queued_at)}{run.requested_by_name ? ` by ${run.requested_by_name}` : ""} · {run.trigger === "retry" ? "retry · " : ""}model {run.model}{run.model_digest ? ` (${run.model_digest})` : ""} · AC prompts {run.prompt_version ?? "—"} · schema {run.schema_version ?? "—"} · input {run.input_sha256.slice(0, 12)}
          </p>
        </section>
      </div>
    </AppShell>
  );
}
