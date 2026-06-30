import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";
import { normaliseResponse } from "@/lib/ai/normalise";

const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export async function analyseWithOpenAI(
  systemPrompt: string,
  meetingText: string,
  apiKey?: string,
): Promise<AIAnalysisResponse> {
  apiKey ??= process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "OPENAI_API_KEY is not set. Add it to .env.local to use the OpenAI provider.",
    );
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Analyse these meeting notes and return a structured JSON response with summary and suggestions:\n\n${meetingText}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("OpenAI error:", res.status, body);
    throw new Error(`OpenAI API error: ${res.status}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content ?? "{}";
  return normaliseResponse(JSON.parse(content));
}

export class ConfigError extends Error {
  readonly isConfigError = true;
}
