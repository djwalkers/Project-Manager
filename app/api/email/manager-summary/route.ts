import { NextResponse } from "next/server";
import { executeEmail, isAuthorisedCron, type EmailRequestPayload } from "@/lib/email-delivery";
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
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  const xVercelCron = request.headers.get("x-vercel-cron");
  const querySecret = url.searchParams.get("secret");

  console.log(`[manager-summary] GET invoked — x-vercel-cron="${xVercelCron}" auth=${auth ? "present" : "absent"} querySecret=${querySecret ? "present" : "absent"}`);

  if (!isAuthorisedCron(auth, xVercelCron, querySecret)) {
    console.log("[manager-summary] Rejected — unauthorised cron request");
    return NextResponse.json({ ok: false, status: "auth_error", message: "Unauthorised cron request." }, { status: 401 });
  }

  const result = await executeEmail("Manager Summary", "Scheduled");
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
