"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, FileText, HelpCircle, Lock, MessageSquarePlus, Plus, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AcReviewDialog, type AcDialogContext, type AcDialogState } from "@/components/ac-review-dialogs";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { RequirementProvenancePanel } from "@/components/requirement-provenance";
import { Button } from "@/components/ui/button";
import { acGenerationSummary, isActiveAcGeneration, isCompletedAcGeneration } from "@/lib/ac-generation";
import {
  acProposalAction, loadAcReviewRun, reviewAcIssue, saveAcClarification, setScopeNoteAssociation, type AcReviewRunDetail,
} from "@/lib/ac-generation-client";
import {
  allowedAcActions, bulkApprovable, bulkRejectable, effectiveAc, isEditedAc, issueBlocksApproval, reasonKind, REASON_GUIDANCE, suggestsSplit,
  type ReviewedAcIssue, type ReviewedAcProposal,
} from "@/lib/ac-review";
import { useAuth } from "@/contexts/auth-context";
import { canReviewRequirementAnalysis, canViewRequirementAnalysis } from "@/lib/permissions";
import { ANALYSIS_ERROR_LABELS } from "@/lib/requirement-analysis";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";

// ── Acceptance Criteria review workspace (Phase 1F) ────────────────────────
// One AC-generation run for one promoted Requirement. Reviewers edit, approve,
// mark Needs Review, reject, split, merge and promote AI proposals into
// canonical Acceptance Criteria; resolve generation issues; record Human
// Clarifications; associate change-level scope notes with Requirements.
// Every rule is re-checked by the database (migration 046). Manager/Admin
// only — Viewers see promoted ACs and their provenance on the Requirement.

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
const statusTone = (s: string) => (s === "Promoted" ? "ok" : s === "Approved" ? "info" : s === "Needs Review" ? "warn" : s === "Rejected" ? "bad" : "muted");
const ORIGIN_LABEL: Record<string, string> = { ai: "AI", split: "Split by reviewer", merge: "Merged by reviewer", manual: "Human-authored" };

const TABS = ["Overview", "Source", "AC Proposals", "Generation Issues", "Scope / Regression", "History"] as const;
type Tab = (typeof TABS)[number];
const STATUS_FILTERS = ["Open", "All", "Proposed", "Needs Review", "Approved", "Promoted", "Rejected", "Superseded"] as const;

