import { NextResponse } from "next/server";
import { loadAISettings, resolveEnvKey } from "@/lib/ai/settings";

const DEFAULT_MODEL = "gemini-2.0-flash";
const PROBE_PROMPT = "Return only: OK";

type GenerateTestResult = {
  ok: boolean;
  status: number | null;
  model: string | null;
  retryAfter: string | null;
  responseTextLength: number | null;
  message: string;
};

/** POST /api/ai-settings/generate-test
 *  Calls generateContent with a minimal probe prompt to confirm quota/key health
 *  independently of Meeting Intelligence prompt size.
 */
export async function POST(): Promise<NextResponse<GenerateTestResult>> {
  try {
    const settings = await loadAISettings();

    if (!settings?.enabled || settings.provider !== "gemini") {
      return NextResponse.json({
        ok: false,
        status: null,
        model: null,
        retryAfter: null,
        responseTextLength: null,
        message: "Gemini is not the active provider. Save Gemini as the provider first.",
      });
    }

    const apiKey = settings.api_key ?? resolveEnvKey("gemini");
    if (!apiKey) {
      return NextResponse.json({
        ok: false,
        status: null,
        model: null,
        retryAfter: null,
        responseTextLength: null,
        message: "No Gemini API key configured. Add one and save first.",
      });
    }

    const model = settings.model?.trim() || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROBE_PROMPT }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 10 },
        }),
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        status: null,
        model,
        retryAfter: null,
        responseTextLength: null,
        message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const status = res.status;
    const retryAfter = res.headers.get("Retry-After");

    console.log(`[generate-test] status=${status} model=${model} retryAfter=${retryAfter ?? "none"}`);

    if (!res.ok) {
      const body = await res.text();
      const retryNote = retryAfter ? ` · Retry-After: ${retryAfter}s` : "";
      return NextResponse.json({
        ok: false,
        status,
        model,
        retryAfter,
        responseTextLength: null,
        message: `HTTP ${status}${retryNote} — ${body.slice(0, 200)}`,
      });
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    console.log(`[generate-test] success textLength=${text.length}`);

    return NextResponse.json({
      ok: true,
      status,
      model,
      retryAfter,
      responseTextLength: text.length,
      message: `HTTP ${status} · model: ${model} · response: ${text.length} char${text.length !== 1 ? "s" : ""}`,
    });
  } catch (err) {
    console.error("[generate-test] unexpected error:", err);
    return NextResponse.json(
      {
        ok: false,
        status: null,
        model: null,
        retryAfter: null,
        responseTextLength: null,
        message: "Generate test failed due to a server error.",
      },
      { status: 500 },
    );
  }
}
