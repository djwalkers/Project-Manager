import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { buildAuthUrl, isMicrosoftConfigured } from "@/lib/microsoft-graph";
import { isAuthorizedRequest } from "@/lib/api-auth";

export async function GET(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  if (!isMicrosoftConfigured()) {
    return NextResponse.json({ ok: false, message: "Microsoft 365 environment variables are not configured." }, { status: 503 });
  }

  const state = randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("ms_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes
  });

  return NextResponse.redirect(buildAuthUrl(state));
}
