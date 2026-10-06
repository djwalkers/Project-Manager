"use client";

import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { CRITERION_TYPES } from "@/lib/ac-generation";
import {
  AC_REJECTION_REASONS, PROMOTED_AC_STATUS, REASON_GUIDANCE, effectiveAc, reasonKind,
  type AcClarification, type ReviewedAcIssue, type ReviewedAcProposal,
} from "@/lib/ac-review";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";

// ── Phase 1F acceptance criteria review dialogs ─────────────────────────────
// One side panel per decision. Each states what the action does before the
// reviewer confirms it; the server (migration 046) re-checks every rule.

export type AcDialogState =
  | { kind: "edit"; proposal: ReviewedAcProposal }
  | { kind: "decide"; proposal: ReviewedAcProposal; action: "approve" | "needs_review" | "reject" | "reopen"; blockers: string[] }
  | { kind: "split"; proposal: ReviewedAcProposal }
  | { kind: "merge"; proposals: ReviewedAcProposal[] }
  | { kind: "promote"; proposal: ReviewedAcProposal; requirementRef: string; clarifications: number }
  | { kind: "bulk"; decision: "approve" | "reject"; proposals: ReviewedAcProposal[] }
  | { kind: "clarify"; proposal: ReviewedAcProposal; clarification: AcClarification | null }
  | { kind: "manual" }
  | { kind: "issue-review"; issue: ReviewedAcIssue; status: "Open" | "Resolved" | "Accepted" | "Not Applicable" }
  | { kind: "associate"; note: { id: string; sequence: number; area: string | null; description: string } }
  | { kind: "adopt"; olderCount: number };

type Submit = (payload: Record<string, unknown>) => Promise<void>;
export type AcDialogContext = {
  fragments: Map<string, AnalysisFragment>;
  /** Fragment ids the run was given (manual proposals may cite only these). */
  runFragmentIds: string[];
  /** Scope notes usable for this run's Requirement. */
  scopeNotes: { id: string; label: string; description: string }[];
  analysisIssues: { id: string; label: string; text: string }[];
  generationIssues: ReviewedAcIssue[];
  requirements: { id: string; requirement_ref: string | null; title: string }[];
};

const ACTION_LABEL = { approve: "Approve", needs_review: "Mark Needs Review", reject: "Reject", reopen: "Reopen" } as const;
const leaf = (f: AnalysisFragment) => (f.section_path.at(-1) ?? f.section_heading ?? "Document start");

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint ? <span className="block text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

type Wording = { criterion: string; description: string; criterion_type: string; given_text: string; when_text: string; then_text: string };
const wordingOf = (p: ReviewedAcProposal): Wording => {
  const e = effectiveAc(p);
  return { criterion: e.criterion, description: e.description ?? "", criterion_type: e.criterion_type, given_text: e.given_text ?? "", when_text: e.when_text ?? "", then_text: e.then_text ?? "" };
};
const payloadOf = (w: Wording) => ({
  criterion: w.criterion, description: w.description || null, criterion_type: w.criterion_type || null,
  given_text: w.given_text || null, when_text: w.when_text || null, then_text: w.then_text || null,
});

