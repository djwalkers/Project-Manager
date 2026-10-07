// JSON schemas for each model-facing test-design stage (Phase 1G). Sent to
// Ollama as `format` AND checked by the shared validator — the constraint
// helps, it is never the guarantee.

import { validateSchema } from "../analysis/schemas.js";
import { BEHAVIOUR_KINDS, TEST_GAP_TYPES, TEST_TYPES } from "./prompts.js";

const str = (maxLength, minLength = 1) => ({ type: "string", minLength, maxLength });
const labels = (pattern, max = 40) => ({ type: "array", items: { type: "string", pattern }, maxItems: max });
// Citation lists accept any context label; a label filed under the wrong list is re-filed by its prefix.
const cites = () => labels("^[FHCRNQA]\\d{1,5}$");
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const testsSchema = obj({
  tests: { type: "array", maxItems: 40, items: obj({
    behaviours: { ...labels("^B\\d{1,4}$", 20), minItems: 1 },
    criteria: { ...labels("^A\\d{1,4}$", 20), minItems: 1 },
    title: str(300), objective: str(2000),
    preconditions: { type: "array", maxItems: 20, items: str(1000) },
    steps: { type: "array", minItems: 1, maxItems: 30, items: obj({ action: str(1000), expected: str(1000, 0) }) },
    expected_result: str(2000),
    test_type: { type: "string", enum: TEST_TYPES },
    variation: str(300, 0),
    basis: { type: "string", enum: ["Explicit", "Inferred"] },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    source_ids: cites(), clarification_ids: cites(), scope_note_ids: cites(),
    rationale: str(2000),
  }) },
  gaps: { type: "array", maxItems: 20, items: obj({
    behaviour: { type: "string", pattern: "^B\\d{1,4}$" }, issue_type: { type: "string", enum: TEST_GAP_TYPES },
    description: str(2000), question: str(1000, 0),
  }) },
});

export const TEST_STAGE_SCHEMAS = {
  behaviours: obj({
    behaviours: { type: "array", maxItems: 40, items: obj({
      criteria: { ...labels("^A\\d{1,4}$", 20), minItems: 1 },
      statement: str(1000), kind: { type: "string", enum: BEHAVIOUR_KINDS }, variation: str(300, 0),
      source_ids: cites(), clarification_ids: cites(), scope_note_ids: cites(),
    }) },
    scope_notes: { type: "array", maxItems: 20, items: obj({ id: { type: "string", pattern: "^N\\d{1,5}$" }, relevant: { type: "boolean" }, reason: str(500, 0) }) },
  }),
  tests: testsSchema,
  coverage: testsSchema,
};

export { validateSchema };
