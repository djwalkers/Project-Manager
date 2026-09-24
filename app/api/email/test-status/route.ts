import { NextResponse } from "next/server";
import { executeEmail, type EmailRequestPayload } from "@/lib/email-delivery";
import { requireCanSendProjectEmail } from "@/lib/api-auth";

// Manual, project-scoped report only — deliberately POST-only. There is no
// GET handler here (unlike Daily Brief/Weekly Summary/Manager Summary),
// which means no cron job, schedule, or automated trigger can ever reach
// this kind: it can only be sent by a signed-in Manager/Admin (or a valid
// CRON_SECRET bearer token, per requireCanSendProjectEmail) explicitly
// clicking Send in the Testing page.
export async function POST(request: Request) {
  // Manual send: CRON_SECRET bearer, or a signed-in Manager/Admin (Viewer → 403).
  const denied = await requireCanSendProjectEmail(request.headers.get("authorization"));
  if (denied) return denied;
  const payload = await request.json().catch(() => ({})) as EmailRequestPayload;
  const result = await executeEmail("Test Status", "Manual", payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
