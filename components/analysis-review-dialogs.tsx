"use client";

import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PROPOSAL_CATEGORIES, PROPOSAL_PRIORITIES, type AnalysisScopeNote } from "@/lib/requirement-analysis";
import type { AnalysisFragment } from "@/lib/requirement-analysis-client";
import {
  ISSUE_TARGETS, PROMOTED_REQUIREMENT_STATUS, REJECTION_REASONS, effectiveProposal,
  type IssueTarget, type ReviewedIssue, type ReviewedProposal,
} from "@/lib/requirement-review";

// ── Phase 1D review dialogs ─────────────────────────────────────────────────
// One side panel per decision. Each states what the action does before the
// reviewer confirms it; the server (migration 040) re-checks every rule.

export type ReviewDialogState =
  | { kind: "edit"; proposal: ReviewedProposal }
  | { kind: "decide"; proposal: ReviewedProposal; action: "approve" | "needs_review" | "reject" | "reopen" }
  | { kind: "split"; proposal: ReviewedProposal }
  | { kind: "merge"; proposals: ReviewedProposal[] }
  | { kind: "promote"; proposal: ReviewedProposal }
  | { kind: "bulk"; decision: "approve" | "reject"; proposals: ReviewedProposal[] }
  | { kind: "issue-review"; issue: ReviewedIssue; status: "Resolved" | "Accepted" | "Not Applicable" | "Open" }
  | { kind: "issue-promote"; issue: ReviewedIssue }
  | { kind: "scope-ack"; note: AnalysisScopeNote };

type Submit = (payload: Record<string, unknown>) => Promise<void>;

const ACTION_LABEL = { approve: "Approve", needs_review: "Mark Needs Review", reject: "Reject", reopen: "Reopen" } as const;
const leaf = (f: AnalysisFragment) => (f.section_path.at(-1) ?? f.section_heading ?? "Document start");
/** Suggested (never automatic) target for an issue type. */
export function suggestedTarget(issueType: string): IssueTarget {
  if (issueType === "Assumption Required") return "decisions";
  return "discovery_questions";
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint ? <span className="block text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function CategoryPriority({ category, priority, onCategory, onPriority }: { category: string; priority: string; onCategory: (v: string) => void; onPriority: (v: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Category">
        <Select value={category} onChange={(e) => onCategory(e.target.value)}>
          <option value="">— not set —</option>
          {PROPOSAL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
      <Field label="Priority">
        <Select value={priority} onChange={(e) => onPriority(e.target.value)}>
          <option value="">— not set —</option>
          {PROPOSAL_PRIORITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
    </div>
  );
}

export function ReviewDialog({ state, fragments, onSubmit, onClose }: {
  state: ReviewDialogState;
  fragments: Map<string, AnalysisFragment>;
  onSubmit: Submit;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await onSubmit(payload); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "The action failed."); } finally { setBusy(false); }
  };

  let title = "";
  let body: React.ReactNode = null;
  switch (state.kind) {
    case "edit": title = `Edit proposal #${state.proposal.sequence}`; body = <EditForm proposal={state.proposal} busy={busy} onSave={run} />; break;
    case "decide": title = `${ACTION_LABEL[state.action]} proposal #${state.proposal.sequence}`; body = <DecideForm proposal={state.proposal} action={state.action} busy={busy} onSave={run} />; break;
    case "split": title = `Split proposal #${state.proposal.sequence}`; body = <SplitForm proposal={state.proposal} fragments={fragments} busy={busy} onSave={run} />; break;
    case "merge": title = `Merge ${state.proposals.length} proposals`; body = <MergeForm proposals={state.proposals} busy={busy} onSave={run} />; break;
    case "promote": title = `Promote proposal #${state.proposal.sequence}`; body = <PromoteForm proposal={state.proposal} busy={busy} onSave={run} />; break;
    case "bulk": title = `${state.decision === "approve" ? "Approve" : "Reject"} ${state.proposals.length} proposals`; body = <BulkForm decision={state.decision} proposals={state.proposals} busy={busy} onSave={run} />; break;
    case "issue-review": title = `${state.status === "Open" ? "Reopen" : `Mark ${state.status}`} — issue #${state.issue.sequence}`; body = <NoteForm label={state.status === "Resolved" ? "Resolution" : "Reviewer note"} busy={busy} submit={state.status === "Open" ? "Reopen" : `Mark ${state.status}`} onSave={(note) => run({ note })} />; break;
    case "issue-promote": title = `Promote issue #${state.issue.sequence}`; body = <IssuePromoteForm issue={state.issue} busy={busy} onSave={run} />; break;
    case "scope-ack": title = `Acknowledge scope note #${state.note.sequence}`; body = <NoteForm label="Note (optional)" busy={busy} submit="Acknowledge" hint="Acknowledging records that the scope/regression statement was reviewed. It never becomes a Requirement." onSave={(note) => run({ note })} />; break;
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

function EditForm({ proposal, busy, onSave }: { proposal: ReviewedProposal; busy: boolean; onSave: Submit }) {
  const e = effectiveProposal(proposal);
  const [t, setT] = useState(e.title), [d, setD] = useState(e.description), [c, setC] = useState(e.category ?? ""), [p, setP] = useState(e.priority ?? "");
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ title: t, description: d, category: c || null, priority: p || null }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">The AI&apos;s original text is kept unchanged as history; you are editing the reviewed version.{proposal.review_status === "Approved" ? " Editing an approved proposal returns it to Needs Review." : ""}</p>
      <Field label="Title"><Input value={t} onChange={(ev) => setT(ev.target.value)} maxLength={300} required /></Field>
      <Field label="Description"><Textarea rows={6} value={d} onChange={(ev) => setD(ev.target.value)} maxLength={4000} required /></Field>
      <CategoryPriority category={c} priority={p} onCategory={setC} onPriority={setP} />
      <details className="rounded-md border p-3 text-xs">
        <summary className="cursor-pointer font-medium">AI original</summary>
        <p className="mt-2 font-medium">{proposal.proposed_title}</p>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{proposal.proposed_description}</p>
        <p className="mt-1 text-muted-foreground">Category {proposal.proposed_category ?? "—"} · Priority {proposal.proposed_priority ?? "—"}</p>
      </details>
      <SubmitRow busy={busy} label="Save reviewed version" disabled={!t.trim() || !d.trim()} />
    </form>
  );
}

