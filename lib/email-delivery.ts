import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DataStore } from "@/lib/data-store";
import { buildAutomatedDailyBrief, buildAutomatedWeeklySummary, buildManagerSummaryEmail, buildTestEmail, type EmailContent } from "@/lib/email-content";
import { getChangesSince } from "@/lib/audit";
import { selectCanonicalProjects } from "@/lib/project-scope";
import { schemaTables } from "@/lib/schema";
import { seedData } from "@/lib/seed-data";
import type { EmailActivity, EmailSettings } from "@/lib/types";

export type EmailKind = "Test" | "Daily Brief" | "Weekly Summary" | "Manager Summary";
export type TriggerType = "Manual" | "Scheduled";
export type EmailRequestPayload = { data?: DataStore; recipient?: string; settings?: Partial<EmailSettings> };
export type EmailStatus = "sent" | "skipped_disabled" | "skipped_duplicate" | "skipped_no_recipient" | "auth_error" | "config_error" | "send_error";
export type EmailExecutionResult = { ok: boolean; skipped?: boolean; status: EmailStatus; message: string; activity?: EmailActivity };

const defaultRecipient = "Andrew.Walker@bluestonex.com";
const settingsId = "99999999-9999-4999-8999-999999999999";
const projectTables = schemaTables.map((table) => table.name).filter((name) => !["email_settings", "email_activity_log"].includes(name));

function serverSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Prefer service role key — bypasses RLS so server-side reads always succeed.
  // Falls back to anon key + anon-read RLS policies (migration 014).
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const usingServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`[email] serverSupabase — using ${usingServiceRole ? "service role key" : "anon key"}`);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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
  if (kind === "Manager Summary") return hour === 16 && weekday === "Fri";
  if (kind === "Weekly Summary") return hour === 7 && weekday === "Mon";
  return hour === 7 && ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday ?? "");
}

// Accepts any of:
//   1. x-vercel-cron: 1  — Vercel injects this on every cron invocation (scheduled + Run button)
//   2. Authorization: Bearer <CRON_SECRET>
//   3. ?secret=<CRON_SECRET>  — query param fallback for local/curl testing
export function isAuthorisedCron(
  authHeader: string | null,
  xVercelCron: string | null,
  querySecret?: string | null,
): boolean {
  // Vercel cron header is present on all legitimate Vercel cron invocations
  if (xVercelCron === "1") {
    console.log("[cron-auth] Accepted via x-vercel-cron header");
    return true;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.log("[cron-auth] No CRON_SECRET configured — allowing request");
    return true;
  }
  if (authHeader === `Bearer ${secret}`) {
    console.log("[cron-auth] Accepted via Authorization Bearer token");
    return true;
  }
  if (querySecret === secret) {
    console.log("[cron-auth] Accepted via ?secret query param");
    return true;
  }
  console.log("[cron-auth] Rejected — no valid auth method matched");
  return false;
}