export function AcGenerationReviewPage({ runId }: { runId: string }) {
  const { user } = useAuth();
  const projectId = useSearchParams().get("project") ?? "";
  const mayView = canViewRequirementAnalysis(user?.role);
  const mayReview = canReviewRequirementAnalysis(user?.role);
  const [detail, setDetail] = useState<AcReviewRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<Tab>("AC Proposals");
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("Open");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<AcDialogState | null>(null);
  const active = isActiveAcGeneration(detail?.run);

  useEffect(() => {
    if (!mayView || !projectId) return;
    let live = true;
    const load = () => loadAcReviewRun(projectId, runId).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the acceptance criteria review."); });
    void load();
    const timer = active ? setInterval(load, 10_000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [mayView, projectId, runId, active, reloadKey]);

  const fragments = useMemo(() => new Map((detail?.fragments ?? []).map((f) => [f.id, f])), [detail?.fragments]);

  if (!user) return <AppShell><LoadingState /></AppShell>;
  if (!mayView) return <AppShell><EmptyState title="Manager or Admin access required" description="AI acceptance criteria proposals are not available to Viewers. Promoted Acceptance Criteria and their source provenance remain available on each Requirement." icon={Lock} /></AppShell>;
  if (!projectId) return <AppShell><EmptyState title="No project" description="Open this from a Requirement." icon={AlertTriangle} /></AppShell>;
  if (error) return <AppShell><LoadErrorState onRetry={() => { setError(null); setReloadKey((k) => k + 1); }} detail={error} /></AppShell>;
  if (!detail) return <AppShell><LoadingState /></AppShell>;

  const { run, proposals, issues, clarifications } = detail;
  const input = run.input_snapshot;
  const reqRef = detail.requirement?.requirement_ref ?? input.requirement.ref ?? "Requirement";
  const completed = isCompletedAcGeneration(run);
  const isLatest = detail.latest_run_id === run.id;
  const clarById = new Map(input.clarifications.map((c, i) => [c.id, { ...c, label: `C${i + 1}` }]));
  const openById = new Map(input.open_questions.map((q, i) => [q.id, { ...q, label: `Q${i + 1}` }]));
  const noteIndex = new Map(detail.scope_notes.map((n) => [n.id, n]));
  const issuesByAnalysisId = new Map<string, ReviewedAcIssue[]>();
  for (const i of issues) for (const a of i.analysis_issue_ids) issuesByAnalysisId.set(a, [...(issuesByAnalysisId.get(a) ?? []), i]);
  const clarsByProposal = new Map<string, typeof clarifications>();
  for (const c of clarifications) clarsByProposal.set(c.proposal_id, [...(clarsByProposal.get(c.proposal_id) ?? []), c]);
  const counts = Object.fromEntries(["Proposed", "Needs Review", "Approved", "Promoted", "Rejected", "Superseded"].map((s) => [s, proposals.filter((p) => p.review_status === s).length]));
  const openBlocking = issues.filter(issueBlocksApproval).length;
  const visible = proposals.filter((p) => filter === "All" ? true : filter === "Open" ? ["Proposed", "Needs Review", "Approved"].includes(p.review_status) : p.review_status === filter);
  const selectedProposals = proposals.filter((p) => selected.has(p.id));

  const context: AcDialogContext = {
    fragments, runFragmentIds: input.fragment_ids,
    scopeNotes: input.scope_notes.map((n, i) => ({ id: n.id, label: `N${i + 1}`, description: `${n.area}: ${n.description}` })),
    analysisIssues: [...input.open_questions.map((q, i) => ({ id: q.id, label: `Q${i + 1}`, text: q.question ?? q.description })), ...input.clarifications.map((c, i) => ({ id: c.id, label: `C${i + 1}`, text: c.question ?? c.description }))],
    generationIssues: issues, requirements: detail.analysis_requirements,
  };
  const reload = (message?: string) => { setNotice(message ?? null); setSelected(new Set()); setReloadKey((k) => k + 1); };
  const warn = (r: { audit_warning?: string }) => (r.audit_warning ? ` (audit warning: ${r.audit_warning})` : "");

  const submit = async (payload: Record<string, unknown>) => {
    if (!dialog) return;
    const d = dialog;
    switch (d.kind) {
      case "edit": { const r = await acProposalAction(projectId, "edit", { proposal_id: d.proposal.id, ...payload }); reload(`Saved the reviewed version of #${d.proposal.sequence}.${warn(r)}`); break; }
      case "decide": { const r = await acProposalAction(projectId, d.action, { proposal_id: d.proposal.id, ...payload }); reload(`#${d.proposal.sequence} updated.${warn(r)}`); break; }
      case "split": { const r = await acProposalAction(projectId, "split", { proposal_id: d.proposal.id, ...payload }); reload(`Split #${d.proposal.sequence}; the new criteria need review.${warn(r)}`); break; }
      case "merge": { const r = await acProposalAction(projectId, "merge", payload); reload(`Merged; the new criterion needs review.${warn(r)}`); break; }
      case "promote": {
        const r = await acProposalAction(projectId, "promote", { proposal_id: d.proposal.id }) as { acceptance_criterion?: { ac_ref?: string }; already_promoted?: boolean; audit_warning?: string };
        reload(r.already_promoted ? `#${d.proposal.sequence} was already promoted to ${r.acceptance_criterion?.ac_ref}.` : `Promoted #${d.proposal.sequence} to ${r.acceptance_criterion?.ac_ref} on ${reqRef}.${warn(r)}`);
        break;
      }
      case "bulk": {
        const r = await acProposalAction(projectId, "bulk_review", payload) as { done?: string[]; skipped?: { reason: string }[] };
        reload(`${d.decision === "approve" ? "Approved" : "Rejected"} ${r.done?.length ?? 0}${r.skipped?.length ? `; skipped ${r.skipped.length} (${[...new Set(r.skipped.map((s) => s.reason))].join("; ")})` : ""}.`);
        break;
      }
      case "clarify": { const r = await saveAcClarification(projectId, payload); reload(`Human Clarification saved.${warn(r)}`); break; }
      case "manual": { const r = await acProposalAction(projectId, "create_manual", { run_id: run.id, ...payload }); reload(`Added a human-authored criterion (Needs Review).${warn(r)}`); break; }
      case "issue-review": { const r = await reviewAcIssue(projectId, d.issue.id, d.status, (payload.note as string | null) ?? null); reload(`Generation issue #${d.issue.sequence} → ${d.status}.${warn(r)}`); break; }
      case "associate": { const r = await setScopeNoteAssociation(projectId, d.note.id, String(payload.requirement_id), true, (payload.note as string | null) ?? null); reload(`Scope note N${d.note.sequence} associated.${warn(r)}`); break; }
      case "adopt": { const r = await acProposalAction(projectId, "supersede_older", { run_id: run.id }) as { superseded?: number }; reload(`Adopted this run; ${r.superseded ?? 0} older proposal(s) superseded.`); break; }
    }
  };
  const unassociate = async (noteId: string, requirementId: string) => {
    try { await setScopeNoteAssociation(projectId, noteId, requirementId, false); reload("Association removed; the note is change-level again for that Requirement."); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Could not remove the association."); }
  };

  const Sources = ({ p }: { p: ReviewedAcProposal }) => (
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
      {p.source_fragment_ids.map((id) => {
        const f = fragments.get(id);
        return <li key={id}><FileText className="mr-1 inline h-3 w-3" aria-hidden="true" />{f ? `F${f.sequence} · ${sectionOf(f)}${pagesOf(f) ? ` · ${pagesOf(f)}` : ""}` : "Source fragment"}</li>;
      })}
      {p.scope_note_ids.map((id) => <li key={id}><ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden="true" />Scope note: {noteIndex.get(id)?.description ?? input.scope_notes.find((n) => n.id === id)?.description}</li>)}
      {p.clarification_issue_ids.map((id) => <li key={id}><HelpCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />Relies on human clarification {clarById.get(id)?.label}: {clarById.get(id)?.resolution_note}</li>)}
      {p.open_issue_ids.map((id) => {
        const gen = issuesByAnalysisId.get(id) ?? [];
        const resolved = gen.some((g) => g.status === "Resolved" || g.status === "Not Applicable");
        return <li key={id} className={resolved ? "" : "text-amber-800 dark:text-amber-200"}><AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />{resolved ? <>Resolved question {openById.get(id)?.label}</> : <>Blocked by open question {openById.get(id)?.label}</>}: {openById.get(id)?.question}</li>;
      })}
    </ul>
  );

  const ProposalCard = ({ p }: { p: ReviewedAcProposal }) => {
    const e = effectiveAc(p);
    const actions = mayReview && completed ? allowedAcActions(p) : [];
    const blockers = detail.approval_blockers[p.id] ?? [];
    const clars = clarsByProposal.get(p.id) ?? [];
    const open = p.review_status === "Proposed" || p.review_status === "Needs Review" || p.review_status === "Approved";
    return (
      <li className={`rounded-lg border bg-card p-3 ${p.review_status === "Needs Review" ? "border-amber-300 dark:border-amber-700" : p.review_status === "Promoted" ? "border-emerald-300 dark:border-emerald-800" : ""} ${["Rejected", "Superseded"].includes(p.review_status) ? "opacity-70" : ""}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          {mayReview && open ? <input type="checkbox" aria-label={`Select #${p.sequence}`} checked={selected.has(p.id)} onChange={(ev) => setSelected((s) => { const n = new Set(s); if (ev.target.checked) n.add(p.id); else n.delete(p.id); return n; })} /> : null}
          <span className="text-xs font-semibold text-muted-foreground">#{p.sequence}</span>
          <Pill tone={statusTone(p.review_status)}>{p.review_status}</Pill>
          <Pill tone={typeTone(e.criterion_type)}>{e.criterion_type}</Pill>
          <Pill tone={p.basis === "Explicit" ? "muted" : "warn"}>{p.basis}</Pill>
          <Pill>{p.confidence} confidence</Pill>
          {p.origin !== "ai" ? <Pill tone="info">{ORIGIN_LABEL[p.origin]}</Pill> : null}
          {isEditedAc(p) ? <Pill tone="info" title={`AI original: ${p.criterion}`}>Edited — AI original kept</Pill> : null}
          {clars.length ? <Pill tone="info">{clars.length} Human Clarification{clars.length === 1 ? "" : "s"}</Pill> : null}
          {p.consolidation?.merged ? <Pill title={(p.consolidation.members ?? []).map((m) => m.criterion).join("\n")}>Consolidates {p.consolidation.member_count}</Pill> : null}
          {p.promoted_ac_ref ? <Pill tone="ok">→ {p.promoted_ac_ref}</Pill> : null}
          {p.rejection_reason ? <Pill tone="bad">{p.rejection_reason}</Pill> : null}
        </div>
        <p className="mt-2 text-sm font-medium">{e.criterion}</p>
        {e.given_text || e.when_text || e.then_text ? (
          <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            {e.given_text ? <><dt className="font-semibold text-muted-foreground">Given</dt><dd>{e.given_text}</dd></> : null}
            {e.when_text ? <><dt className="font-semibold text-muted-foreground">When</dt><dd>{e.when_text}</dd></> : null}
            {e.then_text ? <><dt className="font-semibold text-muted-foreground">Then</dt><dd>{e.then_text}</dd></> : null}
          </dl>
        ) : null}
        {e.description ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{e.description}</p> : null}
        {open && p.needs_review_reasons.length ? (
          <ul className="mt-2 space-y-1 text-xs">
            {p.needs_review_reasons.map((r) => <li key={r} className="text-amber-800 dark:text-amber-200"><span className="font-medium">{r}</span> <span className="text-muted-foreground">— {REASON_GUIDANCE[reasonKind(r)]}</span></li>)}
          </ul>
        ) : null}
        {open && blockers.length ? <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">Before approval: {blockers.join(" · ")}</p> : null}
        {open && suggestsSplit(e.criterion) ? <p className="mt-2 text-xs text-sky-800 dark:text-sky-200">This criterion appears to span several applications — consider splitting it into one criterion per application.</p> : null}
        {clars.length ? (
          <ul className="mt-2 space-y-1 rounded border bg-muted/30 p-2 text-xs">
            {clars.map((c) => (
              <li key={c.id}>
                <MessageSquarePlus className="mr-1 inline h-3 w-3" aria-hidden="true" /><span className="font-medium">Human Clarification:</span> {c.clarification}
                <span className="text-muted-foreground"> — {c.created_by_name}, {when(c.created_at)}{c.updated_by_name ? ` (revised by ${c.updated_by_name})` : ""}</span>
                {actions.includes("clarify") ? <button type="button" className="ml-2 text-primary underline" onClick={() => setDialog({ kind: "clarify", proposal: p, clarification: c })}>Revise</button> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <Sources p={p} />
        {p.source_quote ? <p className="mt-2 border-l-2 pl-2 text-xs italic text-muted-foreground">“{p.source_quote}”</p> : null}
        {p.rationale ? <p className="mt-1 text-xs text-muted-foreground">{p.rationale}</p> : null}
        {p.reviewed_by_name ? <p className="mt-1 text-xs text-muted-foreground">Last reviewed by {p.reviewed_by_name}, {when(p.reviewed_at)}{p.review_note ? ` — ${p.review_note}` : ""}{p.review_confirmed_by_name ? ` · confirmed by ${p.review_confirmed_by_name}` : ""}</p> : null}
        {p.promoted_at ? <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-200">Promoted to {p.promoted_ac_ref} by {p.promoted_by_name ?? "—"}, {when(p.promoted_at)}</p> : null}
        {actions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.includes("promote") ? <Button size="sm" onClick={() => setDialog({ kind: "promote", proposal: p, requirementRef: reqRef, clarifications: clars.length })}>Promote</Button> : null}
            {actions.includes("approve") ? <Button size="sm" variant={blockers.length ? "outline" : "default"} onClick={() => setDialog({ kind: "decide", proposal: p, action: "approve", blockers })}>Approve</Button> : null}
            {actions.includes("edit") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "edit", proposal: p })}>Edit</Button> : null}
            {actions.includes("clarify") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "clarify", proposal: p, clarification: null })}>Add clarification</Button> : null}
            {actions.includes("needs_review") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "decide", proposal: p, action: "needs_review", blockers })}>Needs Review</Button> : null}
            {actions.includes("split") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "split", proposal: p })}>Split</Button> : null}
            {actions.includes("reject") ? <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "decide", proposal: p, action: "reject", blockers })}>Reject</Button> : null}
            {actions.includes("reopen") ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "decide", proposal: p, action: "reopen", blockers })}>Reopen</Button> : null}
          </div>
        ) : null}
      </li>
    );
  };

  const mergeable = selectedProposals.length >= 2 && selectedProposals.every((p) => allowedAcActions(p).includes("merge"));
  const bulkApprove = selectedProposals.filter(bulkApprovable), bulkReject = selectedProposals.filter(bulkRejectable);

  return (
    <AppShell>
      <div className="space-y-5">
        <div>
          <Link href="/requirements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Requirements</Link>
          <h1 className="mt-2 flex items-center gap-2 text-xl font-semibold"><Sparkles className="h-5 w-5" aria-hidden="true" />Acceptance criteria review — {reqRef}</h1>
          <p className="mt-1 text-sm text-muted-foreground">AI proposals for human review. Only promotion creates canonical Acceptance Criteria — one at a time, with status Not Started.</p>
        </div>

        {!isLatest ? (
          <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            This is an <strong>older</strong> generation run. <Link className="underline" href={`/acceptance-criteria-review/${detail.latest_run_id}?project=${projectId}`}>Open the latest run</Link>.
          </div>
        ) : null}
        {notice ? <div role="status" className="rounded-md border bg-muted/50 p-3 text-sm">{notice}</div> : null}

        <nav className="flex flex-wrap gap-1 border-b" aria-label="Review sections">
          {TABS.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-current={tab === t ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {t}{t === "AC Proposals" ? ` (${proposals.length})` : t === "Generation Issues" ? ` (${issues.length})` : ""}
            </button>
          ))}
        </nav>

        {tab === "Overview" ? (
          <section className="space-y-4">
            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={run.status === "Failed" ? "bad" : run.status === "Completed with warnings" ? "warn" : run.status === "Completed" ? "ok" : "info"}>{run.status}</Pill>
                {completed ? <span className="text-sm font-medium">{acGenerationSummary(run)}</span> : null}
              </div>
              {run.status === "Failed" ? <p className="mt-2 text-sm text-destructive">{run.error_category ? ANALYSIS_ERROR_LABELS[run.error_category] ?? run.error_category : "Failed"}{run.error_message ? ` — ${run.error_message}` : ""}</p> : null}
              <h2 className="mt-3 text-base font-semibold">{input.requirement.title}</h2>
              <p className="mt-1 whitespace-pre-wrap text-sm">{input.requirement.description}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {[input.requirement.category, input.requirement.priority ? `${input.requirement.priority} priority` : null, detail.requirement?.status ?? input.requirement.status].filter(Boolean).join(" · ")}
                {" · "}from {input.document?.name ?? "source document"} v{input.version?.version_number ?? "?"}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {(["Proposed", "Needs Review", "Approved", "Promoted", "Rejected", "Superseded"] as const).map((s) => (
                <button key={s} type="button" className="rounded-lg border bg-card p-3 text-left" onClick={() => { setFilter(s); setTab("AC Proposals"); }}>
                  <p className="text-xs text-muted-foreground">{s}</p><p className="text-2xl font-semibold">{counts[s]}</p>
                </button>
              ))}
            </div>
            {openBlocking ? <p className="text-sm font-medium text-amber-800 dark:text-amber-200"><AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden="true" />{openBlocking} blocking generation issue{openBlocking === 1 ? "" : "s"} must be resolved before dependent criteria can be approved.</p> : null}
            <div className="rounded-lg border bg-card p-4 text-sm">
              <h3 className="font-semibold">Existing Acceptance Criteria on {reqRef} ({detail.canonical_acceptance_criteria.length})</h3>
              {detail.canonical_acceptance_criteria.length ? (
                <ul className="mt-2 space-y-1">{detail.canonical_acceptance_criteria.map((a) => <li key={a.id}><span className="font-medium">{a.ac_ref}</span> {a.criterion} <span className="text-xs text-muted-foreground">· {a.status}{a.criterion_type ? ` · ${a.criterion_type}` : ""}</span></li>)}</ul>
              ) : <p className="mt-1 text-xs text-muted-foreground">None yet.</p>}
            </div>
            <div className="rounded-lg border bg-card p-4 text-sm">
              <h3 className="font-semibold">Generation runs for {reqRef}</h3>
              <ul className="mt-2 space-y-1">
                {detail.sibling_runs.map((s, i) => (
                  <li key={s.id}>
                    {s.id === run.id ? <span className="font-medium">This run</span> : <Link className="underline" href={`/acceptance-criteria-review/${s.id}?project=${projectId}`}>Run of {when(s.queued_at)}</Link>}
                    <span className="text-xs text-muted-foreground"> · {s.status} · prompts {s.prompt_version ?? "—"} · {s.proposal_count ?? 0} proposals{i === 0 ? " · latest" : ""}</span>
                  </li>
                ))}
              </ul>
              {mayReview && isLatest && completed && detail.older_open_proposals > 0 ? (
                <Button className="mt-3" size="sm" variant="outline" onClick={() => setDialog({ kind: "adopt", olderCount: detail.older_open_proposals })}>Adopt this run (supersede {detail.older_open_proposals} older open proposal{detail.older_open_proposals === 1 ? "" : "s"})</Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Queued {when(run.queued_at)}{run.requested_by_name ? ` by ${run.requested_by_name}` : ""} · {run.trigger === "retry" ? "retry · " : ""}model {run.model}{run.model_digest ? ` (${run.model_digest})` : ""} · AC prompts {run.prompt_version ?? "—"} · schema {run.schema_version ?? "—"} · input {run.input_sha256.slice(0, 12)}
            </p>
          </section>
        ) : null}

        {tab === "Source" ? (
          <section className="space-y-4">
            <RequirementProvenancePanel projectId={projectId} requirementId={run.requirement_id} />
            <div className="rounded-lg border bg-card p-4 text-sm">
              <h2 className="text-base font-semibold">Source fragments the generation was given ({detail.fragments.length})</h2>
              <ul className="mt-2 space-y-2">
                {detail.fragments.map((f) => (
                  <li key={f.id} className="rounded border bg-muted/30 p-2 text-xs">
                    <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">F{f.sequence} · {f.section_path.length ? f.section_path.join(" › ") : f.section_heading ?? "Document start"}</span><span className="text-muted-foreground">{pagesOf(f) ?? "not paginated"}</span></div>
                    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{f.text}</p>
                  </li>
                ))}
              </ul>
              <h3 className="mt-4 text-xs font-semibold uppercase text-muted-foreground">Analysis clarifications ({input.clarifications.length})</h3>
              {input.clarifications.length ? <ul className="mt-1 space-y-1">{input.clarifications.map((c, i) => <li key={c.id}><span className="font-medium">C{i + 1}</span> {c.question} — <span className="italic">{c.resolution_note}</span>{c.reviewed_by_name ? ` (${c.reviewed_by_name})` : ""}</li>)}</ul> : <p className="text-xs text-muted-foreground">None.</p>}
              <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">Open questions — not treated as fact ({input.open_questions.length})</h3>
              {input.open_questions.length ? <ul className="mt-1 space-y-1">{input.open_questions.map((q, i) => <li key={q.id}><span className="font-medium">Q{i + 1}</span> {q.question ?? q.description}</li>)}</ul> : <p className="text-xs text-muted-foreground">None.</p>}
            </div>
          </section>
        ) : null}

        {tab === "AC Proposals" ? (
          <section aria-label="Acceptance criteria proposals" className="space-y-3">
            {active ? <p className="text-sm text-muted-foreground">Generation is {run.status.toLowerCase()} on the local worker…</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm">Show <select className="ml-1 rounded border bg-background px-2 py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>{STATUS_FILTERS.map((f) => <option key={f} value={f}>{f === "Open" ? "Open for review" : f}</option>)}</select></label>
              {mayReview && completed ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "manual" })}><Plus className="h-4 w-4" aria-hidden="true" />Add criterion</Button> : null}
            </div>
            <p className="text-xs text-muted-foreground">Types: <strong>Positive</strong> (required behaviour) · <strong>Negative</strong> (what must not happen) · <strong>Regression</strong> (unchanged behaviour that must keep working).</p>
            {mayReview && selectedProposals.length ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm">
                <span>{selectedProposals.length} selected</span>
                <Button size="sm" variant="outline" disabled={!bulkApprove.length} title="Only Proposed criteria can be approved in bulk" onClick={() => setDialog({ kind: "bulk", decision: "approve", proposals: bulkApprove })}>Approve {bulkApprove.length} Proposed</Button>
                <Button size="sm" variant="outline" disabled={!bulkReject.length} onClick={() => setDialog({ kind: "bulk", decision: "reject", proposals: bulkReject })}>Reject {bulkReject.length}</Button>
                <Button size="sm" variant="outline" disabled={!mergeable} onClick={() => setDialog({ kind: "merge", proposals: selectedProposals })}>Merge</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
            ) : null}
            {!active && visible.length === 0 ? <p className="text-sm text-muted-foreground">No criteria in this view.</p> : null}
            <ol className="space-y-3">{visible.map((p) => <ProposalCard key={p.id} p={p} />)}</ol>
          </section>
        ) : null}

        {tab === "Generation Issues" ? (
          <section aria-label="Generation issues" className="space-y-2">
            <p className="text-xs text-muted-foreground">Blocking issues must be Resolved or Not Applicable before dependent criteria are approved. Additional Coverage questions may stay open; Informational issues never block.</p>
            {issues.length ? (
              <ul className="space-y-2">
                {issues.map((i) => (
                  <li key={i.id} className={`rounded-lg border bg-card p-3 text-sm ${issueBlocksApproval(i) ? "border-amber-300 dark:border-amber-700" : ""}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-muted-foreground">#{i.sequence}</span>
                      <Pill tone={i.status === "Open" ? "warn" : "ok"}>{i.status}</Pill>
                      <Pill tone={i.severity === "High" ? "bad" : i.severity === "Medium" ? "warn" : "muted"}>{i.severity}</Pill>
                      {i.relation ? <Pill tone={i.relation === "Blocking" ? "warn" : "info"}>{RELATION_LABEL[i.relation]}</Pill> : null}
                      <span className="font-medium">{i.issue_type}</span>
                    </div>
                    <p className="mt-1">{i.description}</p>
                    {i.obligation ? <p className="mt-1 text-xs text-muted-foreground">Obligation: {i.obligation}</p> : null}
                    {i.suggested_question ? <p className="mt-1 text-xs">Question: {i.suggested_question}</p> : null}
                    {i.resolution_note ? <p className="mt-1 text-xs"><CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden="true" />{i.resolution_note} <span className="text-muted-foreground">— {i.reviewed_by_name}, {when(i.reviewed_at)}</span></p> : null}
                    {mayReview && completed ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(["Resolved", "Accepted", "Not Applicable", "Open"] as const).filter((s) => s !== i.status).map((s) => (
                          <Button key={s} size="sm" variant="outline" onClick={() => setDialog({ kind: "issue-review", issue: i, status: s })}>{s === "Open" ? "Reopen" : s}</Button>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No generation issues.</p>}
          </section>
        ) : null}

        {tab === "Scope / Regression" ? (
          <section className="space-y-3">
            <p className="text-xs text-muted-foreground">Acknowledged scope / regression notes from the analysis. They never become Requirements. A note associated with a Requirement is included in that Requirement&apos;s future AC generation for Regression criteria; unassociated notes stay change-level.</p>
            <p className="text-sm">Used by this run: {input.scope_notes.length ? input.scope_notes.map((n, i) => `N${i + 1} ${n.area}`).join(", ") : "none"}.</p>
            {detail.scope_notes.length ? (
              <ul className="space-y-2">
                {detail.scope_notes.map((n) => {
                  const assoc = detail.scope_note_associations.filter((a) => a.scope_note_id === n.id);
                  return (
                    <li key={n.id} className="rounded-lg border bg-card p-3 text-sm">
                      <p className="font-medium">N{n.sequence} · {n.area ?? "Change-level"}</p>
                      <p className="mt-1">{n.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Acknowledged by {n.acknowledged_by_name ?? "—"}{n.acknowledgement_note ? ` — ${n.acknowledgement_note}` : ""}</p>
                      <p className="mt-2 text-xs">
                        {assoc.length ? assoc.map((a) => {
                          const r = detail.analysis_requirements.find((x) => x.id === a.requirement_id);
                          return (
                            <span key={a.id} className="mr-2 inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5">
                              {r?.requirement_ref ?? "Requirement"}{a.note ? ` — ${a.note}` : ""}
                              {mayReview ? <button type="button" className="text-primary underline" onClick={() => void unassociate(n.id, a.requirement_id)}>remove</button> : null}
                            </span>
                          );
                        }) : <span className="text-muted-foreground">Change-level (not associated)</span>}
                      </p>
                      {mayReview ? <Button className="mt-2" size="sm" variant="outline" onClick={() => setDialog({ kind: "associate", note: n })}>Associate with a Requirement</Button> : null}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="text-sm text-muted-foreground">The analysis has no acknowledged scope notes.</p>}
          </section>
        ) : null}

        {tab === "History" ? (
          <section>
            {detail.history.length ? (
              <ul className="space-y-1 text-sm">
                {detail.history.map((h) => (
                  <li key={h.id} className="rounded border bg-card px-3 py-2">
                    <span className="text-xs text-muted-foreground">{when(h.changed_at)} · {h.changed_by_name || "System"}</span>
                    <p><span className="font-medium">{h.entity_name}</span> — {h.action_type}{h.field_name ? ` ${h.field_name}` : ""}{h.old_value ? `: ${h.old_value} →` : ""} {h.new_value}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No review history yet.</p>}
          </section>
        ) : null}
      </div>
      {dialog ? <AcReviewDialog state={dialog} context={context} onSubmit={submit} onClose={() => setDialog(null)} /> : null}
    </AppShell>
  );
}
