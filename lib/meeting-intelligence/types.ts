import type { SuggestionEntityType, SuggestionAction, ConfidenceLevel } from "@/lib/types";

// Raw suggestion as returned by the AI (before saving to DB)
export type AISuggestion = {
  entity_type: SuggestionEntityType;
  action: SuggestionAction;
  title: string;
  description: string | null;
  confidence: ConfidenceLevel;
  reason: string | null;
  existing_record_ref: string | null;
  data_payload: Record<string, unknown> | null;
};

// Structured response from the AI analysis endpoint
export type AIAnalysisResponse = {
  summary: string;
  suggestions: AISuggestion[];
};

// JSON schema passed to the AI for structured output
export const AI_RESPONSE_SCHEMA = {
  type: "object",
  required: ["summary", "suggestions"],
  properties: {
    summary: { type: "string", description: "2-3 sentence meeting summary" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        required: ["entity_type", "action", "title", "confidence", "reason"],
        properties: {
          entity_type: {
            type: "string",
            enum: [
              "action", "decision", "risk", "requirement", "discovery_question",
              "dependency", "milestone", "deliverable", "test_case",
              "acceptance_criterion", "evidence", "project_update", "general_note",
            ],
          },
          action: { type: "string", enum: ["create", "update", "close", "note"] },
          title: { type: "string" },
          description: { type: "string" },
          confidence: { type: "string", enum: ["High", "Medium", "Low"] },
          reason: { type: "string" },
          existing_record_ref: { type: "string", description: "e.g. ACT-009" },
          data_payload: {
            type: "object",
            description: "Suggested field values for the new or updated record",
          },
        },
      },
    },
  },
};

// Document source types for future extension
export type DocumentSourceType =
  | "teams_meeting_summary"
  | "zoom_transcript"
  | "workshop_notes"
  | "customer_email"
  | "functional_specification"
  | "technical_design_document"
  | "other";

export const SOURCE_LABELS: Record<DocumentSourceType, string> = {
  teams_meeting_summary: "Teams Meeting Summary",
  zoom_transcript: "Zoom Transcript",
  workshop_notes: "Workshop Notes",
  customer_email: "Customer Email",
  functional_specification: "Functional Specification",
  technical_design_document: "Technical Design Document",
  other: "Other",
};
