// Server-side only — never import this from client components.
// Reads AI provider settings from Supabase using the service role key.
// Falls back to environment variables when no database is configured.

import { createClient } from "@supabase/supabase-js";

export type AIProviderName = "none" | "openai" | "gemini" | "anthropic";

export type AISettingsRecord = {
  id: string;
  provider: AIProviderName;
  model: string | null;
  api_key: string | null;
  enabled: boolean;
};

// Safe metadata — never includes api_key. Returned to the client.
export type AISettingsMeta = {
  id: string | null;
  provider: AIProviderName;
  model: string | null;
  enabled: boolean;
  key_configured: boolean;
};

function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Load full settings including api_key — server use only. */
export async function loadAISettings(): Promise<AISettingsRecord | null> {
  const db = serviceSupabase();
  if (!db) return null;
  const { data } = await db
    .from("ai_settings")
    .select("id, provider, model, api_key, enabled")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as AISettingsRecord | null) ?? null;
}

/** Load metadata only — safe to pass to API responses. */
export async function loadAISettingsMeta(): Promise<AISettingsMeta> {
  const settings = await loadAISettings();
  if (!settings) {
    // Fall back to env vars
    const envProvider = (process.env.AI_PROVIDER ?? "none") as AIProviderName;
    const envKey = resolveEnvKey(envProvider);
    return {
      id: null,
      provider: envProvider,
      model: null,
      enabled: Boolean(envKey),
      key_configured: Boolean(envKey),
    };
  }
  return {
    id: settings.id,
    provider: settings.provider,
    model: settings.model,
    enabled: settings.enabled,
    key_configured: Boolean(settings.api_key),
  };
}

/** Upsert ai_settings — only one row is ever stored. */
export async function saveAISettings(patch: {
  provider: AIProviderName;
  model?: string | null;
  api_key?: string | null;
  enabled: boolean;
}): Promise<void> {
  const db = serviceSupabase();
  if (!db) throw new Error("Database not configured.");

  const existing = await loadAISettings();
  if (existing) {
    const update: Record<string, unknown> = {
      provider: patch.provider,
      enabled: patch.enabled,
      updated_at: new Date().toISOString(),
    };
    if ("model" in patch) update.model = patch.model ?? null;
    if ("api_key" in patch && patch.api_key !== undefined) update.api_key = patch.api_key;
    await db.from("ai_settings").update(update).eq("id", existing.id);
  } else {
    await db.from("ai_settings").insert({
      provider: patch.provider,
      model: patch.model ?? null,
      api_key: patch.api_key ?? null,
      enabled: patch.enabled,
    });
  }
}

/** Resolve which env-var API key to use for a given provider (fallback path). */
export function resolveEnvKey(provider: AIProviderName): string | null {
  switch (provider) {
    case "openai":    return process.env.OPENAI_API_KEY ?? null;
    case "gemini":    return process.env.GEMINI_API_KEY ?? null;
    case "anthropic": return process.env.ANTHROPIC_API_KEY ?? null;
    default:          return null;
  }
}
