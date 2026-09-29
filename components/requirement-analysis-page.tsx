"use client";

import { AlertTriangle, ArrowLeft, ExternalLink, FileText, HelpCircle, Layers, ListChecks, Loader2, Lock, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { canViewRequirementAnalysis } from "@/lib/permissions";
import { ANALYSIS_ERROR_LABELS, isActiveAnalysis, type AnalysisIssue, type RequirementProposal } from "@/lib/requirement-analysis";
import { loadAnalysisRun, type AnalysisFragment, type AnalysisRunDetail } from "@/lib/requirement-analysis-client";
import { openSourceDocumentVersion } from "@/lib/source-documents-client";

// ── Requirement analysis workspace (Phase 1C) ──────────────────────────────
// Read-only review of one AI analysis run: what was analysed (the exact
// extraction run), the proposed requirements, and the open issues — every
// item traceable to its source fragments, section, page(s) and the original
// file. Proposals are NON-AUTHORITATIVE: nothing here creates or changes a
// canonical Requirement (promotion is Phase 1D). Manager/Admin only.

type Tab = "overview" | "source" | "proposals" | "issues" | "scope";

const when = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

const pagesOf = (f: AnalysisFragment) =>
  f.page_start == null ? null : f.page_end != null && f.page_end !== f.page_start ? `pp. ${f.page_start}–${f.page_end}` : `p. ${f.page_start}`;

const sectionOf = (f: AnalysisFragment) => (f.section_path.length ? f.section_path.join(" › ") : f.section_heading ?? "Document start");

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

const statusTone = (s: string) => (s === "Completed" ? "ok" : s === "Completed with warnings" ? "warn" : s === "Failed" ? "bad" : "info");
const severityTone = (s: string) => (s === "High" ? "bad" : s === "Medium" ? "warn" : "muted");

export function RequirementAnalysisPage({ runId }: { runId: string }) {
  const { user } = useAuth();
  const projectId = useSearchParams().get("project") ?? "";
  const mayView = canViewRequirementAnalysis(user?.role);
  const [detail, setDetail] = useState<AnalysisRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("proposals");
  const [focus, setFocus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const active = isActiveAnalysis(detail?.run);
  useEffect(() => {
    if (!mayView || !projectId) return;
    let live = true;
    const load = () => loadAnalysisRun(projectId, runId).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the analysis."); });
    void load();
    const timer = active ? setInterval(load, 10_000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [mayView, projectId, runId, active, reloadKey]);

  const fragments = useMemo(() => new Map((detail?.fragments ?? []).map((f) => [f.id, f])), [detail?.fragments]);
  const classifications = detail?.run.diagnostics?.fragment_classifications ?? {};

  if (!user) return <AppShell><LoadingState /></AppShell>;
  if (!mayView) {
    return <AppShell><EmptyState title="Manager or Admin access required" description="AI analysis proposals are not yet available to Viewers. The source documents and their extracted text remain available in Source Documents." icon={Lock} /></AppShell>;
  }
  if (!projectId) return <AppShell><EmptyState title="No project" description="Open this analysis from Source Documents." icon={AlertTriangle} /></AppShell>;
  if (error) return <AppShell><LoadErrorState onRetry={() => { setError(null); setReloadKey((k) => k + 1); }} detail={error} /></AppShell>;
  if (!detail) return <AppShell><LoadingState /></AppShell>;

  const { run, proposals, issues, version, document, extraction_job: job } = detail;
  const scopeNotes = detail.scope_notes ?? [];
  const openIssues = issues.filter((i) => i.status === "Open").length;
  const isPdf = version?.content_type === "application/pdf";
  const focused = focus ? fragments.get(focus) ?? null : null;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "source", label: "Source", count: detail.fragments.length },
    { id: "proposals", label: "Proposed Requirements", count: proposals.length },
    { id: "issues", label: "Issues", count: openIssues },
    { id: "scope", label: "Scope & Regression Notes", count: scopeNotes.length },
  ];

  function SourceRefs({ ids, primary }: { ids: string[]; primary?: string }) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const f = fragments.get(id);
          const label = f ? `F${f.sequence} · ${f.section_heading ?? sectionOf(f)}${pagesOf(f) ? ` · ${pagesOf(f)}` : ""}` : "Unknown fragment";
          return (
            <button key={id} type="button" onClick={() => setFocus(id)} title={f ? sectionOf(f) : id}
              className={`max-w-[22rem] truncate rounded border px-2 py-0.5 text-left text-xs hover:bg-muted ${id === primary ? "border-primary/50 bg-primary/5 font-medium" : ""}`}>
              {label}{id === primary ? " (primary)" : ""}
            </button>
          );
        })}
      </div>
    );
  }

  function ProposalCard({ p }: { p: RequirementProposal }) {
    const merged = p.consolidation?.merged && (p.consolidation.members?.length ?? 0) > 1;
    return (
      <li className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h4 className="font-semibold"><span className="mr-2 text-muted-foreground">#{p.sequence}</span>{p.proposed_title}</h4>
          <div className="flex flex-wrap gap-1">
            <Pill tone={p.evidence_basis === "Explicit" ? "ok" : "warn"} title={p.evidence_basis === "Explicit" ? "The source directly states this behaviour" : "An interpretation not directly stated — always needs review"}>{p.evidence_basis}</Pill>
            <Pill tone={p.confidence === "High" ? "ok" : p.confidence === "Medium" ? "info" : "warn"}>{p.confidence} confidence</Pill>
            <Pill tone={p.review_status === "Needs Review" ? "warn" : "muted"}>{p.review_status}</Pill>
          </div>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{p.proposed_description}</p>
        {p.source_quote ? <blockquote className="mt-2 border-l-2 pl-3 text-sm italic text-muted-foreground">“{p.source_quote}”</blockquote> : null}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div><dt className="inline font-semibold text-muted-foreground">Category: </dt><dd className="inline">{p.proposed_category ?? "Not proposed"}</dd></div>
          <div><dt className="inline font-semibold text-muted-foreground">Priority: </dt><dd className="inline">{p.proposed_priority ?? "Not stated in the source"}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground"><span className="font-semibold">Rationale: </span>{p.rationale}</p>
        <div className="mt-3"><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Source</p><SourceRefs ids={p.source_fragment_ids} primary={p.primary_source_fragment_id} /></div>
        {merged ? (
          <details className="mt-3 rounded-md border p-2 text-xs">
            <summary className="flex cursor-pointer items-center gap-1 font-medium"><Layers className="h-3.5 w-3.5" aria-hidden="true" />Consolidated from {p.consolidation.members!.length} statements{p.consolidation.kind === "parts" ? " (parts of one requirement)" : p.consolidation.kind === "duplicate" ? " (the same obligation repeated)" : ""}</summary>
            {p.consolidation.reason ? <p className="mt-1 text-muted-foreground">{p.consolidation.reason}</p> : null}
            <ul className="mt-2 space-y-1">
              {p.consolidation.members!.map((m) => (
                <li key={m.key}>
                  <span className="font-medium">{m.title}</span> <span className="text-muted-foreground">— {m.section} · {m.evidence_basis}</span>
                  {m.quote ? <span className="block italic text-muted-foreground">“{m.quote}”</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </li>
    );
  }

  function IssueCard({ i }: { i: AnalysisIssue }) {
    return (
      <li className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="font-semibold"><span className="mr-2 text-muted-foreground">#{i.sequence}</span>{i.issue_type}</p>
          <div className="flex gap-1"><Pill tone={severityTone(i.severity)}>{i.severity}</Pill><Pill>{i.status}</Pill></div>
        </div>
        <p className="mt-2 text-sm leading-relaxed">{i.description}</p>
        {i.suggested_question ? <p className="mt-2 flex items-start gap-1.5 text-sm font-medium"><HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{i.suggested_question}</p> : null}
        {i.trigger_quote ? <blockquote className="mt-2 border-l-2 pl-3 text-xs italic text-muted-foreground">Raised by: “{i.trigger_quote}”</blockquote> : null}
        {i.impact?.length ? <p className="mt-2 flex flex-wrap gap-1">{i.impact.map((m) => <Pill key={m} tone="info">{m.replace("_", " ")}</Pill>)}</p> : null}
        {i.consolidation?.merged && i.consolidation.members?.length ? (
          <details className="mt-2 rounded-md border p-2 text-xs">
            <summary className="cursor-pointer font-medium">Merged from {i.consolidation.members.length} questions</summary>
            <ul className="mt-1 list-disc pl-4">{i.consolidation.members.map((m, n) => <li key={n}>{m.question}</li>)}</ul>
          </details>
        ) : null}
        <div className="mt-3"><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Source</p><SourceRefs ids={i.source_fragment_ids} /></div>
        {i.related_proposal_sequences.length ? (
          <p className="mt-2 text-xs text-muted-foreground">Affects proposed requirement{i.related_proposal_sequences.length === 1 ? "" : "s"} {i.related_proposal_sequences.map((s) => `#${s}`).join(", ")}</p>
        ) : null}
      </li>
    );
  }

  const d = run.diagnostics ?? {};
  return (
    <AppShell>
      <Link href="/documents" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Source Documents</Link>
      <div className="mb-4 flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">Requirement analysis · AI proposals for review</p>
          <h2 className="text-2xl font-semibold">{document?.document_name ?? "Source document"}{version ? ` — v${version.version_number}` : ""}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Analysed extraction {job?.extractor_version ? `(extractor ${job.extractor_version}, ${when(job.completed_at)})` : ""} · model {run.model}{run.model_digest ? ` · ${run.model_digest}` : ""} · prompts {run.prompt_version ?? "—"} · schema {run.analysis_schema_version ?? "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Pill tone={statusTone(run.status)}>{run.status}</Pill>
          {active ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Analysis in progress" /> : null}
        </div>
      </div>

      <div className="mb-4 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
        These are AI <strong>proposals</strong> from a local model, not project requirements. Nothing here changes the Requirements register, tests or readiness. Inferred items always need review.
      </div>

      {run.status === "Failed" ? (
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-semibold text-destructive">{ANALYSIS_ERROR_LABELS[run.error_category ?? ""] ?? "Analysis failed"}</p>
          {run.error_message ? <p className="mt-1 text-muted-foreground">{run.error_message}</p> : null}
          <p className="mt-1 text-muted-foreground">The source document and its extraction are unaffected. Retry from Source Documents.</p>
        </div>
      ) : null}

      <div role="tablist" aria-label="Analysis sections" className="mb-4 flex flex-wrap gap-1 border-b">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.label}{t.count !== undefined ? <span className="ml-1.5 rounded bg-muted px-1.5 text-xs">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Proposed requirements", run.proposal_count ?? "—"],
              ["Open issues", openIssues],
              ["Scope & regression notes", scopeNotes.length],
              ["Fragments analysed", d.fragment_count ?? detail.fragments.length],
              ["Candidates before consolidation", d.candidates_before_consolidation ?? "—"],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-md border bg-card p-3"><p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>
            ))}
          </div>
          <div className="rounded-md border bg-card p-4 text-sm">
            <p className="font-semibold">Run</p>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div>Requested by {run.requested_by_name ?? "—"} · {when(run.queued_at)}{run.trigger === "retry" ? " · retry" : ""}</div>
              <div>Started {when(run.started_at)} · finished {when(run.completed_at)}</div>
              <div>Worker {run.worker_name ?? "—"} {run.worker_version ?? ""} · attempt {run.attempt_count}</div>
              <div>{d.chunk_count ?? "—"} chunk(s) across {d.section_count ?? "—"} section(s)</div>
            </dl>
            {d.classifications ? (
              <p className="mt-3 text-xs"><span className="font-semibold">Fragment classification: </span>{Object.entries(d.classifications).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(" · ")}</p>
            ) : null}
            {d.consolidation_overrides?.length ? <p className="mt-2 text-xs text-muted-foreground">{d.consolidation_overrides.length} model-proposed group(s) were split by the deterministic checks (same wording / same object).</p> : null}
            {d.suppressed_issues?.length ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted-foreground">{d.suppressed_issues.length} question(s) suppressed by the issue quality gate</summary>
                <ul className="mt-1 list-disc pl-4">{d.suppressed_issues.map((x, n) => <li key={n}><span className="text-muted-foreground">{x.reason}:</span> {x.question}</li>)}</ul>
              </details>
            ) : null}
          </div>
          {d.warnings?.length ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" />Warnings</p>
              <ul className="mt-1 list-disc pl-5">{d.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          ) : null}
          {d.stage_calls?.length ? (
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Stages ({d.stage_calls.length} model calls)</summary>
              <ul className="mt-2 space-y-0.5 text-xs">
                {d.stage_calls.map((c, n) => <li key={n}>{c.stage} · {c.chunk} · {c.reused ? "reused from an earlier run" : `${c.attempts} attempt${c.attempts === 1 ? "" : "s"}${c.duration_ms ? ` · ${(c.duration_ms / 1000).toFixed(0)}s` : ""}`}{c.dropped ? ` · ${c.dropped} invalid reference(s) dropped` : ""}</li>)}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {tab === "source" ? (
        <ol className="space-y-3">
          {detail.fragments.map((f) => (
            <li key={f.id} id={`fragment-${f.id}`} className="rounded-md border bg-card p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">F{f.sequence} · {f.section_heading ?? "No section heading"}</p>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {classifications[f.id] ? <Pill tone={classifications[f.id] === "requirement" ? "ok" : "muted"}>{classifications[f.id].replace("_", " ")}</Pill> : null}
                  <span>{f.fragment_type}{pagesOf(f) ? ` · ${pagesOf(f)}` : ""}</span>
                </div>
              </div>
              {f.section_path.length > 1 ? <p className="text-xs text-muted-foreground">{sectionOf(f)}</p> : null}
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{f.text}</p>
            </li>
          ))}
        </ol>
      ) : null}

      {tab === "proposals" ? (
        proposals.length ? <ul className="space-y-3">{proposals.map((p) => <ProposalCard key={p.id} p={p} />)}</ul>
          : <EmptyState title={active ? "Analysis in progress" : "No proposed requirements"} description={active ? "The local worker is analysing this document." : "The analysis did not propose any requirements for this extraction."} icon={ListChecks} />
      ) : null}

      {tab === "scope" ? (
        scopeNotes.length ? (
          <div>
            <p className="mb-3 text-sm text-muted-foreground">Statements that an area needs no change. They are not proposed requirements; they are kept, with their source, for regression planning.</p>
            <ul className="space-y-3">
              {scopeNotes.map((n) => (
                <li key={n.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-semibold"><span className="mr-2 text-muted-foreground">#{n.sequence}</span>{n.area ?? "Unnamed area"}</p>
                    <Pill>{n.note_type}</Pill>
                  </div>
                  <p className="mt-2 text-sm">{n.description}</p>
                  {n.source_quote && n.source_quote !== n.description ? <blockquote className="mt-2 border-l-2 pl-3 text-sm italic text-muted-foreground">“{n.source_quote}”</blockquote> : null}
                  <div className="mt-3"><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Source</p><SourceRefs ids={n.source_fragment_ids} /></div>
                </li>
              ))}
            </ul>
          </div>
        ) : <EmptyState title={active ? "Analysis in progress" : "No scope or regression notes"} description={run.analysis_schema_version && run.analysis_schema_version < "2" ? "This run used analysis schema 1.0.0, which did not record scope notes." : "The source contains no \"no change\" statements."} icon={ShieldCheck} />
      ) : null}

      {tab === "issues" ? (
        issues.length ? <ul className="space-y-3">{issues.map((i) => <IssueCard key={i.id} i={i} />)}</ul>
          : <EmptyState title={active ? "Analysis in progress" : "No issues"} description={active ? "The local worker is analysing this document." : "No ambiguities or open questions were raised."} icon={HelpCircle} />
      ) : null}

      {focused ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35" role="dialog" aria-label={`Source fragment F${focused.sequence}`} onClick={() => setFocus(null)}>
          <div className="h-full w-full overflow-y-auto border-l bg-background p-5 shadow-2xl sm:max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-muted-foreground">Source fragment F{focused.sequence} · read-only</p>
                <h3 className="text-lg font-semibold">{focused.section_heading ?? "No section heading"}</h3>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setFocus(null)} aria-label="Close"><X className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
            <dl className="mt-3 space-y-1 text-xs">
              <div><dt className="inline font-semibold text-muted-foreground">Document: </dt><dd className="inline">{document?.document_name} v{version?.version_number} ({version?.original_filename})</dd></div>
              <div><dt className="inline font-semibold text-muted-foreground">Section: </dt><dd className="inline">{sectionOf(focused)}</dd></div>
              <div><dt className="inline font-semibold text-muted-foreground">Page(s): </dt><dd className="inline">{pagesOf(focused) ?? "Not paginated (DOCX)"}</dd></div>
              <div><dt className="inline font-semibold text-muted-foreground">Extraction: </dt><dd className="inline">extractor {job?.extractor_version ?? "—"} · fragment {focused.sequence} of {detail.fragments.length}</dd></div>
            </dl>
            <p className="mt-4 whitespace-pre-wrap rounded-md border bg-card p-3 text-sm leading-relaxed">{focused.text}</p>
            {version ? (
              <Button className="mt-4" variant="outline" size="sm" onClick={() => openSourceDocumentVersion(run.project_id, version.id, "inline", isPdf ? focused.page_start : null).catch((e) => setError(e instanceof Error ? e.message : "Could not open the original."))}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open original{isPdf && focused.page_start ? ` at page ${focused.page_start}` : ""}
              </Button>
            ) : null}
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><FileText className="h-3.5 w-3.5" aria-hidden="true" />The fragment is exactly what the deterministic extractor found; it is immutable.</p>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
