"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, FileText, GitMerge, HelpCircle, Layers, ListChecks, Loader2, Lock, Pencil, RotateCcw, Scissors, ShieldCheck, Upload, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { ReviewDialog, type ReviewDialogState } from "@/components/analysis-review-dialogs";
import { canReviewRequirementAnalysis, canViewRequirementAnalysis } from "@/lib/permissions";
import { ANALYSIS_ERROR_LABELS, isActiveAnalysis, type AnalysisScopeNote } from "@/lib/requirement-analysis";
import { acknowledgeScopeNote, issueReview, loadAnalysisRun, proposalReview, type AnalysisFragment, type AnalysisRunDetail } from "@/lib/requirement-analysis-client";
import { allowedProposalActions, effectiveProposal, isEdited, promotionBlocker, type ReviewedIssue, type ReviewedProposal } from "@/lib/requirement-review";
import { openSourceDocumentVersion } from "@/lib/source-documents-client";

// ── Requirement analysis workspace (Phase 1C/1D) ───────────────────────────
// Review of one AI analysis run: what was analysed (the exact extraction
// run), the proposed requirements, the issues and the scope/regression
// notes — every item traceable to its source fragments, section, page(s)
// and the original file. Phase 1D adds the human review layer: edit (the
// AI original stays as history), approve / needs review / reject / reopen,
// split, merge, bulk approve/reject, and promotion of an Approved proposal
// into ONE canonical Requirement (server-side, atomic, idempotent); issues
// can be resolved or promoted into a Discovery Question / Action / Risk /
// Decision; scope notes can be acknowledged (never promoted). Only actions
// valid for the current state are offered. Manager/Admin only.

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
  const [dialog, setDialog] = useState<ReviewDialogState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hideSuperseded, setHideSuperseded] = useState(true);
  const [showOriginal, setShowOriginal] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const mayReview = canReviewRequirementAnalysis(user?.role);

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

  const { run, version, document, extraction_job: job } = detail;
  const proposals = detail.proposals as ReviewedProposal[];
  const issues = detail.issues as ReviewedIssue[];
  const scopeNotes = (detail.scope_notes ?? []) as (AnalysisScopeNote & { acknowledged_at?: string | null; acknowledged_by_name?: string | null; acknowledgement_note?: string | null })[];
  const shownProposals = proposals.filter((p) => !hideSuperseded || p.review_status !== "Superseded");
  const selectedProposals = proposals.filter((p) => selected.has(p.id));
  const bySequence = new Map(proposals.map((p) => [p.sequence, p]));
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const refresh = () => setReloadKey((k) => k + 1);

  // Runs a dialog's decision through the right server route, then reloads.
  async function submitDialog(state: ReviewDialogState, payload: Record<string, unknown>) {
    const base = { project_id: run.project_id };
    let message: string | null = null;
    switch (state.kind) {
      case "edit": await proposalReview({ ...base, action: "edit", proposal_id: state.proposal.id, ...payload }); message = `Proposal #${state.proposal.sequence} updated.`; break;
      case "decide": await proposalReview({ ...base, action: state.action, proposal_id: state.proposal.id, ...payload }); break;
      case "split": {
        const res = await proposalReview({ ...base, action: "split", proposal_id: state.proposal.id, ...payload });
        message = `Split into ${(res.children as unknown[]).length} proposals; #${state.proposal.sequence} is Superseded.`; break;
      }
      case "merge": { await proposalReview({ ...base, action: "merge", ...payload }); setSelected(new Set()); message = "Merged; the members are Superseded."; break; }
      case "promote": {
        const e = effectiveProposal(state.proposal);
        // Category/priority chosen in the promote dialog are saved as the reviewed values first (then re-approved).
        if (payload.needs_edit && (payload.category !== e.category || payload.priority !== e.priority)) {
          await proposalReview({ ...base, action: "edit", proposal_id: state.proposal.id, category: payload.category, priority: payload.priority });
          await proposalReview({ ...base, action: "approve", proposal_id: state.proposal.id, note: "Category/priority set at promotion", acknowledge_inferred: false });
        }
        const res = await proposalReview({ ...base, action: "promote", proposal_id: state.proposal.id });
        const req = res.requirement as { requirement_ref?: string } | null;
        message = res.already_promoted ? `Already promoted as ${req?.requirement_ref}.` : `Promoted as ${req?.requirement_ref} (status Discovery).`; break;
      }
      case "bulk": {
        const res = await proposalReview({ ...base, action: "bulk_review", ...payload });
        const skipped = (res.skipped as { reason: string }[]) ?? [];
        setSelected(new Set());
        message = `${(res.updated as unknown[]).length} ${state.decision === "approve" ? "approved" : "rejected"}${skipped.length ? `; ${skipped.length} skipped (${[...new Set(skipped.map((x) => x.reason))].join("; ")})` : ""}.`; break;
      }
      case "issue-review": await issueReview({ ...base, action: "review", issue_id: state.issue.id, status: state.status, ...payload }); break;
      case "issue-promote": { const res = await issueReview({ ...base, action: "promote", issue_id: state.issue.id, ...payload }); message = `Issue #${state.issue.sequence} ${res.already_promoted ? "was already tracked" : "is now tracked"} as ${res.record_ref}.`; break; }
      case "scope-ack": await acknowledgeScopeNote(run.project_id, state.note.id, (payload.note as string | null) ?? null); break;
    }
    setNotice(message);
    refresh();
  }
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

  const reviewTone = (status: string) => (status === "Approved" || status === "Promoted" ? "ok" : status === "Needs Review" ? "warn" : status === "Rejected" ? "bad" : "muted");

  function ProposalCard({ p }: { p: ReviewedProposal }) {
    const merged = p.consolidation?.merged && (p.consolidation.members?.length ?? 0) > 1;
    const e = effectiveProposal(p);
    const edited = isEdited(p);
    const original = showOriginal.has(p.id);
    const actions = mayReview ? allowedProposalActions(p) : [];
    const blocker = promotionBlocker(p);
    const parents = p.parent_proposal_ids.map((id) => byId.get(id)).filter(Boolean) as ReviewedProposal[];
    const toggleOriginal = () => setShowOriginal((cur) => { const next = new Set(cur); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; });
    return (
      <li className={`rounded-lg border bg-card p-4 ${p.review_status === "Superseded" || p.review_status === "Rejected" ? "opacity-70" : ""}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            {actions.includes("merge") ? (
              <input type="checkbox" className="mt-1.5" aria-label={`Select proposal #${p.sequence}`} checked={selected.has(p.id)}
                onChange={(ev) => setSelected((cur) => { const next = new Set(cur); if (ev.target.checked) next.add(p.id); else next.delete(p.id); return next; })} />
            ) : null}
            <h4 className="font-semibold"><span className="mr-2 text-muted-foreground">#{p.sequence}</span>{original ? p.proposed_title : e.title}</h4>
          </div>
          <div className="flex flex-wrap gap-1">
            <Pill tone={p.evidence_basis === "Explicit" ? "ok" : "warn"} title={p.evidence_basis === "Explicit" ? "The source directly states this behaviour" : "An interpretation not directly stated — always needs review"}>{p.evidence_basis}</Pill>
            <Pill tone={p.confidence === "High" ? "ok" : p.confidence === "Medium" ? "info" : "warn"}>{p.confidence} confidence</Pill>
            <Pill tone={reviewTone(p.review_status)}>{p.review_status}</Pill>
            {p.origin !== "ai" ? <Pill tone="info" title="Created by a reviewer from AI proposals">{p.origin === "split" ? "Split" : "Merged"}</Pill> : null}
            {edited ? <Pill tone="info" title="A reviewer changed the AI's text">Edited</Pill> : null}
          </div>
        </div>
        {parents.length ? <p className="mt-1 text-xs text-muted-foreground">{p.origin === "split" ? "Split from" : "Merged from"} {parents.map((x) => `#${x.sequence}`).join(", ")}</p> : null}
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{original ? p.proposed_description : e.description}</p>
        {edited ? (
          <button type="button" className="mt-1 text-xs text-primary underline" onClick={toggleOriginal}>{original ? "Show reviewed version" : "Show AI original"}</button>
        ) : null}
        {p.source_quote ? <blockquote className="mt-2 border-l-2 pl-3 text-sm italic text-muted-foreground">“{p.source_quote}”</blockquote> : null}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div><dt className="inline font-semibold text-muted-foreground">Category: </dt><dd className="inline">{(original ? p.proposed_category : e.category) ?? "Not set"}</dd></div>
          <div><dt className="inline font-semibold text-muted-foreground">Priority: </dt><dd className="inline">{(original ? p.proposed_priority : e.priority) ?? "Not stated in the source"}</dd></div>
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
                  <span className="font-medium">{m.title}</span> <span className="text-muted-foreground">— {m.section ?? m.applies_to ?? ""} · {m.evidence_basis}</span>
                  {m.quote ? <span className="block italic text-muted-foreground">“{m.quote}”</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {p.reviewed_at || p.review_note || p.inferred_acknowledged_at ? (
          <div className="mt-3 rounded-md border bg-muted/40 p-2 text-xs">
            {p.review_note ? <p><span className="font-semibold">Review note: </span>{p.review_note}</p> : null}
            {p.rejection_reason ? <p><span className="font-semibold">Rejected as: </span>{p.rejection_reason}</p> : null}
            {p.inferred_acknowledged_at ? <p><span className="font-semibold">Inferred interpretation acknowledged</span> by {p.inferred_acknowledged_by_name ?? "—"} · {when(p.inferred_acknowledged_at)}</p> : null}
            {p.reviewed_at ? <p className="text-muted-foreground">Last reviewed by {p.reviewed_by_name ?? "—"} · {when(p.reviewed_at)}</p> : null}
          </div>
        ) : null}
        {p.review_status === "Promoted" ? (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />Promoted as <Link className="underline" href="/requirements">{p.promoted_ref}</Link>
            <span className="font-normal text-muted-foreground">by {p.promoted_by_name ?? "—"} · {when(p.promoted_at)}</span>
          </p>
        ) : null}
        {actions.length ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
            {actions.includes("promote") ? (
              <Button size="sm" onClick={() => setDialog({ kind: "promote", proposal: p })} disabled={Boolean(blocker) && !/category and priority/.test(blocker ?? "")} title={blocker ?? undefined}>
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />Promote
              </Button>
            ) : null}
            {actions.includes("approve") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "decide", proposal: p, action: "approve" })}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Approve</Button> : null}
            {actions.includes("edit") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "edit", proposal: p })}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</Button> : null}
            {actions.includes("split") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "split", proposal: p })}><Scissors className="h-3.5 w-3.5" aria-hidden="true" />Split</Button> : null}
            {actions.includes("needs_review") ? <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "decide", proposal: p, action: "needs_review" })}>Needs Review</Button> : null}
            {actions.includes("reject") ? <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "decide", proposal: p, action: "reject" })}><XCircle className="h-3.5 w-3.5" aria-hidden="true" />Reject</Button> : null}
            {actions.includes("reopen") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "decide", proposal: p, action: "reopen" })}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Reopen</Button> : null}
          </div>
        ) : null}
      </li>
    );
  }

  function IssueCard({ i }: { i: ReviewedIssue }) {
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
          <p className="mt-2 text-xs text-muted-foreground">Affects proposed requirement{i.related_proposal_sequences.length === 1 ? "" : "s"} {i.related_proposal_sequences.map((s) => `#${s}${bySequence.get(s)?.promoted_ref ? ` (${bySequence.get(s)?.promoted_ref})` : ""}`).join(", ")}</p>
        ) : null}
        {i.resolution_note || i.reviewed_at ? (
          <div className="mt-3 rounded-md border bg-muted/40 p-2 text-xs">
            {i.resolution_note ? <p><span className="font-semibold">Resolution: </span>{i.resolution_note}</p> : null}
            {i.reviewed_at ? <p className="text-muted-foreground">Reviewed by {i.reviewed_by_name ?? "—"} · {when(i.reviewed_at)}</p> : null}
          </div>
        ) : null}
        {i.promoted_record_id ? <p className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">Tracked as {i.promoted_ref}</p> : null}
        {mayReview ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
            {i.status === "Open" ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "issue-review", issue: i, status: "Resolved" })}>Resolve</Button>
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "issue-review", issue: i, status: "Accepted" })}>Accept</Button>
                <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "issue-review", issue: i, status: "Not Applicable" })}>Not Applicable</Button>
              </>
            ) : <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "issue-review", issue: i, status: "Open" })}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Reopen</Button>}
            {!i.promoted_record_id ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "issue-promote", issue: i })}><Upload className="h-3.5 w-3.5" aria-hidden="true" />Promote…</Button> : null}
          </div>
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
        These are AI <strong>proposals</strong> from a local model, not project requirements. Only <strong>Promote</strong> on an Approved proposal creates a canonical Requirement (status Discovery). Inferred items always need an explicit acknowledgement.
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

      {notice ? <div role="status" className="mb-4 flex items-start justify-between gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X className="h-4 w-4" aria-hidden="true" /></button></div> : null}

      {tab === "proposals" ? (
        proposals.length ? (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={hideSuperseded} onChange={(ev) => setHideSuperseded(ev.target.checked)} />
                Hide superseded ({proposals.filter((p) => p.review_status === "Superseded").length})
              </label>
              {mayReview && selectedProposals.length ? (
                <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Selected proposals">
                  <span className="text-muted-foreground">{selectedProposals.length} selected</span>
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "bulk", decision: "approve", proposals: selectedProposals })}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Approve selected</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "bulk", decision: "reject", proposals: selectedProposals })}><XCircle className="h-3.5 w-3.5" aria-hidden="true" />Reject selected</Button>
                  {selectedProposals.length >= 2 ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "merge", proposals: selectedProposals })}><GitMerge className="h-3.5 w-3.5" aria-hidden="true" />Merge</Button> : null}
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
                </div>
              ) : null}
            </div>
            <ul className="space-y-3">{shownProposals.map((p) => <ProposalCard key={p.id} p={p} />)}</ul>
          </div>
        )
          : <EmptyState title={active ? "Analysis in progress" : "No proposed requirements"} description={active ? "The local worker is analysing this document." : "The analysis did not propose any requirements for this extraction."} icon={ListChecks} />
      ) : null}

      {tab === "scope" ? (
        scopeNotes.length ? (
          <div>
            <p className="mb-3 text-sm text-muted-foreground">Statements that an area needs no change. They are not proposed requirements and cannot be promoted; they are kept, with their source, for regression and test planning.</p>
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
                  {n.acknowledged_at ? (
                    <p className="mt-3 text-xs text-muted-foreground">Acknowledged by {n.acknowledged_by_name ?? "—"} · {when(n.acknowledged_at)}{n.acknowledgement_note ? ` — ${n.acknowledgement_note}` : ""}</p>
                  ) : mayReview ? (
                    <div className="mt-3 border-t pt-3"><Button size="sm" variant="outline" onClick={() => setDialog({ kind: "scope-ack", note: n })}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Acknowledge</Button></div>
                  ) : null}
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
      {dialog ? <ReviewDialog state={dialog} fragments={fragments} onSubmit={(payload) => submitDialog(dialog, payload)} onClose={() => setDialog(null)} /> : null}
    </AppShell>
  );
}
