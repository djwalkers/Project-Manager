import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DataStore } from "@/lib/data-store";
import { buildAutomatedDailyBrief, buildAutomatedWeeklySummary, buildTestEmail, type EmailContent } from "@/lib/email-content";
import { getChangesSince } from "@/lib/audit";
import { selectCanonicalProjects } from "@/lib/project-scope";
import { schemaTables } from "@/lib/schema";
import { seedData } from "@/lib/seed-data";
import type { EmailActivity, EmailSettings } from "@/lib/types";

export type EmailKind = "Test" | "Daily Brief" | "Weekly Summary";
export type TriggerType = "Manual" | "Scheduled";
export type EmailRequestPayload = { data?: DataStore; recipient?: string; settings?: Partial<EmailSettings> };
export type EmailExecutionResult = { ok: boolean; skipped?: boolean; message: string; activity?: EmailActivity };

const defaultRecipient = "Andrew.Walker@bluestonex.com";
const settingsId = "99999999-9999-4999-8999-999999999999";
const projectTables = schemaTables.map((table) => table.name).filter((name) => !["email_settings", "email_activity_log"].includes(name));

function serverSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function londonDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function isScheduledLondonSlot(kind: Exclude<EmailKind, "Test">, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return hour === 7 && (kind === "Weekly Summary" ? weekday === "Mon" : ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday ?? ""));
}

export function isAuthorisedCron(authorization: string | null) {
  const secret = process.env.CRON_SECRET;
  return !secret || authorization === `Bearer ${secret}`;
}

async function loadSettings(client: SupabaseClient | null): Promise<EmailSettings> {
  if (client) {
    const { data, error } = await client.from("email_settings").select("*").eq("id", settingsId).maybeSingle();
    if (error) throw new Error(`Failed to load email settings: ${error.message}`);
    if (data) return data as EmailSettings;
  }
  return {
    id: settingsId,
    daily_brief_enabled: false,
    weekly_summary_enabled: false,
    recipient_email: process.env.DAILY_BRIEF_RECIPIENT || defaultRecipient,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function loadProjectData(client: SupabaseClient | null): Promise<DataStore> {
  if (!client) return structuredClone(seedData) as DataStore;
  const rows = await Promise.all(projectTables.map(async (table) => {
    const { data, error } = await client.from(table).select("*");
    if (error) throw new Error(`Failed to load ${table}: ${error.message}`);
    return [table, data ?? []] as const;
  }));
  return { ...structuredClone(seedData), ...Object.fromEntries(rows), email_settings: [], email_activity_log: [] } as DataStore;
}

async function alreadySentToday(client: SupabaseClient, kind: EmailKind, now: Date) {
  const { data, error } = await client.from("email_activity_log").select("sent_at").eq("email_type", kind).eq("success", true).eq("trigger_type", "Scheduled").order("sent_at", { ascending: false }).limit(10);
  if (error) throw new Error(`Failed to check email history: ${error.message}`);
  return (data ?? []).some((row) => londonDateKey(new Date(row.sent_at)) === londonDateKey(now));
}

async function logActivity(client: SupabaseClient | null, activity: EmailActivity) {
  if (!client) return activity;
  const { data, error } = await client.from("email_activity_log").insert({
    email_type: activity.email_type,
    recipient: activity.recipient,
    sent_at: activity.sent_at,
    success: activity.success,
    failure_reason: activity.failure_reason,
    duration_ms: activity.duration_ms,
    trigger_type: activity.trigger_type,
  }).select().single();
  if (error) return { ...activity, failure_reason: activity.failure_reason ? `${activity.failure_reason}; activity log failed: ${error.message}` : `Activity log failed: ${error.message}` };
  return data as EmailActivity;
}

async function sendWithResend(recipient: string, content: EmailContent) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  const from = process.env.RESEND_FROM_EMAIL || "Project Manager <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [recipient], subject: content.subject, html: content.html, text: content.text }),
  });
  const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
  if (!response.ok) throw new Error(result.message || `Resend returned HTTP ${response.status}.`);
  return result.id ?? "accepted";
}

