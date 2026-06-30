import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";
import { analyseWithOpenAI, ConfigError } from "@/lib/ai/providers/openai";
import { analyseWithGemini } from "@/lib/ai/providers/gemini";
import { analyseWithAnthropic } from "@/lib/ai/providers/anthropic";
import { loadAISettings, resolveEnvKey, type AIProviderName } from "@/lib/ai/settings";

export type { AIProviderName };
export { ConfigError };

function getEnvProvider(): AIProviderName {
  const raw = (process.env.AI_PROVIDER ?? "none").toLowerCase().trim();
  if (raw === "openai" || raw === "gemini" || raw === "anthropic") return raw;
  return "none";
}

export async function analyseMeeting(
  systemPrompt: string,
  meetingText: string,
): Promise<AIAnalysisResponse> {
  // DB settings take precedence over env vars.
  const dbSettings = await loadAISettings().catch(() => null);

  const provider: AIProviderName = (dbSettings?.enabled && dbSettings.provider !== "none")
    ? dbSettings.provider
    : getEnvProvider();

  if (provider === "none") {
    throw new ConfigError(
      "No AI provider is configured. Go to AI Settings to add a provider and API key.",
    );
  }

  // Prefer DB key; fall back to env var.
  const apiKey = (dbSettings?.enabled ? dbSettings.api_key : null)
    ?? resolveEnvKey(provider)
    ?? undefined;

  // Model override from DB settings (optional — providers fall back to their default).
  const model = dbSettings?.enabled ? (dbSettings.model ?? null) : null;

  console.log(`[ai] analyseMeeting provider=${provider} modelOverride=${model ?? "default"}`);

  switch (provider) {
    case "gemini":    return analyseWithGemini(systemPrompt, meetingText, apiKey, model);
    case "anthropic": return analyseWithAnthropic(systemPrompt, meetingText, apiKey);
    default:          return analyseWithOpenAI(systemPrompt, meetingText, apiKey);
  }
}
