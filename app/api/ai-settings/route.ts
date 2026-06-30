import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import {
  loadAISettingsMeta,
  saveAISettings,
  loadAISettings,
  type AIProviderName,
} from "@/lib/ai/settings";

const VALID_PROVIDERS = new Set<string>(["none", "openai", "gemini", "anthropic"]);

function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  console.log(`[ai-settings] serviceSupabase — service role key configured: ${Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)}`);
  if (!url || !key) return null;
  return createServerClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Authenticate via the SSR Supabase client (handles chunked cookies correctly),
 * then look up user_profiles by user.id to resolve the Admin role.
 *
 * Returns null if the request is allowed through, or an error NextResponse.
 */
async function requireAdmin(): Promise<NextResponse | null> {
  // Local dev with no Supabase — allow through.
  if (!hasSupabaseConfig) {
    console.log("[ai-settings] requireAdmin — local mode, allowing through");
    return null;
  }

  // Resolve the session from SSR cookies (handles chunked sb-*-auth-token cookies).
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log(`[ai-settings] requireAdmin — auth user id: ${user?.id ?? "none"}`);

  if (authError || !user) {
    console.log(`[ai-settings] requireAdmin — no valid session: ${authError?.message ?? "no user"}`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Query user_profiles by id (there is no email column in user_profiles).
  const db = serviceSupabase();
  if (!db) {
    console.log("[ai-settings] requireAdmin — no service client, allowing through");
    return null;
  }

  const { data: profile, error: profileError } = await db
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  console.log(`[ai-settings] requireAdmin — profile found: ${Boolean(profile)}, role: ${profile?.role ?? "none"}`);

  if (profileError) {
    console.error("[ai-settings] requireAdmin — profile lookup error:", profileError.message);
  }

  if (!profile || profile.role !== "Admin") {
    return NextResponse.json(
      { error: `Admin access required (resolved role: ${profile?.role ?? "none"})` },
      { status: 403 },
    );
  }

  return null;
}

/** GET /api/ai-settings — returns safe metadata (no api_key). */
export async function GET() {
  try {
    const meta = await loadAISettingsMeta();
    return NextResponse.json(meta);
  } catch {
    return NextResponse.json({ error: "Failed to load AI settings" }, { status: 500 });
  }
}

/** POST /api/ai-settings — save provider, model, enabled, and optionally replace the key. */
export async function POST(req: NextRequest) {
  const authError = await requireAdmin();
  if (authError) return authError;

  let body: {
    provider: string;
    model?: string | null;
    api_key?: string | null;
    clear_key?: boolean;
    enabled: boolean;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!VALID_PROVIDERS.has(body.provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  try {
    const existing = await loadAISettings();

    // Resolve the key:
    // - clear_key=true  → null
    // - api_key present → use new value
    // - neither         → preserve existing
    let keyToStore: string | null;
    if (body.clear_key) {
      keyToStore = null;
    } else if (typeof body.api_key === "string" && body.api_key.trim()) {
      keyToStore = body.api_key.trim();
    } else {
      keyToStore = existing?.api_key ?? null;
    }

    await saveAISettings({
      provider: body.provider as AIProviderName,
      model: body.model ?? null,
      api_key: keyToStore,
      enabled: Boolean(body.enabled),
    });

    const meta = await loadAISettingsMeta();
    return NextResponse.json(meta);
  } catch (err) {
    console.error("[ai-settings] save error:", err);
    return NextResponse.json({ error: "Failed to save AI settings" }, { status: 500 });
  }
}