function DecideForm({ proposal, action, busy, onSave }: { proposal: ReviewedProposal; action: "approve" | "needs_review" | "reject" | "reopen"; busy: boolean; onSave: Submit }) {
  const [note, setNote] = useState(""), [reason, setReason] = useState<string>(""), [ack, setAck] = useState(false);
  const needsAck = action === "approve" && proposal.evidence_basis === "Inferred" && !proposal.inferred_acknowledged_at;
  const e = effectiveProposal(proposal);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ note: note || null, reason: reason || null, acknowledge_inferred: ack }); }}>
      <div className="rounded-md border bg-card p-3 text-sm"><p className="font-semibold">{e.title}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{e.description}</p></div>
      {action === "reject" ? (
        <Field label="Reason (recommended)" hint="Rejected proposals are kept in the analysis history.">
          <Select value={reason} onChange={(ev) => setReason(ev.target.value)}>
            <option value="">— choose a reason —</option>
            {REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
      ) : null}
      {needsAck ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <input type="checkbox" className="mt-1" checked={ack} onChange={(ev) => setAck(ev.target.checked)} />
          <span>This proposal is <strong>Inferred</strong> — the source does not state it directly. I confirm this interpretation is intended. (Recorded with my name.)</span>
        </label>
      ) : null}
      <Field label="Review note (optional)"><Textarea rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} /></Field>
      <SubmitRow busy={busy} label={ACTION_LABEL[action]} disabled={needsAck && !ack} destructive={action === "reject"} />
    </form>
  );
}

type Child = { title: string; description: string; category: string; priority: string; fragmentIds: string[] };