function WordingFields({ value, onChange, typeLocked }: { value: Wording; onChange: (w: Wording) => void; typeLocked?: boolean }) {
  const set = (patch: Partial<Wording>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3">
      <Field label="Acceptance criterion"><Textarea rows={3} value={value.criterion} onChange={(e) => set({ criterion: e.target.value })} maxLength={2000} required /></Field>
      <Field label="Type" hint={typeLocked ? "Merged criteria keep their shared type." : undefined}>
        <Select value={value.criterion_type} onChange={(e) => set({ criterion_type: e.target.value })} disabled={typeLocked}>
          {CRITERION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </Field>
      <div className="grid gap-3">
        <Field label="Given"><Input value={value.given_text} onChange={(e) => set({ given_text: e.target.value })} maxLength={1000} /></Field>
        <Field label="When"><Input value={value.when_text} onChange={(e) => set({ when_text: e.target.value })} maxLength={1000} /></Field>
        <Field label="Then"><Input value={value.then_text} onChange={(e) => set({ then_text: e.target.value })} maxLength={1000} /></Field>
      </div>
      <Field label="Description (optional)"><Textarea rows={2} value={value.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} /></Field>
    </div>
  );
}

export function AcReviewDialog({ state, context, onSubmit, onClose }: { state: AcDialogState; context: AcDialogContext; onSubmit: Submit; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await onSubmit(payload); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "The action failed."); } finally { setBusy(false); }
  };

  let title = "";
  let body: React.ReactNode = null;
  switch (state.kind) {
    case "edit": title = `Edit AC proposal #${state.proposal.sequence}`; body = <EditForm proposal={state.proposal} busy={busy} onSave={run} />; break;
    case "decide": title = `${ACTION_LABEL[state.action]} AC proposal #${state.proposal.sequence}`; body = <DecideForm proposal={state.proposal} action={state.action} blockers={state.blockers} busy={busy} onSave={run} />; break;
    case "split": title = `Split AC proposal #${state.proposal.sequence}`; body = <SplitForm proposal={state.proposal} fragments={context.fragments} busy={busy} onSave={run} />; break;
    case "merge": title = `Merge ${state.proposals.length} AC proposals`; body = <MergeForm proposals={state.proposals} busy={busy} onSave={run} />; break;
    case "promote": title = `Promote AC proposal #${state.proposal.sequence}`; body = <PromoteForm proposal={state.proposal} requirementRef={state.requirementRef} clarifications={state.clarifications} busy={busy} onSave={run} />; break;
    case "bulk": title = `${state.decision === "approve" ? "Approve" : "Reject"} ${state.proposals.length} AC proposals`; body = <BulkForm decision={state.decision} proposals={state.proposals} busy={busy} onSave={run} />; break;
    case "clarify": title = `${state.clarification ? "Revise" : "Add"} Human Clarification — #${state.proposal.sequence}`; body = <ClarifyForm proposal={state.proposal} clarification={state.clarification} context={context} busy={busy} onSave={run} />; break;
    case "manual": title = "Add a manual acceptance criterion"; body = <ManualForm context={context} busy={busy} onSave={run} />; break;
    case "issue-review": title = `${state.status === "Open" ? "Reopen" : `Mark ${state.status}`} — generation issue #${state.issue.sequence}`; body = <IssueForm issue={state.issue} status={state.status} busy={busy} onSave={run} />; break;
    case "associate": title = `Associate scope note N${state.note.sequence}`; body = <AssociateForm note={state.note} requirements={context.requirements} busy={busy} onSave={run} />; break;
    case "adopt": title = "Adopt this generation run"; body = <AdoptForm olderCount={state.olderCount} busy={busy} onSave={run} />; break;
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

function SubmitRow({ busy, label, disabled, destructive }: { busy: boolean; label: string; disabled?: boolean; destructive?: boolean }) {
  return (
    <div className="flex justify-end border-t pt-4">
      <Button type="submit" disabled={busy || disabled} variant={destructive ? "destructive" : "default"}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{label}
      </Button>
    </div>
  );
}

function Original({ p }: { p: ReviewedAcProposal }) {
  return (
    <details className="rounded-md border p-3 text-xs">
      <summary className="cursor-pointer font-medium">{p.origin === "ai" ? "AI original" : "Original wording"}</summary>
      <p className="mt-2 font-medium">{p.criterion}</p>
      <p className="mt-1 text-muted-foreground">{p.criterion_type}{p.given_text ? ` · Given ${p.given_text}` : ""}{p.when_text ? ` · When ${p.when_text}` : ""}{p.then_text ? ` · Then ${p.then_text}` : ""}</p>
    </details>
  );
}

function EditForm({ proposal, busy, onSave }: { proposal: ReviewedAcProposal; busy: boolean; onSave: Submit }) {
  const [w, setW] = useState(wordingOf(proposal));
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void onSave(payloadOf(w)); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        The original wording is kept unchanged as history; you are editing the reviewed version. Every change is audited.{proposal.review_status === "Approved" ? " Editing an approved proposal returns it to Needs Review." : ""}
      </p>
      {proposal.needs_review_reasons.length ? (
        <ul className="list-disc rounded-md border border-amber-300 bg-amber-50 p-3 pl-7 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          {proposal.needs_review_reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
      <WordingFields value={w} onChange={setW} />
      <Original p={proposal} />
      <SubmitRow busy={busy} label="Save reviewed version" disabled={!w.criterion.trim()} />
    </form>
  );
}

function DecideForm({ proposal, action, blockers, busy, onSave }: { proposal: ReviewedAcProposal; action: "approve" | "needs_review" | "reject" | "reopen"; blockers: string[]; busy: boolean; onSave: Submit }) {
  const [note, setNote] = useState(""), [reason, setReason] = useState(""), [confirm, setConfirm] = useState(false);
  const needsConfirm = action === "approve" && proposal.review_status === "Needs Review";
  // ac_approval_blockers was evaluated as if confirmed; anything listed must be fixed first.
  const blocked = action === "approve" && blockers.length > 0;
  const e = effectiveAc(proposal);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ note: note || null, reason: reason || null, confirm }); }}>
      <div className="rounded-md border bg-card p-3 text-sm">
        <p className="font-semibold">{e.criterion}</p>
        <p className="mt-1 text-xs text-muted-foreground">{e.criterion_type}{e.given_text ? ` · Given ${e.given_text}` : ""}{e.when_text ? ` · When ${e.when_text}` : ""}{e.then_text ? ` · Then ${e.then_text}` : ""}</p>
      </div>
      {blocked ? (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-semibold">This proposal cannot be approved yet:</p>
          <ul className="mt-1 list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      ) : null}
      {action === "approve" && proposal.needs_review_reasons.length ? (
        <ul className="space-y-1 text-xs">
          {proposal.needs_review_reasons.map((r) => <li key={r}><span className="font-medium">{r}</span><br /><span className="text-muted-foreground">{REASON_GUIDANCE[reasonKind(r)]}</span></li>)}
        </ul>
      ) : null}
      {action === "reject" ? (
        <Field label="Reason (recommended)" hint="Rejected proposals are kept in the review history and can be reopened.">
          <Select value={reason} onChange={(ev) => setReason(ev.target.value)}>
            <option value="">— choose a reason —</option>
            {AC_REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
      ) : null}
      {needsConfirm && !blocked ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <input type="checkbox" className="mt-1" checked={confirm} onChange={(ev) => setConfirm(ev.target.checked)} />
          <span>I have reviewed this criterion against its source and the reasons above, and confirm the wording is correct. (Recorded with my name.)</span>
        </label>
      ) : null}
      <Field label="Review note (optional)"><Textarea rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} /></Field>
      <SubmitRow busy={busy} label={ACTION_LABEL[action]} disabled={blocked || (needsConfirm && !confirm)} destructive={action === "reject"} />
    </form>
  );
}

