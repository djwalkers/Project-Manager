import { createClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/supabase/client";

/**
 * Verify the request carries a valid Supabase session.
 * Returns the user object if authenticated, null otherwise.
 * In local mode (no Supabase config) always returns a synthetic user.
 */
export async function getAuthenticatedUser() {
  if (!hasSupabaseConfig) {
    return { id: "local", email: "local@dev" };
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
