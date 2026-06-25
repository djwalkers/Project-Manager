import { NextResponse } from "next/server";
import { getMicrosoftStatus, isMicrosoftConfigured } from "@/lib/microsoft-graph";
import { isAuthorizedRequest } from "@/lib/api-auth";

export async function GET(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  const cfg = {
    clientId: Boolean(process.env.MICROSOFT_CLIENT_ID),
    redirectUri: Boolean(process.env.MICROSOFT_REDIRECT_URI),
    tokenSecret: Boolean(process.env.MICROSOFT_TOKEN_SECRET),
  };
  const configured = isMicrosoftConfigured();
  const status = configured ? await getMicrosoftStatus() : { connected: false };
  return NextResponse.json({ ok: true, configured, ...cfg, ...status });
}