type Child = Wording & { fragmentIds: string[] };

function SplitForm({ proposal, fragments, busy, onSave }: { proposal: ReviewedAcProposal; fragments: Map<string, AnalysisFragment>; busy: boolean; onSave: Submit }) {
  const base = wordingOf(proposal);
  const sources = proposal.source_fragment_ids.map((id) => fragments.get(id)).filter((f): f is AnalysisFragment => Boolean(f));
  const blank = (): Child => ({ ...base, fragmentIds: [...proposal.source_fragment_ids] });
  const [children, setChildren] = useState<Child[]>([blank(), blank()]);
  const update = (i: number, patch: Partial<Child>) => setChildren((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const valid = children.length >= 2 && children.every((c) => c.criterion.trim() && c.fragmentIds.length);
  return (
    <form className="space-y-4" onSubmit={(ev) => {
      ev.preventDefault();
      void onSave({ children: children.map((c) => ({ ...payloadOf(c), source_fragment_ids: c.fragmentIds, scope_note_ids: proposal.scope_note_ids, clarification_issue_ids: proposal.clarification_issue_ids, open_issue_ids: proposal.open_issue_ids })) });
    }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        The original becomes <strong>Superseded</strong> (kept in history). Each new criterion belongs to the same Requirement, starts in Needs Review, keeps the original&apos;s review reasons and must cite at least one of its source fragments. Split one testable behaviour per criterion — for example, one per application.
      </p>
      {children.map((c, i) => (
        <fieldset key={i} className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold">Criterion {i + 1}</legend>
            {children.length > 2 ? <Button type="button" variant="ghost" size="icon" aria-label={`Remove criterion ${i + 1}`} onClick={() => setChildren((cs) => cs.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button> : null}
          </div>
          <WordingFields value={c} onChange={(w) => update(i, w)} />
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Source fragments</p>
            {sources.map((f) => (
              <label key={f.id} className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={c.fragmentIds.includes(f.id)}
                  onChange={(ev) => update(i, { fragmentIds: ev.target.checked ? [...c.fragmentIds, f.id] : c.fragmentIds.filter((x) => x !== f.id) })} />
                <span><span className="font-medium">F{f.sequence} · {leaf(f)}</span> <span className="text-muted-foreground">— {f.text.slice(0, 110)}{f.text.length > 110 ? "…" : ""}</span></span>
              </label>
            ))}
            {!c.fragmentIds.length ? <p className="mt-1 text-xs text-destructive">Select at least one source fragment — a criterion cannot lose its provenance.</p> : null}
          </div>
        </fieldset>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setChildren((cs) => [...cs, blank()])} disabled={children.length >= 20}>
        <Plus className="h-4 w-4" aria-hidden="true" />Add criterion
      </Button>
      <Original p={proposal} />
      <SubmitRow busy={busy} label={`Split into ${children.length}`} disabled={!valid} />
    </form>
  );
}

function MergeForm({ proposals, busy, onSave }: { proposals: ReviewedAcProposal[]; busy: boolean; onSave: Submit }) {
  const first = wordingOf(proposals[0]);
  const types = new Set(proposals.map((p) => effectiveAc(p).criterion_type));
  const [w, setW] = useState<Wording>({ ...first, criterion: proposals.map((p) => effectiveAc(p).criterion).join(" ") });
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ proposal_ids: proposals.map((x) => x.id), ...payloadOf(w) }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        Merging {proposals.map((x) => `#${x.sequence}`).join(", ")}: the new criterion cites every source of every member and starts in Needs Review; the members become Superseded (kept in history). The wording starts with every member&apos;s text — keep every condition you merge.
      </p>
      {types.size > 1 ? <p role="alert" className="text-sm font-medium text-destructive">These proposals have different types ({[...types].join(", ")}); merging them would lose meaning. Merge only criteria of the same type.</p> : null}
      <WordingFields value={w} onChange={setW} typeLocked />
      <SubmitRow busy={busy} label="Merge" disabled={!w.criterion.trim() || types.size > 1} />
    </form>
  );
}

function PromoteForm({ proposal, requirementRef, clarifications, busy, onSave }: { proposal: ReviewedAcProposal; requirementRef: string; clarifications: number; busy: boolean; onSave: Submit }) {
  const e = effectiveAc(proposal);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({}); }}>
      <div className="rounded-md border bg-card p-3 text-sm">
        <p className="font-semibold">{e.criterion}</p>
        {e.given_text || e.when_text || e.then_text ? <p className="mt-1 text-xs text-muted-foreground">Given {e.given_text ?? "—"} · When {e.when_text ?? "—"} · Then {e.then_text ?? "—"}</p> : null}
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Creates <strong>one</strong> canonical Acceptance Criterion on <strong>{requirementRef}</strong> with the next project AC reference (assigned on promotion).</li>
        <li>Status <strong>{PROMOTED_AC_STATUS}</strong>, type <strong>{e.criterion_type}</strong> — it is not Met; no evidence or sign-off is created.</li>
        <li>The AC keeps its link to this proposal, the generation run and the Requirement&apos;s source document{clarifications ? `, and records that it relies on ${clarifications} Human Clarification${clarifications === 1 ? "" : "s"}` : ""}.</li>
        <li>Once promoted, the AC cannot be deleted (its promotion history is preserved); change its status instead.</li>
      </ul>
      <SubmitRow busy={busy} label="Promote to Acceptance Criterion" />
    </form>
  );
}

function BulkForm({ decision, proposals, busy, onSave }: { decision: "approve" | "reject"; proposals: ReviewedAcProposal[]; busy: boolean; onSave: Submit }) {
  const [reason, setReason] = useState(""), [note, setNote] = useState(""), [confirmed, setConfirmed] = useState(false);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ decision, proposal_ids: proposals.map((p) => p.id), reason: reason || null, note: note || null }); }}>
      <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
        {proposals.map((p) => <li key={p.id}>#{p.sequence} {effectiveAc(p).criterion}</li>)}
      </ul>
      {decision === "approve" ? <p className="text-xs text-muted-foreground">Bulk approval applies only to <strong>Proposed</strong> criteria. Criteria that need review must be approved individually.</p> : null}
      {decision === "reject" ? (
        <Field label="Reason (recommended)">
          <Select value={reason} onChange={(ev) => setReason(ev.target.value)}>
            <option value="">— choose a reason —</option>
            {AC_REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field label="Review note (optional)"><Textarea rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} /></Field>
      <p className="text-xs text-muted-foreground">Bulk actions never promote. Promotion is done one proposal at a time.</p>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={confirmed} onChange={(ev) => setConfirmed(ev.target.checked)} />
        {decision === "approve" ? "Approve" : "Reject"} these {proposals.length} proposals
      </label>
      <SubmitRow busy={busy} label={`${decision === "approve" ? "Approve" : "Reject"} ${proposals.length}`} disabled={!confirmed} destructive={decision === "reject"} />
    </form>
  );
}

function ClarifyForm({ proposal, clarification, context, busy, onSave }: { proposal: ReviewedAcProposal; clarification: AcClarification | null; context: AcDialogContext; busy: boolean; onSave: Submit }) {
  const [textValue, setText] = useState(clarification?.clarification ?? "");
  const [reason, setReason] = useState(clarification?.reason ?? proposal.needs_review_reasons.find((r) => ["clarify", "correct"].includes(reasonKind(r))) ?? "");
  const [analysisIssue, setAnalysisIssue] = useState(clarification?.analysis_issue_id ?? "");
  const [generationIssue, setGenerationIssue] = useState(clarification?.generation_issue_id ?? "");
  return (
    <form className="space-y-4" onSubmit={(ev) => {
      ev.preventDefault();
      void onSave({ proposal_id: proposal.id, clarification_id: clarification?.id ?? null, clarification: textValue, reason: reason || null, analysis_issue_id: analysisIssue || null, generation_issue_id: generationIssue || null });
    }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        A Human Clarification records a fact the source does not state precisely (for example, what &quot;load correctly&quot; means). It is kept with your name and time, and the promoted Acceptance Criterion records that it relies on it.{proposal.review_status === "Approved" ? " Changing a clarification on an approved proposal returns it to Needs Review." : ""}
      </p>
      <div className="rounded-md border bg-card p-3 text-sm font-medium">{effectiveAc(proposal).criterion}</div>
      <Field label="Clarification"><Textarea rows={4} value={textValue} onChange={(ev) => setText(ev.target.value)} maxLength={2000} required /></Field>
      <Field label="Reason (optional)" hint="Usually the review reason this clarification resolves."><Input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={1000} /></Field>
      {context.analysisIssues.length ? (
        <Field label="Related analysis question (optional)">
          <Select value={analysisIssue} onChange={(ev) => setAnalysisIssue(ev.target.value)}>
            <option value="">— none —</option>
            {context.analysisIssues.map((i) => <option key={i.id} value={i.id}>{i.label} — {i.text.slice(0, 90)}</option>)}
          </Select>
        </Field>
      ) : null}
      {context.generationIssues.length ? (
        <Field label="Related generation issue (optional)">
          <Select value={generationIssue} onChange={(ev) => setGenerationIssue(ev.target.value)}>
            <option value="">— none —</option>
            {context.generationIssues.map((i) => <option key={i.id} value={i.id}>#{i.sequence} {i.issue_type} — {i.description.slice(0, 80)}</option>)}
          </Select>
        </Field>
      ) : null}
      <SubmitRow busy={busy} label={clarification ? "Save clarification" : "Add clarification"} disabled={!textValue.trim()} />
    </form>
  );
}

function ManualForm({ context, busy, onSave }: { context: AcDialogContext; busy: boolean; onSave: Submit }) {
  const [w, setW] = useState<Wording>({ criterion: "", description: "", criterion_type: "Positive", given_text: "", when_text: "", then_text: "" });
  const [rationale, setRationale] = useState("");
  const [fragmentIds, setFragmentIds] = useState<string[]>([]), [noteIds, setNoteIds] = useState<string[]>([]);
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ ...payloadOf(w), rationale: rationale || null, source_fragment_ids: fragmentIds, scope_note_ids: noteIds }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        Adds a human-authored criterion to this run for the same Requirement. It must cite at least one source the run was given, starts in Needs Review and gets an AC reference only when promoted.
      </p>
      <WordingFields value={w} onChange={setW} />
      <Field label="Rationale (optional)"><Textarea rows={2} value={rationale} onChange={(ev) => setRationale(ev.target.value)} maxLength={2000} /></Field>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Source fragments</p>
        {context.runFragmentIds.map((id) => context.fragments.get(id)).filter((f): f is AnalysisFragment => Boolean(f)).map((f) => (
          <label key={f.id} className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={fragmentIds.includes(f.id)} onChange={(ev) => setFragmentIds((l) => toggle(l, f.id, ev.target.checked))} />
            <span><span className="font-medium">F{f.sequence} · {leaf(f)}</span> <span className="text-muted-foreground">— {f.text.slice(0, 110)}{f.text.length > 110 ? "…" : ""}</span></span>
          </label>
        ))}
      </div>
      {context.scopeNotes.length ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Scope / regression notes (for Regression criteria)</p>
          {context.scopeNotes.map((n) => (
            <label key={n.id} className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={noteIds.includes(n.id)} onChange={(ev) => setNoteIds((l) => toggle(l, n.id, ev.target.checked))} />
              <span><span className="font-medium">{n.label}</span> {n.description}</span>
            </label>
          ))}
        </div>
      ) : null}
      {!fragmentIds.length ? <p className="text-xs text-destructive">Select at least one source fragment.</p> : null}
      <SubmitRow busy={busy} label="Add criterion" disabled={!w.criterion.trim() || !fragmentIds.length} />
    </form>
  );
}

function IssueForm({ issue, status, busy, onSave }: { issue: ReviewedAcIssue; status: "Open" | "Resolved" | "Accepted" | "Not Applicable"; busy: boolean; onSave: Submit }) {
  const [note, setNote] = useState("");
  const required = status === "Resolved" || status === "Not Applicable";
  const hint = status === "Resolved" ? "Record the answer — it is kept with your name and time."
    : status === "Not Applicable" ? "Explain why the question does not apply."
      : status === "Accepted" ? "Accepting keeps the question open as known additional coverage; it does not resolve a blocking question." : undefined;
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ status, note: note || null }); }}>
      <div className="rounded-md border bg-card p-3 text-sm">
        <p className="font-medium">{issue.issue_type}{issue.relation ? ` · ${issue.relation}` : ""}</p>
        <p className="mt-1">{issue.description}</p>
        {issue.suggested_question ? <p className="mt-1 text-xs">Question: {issue.suggested_question}</p> : null}
      </div>
      <Field label={status === "Resolved" ? "Resolution" : "Reviewer note"} hint={hint}><Textarea rows={4} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} /></Field>
      <SubmitRow busy={busy} label={status === "Open" ? "Reopen" : `Mark ${status}`} disabled={required && !note.trim()} />
    </form>
  );
}

