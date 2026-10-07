"use client";

import { AlertTriangle, ArrowLeft, Copy, FileText, FlaskConical, HelpCircle, Lock, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { EmptyState } from "@/components/empty-state";
import { TestReviewDialog, type TestDialogState } from "@/components/test-review-dialogs";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { canReviewRequirementAnalysis, canViewRequirementAnalysis } from "@/lib/permissions";
import { ANALYSIS_ERROR_LABELS } from "@/lib/requirement-analysis";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";
import { isActiveTestGeneration, isCompletedTestGeneration, testGenerationSummary, type TestGenerationAc } from "@/lib/test-generation";
import { loadTestGenerationRun, testProposalAction, type CurrentAc, type TestGenerationRunDetail } from "@/lib/test-generation-client";
import { allowedTestActions, effectiveTest, isEditedTest, unsupportedTerms, type ReviewedTestProposal } from "@/lib/test-review";

// ── Test case review workspace (Phase 1G generation, Phase 1H review) ──────
// One test-generation run for one Requirement's canonical ACs: the source
// ACs and Requirement, the proposed test cases (preconditions, steps,
// expected results, type, basis, confidence, provenance, review reasons),
// the test-design issues and a coverage summary per AC. Manager/Admin review
// each proposal (edit, approve, reject, Needs Review, reopen, split, merge,
// add a manual test) and promote Approved ones one at a time into canonical
// Test Cases. Similar existing tests are shown as advice only. Viewers never
// see this workspace; canonical tests and their provenance are on Testing.

const when = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const pagesOf = (f: AnalysisFragment) =>
  f.page_start == null ? null : f.page_end != null && f.page_end !== f.page_start ? `pp. ${f.page_start}–${f.page_end}` : `p. ${f.page_start}`;
const sectionOf = (f: AnalysisFragment) => (f.section_path.length ? f.section_path.at(-1) : f.section_heading ?? "Document start");
const norm = (v: string | null | undefined) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
/** Material change of a source AC since the run's input was fixed (mirrors test_ac_fingerprint). */
const acChanged = (a: TestGenerationAc, now: CurrentAc | undefined) => !now
  || norm(a.criterion) !== norm(now.criterion) || norm(a.description) !== norm(now.description) || (a.criterion_type ?? "") !== (now.criterion_type ?? "")
  || norm(a.given_text) !== norm(now.given_text) || norm(a.when_text) !== norm(now.when_text) || norm(a.then_text) !== norm(now.then_text);

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
const typeTone = (t: string) => (t === "Regression" ? "info" : t === "Negative" ? "warn" : "ok");
const statusTone = (s: string) => (s === "Approved" || s === "Promoted" ? "ok" : s === "Needs Review" ? "warn" : s === "Rejected" ? "bad" : "muted");
const ORIGIN: Record<string, string> = { split: "Split", merge: "Merged", manual: "Manual" };
const ACTION_BUTTON: Record<string, string> = { approve: "Approve", needs_review: "Needs Review", reject: "Reject", reopen: "Reopen", edit: "Edit", split: "Split", promote: "Promote" };

export function TestGenerationReviewPage({ runId }: { runId: string }) {
  const { user } = useAuth();
  const projectId = useSearchParams().get("project") ?? "";
  const mayView = canViewRequirementAnalysis(user?.role);
  const mayReview = canReviewRequirementAnalysis(user?.role);
  const [detail, setDetail] = useState<TestGenerationRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<TestDialogState | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const active = isActiveTestGeneration(detail?.run);

  useEffect(() => {
    if (!mayView || !projectId) return;
    let live = true;
    const load = () => loadTestGenerationRun(projectId, runId).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the generated tests."); });
    void load();
    const timer = active ? setInterval(load, 10_000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [mayView, projectId, runId, active, reloadKey]);

  const fragments = useMemo(() => new Map((detail?.fragments ?? []).map((f) => [f.id, f])), [detail?.fragments]);

  if (!user) return <AppShell><LoadingState /></AppShell>;
  if (!mayView) return <AppShell><EmptyState title="Manager or Admin access required" description="AI test case proposals are not available to Viewers. Canonical Test Cases remain available on the Testing page." icon={Lock} /></AppShell>;
  if (!projectId) return <AppShell><EmptyState title="No project" description="Open this from a Requirement." icon={AlertTriangle} /></AppShell>;
  if (error) return <AppShell><LoadErrorState onRetry={() => { setError(null); setReloadKey((k) => k + 1); }} detail={error} /></AppShell>;
  if (!detail) return <AppShell><LoadingState /></AppShell>;

  const { run, proposals, issues } = detail;
  const input = run.input_snapshot;
  const acById = new Map(input.acceptance_criteria.map((a) => [a.id, a]));
  const currentById = new Map(detail.current_acceptance_criteria.map((a) => [a.id, a]));
  const changed = new Set(input.acceptance_criteria.filter((a) => acChanged(a, currentById.get(a.id))).map((a) => a.id));
  const human = new Map(input.human_clarifications.map((h) => [h.id, h]));
  const clar = new Map(input.analysis_clarifications.map((c) => [c.id, c]));
  const resolved = new Map(input.resolved_questions.map((q) => [q.id, q]));
  const notes = new Map(input.scope_notes.map((n) => [n.id, n]));
  const isLatest = detail.latest_run_id === run.id;
  const testsFor = (acId: string) => proposals.filter((p) => p.source_ac_ids.includes(acId) && p.review_status !== "Superseded" && p.review_status !== "Rejected");
  const issuesFor = (acId: string) => issues.filter((i) => i.ac_ids.includes(acId));
  const counts = proposals.reduce<Record<string, number>>((m, p) => ({ ...m, [p.review_status]: (m[p.review_status] ?? 0) + 1 }), {});
  const requirementRef = detail.requirement?.requirement_ref ?? input.requirement.ref ?? "Requirement";
  const context = { acs: input.acceptance_criteria.filter((a) => currentById.has(a.id)).map((a) => ({ id: a.id, ref: a.ref, criterion: currentById.get(a.id)?.criterion ?? a.criterion })) };
  const mergeSet = proposals.filter((p) => mergeIds.includes(p.id));

  const submit = async (action: string, body: Record<string, unknown>) => {
    const res = await testProposalAction(projectId, action, body);
    const test = (res as { test_case?: { test_ref?: string } }).test_case;
    setNotice(action === "promote" && test?.test_ref ? `${res.already_promoted ? "Already promoted as" : "Promoted as"} ${test.test_ref}.` : res.audit_warning ? `Saved, but the audit entry failed: ${res.audit_warning}` : null);
    if (action === "merge") setMergeIds([]);
    setReloadKey((k) => k + 1);
  };
  const onDialogSubmit = async (payload: Record<string, unknown>) => {
    if (!dialog) return;
    switch (dialog.kind) {
      case "edit": return submit("edit", { proposal_id: dialog.proposal.id, ...payload });
      case "decide": return submit(dialog.action, { proposal_id: dialog.proposal.id, ...payload });
      case "split": return submit("split", { proposal_id: dialog.proposal.id, ...payload });
      case "merge": return submit("merge", payload);
      case "promote": return submit("promote", { proposal_id: dialog.proposal.id });
      case "manual": return submit("create_manual", { run_id: run.id, ...payload });
    }
  };
  const open = (p: ReviewedTestProposal, action: string) => {
    if (action === "edit" || action === "split") setDialog({ kind: action, proposal: p });
    else if (action === "promote") setDialog({ kind: "promote", proposal: p, requirementRef, similar: detail.similar_tests[p.id] ?? [] });
    else setDialog({ kind: "decide", proposal: p, action: action as "approve" | "needs_review" | "reject" | "reopen", blockers: detail.approval_blockers[p.id] ?? [], changedAcs: p.source_ac_ids.filter((id) => changed.has(id)).map((id) => acById.get(id)?.ref ?? "AC") });
  };

  const Provenance = ({ p }: { p: ReviewedTestProposal }) => (
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
      {p.source_ac_ids.map((id) => <li key={id}><ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden="true" />Proves {acById.get(id)?.ref ?? "acceptance criterion"}: {acById.get(id)?.criterion}{changed.has(id) ? <span className="ml-1 font-medium text-amber-700 dark:text-amber-300">(changed since generation)</span> : null}</li>)}
      {p.source_fragment_ids.map((id) => {
        const f = fragments.get(id);
        return <li key={id}><FileText className="mr-1 inline h-3 w-3" aria-hidden="true" />{f ? `${sectionOf(f)}${pagesOf(f) ? ` · ${pagesOf(f)}` : ""}` : "Source fragment"}</li>;
      })}
      {p.human_clarification_ids.map((id) => <li key={id}><HelpCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />Relies on Human Clarification: {human.get(id)?.clarification}</li>)}
      {p.analysis_clarification_ids.map((id) => <li key={id}><HelpCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />Relies on clarification: {clar.get(id)?.resolution_note}</li>)}
      {p.resolved_issue_ids.map((id) => <li key={id}><HelpCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />Relies on resolved question: {resolved.get(id)?.question ?? resolved.get(id)?.description}</li>)}
      {p.scope_note_ids.map((id) => <li key={id}><ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden="true" />Scope note: {notes.get(id)?.description}</li>)}
    </ul>
  );

  return (
    <AppShell>
      <div className="space-y-5">
        <div>
          <Link href="/requirements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Requirements</Link>
          <h1 className="mt-2 flex items-center gap-2 text-xl font-semibold"><FlaskConical className="h-5 w-5" aria-hidden="true" />AI test cases — {requirementRef}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Proposals for human review. Approved tests are promoted one at a time into canonical Test Cases linked to their acceptance criteria.</p>
        </div>
        {!isLatest ? (
          <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            This is an <strong>older</strong> generation run. <Link className="underline" href={`/test-generation-review/${detail.latest_run_id}?project=${projectId}`}>Open the latest run</Link>.
          </div>
        ) : null}
        {notice ? <div role="status" className="rounded-md border bg-muted/50 p-3 text-sm">{notice}</div> : null}

        <section className="rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={run.status === "Failed" ? "bad" : run.status === "Completed with warnings" ? "warn" : run.status === "Completed" ? "ok" : "info"}>{run.status}</Pill>
            {isCompletedTestGeneration(run) ? <span className="text-sm font-medium">{testGenerationSummary(run)}</span> : null}
            {Object.entries(counts).map(([s, n]) => <Pill key={s} tone={statusTone(s)}>{n} {s}</Pill>)}
          </div>
          {run.status === "Failed" ? <p className="mt-2 text-sm text-destructive">{run.error_category ? ANALYSIS_ERROR_LABELS[run.error_category] ?? run.error_category : "Failed"}{run.error_message ? ` — ${run.error_message}` : ""}</p> : null}
          <h2 className="mt-3 text-base font-semibold">{input.requirement.title}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{input.requirement.description}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Queued {when(run.queued_at)}{run.requested_by_name ? ` by ${run.requested_by_name}` : ""} · {run.trigger === "retry" ? "retry · " : ""}model {run.model}{run.model_digest ? ` (${run.model_digest})` : ""} · test prompts {run.prompt_version ?? "—"} · schema {run.schema_version ?? "—"} · input {run.input_sha256.slice(0, 12)}
          </p>
          {changed.size ? <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">{[...changed].map((id) => acById.get(id)?.ref).join(", ")} changed since these tests were generated. Approving a test that proves {changed.size === 1 ? "it" : "them"} needs your explicit confirmation.</p> : null}
        </section>

        <section aria-label="Coverage" className="rounded-lg border bg-card p-4">
          <h2 className="text-base font-semibold">Coverage by acceptance criterion</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {input.acceptance_criteria.map((a) => {
              const t = testsFor(a.id), i = issuesFor(a.id), promoted = t.filter((p) => p.promoted_test_ref);
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{a.ref}</span>
                  <span className="flex-1">{a.criterion}</span>
                  <Pill tone={a.origin === "ai" ? "info" : "muted"}>{a.origin === "ai" ? "AI-promoted" : "Manual"}</Pill>
                  <Pill tone={t.length ? "ok" : "bad"}>{t.length ? `Tests ${t.map((p) => `#${p.sequence}`).join(", ")}` : "No test"}</Pill>
                  {promoted.length ? <Pill tone="ok">Promoted {promoted.map((p) => p.promoted_test_ref).join(", ")}</Pill> : null}
                  {i.length ? <Pill tone="warn">{i.length} issue{i.length === 1 ? "" : "s"}</Pill> : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Proposed test cases">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Proposed test cases ({proposals.length})</h2>
            {mayReview && isCompletedTestGeneration(run) ? (
              <div className="flex flex-wrap gap-2">
                {mergeSet.length >= 2 ? <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "merge", proposals: mergeSet })}>Merge {mergeSet.length} selected</Button> : null}
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "manual" })}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add manual test</Button>
              </div>
            ) : null}
          </div>
          {active ? <p className="mt-2 text-sm text-muted-foreground">Generation is {run.status.toLowerCase()} on the local worker…</p> : null}
          {!active && proposals.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No tests were proposed.</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">Types: <strong>Positive</strong> (required behaviour) · <strong>Negative</strong> (what must not happen) · <strong>Regression</strong> (unchanged behaviour that must keep working).</p>
          <ol className="mt-3 space-y-3">
            {proposals.map((p) => {
              const e = effectiveTest(p);
              const actions = mayReview ? allowedTestActions(p) : [];
              const unsupported = ["Proposed", "Needs Review", "Approved"].includes(p.review_status) ? unsupportedTerms(p).filter((t) => !p.accepted_inferences.includes(t)) : [];
              const similar = detail.similar_tests[p.id] ?? [];
              const blockers = detail.approval_blockers[p.id] ?? [];
              const closed = p.review_status === "Superseded" || p.review_status === "Rejected";
              return (
                <li key={p.id} className={`rounded-lg border bg-card p-3 ${p.review_status === "Needs Review" ? "border-amber-300 dark:border-amber-700" : ""} ${closed ? "opacity-70" : ""}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {actions.includes("merge") ? (
                      <input type="checkbox" aria-label={`Select #${p.sequence} to merge`} checked={mergeIds.includes(p.id)} onChange={(ev) => setMergeIds((ids) => ev.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id))} />
                    ) : null}
                    <span className="text-xs font-semibold text-muted-foreground">#{p.sequence}</span>
                    <Pill tone={statusTone(p.review_status)}>{p.review_status}{p.promoted_test_ref ? ` → ${p.promoted_test_ref}` : ""}</Pill>
                    <Pill tone={typeTone(e.test_type)}>{e.test_type}</Pill>
                    {p.variation ? <Pill>{p.variation}</Pill> : null}
                    <Pill tone={p.basis === "Explicit" ? "muted" : "warn"}>{p.basis}</Pill>
                    <Pill>{p.confidence} confidence</Pill>
                    {ORIGIN[p.origin] ? <Pill tone="info">{ORIGIN[p.origin]}</Pill> : null}
                    {isEditedTest(p) ? <Pill tone="info">Edited</Pill> : null}
                    {p.accepted_inferences.length ? <Pill tone="warn" title={p.review_note ?? undefined}>Accepted as Inferred: {p.accepted_inferences.join(", ")}</Pill> : null}
                    {p.consolidation?.merged ? <Pill title={(p.consolidation.members ?? []).map((m) => m.title).join("\n")}>Consolidates {p.consolidation.member_count}</Pill> : null}
                  </div>
                  <p className="mt-2 text-sm font-semibold">{e.title}</p>
                  <p className="mt-1 text-sm">{e.objective}</p>
                  {e.preconditions.length ? (
                    <div className="mt-2 text-xs"><p className="font-semibold text-muted-foreground">Preconditions</p><ul className="list-disc pl-5">{e.preconditions.map((c) => <li key={c}>{c}</li>)}</ul></div>
                  ) : null}
                  <table className="mt-2 w-full text-left text-xs">
                    <thead><tr className="text-muted-foreground"><th className="w-8 py-1">#</th><th className="py-1">Action</th><th className="py-1">Expected</th></tr></thead>
                    <tbody>{e.steps.map((s, i) => <tr key={i} className="border-t align-top"><td className="py-1">{i + 1}</td><td className="py-1 pr-2">{s.action}</td><td className="py-1">{s.expected ?? "—"}</td></tr>)}</tbody>
                  </table>
                  <p className="mt-2 text-sm"><span className="font-semibold">Expected result:</span> {e.expected_result}</p>
                  {unsupported.length ? (
                    <p className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
                      <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />Unsupported detail — not established by the acceptance criteria or their context: {unsupported.map((t) => `"${t}"`).join(", ")}. Correct it, or accept it as Inferred with a reason, before approval.
                    </p>
                  ) : null}
                  {p.needs_review_reasons.length && !closed ? <ul className="mt-2 list-disc pl-5 text-xs text-amber-800 dark:text-amber-200">{p.needs_review_reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
                  {similar.length ? (
                    <ul className="mt-2 space-y-0.5 text-xs text-sky-800 dark:text-sky-200">
                      {similar.map((s) => <li key={s.test_id}><Copy className="mr-1 inline h-3 w-3" aria-hidden="true" />Similar existing test: <strong>{s.test_ref}</strong>{s.same_ac_refs.length ? ` (already proves ${s.same_ac_refs.join(", ")})` : ""} — {s.scenario.slice(0, 120)}{s.scenario.length > 120 ? "…" : ""}</li>)}
                    </ul>
                  ) : null}
                  <Provenance p={p} />
                  <p className="mt-1 text-xs text-muted-foreground">{p.rationale}</p>
                  {p.review_note || p.reviewed_by_name ? <p className="mt-1 text-xs text-muted-foreground">{p.reviewed_by_name ? `Reviewed by ${p.reviewed_by_name}, ${when(p.reviewed_at)}` : ""}{p.rejection_reason ? ` · ${p.rejection_reason}` : ""}{p.review_note ? ` — ${p.review_note}` : ""}</p> : null}
                  {actions.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {actions.filter((a) => a !== "merge").map((a) => (
                        <Button key={a} size="sm" variant={a === "promote" || a === "approve" ? "default" : "outline"} disabled={a === "promote" && blockers.length > 0}
                          title={a === "promote" && blockers.length ? blockers.join(" ") : undefined} onClick={() => open(p, a)}>{ACTION_BUTTON[a]}</Button>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>

        {issues.length ? (
          <section aria-label="Test-design issues">
            <h2 className="text-base font-semibold">Test-design issues ({issues.length})</h2>
            <p className="mt-1 text-xs text-muted-foreground">Uncovered criteria and behaviours, and open questions kept visible — no placeholder tests are created for them. Add a manual test where a gap should be covered.</p>
            <ul className="mt-3 space-y-2">
              {issues.map((i) => (
                <li key={i.id} className={`rounded-lg border bg-card p-3 text-sm ${i.severity === "High" ? "border-amber-300 dark:border-amber-700" : ""}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={i.severity === "High" ? "bad" : i.severity === "Medium" ? "warn" : "muted"}>{i.severity}</Pill>
                    <span className="font-medium">{i.issue_type}</span>
                    {i.ac_ids.map((id) => <Pill key={id}>{acById.get(id)?.ref ?? "AC"}</Pill>)}
                  </div>
                  <p className="mt-1">{i.description}</p>
                  {i.behaviour ? <p className="mt-1 text-xs text-muted-foreground">Behaviour: {i.behaviour}</p> : null}
                  {i.suggested_question ? <p className="mt-1 text-xs">Question: {i.suggested_question}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-label="Context supplied" className="rounded-lg border bg-card p-4 text-sm">
          <h2 className="text-base font-semibold">What the generation was given</h2>
          <p className="mt-1 text-xs text-muted-foreground">The Requirement, {input.acceptance_criteria.length} canonical acceptance criteri{input.acceptance_criteria.length === 1 ? "on" : "a"}, {input.fragment_ids.length} source fragment{input.fragment_ids.length === 1 ? "" : "s"}, {input.human_clarifications.length} Human Clarification{input.human_clarifications.length === 1 ? "" : "s"}, {input.resolved_questions.length} resolved question{input.resolved_questions.length === 1 ? "" : "s"}, {input.scope_notes.length} scope note{input.scope_notes.length === 1 ? "" : "s"} and {input.open_questions.length} open question{input.open_questions.length === 1 ? "" : "s"} (never treated as fact). Existing test cases were not supplied.</p>
          <ul className="mt-2 space-y-1">
            {input.acceptance_criteria.map((a) => (
              <li key={a.id}><span className="font-medium">{a.ref}</span>{a.criterion_type ? ` (${a.criterion_type})` : ""}: {a.criterion}{a.given_text || a.when_text || a.then_text ? <span className="text-xs text-muted-foreground"> — Given {a.given_text ?? "—"} · When {a.when_text ?? "—"} · Then {a.then_text ?? "—"}</span> : null}</li>
            ))}
          </ul>
        </section>

        {detail.history.length ? (
          <section aria-label="Review history" className="rounded-lg border bg-card p-4 text-sm">
            <h2 className="text-base font-semibold">Review history</h2>
            <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto text-xs">
              {detail.history.map((h) => (
                <li key={h.id}><span className="text-muted-foreground">{when(h.changed_at)} · {h.changed_by_name ?? "—"}</span> — {h.entity_name}: {h.field_name ? `${h.field_name} ` : ""}{h.old_value ? `${h.old_value.slice(0, 80)} → ` : ""}{(h.new_value ?? h.action_type).slice(0, 200)}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {dialog ? <TestReviewDialog state={dialog} context={context} onSubmit={onDialogSubmit} onClose={() => setDialog(null)} /> : null}
    </AppShell>
  );
}
