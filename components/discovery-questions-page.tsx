"use client";

import { ExternalLink, Mail, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { loadSelectedProjectId } from "@/lib/project-selection";
import { selectProjectById } from "@/lib/project-scope";
import { moduleByKey } from "@/lib/modules";
import { createRecord, saveRecord } from "@/lib/supabase/data-store";
import type { DiscoveryQuestion } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";

type Row = Record<string, unknown>;

function toQuestion(row: Row): DiscoveryQuestion {
  return row as unknown as DiscoveryQuestion;
}

function buildEmailBody(questions: DiscoveryQuestion[]): string {
  const lines = questions
    .map((q, i) => `${i + 1}.\n${q.question}`)
    .join("\n\n");
  return `Hi,\n\nAs I'm getting up to speed with the current Replenishment solution before implementing the Delivery Date Range enhancement, I'd really appreciate your help with a few questions.\n\nCould you please clarify the following:\n\n${lines}\n\nMany thanks,\nAndy`;
}

function buildOutlookUrl(to: string, cc: string, subject: string, body: string): string {
  // Use encodeURIComponent (RFC 3986 percent-encoding) so spaces become %20, not +.
  // URLSearchParams uses application/x-www-form-urlencoded which encodes spaces as +,
  // causing Outlook Web to display literal '+' characters.
  const parts: string[] = [];
  if (to) parts.push(`to=${encodeURIComponent(to)}`);
  if (cc) parts.push(`cc=${encodeURIComponent(cc)}`);
  parts.push(`subject=${encodeURIComponent(subject)}`);
  parts.push(`body=${encodeURIComponent(body)}`);
  return `https://outlook.office.com/mail/deeplink/compose?${parts.join("&")}`;
}

// ── Confirm raised dialog ─────────────────────────────────────────────────────

function ConfirmRaisedDialog({
  count,
  recipients,
  onConfirm,
  onSkip,
}: {
  count: number;
  recipients: string;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-2xl">
        <h2 className="text-base font-semibold">Mark questions as raised?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Update {count} question{count !== 1 ? "s" : ""} to <strong>Awaiting Response</strong> and record that they were raised to <strong>{recipients || "the recipients"}</strong>?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onSkip}>Skip</Button>
          <Button onClick={onConfirm}>Mark as Raised</Button>
        </div>
      </div>
    </div>
  );
}

// ── Email modal ───────────────────────────────────────────────────────────────

