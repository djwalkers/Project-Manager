"use client";

import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { TEST_TYPES, type TestGenerationIssue, type TestStep } from "@/lib/test-generation";
import {
  PROMOTED_TEST_STATUS, TEST_REASON_GUIDANCE, TEST_REJECTION_REASONS, effectiveTest, testReasonKind, unsupportedTerms,
  type ReviewedTestProposal, type SimilarTest,
} from "@/lib/test-review";

// ── Phase 1H test case review dialogs ───────────────────────────────────────
// One side panel per decision, same shape as the Phase 1F AC dialogs. Each
// states what the action does before the reviewer confirms it; the server
// (migration 048) re-checks every rule.

export type TestDialogState =
  | { kind: "edit"; proposal: ReviewedTestProposal }
  | { kind: "decide"; proposal: ReviewedTestProposal; action: "approve" | "needs_review" | "reject" | "reopen"; blockers: string[]; changedAcs: string[] }
  | { kind: "split"; proposal: ReviewedTestProposal }
  | { kind: "merge"; proposals: ReviewedTestProposal[] }
  | { kind: "promote"; proposal: ReviewedTestProposal; requirementRef: string; similar: SimilarTest[] }
  | { kind: "manual" }
  | { kind: "issue-review"; issue: TestGenerationIssue; status: "Open" | "Resolved" | "Accepted" | "Not Applicable" };

type Submit = (payload: Record<string, unknown>) => Promise<void>;
export type TestDialogContext = { acs: { id: string; ref: string; criterion: string }[] };

const ACTION_LABEL = { approve: "Approve", needs_review: "Mark Needs Review", reject: "Reject", reopen: "Reopen" } as const;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint ? <span className="block text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

type Draft = { title: string; objective: string; test_type: string; preconditions: string; steps: { action: string; expected: string }[]; expected_result: string };
const draftOf = (p: ReviewedTestProposal): Draft => {
  const e = effectiveTest(p);
  return { title: e.title, objective: e.objective, test_type: e.test_type, preconditions: e.preconditions.join("\n"), steps: e.steps.map((s) => ({ action: s.action, expected: s.expected ?? "" })), expected_result: e.expected_result };
};
const blankDraft = (): Draft => ({ title: "", objective: "", test_type: "Positive", preconditions: "", steps: [{ action: "", expected: "" }], expected_result: "" });
const payloadOf = (d: Draft) => ({
  title: d.title, objective: d.objective, test_type: d.test_type || null, expected_result: d.expected_result,
  preconditions: d.preconditions.split("\n").map((x) => x.trim()).filter(Boolean),
  steps: d.steps.map((s) => ({ action: s.action, expected: s.expected || null })),
});
const draftValid = (d: Draft) => Boolean(d.title.trim() && d.objective.trim() && d.expected_result.trim() && d.steps.length && d.steps.every((s) => s.action.trim()));