function AssociateForm({ note, requirements, busy, onSave }: { note: { id: string; sequence: number; area: string | null; description: string }; requirements: AcDialogContext["requirements"]; busy: boolean; onSave: Submit }) {
  const [req, setReq] = useState(""), [comment, setComment] = useState("");
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ requirement_id: req, note: comment || null }); }}>
      <div className="rounded-md border bg-card p-3 text-sm"><p className="font-medium">{note.area ?? "Change-level"}</p><p className="mt-1">{note.description}</p></div>
      <p className="text-xs text-muted-foreground">Associating makes this scope / regression note available to that Requirement&apos;s future Regression acceptance criteria generation. It never becomes a Requirement. Unassociated notes stay change-level.</p>
      <Field label="Requirement">
        <Select value={req} onChange={(ev) => setReq(ev.target.value)} required>
          <option value="">— choose a Requirement —</option>
          {requirements.map((r) => <option key={r.id} value={r.id}>{r.requirement_ref ?? "—"} {r.title}</option>)}
        </Select>
      </Field>
      <Field label="Note (optional)"><Input value={comment} onChange={(ev) => setComment(ev.target.value)} maxLength={1000} /></Field>
      <SubmitRow busy={busy} label="Associate" disabled={!req} />
    </form>
  );
}

function AdoptForm({ olderCount, busy, onSave }: { olderCount: number; busy: boolean; onSave: Submit }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({}); }}>
      <p className="text-sm">Adopting this run marks the <strong>{olderCount}</strong> unpromoted open proposal{olderCount === 1 ? "" : "s"} of older runs for this Requirement as <strong>Superseded</strong>. Promoted proposals and their Acceptance Criteria are never affected. Older runs stay readable in history.</p>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={confirmed} onChange={(ev) => setConfirmed(ev.target.checked)} />Supersede the older proposals</label>
      <SubmitRow busy={busy} label="Adopt this run" disabled={!confirmed} />
    </form>
  );
}
