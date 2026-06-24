import { NextResponse } from "next/server";
import { executeEmail, type EmailRequestPayload } from "@/lib/email-delivery";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as EmailRequestPayload;
  const result = await executeEmail("Test", "Manual", payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
