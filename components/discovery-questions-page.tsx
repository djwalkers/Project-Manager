"use client";

import { Mail, Send, X } from "lucide-react";
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

function buildEmailBody(questions: DiscoveryQuestion[], projectName: string): string {
  const lines = questions
    .map((q, i) => `${i + 1}. [${q.question_ref}] ${q.question}`)
    .join("\n\n");
  return `Hi,\n\nCould you please clarify the following questions relating to the ${projectName} Replenishment workstream.\n\n${lines}\n\nMany thanks,\nAndy`;
}

function buildHtmlBody(plainText: string): string {
  return `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1a1a1a; line-height: 1.6;">${
    plainText
      .split("\n\n")
      .map((para) =>
        para.startsWith("1.") || /^\d+\./.test(para)
          ? `<p style="margin: 8px 0;">${para.replace(/\n/g, "<br/>")}</p>`
          : `<p style="margin: 8px 0;">${para}</p>`,
      )
      .join("")
  }</div>`;
}

// ── Email modal ───────────────────────────────────────────────────────────────

function EmailModal({
  questions,
  projectName,
  onClose,
  onSent,
}: {
  questions: DiscoveryQuestion[];
  projectName: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(`${projectName} - Replenishment Queries`);
  const [body, setBody] = useState(() => buildEmailBody(questions, projectName));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!to.trim()) { setError("Please enter at least one recipient email address."); return; }
    setSending(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch("/api/microsoft/send-queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body: buildHtmlBody(body),
          to: to.split(",").map((s) => s.trim()).filter(Boolean),
          cc: cc ? cc.split(",").map((s) => s.trim()).filter(Boolean) : [],
          questionIds: questions.map((q) => q.id),
          projectName,
        }),
      });
      const result = await res.json() as { ok: boolean; message?: string; warning?: string };
      if (!result.ok) { setError(result.message ?? "Failed to send email."); return; }
      if (result.warning) setWarning(result.warning);
      onSent();
      if (!result.warning) onClose();
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Microsoft 365 / Outlook</p>
            <h2 className="text-lg font-semibold">Email Selected Queries</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>

        <form className="max-h-[80vh] overflow-y-auto p-5 space-y-4" onSubmit={send}>
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
          {warning && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{warning}</div>}

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
            <span className="text-xs font-normal text-muted-foreground">Edit the body before sending. Sent via your connected Microsoft 365 account.</span>
          </label>

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={sending}>Cancel</Button>
            <Button type="submit" disabled={sending}>
              <Send className="h-4 w-4" aria-hidden="true" />
              {sending ? "Sending…" : "Send via Outlook"}
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

  async function logActivityAfterSend() {
    if (!activeProject) return;
    try {
      const activity = await createRecord("activity_log", {
        project_id: activeProject.id,
        activity_type: "Queries emailed",
        description: `${selectedQuestions.length} discovery question${selectedQuestions.length !== 1 ? "s" : ""} sent by email.`,
      });
      setData((current) =>
        current ? { ...current, activity_log: [activity, ...current.activity_log] } : current,
      );
    } catch { /* non-fatal */ }
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
          <p className="text-sm font-semibold">Email queries via Microsoft 365</p>
          <p className="text-xs text-muted-foreground">Select one or more questions, then click <strong>Email Selected Queries</strong>. Emails are sent from your connected Outlook account. Replies come back to your Bluestonex mailbox.</p>
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
          onSent={() => { void logActivityAfterSend(); setSelectedQuestions([]); }}
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
    </AppShell>
  );
}
