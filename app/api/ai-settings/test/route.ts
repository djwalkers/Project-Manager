import { NextResponse } from "next/server";
import { loadAISettings, resolveEnvKey, type AIProviderName } from "@/lib/ai/settings";

type TestResult = { ok: boolean; message: string };

async function testOpenAI(apiKey: string): Promise<TestResult> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.ok) return { ok: true, message: "Connected to OpenAI successfully." };
  const body = await res.text();
  return { ok: false, message: `OpenAI returned ${res.status}: ${body.slice(0, 120)}` };
}

async function testGemini(apiKey: string): Promise<TestResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  if (res.ok) return { ok: true, message: "Connected to Google Gemini successfully." };
  const body = await res.text();
  return { ok: false, message: `Gemini returned ${res.status}: ${body.slice(0, 120)}` };
}

async function testAnthropic(apiKey: string): Promise<TestResult> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (res.ok) return { ok: true, message: "Connected to Anthropic successfully." };
  const body = await res.text();
  return { ok: false, message: `Anthropic returned ${res.status}: ${body.slice(0, 120)}` };
}

/** POST /api/ai-settings/test — test the active provider connection. */
export async function POST(): Promise<NextResponse> {
  try {
    const settings = await loadAISettings();

    const provider: AIProviderName = (settings?.enabled && settings.provider !== "none")
      ? settings.provider
      : ((process.env.AI_PROVIDER ?? "none") as AIProviderName);

    if (provider === "none") {
      return NextResponse.json({
        ok: false,
        message: "No AI provider configured. Set a provider and API key first.",
      });
    }

    const apiKey = (settings?.enabled ? settings.api_key : null)
      ?? resolveEnvKey(provider);

    if (!apiKey) {
      return NextResponse.json({
        ok: false,
        message: `No API key found for ${provider}. Add one in AI Settings or set the environment variable.`,
      });
    }

    let result: TestResult;
    switch (provider) {
      case "openai":    result = await testOpenAI(apiKey); break;
      case "gemini":    result = await testGemini(apiKey); break;
      case "anthropic": result = await testAnthropic(apiKey); break;
      default:          result = { ok: false, message: "Unknown provider." };
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("AI test error:", err);
    return NextResponse.json({ ok: false, message: "Test failed due to a server error." }, { status: 500 });
  }
}
