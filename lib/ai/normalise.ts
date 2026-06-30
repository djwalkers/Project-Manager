import type { AISuggestion, AIAnalysisResponse } from "@/lib/meeting-intelligence/types";

const VALID_ENTITY_TYPES = new Set([
  "action", "decision", "risk", "requirement", "discovery_question",
  "dependency", "milestone", "deliverable", "test_case",
  "acceptance_criterion", "evidence", "project_update", "general_note",
]);
const VALID_ACTIONS = new Set(["create", "update", "close", "note"]);
const VALID_CONFIDENCE = new Set(["High", "Medium", "Low"]);

export function normaliseResponse(raw: unknown): AIAnalysisResponse {
  const parsed = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<AIAnalysisResponse>;
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const rawList = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  const suggestions: AISuggestion[] = (rawList as unknown[])
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .filter((s) => typeof s.title === "string" && (s.title as string).trim())
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

  return { summary, suggestions };
}
