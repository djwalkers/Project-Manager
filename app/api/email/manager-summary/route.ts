import { NextResponse } from "next/server";
import { executeEmail, isAuthorisedCron, isScheduledLondonSlot, type EmailRequestPayload } from "@/lib/email-delivery";
import { isAuthorizedRequest } from "@/lib/api-auth";

export async function POST(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  const payload = await request.json().catch(() => ({})) as EmailRequestPayload;
  const result = await executeEmail("Manager Summary", "Manual", payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}

export async function GET(request: Request) {
  if (!isAuthorisedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorised cron request." }, { status: 401 });
  }
  if (!isScheduledLondonSlot("Manager Summary")) {
    return NextResponse.json({ ok: true, skipped: true, message: "Outside the Friday 16:00 Europe/London delivery window." });
  }
  const result = await executeEmail("Manager Summary", "Scheduled");
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