function EmailModal({
  questions,
  projectName,
  onClose,
  onOpened,
}: {
  questions: DiscoveryQuestion[];
  projectName: string;
  onClose: () => void;
  onOpened: (to: string, cc: string) => void;
}) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(`${projectName} - Replenishment Queries`);
  const [body, setBody] = useState(() => buildEmailBody(questions));
  const [error, setError] = useState<string | null>(null);

  function openInOutlook(event: React.FormEvent) {
    event.preventDefault();
    if (!to.trim()) { setError("Please enter at least one recipient email address."); return; }
    const url = buildOutlookUrl(to.trim(), cc.trim(), subject, body);
    window.open(url, "_blank", "noopener,noreferrer");
    onOpened(to.trim(), cc.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Outlook Compose</p>
            <h2 className="text-lg font-semibold">Email Selected Queries</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>

        <form className="max-h-[80vh] overflow-y-auto p-5 space-y-4" onSubmit={openInOutlook}>
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{questions.length} question{questions.length !== 1 ? "s" : ""} selected</p>
            <ul className="mt-2 space-y-1">
              {questions.map((q) => (
                <li key={q.id} className="text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">{q.question_ref}</span> — {q.question.length > 80 ? `${q.question.slice(0, 80)}…` : q.question}
                </li>
              ))}
            </ul>
          </div>

          <label className="block space-y-2 text-sm font-medium">
            <span>To <span className="text-destructive">*</span></span>
            <Input
              type="text"
              placeholder="email@example.com, another@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
            <span className="text-xs font-normal text-muted-foreground">Separate multiple addresses with commas</span>
          </label>

          <label className="block space-y-2 text-sm font-medium">
            <span>CC</span>
            <Input
              type="text"
              placeholder="cc@example.com"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          </label>

          <label className="block space-y-2 text-sm font-medium">
            <span>Subject <span className="text-destructive">*</span></span>
            <Input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
            />
          </label>

          <label className="block space-y-2 text-sm font-medium">
            <span>Email body</span>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-56 font-mono text-xs"
            />
            <span className="text-xs font-normal text-muted-foreground">Edit before opening. Outlook will open a compose window — you send it manually from your own mailbox.</span>
          </label>

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open in Outlook
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function DiscoveryQuestionsPage() {
  const { data, setData, error, reload } = useProjectData();
  const { user } = useAuth();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedQuestions, setSelectedQuestions] = useState<DiscoveryQuestion[]>([]);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [confirmRaised, setConfirmRaised] = useState<{ to: string; cc: string } | null>(null);

  const config = moduleByKey.get("discovery_questions")!;
  const activeProject = data ? selectProjectById(data, selectedProjectId) : null;

  useEffect(() => {
    setSelectedProjectId(loadSelectedProjectId());
  }, []);

  const defaultValues = useMemo(
    () => (user?.fullName ? { owner: user.fullName } : undefined),
    [user],
  );

  async function persistRecord(record: Row) {
    const saved = await saveRecord("discovery_questions", {
      ...record,
      project_id: record.project_id ?? activeProject?.id,
    });
    setData((current) => {
      if (!current) return current;
      const rows = current.discovery_questions as DiscoveryQuestion[];
      const savedQ = saved as DiscoveryQuestion;
      const exists = rows.some((r) => r.id === savedQ.id);
      return {
        ...current,
        discovery_questions: exists
          ? rows.map((r) => (r.id === savedQ.id ? savedQ : r))
          : [savedQ, ...rows],
      };
    });
    return saved as Row;
  }

  async function removeRecord(record: Row) {
    const { deleteRecord } = await import("@/lib/supabase/data-store");
    if (!record.id) throw new Error("Cannot delete a record without an ID");
    await deleteRecord("discovery_questions", String(record.id));
    setData((current) =>
      current
        ? { ...current, discovery_questions: current.discovery_questions.filter((r) => r.id !== record.id) }
        : current,
    );
  }

  function handleOpened(to: string, cc: string) {
    setEmailModalOpen(false);
    setConfirmRaised({ to, cc });
  }

  async function markAsRaised(to: string, cc: string) {
    setConfirmRaised(null);
    const now = new Date().toISOString();
    const recipients = [to, cc].filter(Boolean).join(", ");
    const noteAppend = `Raised by Outlook email to ${recipients} on ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(now))}.`;

    const updated: DiscoveryQuestion[] = [];
    for (const q of selectedQuestions) {
      try {
        const saved = await saveRecord("discovery_questions", {
          ...q,
          status: "Awaiting Response",
          raised_to: to,
          raised_date: now,
          notes: q.notes ? `${q.notes}\n${noteAppend}` : noteAppend,
        });
        updated.push(saved as DiscoveryQuestion);
      } catch { /* non-fatal — continue with remaining */ }
    }

    if (updated.length > 0) {
      setData((current) => {
        if (!current) return current;
        const updatedIds = new Map(updated.map((q) => [q.id, q]));
        return {
          ...current,
          discovery_questions: current.discovery_questions.map((q) => updatedIds.get(q.id) ?? q),
        };
      });
    }

    // Audit log + activity
    if (activeProject) {
      try {
        const activity = await createRecord("activity_log", {
          project_id: activeProject.id,
          activity_type: "Queries raised",
          description: `${selectedQuestions.length} discovery question${selectedQuestions.length !== 1 ? "s" : ""} prepared for Outlook email to ${recipients}.`,
        });
        setData((current) =>
          current ? { ...current, activity_log: [activity, ...current.activity_log] } : current,
        );
      } catch { /* non-fatal */ }
    }

    setSelectedQuestions([]);
    reload();
  }

  function skipRaised() {
    setConfirmRaised(null);
    setSelectedQuestions([]);
    reload();
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">{activeProject?.name ?? "Project"}</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal">{config.title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{config.description}</p>
        </div>
        <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
          {data.discovery_questions.length} total records
        </p>
      </div>

      <div className="mb-4 flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <Mail className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Email queries via Outlook</p>
          <p className="text-xs text-muted-foreground">Select one or more questions, click <strong>Email Selected</strong>, then send from your own Outlook. No Microsoft account connection required.</p>
        </div>
        {selectedQuestions.length > 0 && (
          <Button onClick={() => setEmailModalOpen(true)}>
            <Mail className="h-4 w-4" aria-hidden="true" />
            Email Selected ({selectedQuestions.length})
          </Button>
        )}
      </div>

      <DataTable
        config={config}
        data={data}
        onSaveRecord={persistRecord}
        onDeleteRecord={removeRecord}
        defaultValues={defaultValues}
        selectable
        onSelectionChange={(rows) => setSelectedQuestions(rows.map(toQuestion))}
        selectionActions={
          <Button variant="default" onClick={() => setEmailModalOpen(true)}>
            <Mail className="h-4 w-4" aria-hidden="true" />
            Email Selected ({selectedQuestions.length})
          </Button>
        }
      />

      {emailModalOpen && activeProject && (
        <EmailModal
          questions={selectedQuestions}
          projectName={activeProject.name}
          onClose={() => setEmailModalOpen(false)}
          onOpened={handleOpened}
        />
      )}

      {emailModalOpen && !activeProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="rounded-xl border bg-background p-6 shadow-xl">
            <p className="text-sm font-medium">No project selected. Please select a project first.</p>
            <Button className="mt-4" onClick={() => setEmailModalOpen(false)}>Close</Button>
          </div>
        </div>
      )}

      {confirmRaised && (
        <ConfirmRaisedDialog
          count={selectedQuestions.length}
          recipients={[confirmRaised.to, confirmRaised.cc].filter(Boolean).join(", ")}
          onConfirm={() => void markAsRaised(confirmRaised.to, confirmRaised.cc)}
          onSkip={skipRaised}
        />
      )}
    </AppShell>
  );
}