function SplitForm({ proposal, fragments, busy, onSave }: { proposal: ReviewedProposal; fragments: Map<string, AnalysisFragment>; busy: boolean; onSave: Submit }) {
  const e = effectiveProposal(proposal);
  const baseText = e.description.split(/\n\n(Applies to|Stated in):/)[0];
  const sources = proposal.source_fragment_ids.map((id) => fragments.get(id)).filter((f): f is AnalysisFragment => Boolean(f));
  // Default: one child per source fragment (e.g. one per application section), which the reviewer adjusts.
  const initial: Child[] = (sources.length >= 2 ? sources : [sources[0], sources[0]].filter(Boolean)).map((f) => ({
    title: `${e.title} — ${leaf(f)}`.slice(0, 300), description: `${leaf(f)}: ${baseText}`.slice(0, 4000),
    category: e.category ?? "", priority: e.priority ?? "", fragmentIds: [f.id],
  }));
  const [children, setChildren] = useState<Child[]>(initial.length >= 2 ? initial : [
    { title: e.title, description: baseText, category: e.category ?? "", priority: e.priority ?? "", fragmentIds: [...proposal.source_fragment_ids] },
    { title: e.title, description: baseText, category: e.category ?? "", priority: e.priority ?? "", fragmentIds: [...proposal.source_fragment_ids] },
  ]);
  const update = (i: number, patch: Partial<Child>) => setChildren((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const valid = children.length >= 2 && children.every((c) => c.title.trim() && c.description.trim() && c.fragmentIds.length);
  return (
    <form className="space-y-4" onSubmit={(ev) => {
      ev.preventDefault();
      void onSave({ children: children.map((c) => ({ title: c.title, description: c.description, category: c.category || null, priority: c.priority || null, source_fragment_ids: c.fragmentIds })) });
    }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        The original becomes <strong>Superseded</strong> (kept in history). Each child is a human-created derivative that starts in Needs Review and must cite at least one of the original&apos;s source fragments.
      </p>
      {children.map((c, i) => (
        <fieldset key={i} className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold">Child {i + 1}</legend>
            {children.length > 2 ? <Button type="button" variant="ghost" size="icon" aria-label={`Remove child ${i + 1}`} onClick={() => setChildren((cs) => cs.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button> : null}
          </div>
          <Field label="Title"><Input value={c.title} onChange={(ev) => update(i, { title: ev.target.value })} maxLength={300} /></Field>
          <Field label="Description"><Textarea rows={3} value={c.description} onChange={(ev) => update(i, { description: ev.target.value })} maxLength={4000} /></Field>
          <CategoryPriority category={c.category} priority={c.priority} onCategory={(v) => update(i, { category: v })} onPriority={(v) => update(i, { priority: v })} />
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Source fragments</p>
            {sources.map((f) => (
              <label key={f.id} className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={c.fragmentIds.includes(f.id)}
                  onChange={(ev) => update(i, { fragmentIds: ev.target.checked ? [...c.fragmentIds, f.id] : c.fragmentIds.filter((x) => x !== f.id) })} />
                <span><span className="font-medium">F{f.sequence} · {leaf(f)}</span> <span className="text-muted-foreground">— {f.text.slice(0, 110)}{f.text.length > 110 ? "…" : ""}</span></span>
              </label>
            ))}
            {!c.fragmentIds.length ? <p className="mt-1 text-xs text-destructive">Select at least one source fragment — a proposal cannot lose its provenance.</p> : null}
          </div>
        </fieldset>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setChildren((cs) => [...cs, { title: e.title, description: baseText, category: e.category ?? "", priority: e.priority ?? "", fragmentIds: [] }])} disabled={children.length >= 20}>
        <Plus className="h-4 w-4" aria-hidden="true" />Add child
      </Button>
      <SubmitRow busy={busy} label={`Split into ${children.length}`} disabled={!valid} />
    </form>
  );
}

function MergeForm({ proposals, busy, onSave }: { proposals: ReviewedProposal[]; busy: boolean; onSave: Submit }) {
  const first = effectiveProposal(proposals[0]);
  const [t, setT] = useState(first.title);
  const [d, setD] = useState(proposals.map((p) => `- ${effectiveProposal(p).description}`).join("\n"));
  const [c, setC] = useState(first.category ?? ""), [p, setP] = useState(first.priority ?? "");
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ proposal_ids: proposals.map((x) => x.id), title: t, description: d, category: c || null, priority: p || null }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
        Merging {proposals.map((x) => `#${x.sequence}`).join(", ")}: the new proposal cites every source fragment of every member and starts in Needs Review; the members become Superseded (kept in history). The description starts with every member&apos;s text — keep every obligation you merge.
      </p>
      <Field label="Title"><Input value={t} onChange={(ev) => setT(ev.target.value)} maxLength={300} /></Field>
      <Field label="Description"><Textarea rows={8} value={d} onChange={(ev) => setD(ev.target.value)} maxLength={4000} /></Field>
      <CategoryPriority category={c} priority={p} onCategory={setC} onPriority={setP} />
      <SubmitRow busy={busy} label="Merge" disabled={!t.trim() || !d.trim()} />
    </form>
  );
}

function PromoteForm({ proposal, busy, onSave }: { proposal: ReviewedProposal; busy: boolean; onSave: Submit }) {
  const e = effectiveProposal(proposal);
  const [c, setC] = useState(e.category ?? ""), [p, setP] = useState(e.priority ?? "");
  const missing = !e.category || !e.priority;
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ category: c || null, priority: p || null, needs_edit: missing }); }}>
      <div className="rounded-md border bg-card p-3 text-sm">
        <p className="font-semibold">{e.title}</p>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{e.description}</p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Creates <strong>one</strong> canonical Requirement with the next project reference (assigned on promotion).</li>
        <li>Status <strong>{PROMOTED_REQUIREMENT_STATUS}</strong> — not approved or signed off; no owner is set.</li>
        <li>The Requirement keeps its link to this proposal and its source fragments, section and pages.</li>
      </ul>
      {missing ? (
        <>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Choose the category and priority — they are not set automatically.</p>
          <CategoryPriority category={c} priority={p} onCategory={setC} onPriority={setP} />
        </>
      ) : <p className="text-sm">Category <strong>{e.category}</strong> · Priority <strong>{e.priority}</strong></p>}
      <SubmitRow busy={busy} label="Promote to Requirement" disabled={!c || !p} />
    </form>
  );
}

