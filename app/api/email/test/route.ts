import { NextResponse } from "next/server";
import { executeEmail, type EmailRequestPayload } from "@/lib/email-delivery";
import { requireCanSendProjectEmail } from "@/lib/api-auth";

export async function POST(request: Request) {
  // Manual send: CRON_SECRET bearer, or a signed-in Manager/Admin (Viewer → 403).
  const denied = await requireCanSendProjectEmail(request.headers.get("authorization"));
  if (denied) return denied;
  const payload = await request.json().catch(() => ({})) as EmailRequestPayload;
  const result = await executeEmail("Test", "Manual", payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
