import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";
import { normaliseResponse } from "@/lib/ai/normalise";
import { ConfigError } from "@/lib/ai/providers/openai";

// Gemini 1.5 Flash — fast and cost-effective for structured extraction
const MODEL = "gemini-1.5-flash";

export async function analyseWithGemini(
  systemPrompt: string,
  meetingText: string,
): Promise<AIAnalysisResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "GEMINI_API_KEY is not set. Add it to .env.local to use the Gemini provider.",
    );
  }

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const prompt = [
    systemPrompt,
    "",
    "Analyse these meeting notes and return a structured JSON response with summary and suggestions:",
    "",
    meetingText,
  ].join("\n");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4000,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Gemini error:", res.status, body);
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const text = data.candidates[0]?.content?.parts[0]?.text ?? "{}";
  return normaliseResponse(JSON.parse(text));
}
