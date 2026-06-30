import { NextRequest, NextResponse } from "next/server";
import { analyseMeeting, ConfigError } from "@/lib/ai";
import { AnalysisError } from "@/lib/ai/errors";

export async function POST(req: NextRequest) {
  let body: { systemPrompt: string; meetingText: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { systemPrompt, meetingText } = body;
  if (!meetingText?.trim()) {
    return NextResponse.json({ error: "Meeting notes are empty." }, { status: 400 });
  }

  try {
    const result = await analyseMeeting(systemPrompt, meetingText);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof AnalysisError) {
      // Safe message from provider — return it verbatim so the UI can show the real reason.
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("[meeting/analyse] unexpected error:", err);
    return NextResponse.json(
      { error: "AI provider request failed. Check AI Settings and try again." },
      { status: 500 },
    );
  }
}