async function loadSettings(client: SupabaseClient | null): Promise<EmailSettings> {
  if (client) {
    const { data, error } = await client.from("email_settings").select("*").eq("id", settingsId).maybeSingle();
    if (error) {
      console.error(`[email] loadSettings — Supabase error: ${error.message} (code=${error.code})`);
      throw new Error(`Failed to load email settings: ${error.message}`);
    }
    if (data) {
      console.log(`[email] loadSettings — raw row: daily_brief_enabled=${data.daily_brief_enabled} weekly_summary_enabled=${data.weekly_summary_enabled} manager_summary_enabled=${data.manager_summary_enabled} recipient="${data.recipient_email}"`);
      return data as EmailSettings;
    }
    // data is null — RLS blocked the query or no row with this ID exists
    console.warn(`[email] loadSettings — query returned null (no error). Likely cause: RLS policy blocked the anon client (run migration 014) or the settings row does not exist. Falling back to env/defaults.`);
  }
  const fallback: EmailSettings = {
    id: settingsId,
    daily_brief_enabled: false,
    weekly_summary_enabled: false,
    manager_summary_enabled: false,
    recipient_email: process.env.DAILY_BRIEF_RECIPIENT || defaultRecipient,
    manager_recipient_email: process.env.MANAGER_BRIEF_RECIPIENT || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  console.log(`[email] loadSettings — using fallback defaults: daily_brief_enabled=${fallback.daily_brief_enabled} recipient="${fallback.recipient_email}"`);
  return fallback;
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

  console.log(`[email] ${kind} invoked — trigger=${trigger}`);

  const skip = async (emailStatus: EmailStatus, message: string): Promise<EmailExecutionResult> => {
    console.log(`[email] ${kind} skipped — status=${emailStatus} message="${message}"`);
    const sentAt = new Date().toISOString();
    const activity = await logActivity(client, {
      id: crypto.randomUUID(), email_type: kind, recipient, sent_at: sentAt,
      success: false, failure_reason: message,
      duration_ms: Date.now() - started, trigger_type: trigger, created_at: sentAt,
    });
    return { ok: true, skipped: true, status: emailStatus, message, activity };
  };

  try {
    console.log(`[email] ${kind} — loading settings`);
    const stored = await loadSettings(client);
    console.log(`[email] ${kind} — settings loaded, daily_brief_enabled=${stored.daily_brief_enabled} recipient="${stored.recipient_email}"`);

    if (kind === "Manager Summary") {
      const managerRecipient = payload.settings?.manager_recipient_email?.trim() || stored.manager_recipient_email?.trim();
      recipient = managerRecipient || payload.settings?.recipient_email?.trim() || stored.recipient_email?.trim() || recipient;
    } else {
      recipient = payload.settings?.recipient_email?.trim() || stored.recipient_email?.trim() || recipient;
    }
    console.log(`[email] ${kind} — resolved recipient="${recipient}"`);

    if (!recipient || !validEmail(recipient)) {
      return await skip("skipped_no_recipient", "A valid recipient email is not configured.");
    }
    recipient = recipient.toLowerCase();

    const enabled = kind === "Daily Brief"
      ? (payload.settings?.daily_brief_enabled ?? stored.daily_brief_enabled)
      : kind === "Manager Summary"
        ? (payload.settings?.manager_summary_enabled ?? stored.manager_summary_enabled)
        : (payload.settings?.weekly_summary_enabled ?? stored.weekly_summary_enabled);
    console.log(`[email] ${kind} — enabled=${enabled} trigger=${trigger}`);

    if (trigger === "Scheduled" && kind !== "Test" && !enabled) {
      return await skip("skipped_disabled", `${kind} is disabled in email settings.`);
    }

    if (trigger === "Scheduled" && !client) {
      return await skip("config_error", "Supabase is required for scheduled email data and activity logging.");
    }

    if (trigger === "Scheduled" && client) {
      const duplicate = await alreadySentToday(client, kind, now);
      console.log(`[email] ${kind} — duplicate check result: alreadySentToday=${duplicate}`);
      if (duplicate) {
        return await skip("skipped_duplicate", `${kind} was already sent today.`);
      }
    }

    console.log(`[email] ${kind} — loading project data`);
    const data = payload.data ?? await loadProjectData(client);
    const projectIds = selectCanonicalProjects(data).map((p) => p.id);
    console.log(`[email] ${kind} — projectIds=${JSON.stringify(projectIds)}`);

    const recentAuditChanges = kind === "Daily Brief" ? await getChangesSince(24, projectIds).catch(() => []) : [];
    const weeklyAuditChanges = kind === "Weekly Summary" ? await getChangesSince(168, projectIds).catch(() => []) : [];

    const content =
      kind === "Test" ? buildTestEmail(now)
      : kind === "Daily Brief" ? buildAutomatedDailyBrief(data, now, recentAuditChanges)
      : kind === "Manager Summary" ? buildManagerSummaryEmail(data, now)
      : buildAutomatedWeeklySummary(data, now, weeklyAuditChanges);

    console.log(`[email] ${kind} — built content, subject="${content.subject}", sending via Resend`);
    await sendWithResend(recipient, content);

    const sentAt = new Date().toISOString();
    console.log(`[email] ${kind} — sent successfully to ${recipient}, logging activity`);
    const activity = await logActivity(client, {
      id: crypto.randomUUID(), email_type: kind, recipient, sent_at: sentAt,
      success: true, failure_reason: null,
      duration_ms: Date.now() - started, trigger_type: trigger, created_at: sentAt,
    });
    console.log(`[email] ${kind} — activity log result: ${activity.id ? "saved" : "failed"}`);
    return { ok: true, status: "sent", message: `${kind} sent to ${recipient}.`, activity };

  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown email delivery failure.";
    const emailStatus: EmailStatus = reason.includes("RESEND_API_KEY") ? "config_error" : "send_error";
    console.error(`[email] ${kind} — ERROR status=${emailStatus}:`, reason);
    const sentAt = new Date().toISOString();
    const activity = await logActivity(client, {
      id: crypto.randomUUID(), email_type: kind, recipient, sent_at: sentAt,
      success: false, failure_reason: reason,
      duration_ms: Date.now() - started, trigger_type: trigger, created_at: sentAt,
    });
    return { ok: false, status: emailStatus, message: reason, activity };
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
    managerSummaryEnabled: settings?.manager_summary_enabled ?? false,
    lastDailyBriefStatus: activity.find((item) => item.email_type === "Daily Brief") ?? null,
    lastWeeklySummaryStatus: activity.find((item) => item.email_type === "Weekly Summary") ?? null,
    lastManagerSummaryStatus: activity.find((item) => item.email_type === "Manager Summary") ?? null,
    lastEmailSentTimestamp: activity[0]?.sent_at ?? null,
  };
}
