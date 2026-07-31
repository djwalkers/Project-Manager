import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/supabase/client";

/**
 * Verify the request carries a valid Supabase session.
 * Returns the user object if authenticated, null otherwise.
 *
 * When Supabase isn't configured at all, a synthetic local-dev user is
 * returned only if allowLocalFallback is true (the default, preserving
 * every existing caller's behaviour). Callers that must never accept the
 * synthetic fallback in production pass allowLocalFallback: false — see
 * requireAuthenticatedUser().
 */
export async function getAuthenticatedUser(options?: { allowLocalFallback?: boolean }) {
  const allowLocalFallback = options?.allowLocalFallback ?? true;
  if (!hasSupabaseConfig) {
    return allowLocalFallback ? { id: "local", email: "local@dev" } : null;
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * Returns true if the caller is a valid authenticated user or a valid cron request.
 */
export async function isAuthorizedRequest(authHeader: string | null): Promise<boolean> {
  // Valid cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;

  // Valid user session
  const user = await getAuthenticatedUser();
  return Boolean(user);
}

/**
 * Route guard for endpoints that must never accept the synthetic local-dev
 * user in production. In production, only a real Supabase session is
 * accepted — Supabase being unconfigured in production is NOT treated as a
 * reason to fall back to the synthetic user. Outside production, the
 * synthetic user is still accepted when Supabase is genuinely unconfigured,
 * exactly as getAuthenticatedUser() already does everywhere else.
 *
 * Returns a 401 NextResponse to short-circuit the route, or null to proceed.
 */
export async function requireAuthenticatedUser(): Promise<NextResponse<{ error: string }> | null> {
  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}