function BulkForm({ decision, proposals, busy, onSave }: { decision: "approve" | "reject"; proposals: ReviewedProposal[]; busy: boolean; onSave: Submit }) {
  const inferred = proposals.filter((p) => p.evidence_basis === "Inferred" && !p.inferred_acknowledged_at);
  const [ack, setAck] = useState(false), [reason, setReason] = useState(""), [note, setNote] = useState(""), [confirmed, setConfirmed] = useState(false);
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ decision, proposal_ids: proposals.map((p) => p.id), confirmed_count: proposals.length, acknowledge_inferred: ack, reason: reason || null, note: note || null }); }}>
      <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
        {proposals.map((p) => <li key={p.id}>#{p.sequence} {effectiveProposal(p).title}{p.evidence_basis === "Inferred" ? " (Inferred)" : ""}</li>)}
      </ul>
      {decision === "approve" && inferred.length ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <input type="checkbox" className="mt-1" checked={ack} onChange={(ev) => setAck(ev.target.checked)} />
          <span>{inferred.length} of these are <strong>Inferred</strong>. Tick to confirm each inferred interpretation is intended; otherwise they are skipped and stay unapproved.</span>
        </label>
      ) : null}
      {decision === "reject" ? (
        <Field label="Reason (recommended)">
          <Select value={reason} onChange={(ev) => setReason(ev.target.value)}>
            <option value="">— choose a reason —</option>
            {REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
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

function NoteForm({ label, submit, hint, busy, onSave }: { label: string; submit: string; hint?: string; busy: boolean; onSave: (note: string | null) => Promise<void> }) {
  const [note, setNote] = useState("");
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave(note || null); }}>
      <Field label={label} hint={hint}><Textarea rows={4} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} /></Field>
      <SubmitRow busy={busy} label={submit} />
    </form>
  );
}

function IssuePromoteForm({ issue, busy, onSave }: { issue: ReviewedIssue; busy: boolean; onSave: Submit }) {
  const [target, setTarget] = useState<IssueTarget>(suggestedTarget(issue.issue_type));
  const defaultText = (t: IssueTarget) => (t === "risks" ? issue.description : issue.suggested_question ?? issue.description);
  const [textValue, setText] = useState(defaultText(target));
  const [category, setCategory] = useState(""), [impact, setImpact] = useState(issue.severity === "High" ? "High" : issue.severity === "Low" ? "Low" : "Medium"), [probability, setProbability] = useState("");
  const discoveryCategories = ["Business Rule", "Replenishment Logic", "Database", "Performance", "Testing", "UI"];
  return (
    <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void onSave({ target, fields: { text: textValue, category: category || null, impact, probability } }); }}>
      <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">Creates one record in the chosen module with the next reference, status Open and no owner, linked back to this issue (and to any Requirement its proposals were promoted into). An issue can be promoted once.</p>
      <Field label="Create as" hint="A suggestion based on the issue type — you choose.">
        <Select value={target} onChange={(ev) => { const t = ev.target.value as IssueTarget; setTarget(t); setText(defaultText(t)); }}>
          {ISSUE_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
      </Field>
      <Field label={target === "actions" || target === "risks" ? "Description" : "Question"}><Textarea rows={4} value={textValue} onChange={(ev) => setText(ev.target.value)} maxLength={4000} /></Field>
      {target === "discovery_questions" ? (
        <Field label="Category (optional)"><Select value={category} onChange={(ev) => setCategory(ev.target.value)}><option value="">— default —</option>{discoveryCategories.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
      ) : null}
      {target === "risks" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Impact"><Select value={impact} onChange={(ev) => setImpact(ev.target.value)}>{["Low", "Medium", "High", "Critical"].map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
          <Field label="Probability"><Select value={probability} onChange={(ev) => setProbability(ev.target.value)}><option value="">— choose —</option>{["Low", "Medium", "High"].map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
        </div>
      ) : null}
      <SubmitRow busy={busy} label={`Create ${ISSUE_TARGETS.find((t) => t.value === target)?.label}`} disabled={!textValue.trim() || (target === "risks" && !probability)} />
    </form>
  );
}
