// JSON schemas for each model-facing stage, and a small strict validator for
// the subset of JSON Schema they use (no dependency). The same schema is sent
// to Ollama as `format` (constrained decoding) AND checked here — Ollama's
// constraint is a help, never the guarantee.

import { CATEGORIES, CLASSIFICATIONS, ISSUE_IMPACTS, ISSUE_TYPES, PRIORITIES, STATEMENT_TYPES } from "./prompts.js";

const str = (maxLength, minLength = 1) => ({ type: "string", minLength, maxLength });
const ids = { type: "array", items: { type: "string", pattern: "^F\\d{1,5}$" }, minItems: 1, maxItems: 40 };
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const requirementsSchema = obj({
  requirements: { type: "array", maxItems: 60, items: obj({
    title: str(300), description: str(4000), applies_to: str(300, 0), statement_type: { type: "string", enum: STATEMENT_TYPES },
    source_ids: ids, primary_source_id: { type: "string", pattern: "^F\\d{1,5}$" },
    source_quote: str(2000, 0), evidence_basis: { type: "string", enum: ["Explicit", "Inferred"] },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    category: { type: "string", enum: [...CATEGORIES, "Unknown"] }, priority: { type: "string", enum: [...PRIORITIES, "Not stated"] },
    rationale: str(2000),
  }) },
});

export const STAGE_SCHEMAS = {
  classification: obj({
    fragments: { type: "array", maxItems: 400, items: obj({ id: { type: "string", pattern: "^F\\d{1,5}$" }, classification: { type: "string", enum: CLASSIFICATIONS }, reason: str(300, 0) }) },
  }),
  requirements: requirementsSchema,
  // Stage 2b: statements the first pass left uncaptured (same item shape).
  coverage: requirementsSchema,
  ambiguities: obj({
    issues: { type: "array", maxItems: 20, items: obj({
      issue_type: { type: "string", enum: ISSUE_TYPES }, severity: { type: "string", enum: ["High", "Medium", "Low"] },
      impact: { type: "array", minItems: 1, maxItems: 7, items: { type: "string", enum: ISSUE_IMPACTS } },
      trigger_quote: str(400, 0), description: str(2000), suggested_question: str(1000), source_ids: ids,
      related_requirements: { type: "array", maxItems: 40, items: { type: "string", pattern: "^R\\d{1,4}$" } },
    }) },
  }),
  consolidation: obj({
    groups: { type: "array", maxItems: 200, items: obj({
      kind: { type: "string", enum: ["duplicate", "parts"] },
      members: { type: "array", minItems: 2, maxItems: 200, items: { type: "string", pattern: "^[RI]\\d{1,4}$" } },
      reason: str(500, 0), title: str(400, 0),
    }) },
  }),
  source_check: obj({
    checks: { type: "array", maxItems: 400, items: obj({
      key: { type: "string", pattern: "^I\\d{1,4}$" }, answered: { type: "boolean" },
      answer_id: { type: "string", pattern: "^(F\\d{1,5})?$" }, answer_quote: str(600, 0),
    }) },
  }),
};

/** Returns a list of "path: problem" strings; empty when `value` conforms to `schema`. */
export function validateSchema(schema, value, path = "$") {
  const errors = [];
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && schema.type !== type) return [`${path}: expected ${schema.type}, got ${type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(" | ")}`);
  if (type === "string") {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) errors.push(`${path}: must not be empty`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: "${value.slice(0, 40)}" is not a valid ID`);
  }
  if (type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(schema.items, item, `${path}[${i}]`)));
  }
  if (type === "object" && schema.properties) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    for (const [key, sub] of Object.entries(schema.properties)) if (key in value) errors.push(...validateSchema(sub, value[key], `${path}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected field`);
  }
  return errors;
}
