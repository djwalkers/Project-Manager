"use client";

import { AlertCircle, CheckCircle2, Clock3, Mail, RefreshCw, Save, Send, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createRecord, hasSupabaseConfig, saveRecord } from "@/lib/supabase/data-store";
import type { DataStore } from "@/lib/data-store";
import type { EmailActivity, EmailSettings } from "@/lib/types";
import { useProjectData } from "@/lib/use-project-data";

const fallbackSettings: Omit<EmailSettings, "id" | "created_at" | "updated_at"> = {
  daily_brief_enabled: false,
  weekly_summary_enabled: false,
  recipient_email: "Andrew.Walker@bluestonex.com",
};

type SendResult = { ok: boolean; message: string; activity?: EmailActivity };

function SettingToggle({ id, title, description, checked, onChange }: { id: string; title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex min-h-20 cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/25 p-4 transition-colors hover:bg-muted/45">
      <span><span className="block text-sm font-semibold">{title}</span><span className="mt-1 block text-sm text-muted-foreground">{description}</span></span>
      <span className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-muted-foreground/35 transition-colors has-[:checked]:bg-primary">
        <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" />
        <span className="ml-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value));
}

export function EmailSettingsPage() {
  const { data, error, reload } = useProjectData();
  const stored = data?.email_settings[0];
  const [form, setForm] = useState(fallbackSettings);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (stored) setForm({ daily_brief_enabled: stored.daily_brief_enabled, weekly_summary_enabled: stored.weekly_summary_enabled, recipient_email: stored.recipient_email });
  }, [stored]);

  const activity = useMemo(() => [...(data?.email_activity_log ?? [])].sort((a, b) => b.sent_at.localeCompare(a.sent_at)), [data]);

  async function saveSettings() {
    if (!form.recipient_email.trim()) return setNotice({ ok: false, text: "Enter a recipient email before saving." });
    setBusy("save");
    setNotice(null);
    try {
      await saveRecord("email_settings", { ...form, id: stored?.id });
      setNotice({ ok: true, text: "Email settings saved." });
      reload();
    } catch (saveError) {
      setNotice({ ok: false, text: saveError instanceof Error ? saveError.message : "Email settings could not be saved." });
    } finally {
      setBusy(null);
    }
  }

  async function send(path: string, label: string) {
    if (!data) return;
    setBusy(path);
    setNotice(null);
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: data as DataStore, recipient: form.recipient_email, settings: form }) });
      const result = await response.json() as SendResult;
      if (!hasSupabaseConfig && result.activity) {
        await createRecord("email_activity_log", {
          email_type: result.activity.email_type,
          recipient: result.activity.recipient,
          sent_at: result.activity.sent_at,
          success: result.activity.success,
          failure_reason: result.activity.failure_reason,
          duration_ms: result.activity.duration_ms,
          trigger_type: result.activity.trigger_type,
        });
      }
      setNotice({ ok: result.ok, text: result.message || `${label} request completed.` });
      reload();
    } catch (sendError) {
      setNotice({ ok: false, text: sendError instanceof Error ? sendError.message : `${label} could not be sent.` });
    } finally {
      setBusy(null);
    }
  }

  if (!data && !error) return <AppShell><LoadingState /></AppShell>;
  if (!data) return <AppShell><LoadErrorState detail="Failed to load email settings." onRetry={reload} /></AppShell>;

  return (
    <AppShell>
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div><p className="text-sm font-medium text-primary">Automated delivery</p><h2 className="mt-1 text-2xl font-semibold">Email Settings</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Control scheduled management emails, run manual sends, and review every delivery attempt.</p></div>
        <Button onClick={saveSettings} disabled={Boolean(busy)}><Save className="h-4 w-4" aria-hidden="true" />{busy === "save" ? "Saving…" : "Save settings"}</Button>
      </div>

      {notice ? <div role="status" aria-live="polite" className={`mt-5 flex items-start gap-3 rounded-lg border p-4 text-sm ${notice.ok ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100" : "border-destructive/40 bg-destructive/5 text-destructive"}`}>{notice.ok ? <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" /> : <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />}<span>{notice.text}</span></div> : null}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
        <section className="rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="delivery-preferences-title">
          <div className="flex items-center gap-3"><span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary"><Mail className="h-5 w-5" aria-hidden="true" /></span><div><h3 id="delivery-preferences-title" className="font-semibold">Delivery Preferences</h3><p className="text-sm text-muted-foreground">Schedules run at 07:00 Europe/London.</p></div></div>
          <div className="mt-5 space-y-3">
            <SettingToggle id="daily-brief-enabled" title="Enable Daily Brief" description="Send Monday to Friday at 07:00." checked={form.daily_brief_enabled} onChange={(value) => setForm((current) => ({ ...current, daily_brief_enabled: value }))} />
            <SettingToggle id="weekly-summary-enabled" title="Enable Weekly Summary" description="Send every Monday at 07:00." checked={form.weekly_summary_enabled} onChange={(value) => setForm((current) => ({ ...current, weekly_summary_enabled: value }))} />
          </div>
          <div className="mt-5"><label htmlFor="recipient-email" className="text-sm font-medium">Recipient email</label><Input id="recipient-email" type="email" autoComplete="email" className="mt-2" value={form.recipient_email} onChange={(event) => setForm((current) => ({ ...current, recipient_email: event.target.value }))} /><p className="mt-2 text-xs text-muted-foreground">Used by test, manual, and scheduled delivery.</p></div>
        </section>

        <section className="rounded-lg border bg-card p-5 shadow-operational" aria-labelledby="manual-delivery-title">
          <div className="flex items-center gap-3"><span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary"><Send className="h-5 w-5" aria-hidden="true" /></span><div><h3 id="manual-delivery-title" className="font-semibold">Manual Delivery</h3><p className="text-sm text-muted-foreground">Manual sends ignore schedule toggles.</p></div></div>
          <div className="mt-5 grid gap-3">
            <Button variant="outline" className="min-h-11 justify-start" disabled={Boolean(busy)} onClick={() => send("/api/email/test", "Test email")}><Mail className="h-4 w-4" aria-hidden="true" />{busy === "/api/email/test" ? "Sending test…" : "Send Test Email"}</Button>
            <Button variant="outline" className="min-h-11 justify-start" disabled={Boolean(busy)} onClick={() => send("/api/email/daily-brief", "Daily Brief")}><Send className="h-4 w-4" aria-hidden="true" />{busy === "/api/email/daily-brief" ? "Sending Daily Brief…" : "Send Daily Brief Now"}</Button>
            <Button variant="outline" className="min-h-11 justify-start" disabled={Boolean(busy)} onClick={() => send("/api/email/weekly-summary", "Weekly Summary")}><Send className="h-4 w-4" aria-hidden="true" />{busy === "/api/email/weekly-summary" ? "Sending Weekly Summary…" : "Send Weekly Summary Now"}</Button>
          </div>
          <div className="mt-5 rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">The Resend API key remains server-side. A missing key or recipient produces a visible, logged failure without interrupting the app.</div>
        </section>
      </div>

      <section className="mt-5 overflow-hidden rounded-lg border bg-card shadow-operational" aria-labelledby="email-activity-title">
        <div className="flex items-center justify-between gap-3 border-b p-4"><div><h3 id="email-activity-title" className="font-semibold">Email Activity Log</h3><p className="mt-1 text-sm text-muted-foreground">Latest delivery attempts across manual and scheduled triggers.</p></div><Button variant="ghost" size="icon" onClick={reload} aria-label="Refresh email activity"><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm"><thead className="bg-muted/70 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-4 py-3">Email Type</th><th className="px-4 py-3">Recipient</th><th className="px-4 py-3">Sent</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Duration</th><th className="px-4 py-3">Trigger</th><th className="px-4 py-3">Failure Reason</th></tr></thead>
            <tbody>{activity.slice(0, 50).map((item) => <tr key={item.id} className="border-t"><td className="px-4 py-3 font-medium">{item.email_type}</td><td className="px-4 py-3">{item.recipient}</td><td className="px-4 py-3 tabular-nums">{formatTimestamp(item.sent_at)}</td><td className="px-4 py-3"><span className={`inline-flex items-center gap-1.5 font-medium ${item.success ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>{item.success ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <XCircle className="h-4 w-4" aria-hidden="true" />}{item.success ? "Sent" : "Failed"}</span></td><td className="px-4 py-3 tabular-nums">{item.duration_ms} ms</td><td className="px-4 py-3"><span className="inline-flex items-center gap-1.5"><Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{item.trigger_type}</span></td><td className="max-w-sm px-4 py-3 text-muted-foreground">{item.failure_reason ?? "—"}</td></tr>)}</tbody>
          </table>
        </div>
        {!activity.length ? <div className="border-t border-dashed p-8 text-center text-sm text-muted-foreground">No email attempts have been recorded yet.</div> : null}
      </section>
    </AppShell>
  );
}
