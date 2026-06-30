import type { AISuggestion, AIAnalysisResponse } from "@/lib/meeting-intelligence/types";

const VALID_ENTITY_TYPES = new Set([
  "action", "decision", "risk", "requirement", "discovery_question",
  "dependency", "milestone", "deliverable", "test_case",
  "acceptance_criterion", "evidence", "project_update", "general_note",
]);
const VALID_ACTIONS = new Set(["create", "update", "close", "note"]);
const VALID_CONFIDENCE = new Set(["High", "Medium", "Low"]);

/**
 * Attempt to locate the suggestions array in a variety of shapes Gemini/OpenAI may return:
 *   { summary, suggestions: [...] }         ← canonical
 *   { summary, suggestions: { items: [...] } } ← nested object
 *   [ ...suggestion objects... ]            ← bare array
 *   { data: { summary, suggestions } }      ← extra wrapper
 */
function extractSuggestionsList(raw: unknown): {
  summary: string;
  rawList: unknown[];
} {
  if (Array.isArray(raw)) {
    return { summary: "", rawList: raw };
  }

  if (typeof raw !== "object" || raw === null) {
    return { summary: "", rawList: [] };
  }

  const obj = raw as Record<string, unknown>;

  // Unwrap a data envelope if present.
  const unwrapped: Record<string, unknown> =
    typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : obj;

  const summary =
    typeof unwrapped.summary === "string" ? unwrapped.summary : "";

  const sugField = unwrapped.suggestions;

  if (Array.isArray(sugField)) {
    return { summary, rawList: sugField };
  }

  // suggestions may be an object with a nested array.
  if (typeof sugField === "object" && sugField !== null) {
    const inner = sugField as Record<string, unknown>;
    for (const key of ["items", "list", "updates", "changes"]) {
      if (Array.isArray(inner[key])) {
        console.log(`[normalise] suggestions wrapped under key="${key}" — unwrapping`);
        return { summary, rawList: inner[key] as unknown[] };
      }
    }
  }

  console.log(
    `[normalise] suggestions field type=${Array.isArray(sugField) ? "array" : typeof sugField}, defaulting to []`,
  );
  return { summary, rawList: [] };
}

export function normaliseResponse(raw: unknown): AIAnalysisResponse {
  const { summary, rawList } = extractSuggestionsList(raw);

  let accepted = 0;
  let rejected = 0;

  const suggestions: AISuggestion[] = (rawList as unknown[])
    .filter((s): s is Record<string, unknown> => {
      if (typeof s !== "object" || s === null) { rejected++; return false; }
      return true;
    })
    .filter((s) => {
      if (typeof s.title !== "string" || !(s.title as string).trim()) {
        console.log("[normalise] rejecting suggestion — missing/empty title");
        rejected++;
        return false;
      }
      return true;
    })
    .map((s): AISuggestion => {
      accepted++;
      return {
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
      };
    });

  console.log(
    `[normalise] validationComplete accepted=${accepted} rejected=${rejected} summaryLength=${summary.length}`,
  );

  return { summary, suggestions };
}
