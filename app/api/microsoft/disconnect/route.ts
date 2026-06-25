import { NextResponse } from "next/server";
import { clearTokens } from "@/lib/microsoft-graph";
import { isAuthorizedRequest } from "@/lib/api-auth";

export async function POST(request: Request) {
  if (!await isAuthorizedRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }
  await clearTokens();
  return NextResponse.json({ ok: true });
}
