"use client";

import { CheckCircle2, Code2, Eye, FileText, Loader2, Mail, Printer, Send, X, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DataStore } from "@/lib/data-store";
import { buildTestStatusEmail } from "@/lib/email-content";
import { MAX_RECIPIENT_INPUT_LENGTH, parseAndValidateRecipients } from "@/lib/email-recipients";
import { scopeProjectData } from "@/lib/project-scope";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { EmailActivity, EmailSettings, Project } from "@/lib/types";

type PreviewMode = "rendered" | "html" | "plain";

function TestStatusPreviewModal({
  data,
  project,
  defaultRecipient,
  onClose,
  onReload,
}: {
  data: DataStore;
  project: Project;
  /** email_settings.recipient_email, purely a convenience starting value — freely editable/replaceable, never re-persisted. */
  defaultRecipient: string;
  onClose: () => void;
  onReload?: () => void;
}) {
  const [mode, setMode] = useState<PreviewMode>("rendered");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  // One-off recipients for THIS manual send only — never written back to
  // email_settings, never persisted anywhere. Pre-populated from the
  // stored personal recipient purely as a convenience default; the user
  // may keep it, replace it, or add more (comma/semicolon separated).
  const [recipientInput, setRecipientInput] = useState(defaultRecipient);
  const validation = useMemo(() => parseAndValidateRecipients(recipientInput), [recipientInput]);

  // Built purely client-side from already-loaded data — the exact same
  // function the server calls at send time (lib/email-content.ts's
  // buildTestStatusEmail), so the preview can never drift from what
  // actually gets sent. Opening this modal never sends anything itself.
  // The preview is the email exactly as sent (no procedures appendix). The
  // Print / PDF view is the same builder and the same generation time with
  // includeProcedures: true — one canonical report, two render variants.
  const [generatedAt] = useState(() => new Date());
  const content = useMemo(() => buildTestStatusEmail(data, project, generatedAt), [data, project, generatedAt]);
  const printContent = useMemo(() => buildTestStatusEmail(data, project, generatedAt, { includeProcedures: true }), [data, project, generatedAt]);

  const tabs: { value: PreviewMode; label: string; icon: typeof Eye }[] = [
    { value: "rendered", label: "Rendered", icon: Eye },
    { value: "html", label: "HTML", icon: Code2 },
    { value: "plain", label: "Plain text", icon: FileText },
  ];

  // Opens the FULL report (main report + Detailed Test Procedures appendix)
  // as its own standalone page so it can be printed / saved as PDF without
  // any application chrome. Display only — sends nothing.
  function openPrintableReport() {
    const url = URL.createObjectURL(new Blob([printContent.html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function sendNow() {
    if (sending || !validation.ok) return; // double-send guard + never send with an unvalidated/invalid recipient list
    setSending(true);
    setSendResult(null);
    try {
      const response = await fetch("/api/email/test-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, project_id: project.id, recipients: validation.recipients }),
      });
      const result = await response.json() as { ok: boolean; message: string; activity?: EmailActivity };
      setSendResult({ ok: result.ok, text: result.message });
      if (!hasSupabaseConfig && result.activity) {
        import("@/lib/supabase/data-store").then(({ createRecord }) => {
          if (result.activity) createRecord("email_activity_log", result.activity).catch(() => undefined);
        });
        onReload?.();
      }
    } catch (error) {
      setSendResult({ ok: false, text: error instanceof Error ? error.message : "Send failed." });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="test-status-preview-title">
      <section className="flex max-h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-xl border bg-background shadow-2xl sm:rounded-xl">
        <div className="flex items-start justify-between gap-4 border-b p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-primary">Email preparation</p>
            <h2 id="test-status-preview-title" className="mt-1 text-xl font-semibold">Test Status Email Preview</h2>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              Project: <span className="font-medium text-foreground">{project.project_ref ?? project.name}</span>
            </p>
            <p className="mt-1 truncate text-sm text-muted-foreground">Subject: {content.subject}</p>

            <div className="mt-3">
              <label htmlFor="test-status-recipients" className="block text-xs font-semibold uppercase text-muted-foreground">
                Recipients
              </label>
              <Input
                id="test-status-recipients"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                maxLength={MAX_RECIPIENT_INPUT_LENGTH}
                placeholder="name@example.com, another@example.com"
                className="mt-1 max-w-md"
                aria-invalid={!validation.ok}
                aria-describedby="test-status-recipients-status"
              />
              <p id="test-status-recipients-status" className="mt-1 text-xs">
                {validation.ok
                  ? <span className="text-muted-foreground">Sending to: <span className="font-medium text-foreground">{validation.recipients.join(", ")}</span></span>
                  : <span className="font-medium text-red-600">{validation.error}</span>}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close email preview">
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 border-b p-3 sm:px-5" role="tablist" aria-label="Email preview format">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <Button key={tab.value} size="sm" variant={mode === tab.value ? "default" : "outline"} onClick={() => setMode(tab.value)} role="tab" aria-selected={mode === tab.value}>
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </Button>
            );
          })}
          <Button size="sm" variant="outline" className="ml-auto" onClick={openPrintableReport} title="Open the full report, including detailed test procedures, on its own page to print or save as PDF">
            <Printer className="h-4 w-4" aria-hidden="true" />
            Print / PDF
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3 sm:p-5">
          {mode === "rendered" ? (
            <iframe title="Rendered test status email" srcDoc={content.html} sandbox="" className="h-[620px] w-full rounded-md border bg-white" />
          ) : (
            <pre className="min-h-[520px] whitespace-pre-wrap break-words rounded-md border bg-card p-4 text-xs leading-6 text-foreground">{mode === "html" ? content.html : content.text}</pre>
          )}
        </div>

        {sendResult && (
          <div className={cn(
            "mx-4 mb-2 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm sm:mx-5",
            sendResult.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
          )}>
            {sendResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
            {sendResult.text}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t p-4 text-xs text-muted-foreground sm:px-5">
          <span>Nothing is sent until you click Send.</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button onClick={() => void sendNow()} disabled={sending || !validation.ok} className="gap-2">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function TestStatusEmailAction({
  data,
  project,
  onReload,
}: {
  data: DataStore;
  project: Project;
  onReload?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Project-scoped count only (no verification derivation needed here) —
  // reuses the same canonical scopeProjectData() every other consumer uses,
  // never a re-filter of the raw DataStore.
  const testCount = useMemo(() => scopeProjectData(data, project).test_cases.length, [data, project]);
  const stored = data.email_settings?.[0] as EmailSettings | undefined;
  // A convenience starting value only — the preview's Recipients field is
  // freely editable and this default is never re-read or re-persisted.
  const defaultRecipient = stored?.recipient_email?.trim() || "Andrew.Walker@bluestonex.com";

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={testCount === 0}
        title={testCount === 0 ? "No test cases recorded for this project yet." : undefined}
        className="gap-2"
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        Email Test Status
      </Button>
      {open && (
        <TestStatusPreviewModal
          data={data}
          project={project}
          defaultRecipient={defaultRecipient}
          onClose={() => setOpen(false)}
          onReload={onReload}
        />
      )}
    </>
  );
}
