// JSON schemas for each model-facing AC-generation stage (Phase 1E). Sent to
// Ollama as `format` AND checked by the shared validator — the constraint
// helps, it is never the guarantee.

import { validateSchema } from "../analysis/schemas.js";
import { CRITERION_TYPES, GAP_TYPES, OBLIGATION_KINDS, QUESTION_RELATIONS } from "./prompts.js";

const str = (maxLength, minLength = 1) => ({ type: "string", minLength, maxLength });
const labels = (prefix, max = 40) => ({ type: "array", items: { type: "string", pattern: `^${prefix}\\d{1,5}$` }, maxItems: max });
// Citation lists accept any input label; a label filed under the wrong list
// is re-filed by its prefix (pipeline.refile) before the reference check.
const cites = () => labels("[FNCQ]");
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const criteriaSchema = obj({
  criteria: { type: "array", maxItems: 40, items: obj({
    obligations: { ...labels("O", 20), minItems: 1 },
    criterion: str(2000), given: str(1000, 0), when: str(1000, 0), then: str(1000, 0),
    criterion_type: { type: "string", enum: CRITERION_TYPES },
    basis: { type: "string", enum: ["Explicit", "Inferred"] },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    source_ids: cites(), scope_note_ids: cites(), clarification_ids: cites(), blocking_question_ids: cites(),
    source_quote: str(2000, 0), rationale: str(2000),
  }) },
  gaps: { type: "array", maxItems: 20, items: obj({
    obligation: { type: "string", pattern: "^O\\d{1,4}$" }, issue_type: { type: "string", enum: GAP_TYPES },
    description: str(2000), question: str(1000, 0),
  }) },
  questions: { type: "array", maxItems: 20, items: obj({ id: { type: "string", pattern: "^Q\\d{1,5}$" }, relation: { type: "string", enum: QUESTION_RELATIONS }, reason: str(500, 0) }) },
});

export const AC_STAGE_SCHEMAS = {
  obligations: obj({
    obligations: { type: "array", maxItems: 30, items: obj({
      statement: str(1000), kind: { type: "string", enum: OBLIGATION_KINDS },
      source_ids: cites(), scope_note_ids: cites(), clarification_ids: cites(), open_question_ids: cites(),
      source_quote: str(2000, 0),
    }) },
    scope_notes: { type: "array", maxItems: 20, items: obj({ id: { type: "string", pattern: "^N\\d{1,5}$" }, relevant: { type: "boolean" }, reason: str(500, 0) }) },
  }),
  criteria: criteriaSchema,
  coverage: criteriaSchema,
  repair: obj({
    repairs: { type: "array", maxItems: 40, items: obj({
      key: { type: "string", pattern: "^A\\d{1,4}$" }, criterion: str(2000), given: str(1000, 0), when: str(1000, 0), then: str(1000, 0), unresolved: { type: "boolean" },
    }) },
  }),
};

export { validateSchema };