export async function executeEmail(kind: EmailKind, trigger: TriggerType, payload: EmailRequestPayload = {}, now = new Date()): Promise<EmailExecutionResult> {
  const started = Date.now();
  const client = serverSupabase();
  let recipient = payload.recipient?.trim() || process.env.DAILY_BRIEF_RECIPIENT?.trim() || defaultRecipient;
  try {
    const stored = await loadSettings(client);
    recipient = payload.settings?.recipient_email?.trim() || stored.recipient_email?.trim() || recipient;
    const enabled = kind === "Daily Brief" ? (payload.settings?.daily_brief_enabled ?? stored.daily_brief_enabled) : (payload.settings?.weekly_summary_enabled ?? stored.weekly_summary_enabled);
    if (trigger === "Scheduled" && kind !== "Test" && !enabled) return { ok: true, skipped: true, message: `${kind} is disabled.` };
    if (trigger === "Scheduled" && !client) throw new Error("Supabase is required for scheduled email data and activity logging.");
    if (!recipient || !validEmail(recipient)) throw new Error("A valid recipient email is not configured.");
    recipient = recipient.toLowerCase();
    if (trigger === "Scheduled" && client && await alreadySentToday(client, kind, now)) return { ok: true, skipped: true, message: `${kind} was already sent today.` };
    const data = payload.data ?? await loadProjectData(client);
    const projectIds = selectCanonicalProjects(data).map((p) => p.id);
    const recentAuditChanges = kind === "Daily Brief" ? await getChangesSince(24, projectIds).catch(() => []) : [];
    const weeklyAuditChanges = kind === "Weekly Summary" ? await getChangesSince(168, projectIds).catch(() => []) : [];
    const content = kind === "Test" ? buildTestEmail(now) : kind === "Daily Brief" ? buildAutomatedDailyBrief(data, now, recentAuditChanges) : buildAutomatedWeeklySummary(data, now, weeklyAuditChanges);
    await sendWithResend(recipient, content);
    const sentAt = new Date().toISOString();
    const activity = await logActivity(client, { id: crypto.randomUUID(), email_type: kind, recipient, sent_at: sentAt, success: true, failure_reason: null, duration_ms: Date.now() - started, trigger_type: trigger, created_at: sentAt });
    return { ok: true, message: `${kind} sent to ${recipient}.`, activity };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown email delivery failure.";
    const sentAt = new Date().toISOString();
    const activity = await logActivity(client, { id: crypto.randomUUID(), email_type: kind, recipient, sent_at: sentAt, success: false, failure_reason: reason, duration_ms: Date.now() - started, trigger_type: trigger, created_at: sentAt });
    return { ok: false, message: reason, activity };
  }
}

export async function getEmailDeliveryHealth() {
  const client = serverSupabase();
  let settings: EmailSettings | null = null;
  let activity: EmailActivity[] = [];
  try {
    settings = await loadSettings(client);
    if (client) {
      const { data } = await client.from("email_activity_log").select("*").order("sent_at", { ascending: false }).limit(50);
      activity = (data ?? []) as EmailActivity[];
    }
  } catch {
    settings = null;
  }
  return {
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
    recipientConfigured: Boolean((settings?.recipient_email || process.env.DAILY_BRIEF_RECIPIENT)?.trim()),
    dailyBriefEnabled: settings?.daily_brief_enabled ?? false,
    weeklySummaryEnabled: settings?.weekly_summary_enabled ?? false,
    lastDailyBriefStatus: activity.find((item) => item.email_type === "Daily Brief") ?? null,
    lastWeeklySummaryStatus: activity.find((item) => item.email_type === "Weekly Summary") ?? null,
    lastEmailSentTimestamp: activity[0]?.sent_at ?? null,
  };
}
