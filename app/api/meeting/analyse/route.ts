import { NextRequest } from "next/server";
import { analyseMeeting, ConfigError } from "@/lib/ai";
import { AnalysisError, RateLimitError } from "@/lib/ai/errors";
import { chunkMeetingText } from "@/lib/meeting-intelligence/chunker";
import { buildChunkPrompt } from "@/lib/meeting-intelligence/prompt";
import { mergeAnalysisResults } from "@/lib/meeting-intelligence/merger";
import type { AIAnalysisResponse } from "@/lib/meeting-intelligence/types";

// SSE event shapes sent to the client
export type AnalyseSSEEvent =
  | { type: "log"; label: string }
  | { type: "result"; summary: string; suggestions: AIAnalysisResponse["suggestions"] }
  | { type: "rate_limit"; message: string; retryAfter: number | null; hint: string; failedChunk: number; totalChunks: number }
  | { type: "error"; message: string };

export async function POST(req: NextRequest) {
  let body: { compactContext: string; meetingText: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { compactContext, meetingText } = body;
  if (!meetingText?.trim()) {
    return new Response(JSON.stringify({ error: "Meeting notes are empty." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: AnalyseSSEEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const chunks = chunkMeetingText(meetingText);
        const total = chunks.length;

        send({ type: "log", label: `Preparing ${total} chunk${total > 1 ? "s" : ""}` });

        const results: AIAnalysisResponse[] = [];

        for (const chunk of chunks) {
          const chunkLabel =
            total > 1
              ? `Analysing chunk ${chunk.index + 1} of ${total}`
              : "Analysing meeting notes";

          send({ type: "log", label: chunkLabel });

          const systemPrompt = buildChunkPrompt(compactContext, chunk.index, total);

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

        send({ type: "log", label: "Preparing review" });
        send({ type: "result", summary: merged.summary, suggestions: merged.suggestions });
      } catch (err) {
        console.error("[analyse] stream error:", err);
        send({ type: "error", message: "Analysis failed unexpectedly. Please try again." });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
