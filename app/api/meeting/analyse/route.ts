import { NextRequest, NextResponse } from "next/server";
import { analyseMeeting, ConfigError } from "@/lib/ai";

export async function POST(req: NextRequest) {
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
    const result = await analyseMeeting(systemPrompt, meetingText);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error("Meeting analysis error:", err);
    return NextResponse.json(
      { error: "Failed to process meeting notes. Please try again." },
      { status: 500 },
    );
  }
}
