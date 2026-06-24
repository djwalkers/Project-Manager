import { NextResponse } from "next/server";
import { executeEmail, type EmailRequestPayload } from "@/lib/email-delivery";
import { isAuthorizedRequest } from "@/lib/api-auth";

export async function POST(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  const payload = await request.json().catch(() => ({})) as EmailRequestPayload;
  const result = await executeEmail("Test", "Manual", payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
