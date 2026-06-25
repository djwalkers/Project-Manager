import { NextResponse } from "next/server";
import { sendMailViaGraph, isMicrosoftConfigured } from "@/lib/microsoft-graph";
import { isAuthorizedRequest, getAuthenticatedUser } from "@/lib/api-auth";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { createClient } from "@/lib/supabase/server";

type SendQueriesPayload = {
  subject: string;
  body: string;         // HTML body, user-edited
  to: string[];         // email addresses
  cc?: string[];
  questionIds: string[];
  projectName?: string;
};

function parseEmails(raw: string[]): Array<{ address: string }> {
  return raw.flatMap((s) => s.split(",").map((e) => e.trim()).filter(Boolean)).map((address) => ({ address }));
}

function isoNow() {
  return new Date().toISOString();
}

export async function POST(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  if (!isMicrosoftConfigured()) {
    return NextResponse.json({ ok: false, message: "Microsoft 365 environment variables are not configured. Add MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI and MICROSOFT_TOKEN_SECRET to your environment." }, { status: 503 });
  }

  const payload = await request.json().catch(() => null) as SendQueriesPayload | null;
  if (!payload?.subject || !payload.body || !payload.to?.length || !payload.questionIds?.length) {
    return NextResponse.json({ ok: false, message: "Missing required fields: subject, body, to, questionIds." }, { status: 400 });
  }

  const to = parseEmails(payload.to);
  const cc = parseEmails(payload.cc ?? []);

  // Send via Graph
  const result = await sendMailViaGraph({ subject: payload.subject, body: payload.body, to, cc });
  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.error }, { status: 502 });
  }

  // Update question statuses + notes in Supabase
  if (hasSupabaseConfig) {
    try {
      const supabase = await createClient();
      const now = isoNow();
      const recipientSummary = to.map((r) => r.address).join(", ");
      const user = await getAuthenticatedUser();
      const sentByNote = `Sent by email to ${recipientSummary} on ${new Date(now).toLocaleString("en-GB", { timeZone: "Europe/London" })}.`;

      for (const id of payload.questionIds) {
        const { data: existing } = await supabase
          .from("discovery_questions")
          .select("notes, status")
          .eq("id", id)
          .single();

        const currentNotes = (existing as { notes?: string | null } | null)?.notes ?? "";
        const appendedNotes = currentNotes ? `${currentNotes}\n${sentByNote}` : sentByNote;

        await supabase
          .from("discovery_questions")
          .update({
            status: "Awaiting Response",
            raised_to: recipientSummary,
            raised_date: now,
            notes: appendedNotes,
            updated_at: now,
          })
          .eq("id", id);
      }

      // Audit log (non-fatal)
      try {
        await supabase.from("audit_log").insert({
          entity_type: "discovery_questions",
          entity_id: payload.questionIds[0],
          action: "email_sent",
          changed_by: user?.email ?? "system",
          changes: JSON.stringify({
            questionCount: payload.questionIds.length,
            recipients: recipientSummary,
            subject: payload.subject,
            sentAt: now,
          }),
          created_at: now,
        });
      } catch { /* non-fatal */ }
    } catch (dbError) {
      // Email was sent successfully; DB update failure is non-fatal but logged
      console.error("Failed to update discovery questions after email send:", dbError);
      return NextResponse.json({
        ok: true,
        warning: "Email sent successfully, but question statuses could not be updated automatically. Please update them manually.",
      });
    }
  }

  return NextResponse.json({ ok: true, message: `Email sent to ${to.map((r) => r.address).join(", ")}.` });
}
