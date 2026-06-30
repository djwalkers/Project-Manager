import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";
import { normaliseResponse } from "@/lib/ai/normalise";
import { ConfigError } from "@/lib/ai/providers/openai";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const API_VERSION = "2023-06-01";

export async function analyseWithAnthropic(
  systemPrompt: string,
  meetingText: string,
  apiKey?: string,
): Promise<AIAnalysisResponse> {
  apiKey ??= process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local to use the Anthropic provider.",
    );
  }

  const userMessage = [
    "Analyse these meeting notes and return a structured JSON response with summary and suggestions.",
    "Your response must be valid JSON only — no markdown fences, no commentary outside the JSON object.",
    "",
    meetingText,
  ].join("\n");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Anthropic error:", res.status, body);
    throw new Error(`Anthropic API error: ${res.status}`);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content.find((b) => b.type === "text")?.text ?? "{}";

  // Strip markdown fences if model wraps JSON despite instructions
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return normaliseResponse(JSON.parse(cleaned));
}
