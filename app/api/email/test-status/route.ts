import { NextResponse } from "next/server";
import { executeEmail, type EmailRequestPayload } from "@/lib/email-delivery";
import { isAuthorizedRequest } from "@/lib/api-auth";

// Manual, project-scoped report only — deliberately POST-only. There is no
// GET handler here (unlike Daily Brief/Weekly Summary/Manager Summary),
// which means no cron job, schedule, or automated trigger can ever reach
// this kind: it can only be sent by an authenticated user (or a valid
// CRON_SECRET bearer token, per isAuthorizedRequest) explicitly clicking
// Send in the Testing page.
export async function POST(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  const payload = await request.json().catch(() => ({})) as EmailRequestPayload;
  const result = await executeEmail("Test Status", "Manual", payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
