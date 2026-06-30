import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";
import { analyseWithOpenAI, ConfigError } from "@/lib/ai/providers/openai";
import { analyseWithGemini } from "@/lib/ai/providers/gemini";
import { analyseWithAnthropic } from "@/lib/ai/providers/anthropic";

export type AIProvider = "openai" | "gemini" | "anthropic";

export { ConfigError };

function getProvider(): AIProvider {
  const raw = (process.env.AI_PROVIDER ?? "openai").toLowerCase().trim();
  if (raw === "gemini") return "gemini";
  if (raw === "anthropic") return "anthropic";
  return "openai";
}

export async function analyseMeeting(
  systemPrompt: string,
  meetingText: string,
): Promise<AIAnalysisResponse> {
  const provider = getProvider();
  switch (provider) {
    case "gemini":
      return analyseWithGemini(systemPrompt, meetingText);
    case "anthropic":
      return analyseWithAnthropic(systemPrompt, meetingText);
    default:
      return analyseWithOpenAI(systemPrompt, meetingText);
  }
}
