import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForTokens, storeTokens } from "@/lib/microsoft-graph";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDesc = searchParams.get("error_description");

  const base = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/supabase\.co.*/, "") ?? "";
  const settingsUrl = `${process.env.MICROSOFT_REDIRECT_URI?.replace("/api/microsoft/callback", "") ?? ""}/microsoft-connection`;

  if (error) {
    const msg = encodeURIComponent(errorDesc ?? error);
    return NextResponse.redirect(`${settingsUrl}?error=${msg}`);
  }

  const store = await cookies();
  const savedState = store.get("ms_oauth_state")?.value;
  store.delete("ms_oauth_state");

  if (!state || state !== savedState) {
    return NextResponse.redirect(`${settingsUrl}?error=${encodeURIComponent("Invalid OAuth state. Please try again.")}`);
  }

  if (!code) {
    return NextResponse.redirect(`${settingsUrl}?error=${encodeURIComponent("No authorisation code received.")}`);
  }

  const tokenData = await exchangeCodeForTokens(code);
  if (!tokenData) {
    return NextResponse.redirect(`${settingsUrl}?error=${encodeURIComponent("Failed to exchange authorisation code for tokens.")}`);
  }

  await storeTokens(tokenData);
  void base; // suppress unused warning
  return NextResponse.redirect(`${settingsUrl}?connected=1`);
}
