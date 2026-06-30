import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  // In local dev (no Supabase), allow through.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return null;

  const authHeader = req.headers.get("authorization");
  const cookieHeader = req.headers.get("cookie") ?? "";

  // Extract bearer token from Authorization header or sb-access-token cookie
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : cookieHeader.match(/sb-[^-]+-auth-token(?:\.0)?=([^;]+)/)?.[1]
      ?? null;

  if (!bearerToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = serviceSupabase();
  if (!db) return null;

  // Verify the JWT and get the user
  const { data: { user }, error } = await db.auth.getUser(bearerToken);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check role
  const { data: profile } = await db
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.role !== "Admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
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
  const authError = await requireAdmin(req);
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
    console.error("AI settings save error:", err);
    return NextResponse.json({ error: "Failed to save AI settings" }, { status: 500 });
  }
}