function TestFields({ value, onChange, typeLocked }: { value: Draft; onChange: (d: Draft) => void; typeLocked?: boolean }) {
  const set = (patch: Partial<Draft>) => onChange({ ...value, ...patch });
  const setStep = (i: number, patch: Partial<Draft["steps"][number]>) => set({ steps: value.steps.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
  return (
    <div className="space-y-3">
      <Field label="Title"><Input value={value.title} onChange={(e) => set({ title: e.target.value })} maxLength={300} required /></Field>
      <Field label="Type" hint={typeLocked ? "Merged tests keep their shared type." : undefined}>
        <Select value={value.test_type} onChange={(e) => set({ test_type: e.target.value })} disabled={typeLocked}>
          {TEST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </Field>
      <Field label="Objective"><Textarea rows={2} value={value.objective} onChange={(e) => set({ objective: e.target.value })} maxLength={2000} required /></Field>
      <Field label="Preconditions" hint="One per line."><Textarea rows={2} value={value.preconditions} onChange={(e) => set({ preconditions: e.target.value })} /></Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Steps</legend>
        {value.steps.map((s, i) => (
          <div key={i} className="grid grid-cols-[1.5rem_1fr_1fr_auto] items-start gap-2">
            <span className="pt-2 text-xs text-muted-foreground">{i + 1}</span>
            <Input aria-label={`Step ${i + 1} action`} placeholder="Action" value={s.action} onChange={(e) => setStep(i, { action: e.target.value })} maxLength={1000} />
            <Input aria-label={`Step ${i + 1} expected`} placeholder="Expected (optional)" value={s.expected} onChange={(e) => setStep(i, { expected: e.target.value })} maxLength={1000} />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove step ${i + 1}`} disabled={value.steps.length <= 1} onClick={() => set({ steps: value.steps.filter((_, n) => n !== i) })}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={value.steps.length >= 30} onClick={() => set({ steps: [...value.steps, { action: "", expected: "" }] })}><Plus className="h-4 w-4" aria-hidden="true" />Add step</Button>
      </fieldset>
      <Field label="Expected result"><Textarea rows={2} value={value.expected_result} onChange={(e) => set({ expected_result: e.target.value })} maxLength={2000} required /></Field>
    </div>
  );
}

function StepsTable({ steps }: { steps: TestStep[] }) {
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead><tr className="text-muted-foreground"><th className="w-8 py-1">#</th><th className="py-1">Action</th><th className="py-1">Expected</th></tr></thead>
      <tbody>{steps.map((s, i) => <tr key={i} className="border-t align-top"><td className="py-1">{i + 1}</td><td className="py-1 pr-2">{s.action}</td><td className="py-1">{s.expected ?? "—"}</td></tr>)}</tbody>
    </table>
  );
}

function Summary({ p }: { p: ReviewedTestProposal }) {
  const e = effectiveTest(p);
  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <p className="font-semibold">{e.title} <span className="text-xs font-normal text-muted-foreground">· {e.test_type}</span></p>
      <p className="mt-1 text-xs">{e.objective}</p>
      <StepsTable steps={e.steps} />
      <p className="mt-2 text-xs"><span className="font-semibold">Expected result:</span> {e.expected_result}</p>
    </div>
  );
}

function Original({ p }: { p: ReviewedTestProposal }) {
  return (
    <details className="rounded-md border p-3 text-xs">
      <summary className="cursor-pointer font-medium">{p.origin === "ai" ? "AI original" : "Original wording"}</summary>
      <p className="mt-2 font-medium">{p.title} · {p.test_type}</p>
      <p className="mt-1">{p.objective}</p>
      {p.preconditions.length ? <p className="mt-1 text-muted-foreground">Preconditions: {p.preconditions.join("; ")}</p> : null}
      <StepsTable steps={p.steps} />
      <p className="mt-1">Expected result: {p.expected_result}</p>
    </details>
  );
}

function SubmitRow({ busy, label, disabled, destructive }: { busy: boolean; label: string; disabled?: boolean; destructive?: boolean }) {
  return (
    <div className="flex justify-end border-t pt-4">
      <Button type="submit" disabled={busy || disabled} variant={destructive ? "destructive" : "default"}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{label}
      </Button>
    </div>
  );
}

export function TestReviewDialog({ state, context, onSubmit, onClose }: { state: TestDialogState; context: TestDialogContext; onSubmit: Submit; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await onSubmit(payload); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "The action failed."); } finally { setBusy(false); }
  };

  let title = "";
  let body: React.ReactNode = null;
  switch (state.kind) {
    case "edit": title = `Edit test proposal #${state.proposal.sequence}`; body = <EditForm proposal={state.proposal} busy={busy} onSave={run} />; break;
    case "decide": title = `${ACTION_LABEL[state.action]} test proposal #${state.proposal.sequence}`; body = <DecideForm proposal={state.proposal} action={state.action} blockers={state.blockers} changedAcs={state.changedAcs} busy={busy} onSave={run} />; break;
    case "split": title = `Split test proposal #${state.proposal.sequence}`; body = <SplitForm proposal={state.proposal} context={context} busy={busy} onSave={run} />; break;
    case "merge": title = `Merge ${state.proposals.length} test proposals`; body = <MergeForm proposals={state.proposals} busy={busy} onSave={run} />; break;
    case "promote": title = `Promote test proposal #${state.proposal.sequence}`; body = <PromoteForm proposal={state.proposal} requirementRef={state.requirementRef} similar={state.similar} context={context} busy={busy} onSave={run} />; break;
    case "manual": title = "Add a manual test"; body = <ManualForm context={context} busy={busy} onSave={run} />; break;
    case "issue-review": title = `${state.status === "Open" ? "Reopen" : `Mark ${state.status}`} — test-design issue #${state.issue.sequence}`; body = <IssueForm issue={state.issue} status={state.status} busy={busy} onSave={run} />; break;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35" role="dialog" aria-label={title}>
      <div className="h-full w-full overflow-y-auto border-l bg-background shadow-2xl sm:max-w-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-5 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" disabled={busy}><X className="h-4 w-4" aria-hidden="true" /></Button>
        </div>
        <div className="space-y-4 p-5">
          {error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">{error}</div> : null}
          {body}
        </div>
      </div>
    </div>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      {reasons.map((r) => <li key={r}><span className="font-medium">{r}</span><br /><span>{TEST_REASON_GUIDANCE[testReasonKind(r)]}</span></li>)}
    </ul>
  );
}

function EditForm({ proposal, busy, onSave }: { proposal: ReviewedTestProposal; busy: boolean; onSave: Submit }) {
  const [d, setD] = useState(draftOf(proposal));
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void onSave(payloadOf(d)); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        The original is kept unchanged as history; you are editing the reviewed version. Every change is audited.{proposal.review_status === "Approved" ? " Editing an approved test returns it to Needs Review." : ""}
      </p>
      <Reasons reasons={proposal.needs_review_reasons} />
      <TestFields value={d} onChange={setD} />
      <Original p={proposal} />
      <SubmitRow busy={busy} label="Save reviewed version" disabled={!draftValid(d)} />
    </form>
  );
}

function DecideForm({ proposal, action, blockers, changedAcs, busy, onSave }: { proposal: ReviewedTestProposal; action: "approve" | "needs_review" | "reject" | "reopen"; blockers: string[]; changedAcs: string[]; busy: boolean; onSave: Submit }) {
  const [note, setNote] = useState(""), [reason, setReason] = useState(""), [confirm, setConfirm] = useState(false), [accept, setAccept] = useState(false);
  const approving = action === "approve";
  // test_approval_blockers was evaluated as if confirmed: unsupported details may be accepted as Inferred (with a reason); anything else must be fixed first.
  const unsupported = approving ? unsupportedTerms(proposal) : [];
  const hard = approving ? blockers.filter((b) => !/is not established by the acceptance criteria/.test(b)) : [];
  const blocked = hard.length > 0 || (unsupported.length > 0 && !accept);
  const needsConfirm = approving && (proposal.review_status === "Needs Review" || changedAcs.length > 0 || accept);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ note: note || null, reason: reason || null, confirm, accept_inferences: accept }); }}>
      <Summary p={proposal} />
      {hard.length ? (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-semibold">This test cannot be approved yet:</p>
          <ul className="mt-1 list-disc pl-5">{hard.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      ) : null}
      {approving ? <Reasons reasons={proposal.needs_review_reasons} /> : null}
      {changedAcs.length && approving ? <p className="text-sm text-amber-800 dark:text-amber-200">{changedAcs.join(", ")} changed since these tests were generated — check the test against the current wording.</p> : null}
      {unsupported.length ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
          <p className="font-semibold">Unsupported detail: {unsupported.map((t) => `"${t}"`).join(", ")}</p>
          <p className="mt-1 text-xs">No acceptance criterion or governed context establishes this. Edit the test to remove it, or accept it as <strong>Inferred</strong> and record why it is valid.</p>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={accept} onChange={(ev) => setAccept(ev.target.checked)} />
            <span>Accept as Inferred — the promoted test will show this as reviewer-accepted, not source-stated.</span>
          </label>
        </div>
      ) : null}
      {action === "reject" ? (
        <Field label="Reason (recommended)" hint="Rejected proposals are kept in the review history and can be reopened.">
          <Select value={reason} onChange={(ev) => setReason(ev.target.value)}>
            <option value="">— choose a reason —</option>
            {TEST_REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
      ) : null}
      {needsConfirm && !blocked ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <input type="checkbox" className="mt-1" checked={confirm} onChange={(ev) => setConfirm(ev.target.checked)} />
          <span>I have reviewed this test against its acceptance criteria and the reasons above, and confirm it is correct. (Recorded with my name.)</span>
        </label>
      ) : null}
      <Field label={accept ? "Why the unsupported detail is valid (required)" : "Review note (optional)"}><Textarea rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} required={accept} /></Field>
      <SubmitRow busy={busy} label={ACTION_LABEL[action]} disabled={blocked || (needsConfirm && !confirm) || (accept && !note.trim())} destructive={action === "reject"} />
    </form>
  );
}

