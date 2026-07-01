import { NextRequest } from "next/server";
import { analyseMeeting, ConfigError } from "@/lib/ai";
import { AnalysisError, RateLimitError } from "@/lib/ai/errors";
import { chunkMeetingText, SINGLE_CALL_THRESHOLD } from "@/lib/meeting-intelligence/chunker";
import { buildChunkPrompt } from "@/lib/meeting-intelligence/prompt";
import { mergeAnalysisResults } from "@/lib/meeting-intelligence/merger";
import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";

// SSE event shapes sent to the client
export type AnalyseSSEEvent =
  | { type: "log"; label: string }
  | { type: "result"; summary: string; suggestions: AIAnalysisResponse["suggestions"] }
  | { type: "rate_limit"; message: string; retryAfter: number | null; hint: string; failedChunk: number; totalChunks: number }
  | { type: "duplicate"; message: string }
  | { type: "error"; message: string };

// In-flight tracking — prevents duplicate analyses for the same meeting
const inFlight = new Map<string, string>(); // meeting_id → startedAt ISO string

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
};

export async function POST(req: NextRequest) {
  let body: { compactContext: string; meetingText: string; meeting_id?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { compactContext, meetingText, meeting_id } = body;
  if (!meetingText?.trim()) {
    return new Response(JSON.stringify({ error: "Meeting notes are empty." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Server-side dedup: reject if an analysis for this meeting is already in-flight
  if (meeting_id && inFlight.has(meeting_id)) {
    const existingStartedAt = inFlight.get(meeting_id)!;
    console.log(
      `[analyse] duplicate_prevented=yes meeting_id=${meeting_id} existing_started_at=${existingStartedAt}`,
    );
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const event: AnalyseSSEEvent = {
          type: "duplicate",
          message: "Analysis already in progress for this meeting. Wait for it to complete.",
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  const startedAt = new Date().toISOString();
  if (meeting_id) {
    inFlight.set(meeting_id, startedAt);
    console.log(
      `[analyse] start meeting_id=${meeting_id} started_at=${startedAt} textLength=${meetingText.length}`,
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let generateCallsAttempted = 0;

      const send = (event: AnalyseSSEEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const trimmed = meetingText.trim();
        const isSingleCall = trimmed.length <= SINGLE_CALL_THRESHOLD;
        const chunks = isSingleCall
          ? [{ text: trimmed, index: 0, total: 1 }]
          : chunkMeetingText(meetingText);
        const total = chunks.length;

        console.log(
          `[analyse] meeting_id=${meeting_id ?? "unknown"} chunkCount=${total} singleCall=${isSingleCall} textLength=${trimmed.length} duplicate_prevented=no`,
        );

        const singleCallNote = isSingleCall && trimmed.length > 5000 ? " (single-call mode)" : "";
        send({ type: "log", label: `Preparing ${total} chunk${total > 1 ? "s" : ""}${singleCallNote}` });

        const results: AIAnalysisResponse[] = [];

        for (const chunk of chunks) {
          const chunkLabel =
            total > 1
              ? `Analysing chunk ${chunk.index + 1} of ${total}`
              : "Analysing meeting notes";

          send({ type: "log", label: chunkLabel });

          const systemPrompt = buildChunkPrompt(compactContext, chunk.index, total);
          generateCallsAttempted++;

          try {
            const result = await analyseMeeting(systemPrompt, chunk.text);
            results.push(result);
          } catch (err) {
            if (err instanceof RateLimitError) {
              send({
                type: "rate_limit",
                message: err.message,
                retryAfter: err.retryAfterSeconds ?? null,
                hint: "Try switching to gemini-2.0-flash or gemini-1.5-flash-latest in AI Settings — these models have higher free-tier quotas.",
                failedChunk: chunk.index + 1,
                totalChunks: total,
              });
              console.log(
                `[analyse] meeting_id=${meeting_id ?? "unknown"} generateCallsAttempted=${generateCallsAttempted} rate_limited=yes`,
              );
              return;
            }
            if (err instanceof ConfigError) {
              send({ type: "error", message: err.message });
              return;
            }
            if (err instanceof AnalysisError) {
              send({ type: "error", message: err.message });
              return;
            }
            console.error(`[analyse] chunk ${chunk.index} unexpected error:`, err);
            send({
              type: "error",
              message: `Analysis failed at chunk ${chunk.index + 1} of ${total}. Please try again.`,
            });
            return;
          }
        }

        if (total > 1) {
          send({ type: "log", label: "Merging findings" });
        }
        const merged = mergeAnalysisResults(results);

        console.log(
          `[analyse] meeting_id=${meeting_id ?? "unknown"} generateCallsAttempted=${generateCallsAttempted} success=true`,
        );

        send({ type: "log", label: "Preparing review" });
        send({ type: "result", summary: merged.summary, suggestions: merged.suggestions });
      } catch (err) {
        console.error("[analyse] stream error:", err);
        console.log(
          `[analyse] meeting_id=${meeting_id ?? "unknown"} generateCallsAttempted=${generateCallsAttempted} success=false`,
        );
        send({ type: "error", message: "Analysis failed unexpectedly. Please try again." });
      } finally {
        if (meeting_id) inFlight.delete(meeting_id);
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
