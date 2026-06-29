import { NextRequest, NextResponse } from "next/server";
import type { AIAnalysisResponse, AISuggestion } from "@/lib/meeting-intelligence/types";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured. Add it to .env.local to enable AI analysis." },
      { status: 503 },
    );
  }

  let body: { systemPrompt: string; meetingText: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { systemPrompt, meetingText } = body;
  if (!meetingText?.trim()) {
    return NextResponse.json({ error: "meetingText is required" }, { status: 400 });
  }

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `Analyse these meeting notes and return a structured JSON response with summary and suggestions:\n\n${meetingText}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("OpenAI error:", response.status, errorBody);
      return NextResponse.json(
        { error: `OpenAI API error: ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as Partial<AIAnalysisResponse>;

    // Validate and normalise
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

    const VALID_ENTITY_TYPES = new Set([
      "action", "decision", "risk", "requirement", "discovery_question",
      "dependency", "milestone", "deliverable", "test_case",
      "acceptance_criterion", "evidence", "project_update", "general_note",
    ]);
    const VALID_ACTIONS = new Set(["create", "update", "close", "note"]);
    const VALID_CONFIDENCE = new Set(["High", "Medium", "Low"]);

    const suggestions: AISuggestion[] = (raw as unknown[])
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .filter((s) => typeof s.title === "string" && s.title.trim())
      .map((s): AISuggestion => ({
        entity_type: VALID_ENTITY_TYPES.has(String(s.entity_type))
          ? (s.entity_type as AISuggestion["entity_type"])
          : "general_note",
        action: VALID_ACTIONS.has(String(s.action))
          ? (s.action as AISuggestion["action"])
          : "create",
        title: String(s.title).slice(0, 200),
        description: typeof s.description === "string" ? s.description : null,
        confidence: VALID_CONFIDENCE.has(String(s.confidence))
          ? (s.confidence as AISuggestion["confidence"])
          : "Medium",
        reason: typeof s.reason === "string" ? s.reason : null,
        existing_record_ref: typeof s.existing_record_ref === "string"
          ? s.existing_record_ref
          : null,
        data_payload: s.data_payload && typeof s.data_payload === "object"
          ? (s.data_payload as Record<string, unknown>)
          : null,
      }));

    return NextResponse.json({ summary, suggestions } satisfies AIAnalysisResponse);
  } catch (err) {
    console.error("Meeting analysis error:", err);
    return NextResponse.json(
      { error: "Failed to process meeting notes. Please try again." },
      { status: 500 },
    );
  }
}
