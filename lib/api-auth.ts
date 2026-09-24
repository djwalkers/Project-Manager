import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { canAssessManualChecks, canCreateProject, canSendProjectEmail, canWriteDeliveryData } from "@/lib/permissions";
import type { UserRole } from "@/lib/auth";

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

/**
 * Route guard for endpoints that assess a manual Go-Live Readiness check —
 * only Admin/Manager may record an assessment; Viewer is read-only (see
 * lib/permissions.ts's canAssessManualChecks, the single rule shared with
 * the client-side edit action).
 *
 * When Supabase isn't configured at all, the synthetic local-dev user is
 * always treated as Admin — matching contexts/auth-context.tsx, which
 * hands the same synthetic user an "Admin" role so the UI still renders as
 * fully editable in local dev.
 *
 * Returns a 401/403 NextResponse to short-circuit the route, or null to
 * proceed. Callers must call requireAuthenticatedUser() first if they also
 * need the plain-401 behaviour for a fully anonymous request; this guard
 * folds that check in too, so it is safe to call on its own.
 */
export async function requireAdminOrManagerUser(): Promise<NextResponse<{ error: string }> | null> {
  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSupabaseConfig) return null;

  const db = createServiceRoleClient();
  if (!db) return null;

  const { data: profile } = await db.from("user_profiles").select("role").eq("id", user.id).maybeSingle();
  const role = (profile?.role ?? null) as UserRole | null;
  if (!canAssessManualChecks(role)) {
    return NextResponse.json({ error: `Admin or Manager access required (resolved role: ${role ?? "none"})` }, { status: 403 });
  }
  return null;
}

/**
 * Route guard for creating a new project — only Admin/Manager may do so
 * (see lib/permissions.ts's canCreateProject, the single rule shared with
 * the client-side "New Project" action). Structurally identical to
 * requireAdminOrManagerUser above, kept as its own function (rather than a
 * shared alias) so the two features' permission rules can diverge later
 * without one silently affecting the other.
 */
export async function requireCanCreateProject(): Promise<NextResponse<{ error: string }> | null> {
  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSupabaseConfig) return null;

  const db = createServiceRoleClient();
  if (!db) return null;

  const { data: profile } = await db.from("user_profiles").select("role").eq("id", user.id).maybeSingle();
  const role = (profile?.role ?? null) as UserRole | null;
  if (!canCreateProject(role)) {
    return NextResponse.json({ error: `Admin or Manager access required (resolved role: ${role ?? "none"})` }, { status: 403 });
  }
  return null;
}

/**
 * Generic role guard shared by the Phase 0B routes below. Same resolution
 * as requireAdminOrManagerUser: a real session (the synthetic local-dev
 * user only outside production, and only when Supabase is unconfigured —
 * it is then treated as Admin, matching contexts/auth-context.tsx), then
 * the caller's role from user_profiles via the service-role client.
 *
 * Fails CLOSED when Supabase is configured but the service-role key is
 * missing: the role cannot be verified, so the request is refused (503)
 * rather than allowed through.
 */
async function requireRole(
  allowed: (role: UserRole | null) => boolean,
  requirement: string,
): Promise<NextResponse<{ error: string }> | null> {
  const allowLocalFallback = process.env.NODE_ENV !== "production";
  const user = await getAuthenticatedUser({ allowLocalFallback });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSupabaseConfig) return null;

  const db = createServiceRoleClient();
  if (!db) return NextResponse.json({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set, so the caller's role cannot be verified" }, { status: 503 });

  const { data: profile } = await db.from("user_profiles").select("role").eq("id", user.id).maybeSingle();
  const role = (profile?.role ?? null) as UserRole | null;
  if (!allowed(role)) {
    return NextResponse.json({ error: `${requirement} (resolved role: ${role ?? "none"})` }, { status: 403 });
  }
  return null;
}

/** Delivery-data writes (Audit entries, go-live checklist/cutover) — Manager/Admin. */
export function requireCanWriteDeliveryData(): Promise<NextResponse<{ error: string }> | null> {
  return requireRole(canWriteDeliveryData, "Admin or Manager access required");
}

/**
 * Manual email/report sends — a valid CRON_SECRET bearer token (automated
 * sends), otherwise a signed-in Manager/Admin. Viewers are refused.
 */
export async function requireCanSendProjectEmail(authHeader: string | null): Promise<NextResponse<{ ok: false; message: string }> | null> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return null;
  const denied = await requireRole(canSendProjectEmail, "Admin or Manager access required to send emails");
  if (!denied) return null;
  const body = await denied.json() as { error: string };
  return NextResponse.json({ ok: false, message: denied.status === 401 ? "Unauthorized." : body.error }, { status: denied.status });
}
