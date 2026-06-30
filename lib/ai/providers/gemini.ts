import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";
import { normaliseResponse } from "@/lib/ai/normalise";
import { ConfigError } from "@/lib/ai/providers/openai";
import { AnalysisError } from "@/lib/ai/errors";

const DEFAULT_MODEL = "gemini-2.0-flash";

/** Strip markdown code fences Gemini sometimes adds despite responseMimeType:json. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

export async function analyseWithGemini(
  systemPrompt: string,
  meetingText: string,
  apiKey?: string,
  model?: string | null,
): Promise<AIAnalysisResponse> {
  apiKey ??= process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "GEMINI_API_KEY is not set. Add it to .env.local or configure it in AI Settings.",
    );
  }

  const resolvedModel = model ?? DEFAULT_MODEL;
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${apiKey}`;

  // Explicit JSON instruction appended so the model never wraps output in prose.
  const prompt = [
    systemPrompt,
    "",
    "Analyse these meeting notes and respond with a single JSON object only.",
    "Rules:",
    "- Do NOT wrap the JSON in markdown code fences.",
    "- Do NOT include any text before or after the JSON.",
    "- The root object must have exactly two keys: \"summary\" (string) and \"suggestions\" (array).",
    "",
    "Meeting notes:",
    meetingText,
  ].join("\n");

  console.log(
    `[gemini] provider=gemini model=${resolvedModel} promptLength=${prompt.length}`,
  );

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
    console.error(`[gemini] API error status=${res.status} body=${body.slice(0, 200)}`);
    if (res.status === 404) {
      throw new AnalysisError(
        `Gemini model not found. Check the model name in AI Settings (using "${resolvedModel}").`,
      );
    }
    if (res.status === 400) {
      throw new AnalysisError(`Gemini rejected the request (400). Check the model name in AI Settings.`);
    }
    throw new AnalysisError(`Gemini API error: ${res.status}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };

  console.log(`[gemini] responseReceived=true candidateCount=${data.candidates?.length ?? 0}`);

  // Safety filter blocked the entire prompt.
  if (data.promptFeedback?.blockReason) {
    throw new AnalysisError(
      `Gemini blocked the request: ${data.promptFeedback.blockReason}`,
    );
  }

  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;

  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw new AnalysisError(
      `Gemini stopped unexpectedly (finishReason: ${finishReason}).`,
    );
  }

  const rawText = candidate?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error("[gemini] empty text in response:", JSON.stringify(data).slice(0, 300));
    throw new AnalysisError("Gemini returned an empty response.");
  }

  console.log(`[gemini] rawTextLength=${rawText.length}`);

  const cleaned = stripFences(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Last-resort repair: find the first { ... } block.
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        console.log("[gemini] jsonParseSuccess=true (via repair)");
      } catch {
        console.error("[gemini] jsonParseFailed cleaned snippet:", cleaned.slice(0, 200));
        throw new AnalysisError("Gemini returned invalid JSON. Check the AI Settings or try again.");
      }
    } else {
      console.error("[gemini] jsonParseFailed cleaned snippet:", cleaned.slice(0, 200));
      throw new AnalysisError("Gemini returned invalid JSON. Check the AI Settings or try again.");
    }
  }

  console.log("[gemini] jsonParseSuccess=true normalising...");
  return normaliseResponse(parsed);
}