function AcChoice({ acs, chosen, onChange }: { acs: TestDialogContext["acs"]; chosen: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Proves acceptance criteria</p>
      {acs.map((a) => (
        <label key={a.id} className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={chosen.includes(a.id)} onChange={(ev) => onChange(ev.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
          <span><span className="font-medium">{a.ref}</span> <span className="text-muted-foreground">— {a.criterion}</span></span>
        </label>
      ))}
      {!chosen.length ? <p className="mt-1 text-xs text-destructive">Choose at least one acceptance criterion — every test must trace to one.</p> : null}
    </div>
  );
}

type Child = Draft & { acIds: string[] };

function SplitForm({ proposal, context, busy, onSave }: { proposal: ReviewedTestProposal; context: TestDialogContext; busy: boolean; onSave: Submit }) {
  const acs = context.acs.filter((a) => proposal.source_ac_ids.includes(a.id));
  const blank = (i: number): Child => ({ ...draftOf(proposal), acIds: proposal.source_ac_ids.length > 1 && acs[i] ? [acs[i].id] : [...proposal.source_ac_ids] });
  const [children, setChildren] = useState<Child[]>([blank(0), blank(1)]);
  const update = (i: number, patch: Partial<Child>) => setChildren((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const valid = children.length >= 2 && children.every((c) => draftValid(c) && c.acIds.length);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ children: children.map((c) => ({ ...payloadOf(c), source_ac_ids: c.acIds })) }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        The original becomes <strong>Superseded</strong> (kept in history). Each new test starts in Needs Review, keeps the original&apos;s sources and review reasons, and proves one or more of its acceptance criteria. Split one independently testable variation per test.
      </p>
      {children.map((c, i) => (
        <fieldset key={i} className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold">Test {i + 1}</legend>
            {children.length > 2 ? <Button type="button" variant="ghost" size="icon" aria-label={`Remove test ${i + 1}`} onClick={() => setChildren((cs) => cs.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button> : null}
          </div>
          <TestFields value={c} onChange={(d) => update(i, d)} />
          <AcChoice acs={acs} chosen={c.acIds} onChange={(acIds) => update(i, { acIds })} />
        </fieldset>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setChildren((cs) => [...cs, blank(cs.length)])} disabled={children.length >= 20}><Plus className="h-4 w-4" aria-hidden="true" />Add test</Button>
      <Original p={proposal} />
      <SubmitRow busy={busy} label={`Split into ${children.length}`} disabled={!valid} />
    </form>
  );
}

function MergeForm({ proposals, busy, onSave }: { proposals: ReviewedTestProposal[]; busy: boolean; onSave: Submit }) {
  const types = new Set(proposals.map((p) => effectiveTest(p).test_type));
  const first = draftOf(proposals[0]);
  const [d, setD] = useState<Draft>({ ...first, steps: proposals.flatMap((p) => draftOf(p).steps).slice(0, 30), expected_result: proposals.map((p) => effectiveTest(p).expected_result).join(" ") });
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ proposal_ids: proposals.map((x) => x.id), ...payloadOf(d) }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        Merging {proposals.map((x) => `#${x.sequence}`).join(", ")}: the new test proves every member&apos;s acceptance criteria, cites every member&apos;s sources and starts in Needs Review; the members become Superseded (kept in history). Steps start with every member&apos;s steps — keep every check you merge.
      </p>
      {types.size > 1 ? <p role="alert" className="text-sm font-medium text-destructive">These tests have different types ({[...types].join(", ")}); merging them would lose meaning. Merge only tests of the same type.</p> : null}
      <TestFields value={d} onChange={setD} typeLocked />
      <SubmitRow busy={busy} label="Merge" disabled={!draftValid(d) || types.size > 1} />
    </form>
  );
}

function PromoteForm({ proposal, requirementRef, similar, context, busy, onSave }: { proposal: ReviewedTestProposal; requirementRef: string; similar: SimilarTest[]; context: TestDialogContext; busy: boolean; onSave: Submit }) {
  const refs = proposal.source_ac_ids.map((id) => context.acs.find((a) => a.id === id)?.ref ?? "AC");
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({}); }}>
      <Summary p={proposal} />
      {similar.length ? (
        <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
          <p className="font-semibold">Possible duplicates (advisory)</p>
          <ul className="mt-1 space-y-1 text-xs">{similar.map((s) => <li key={s.test_id}>Similar existing test: <strong>{s.test_ref}</strong> — {s.scenario}</li>)}</ul>
          <p className="mt-1 text-xs">You decide: promote anyway, or reject this proposal as a duplicate of an existing test.</p>
        </div>
      ) : null}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Creates <strong>one</strong> canonical Test Case with the next project TST reference, status <strong>{PROMOTED_TEST_STATUS}</strong>, keeping these steps, preconditions, objective and type.</li>
        <li>Links it to <strong>{refs.join(", ")}</strong> on <strong>{requirementRef}</strong>. Their verification will count this test (as Pending until it is run), so a Verified criterion can move back to Testing.</li>
        <li>The test keeps the acceptance criteria exactly as approved; if one changes later the test is flagged as possibly stale — it is never rewritten.</li>
        {proposal.accepted_inferences.length ? <li>Shows {proposal.accepted_inferences.map((t) => `"${t}"`).join(", ")} as reviewer-accepted (Inferred).</li> : null}
        <li>Once promoted, the test cannot be deleted (its promotion history is preserved); change its status instead.</li>
      </ul>
      <SubmitRow busy={busy} label="Promote to Test Case" />
    </form>
  );
}

function ManualForm({ context, busy, onSave }: { context: TestDialogContext; busy: boolean; onSave: Submit }) {
  const [d, setD] = useState<Draft>(blankDraft());
  const [acIds, setAcIds] = useState<string[]>([]);
  const [rationale, setRationale] = useState("");
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ ...payloadOf(d), source_ac_ids: acIds, rationale: rationale || null }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">A human-authored test inside this generation run. It starts in Needs Review and must prove at least one of the run&apos;s acceptance criteria.</p>
      <TestFields value={d} onChange={setD} />
      <AcChoice acs={context.acs} chosen={acIds} onChange={setAcIds} />
      <Field label="Rationale (optional)"><Textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={2000} /></Field>
      <SubmitRow busy={busy} label="Add test" disabled={!draftValid(d) || !acIds.length} />
    </form>
  );
}

function IssueForm({ issue, status, busy, onSave }: { issue: TestGenerationIssue; status: "Open" | "Resolved" | "Accepted" | "Not Applicable"; busy: boolean; onSave: Submit }) {
  const [note, setNote] = useState(issue.resolution_note ?? "");
  const required = status === "Resolved" || status === "Not Applicable";
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ note: note || null }); }}>
      <div className="rounded-md border bg-card p-3 text-sm"><p className="font-semibold">{issue.issue_type}</p><p className="mt-1">{issue.description}</p></div>
      <p className="text-xs text-muted-foreground">
        {status === "Resolved" ? "Record how the gap was addressed (for example, the manual test that now covers it)." : status === "Not Applicable" ? "Record why this does not apply." : status === "Accepted" ? "Accept the gap knowingly; it stays visible in the review history." : "Return the issue to Open."} Test-design issues never change canonical tests.
      </p>
      <Field label={required ? "Resolution note (required)" : "Note (optional)"}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={required} /></Field>
      <SubmitRow busy={busy} label={status === "Open" ? "Reopen" : `Mark ${status}`} disabled={required && !note.trim()} />
    </form>
  );
}
