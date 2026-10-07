// Versioned test-design prompts (Phase 1G). A separate workflow from
// requirement analysis and AC generation, with its own versions: every test
// generation run records TEST_PROMPT_VERSION and the SHA-256 of the prompt
// text (testPromptFingerprint). Any change to the wording below MUST bump
// TEST_PROMPT_VERSION — tests/test-generation.test.mjs pins the fingerprint.
//
// The model sees ONE Requirement and the canonical Acceptance Criteria it
// is asked to design tests for, plus the governed context those criteria
// rely on. It never sees existing test cases. Nothing here is specific to
// any one project or document.

import { createHash } from "node:crypto";

export const TEST_PROMPT_VERSION = "1.0.0";
export const TEST_SCHEMA_VERSION = "1.0.0";
export const BEHAVIOUR_KINDS = ["positive", "negative", "regression"];
export const TEST_TYPES = ["Positive", "Negative", "Regression"];
export const TEST_GAP_TYPES = ["Missing Test Detail", "Ambiguous Expected Result", "Insufficient Source Support", "Conflicting Context"];

export const TEST_SYSTEM_PROMPT = `You are a careful software test designer. You design MANUAL TEST CASES for the approved ACCEPTANCE CRITERIA of ONE requirement of a software delivery team. Your output is a PROPOSAL that a human will review; it is never final.

Rules — follow them exactly:
1. Use only the REQUIREMENT, ACCEPTANCE CRITERIA, SOURCE, HUMAN CLARIFICATIONS, CLARIFICATIONS, RESOLVED QUESTIONS and SCOPE NOTES you are given. Never use outside knowledge about the company, system, project or people.
2. The ACCEPTANCE CRITERIA are authoritative. Every test proves one or more of them.
3. NO INVENTION. Never add screens, buttons, menus, tabs, fields, roles, users, values, error messages, timings, integrations or workflow steps that the text does not state. When a step needs a detail the text does not give, describe it in the text's own terms (e.g. "Open the screen that shows the pick task" when the text names no screen), or report a gap. Example: the criterion says "The approver's name is shown on the approved invoice." Correct step: "Open an invoice that has been approved." Wrong: "Click the green 'Approve' button on the Invoices tab, then wait 2 seconds."
4. An OPEN QUESTION is not a fact. Never design a test that assumes its answer or that tests the unanswered situation. HUMAN CLARIFICATIONS and RESOLVED QUESTIONS are authoritative human answers and may be used.
5. Every item is labelled with an ID in square brackets — ACCEPTANCE CRITERIA [A1], SOURCE fragments [F3], HUMAN CLARIFICATIONS [H1], CLARIFICATIONS [C1], RESOLVED QUESTIONS [R1], SCOPE NOTES [N1], OPEN QUESTIONS [Q1]. Cite only IDs that appear in the text you are given, exactly as written. Never make up an ID. Never assign test references such as TC-001.
6. Keep the text's own terms (screen names, field names, roles, record names). Do not rename things.
7. Respond with JSON only, matching the requested schema. No prose outside the JSON.`;

const CONTEXT = ({ requirementText, criteriaText, sourceText, humanText, clarificationsText, resolvedText, scopeNotesText, openQuestionsText }) => `REQUIREMENT:
${requirementText}

ACCEPTANCE CRITERIA (authoritative — every test proves at least one):
${criteriaText}

SOURCE (the sentences of the source document these criteria come from, when available):
${sourceText || "(none — the acceptance criteria text is the authority)"}

HUMAN CLARIFICATIONS (authoritative answers recorded by a reviewer):
${humanText || "(none)"}

CLARIFICATIONS (authoritative human answers from the requirement analysis):
${clarificationsText || "(none)"}

RESOLVED QUESTIONS (answered by a reviewer):
${resolvedText || "(none)"}

SCOPE NOTES (areas that must stay unchanged — regression context):
${scopeNotesText || "(none)"}

OPEN QUESTIONS (unanswered — NOT facts; never design a test for them):
${openQuestionsText || "(none)"}`;

export function behavioursPrompt(ctx) {
  return `TASK: decompose the ACCEPTANCE CRITERIA into the distinct testable BEHAVIOURS a tester must observe.

Guidance:
- Work criterion by criterion. One behaviour per distinct observable result. A criterion that names several actors, applications, screens, records or data states that are tested separately yields one behaviour for each — but only those the text names. Do not invent variations.
- kind: "positive" (must happen), "negative" (must NOT happen / is prohibited / is not required — only when the text says so), "regression" (must remain unchanged — only when a criterion or a SCOPE NOTE says so).
- variation: the actor, application, screen or data state this behaviour is about, in the text's own words ("" when the criterion has none).
- statement: the behaviour in one sentence, in the text's own terms.
- criteria: the ACCEPTANCE CRITERIA it comes from (e.g. ["A1"]). source_ids / clarification_ids / scope_note_ids: what else it relies on (F…, H…/C…/R…, N…).
- For EVERY SCOPE NOTE, decide in scope_notes whether it applies to these criteria: relevant = true only if it concerns the same application, process or records; give a one-sentence reason. A relevant note gets ONE regression behaviour (not one per criterion).

${CONTEXT(ctx)}

Return {"behaviours":[{"criteria":["A…"],"statement":"…","kind":"positive|negative|regression","variation":"…","source_ids":["F…"],"clarification_ids":["H…"],"scope_note_ids":["N…"]}],"scope_notes":[{"id":"N…","relevant":true|false,"reason":"…"}]}.`;
}

const TEST_GUIDANCE = `Guidance:
- Design the tests needed to prove every BEHAVIOUR. One test may cover several behaviours when ONE procedure observes all of them; use separate tests when behaviours concern different actors, applications or outcomes (a failure must point to one cause). Do not write two tests that check the same thing. Do not pad: no speculative edge cases.
- title: short and specific. objective: what the test proves, in one sentence.
- preconditions: the state that must exist before the test, in the text's terms ([] when the text gives none). Never invent data values, users or configuration.
- steps: numbered actions a tester performs, each with the expected observation where there is one ("" when a step has none). Use the text's own screen, record and role names. Do not name buttons, menus, fields or screens the text does not name. A test must have a real procedure — not just the criterion restated.
- expected_result: the final observable result that proves the behaviour, specific and checkable. Never "works correctly", "as expected", "is correct".
- test_type: "Positive", "Negative" (proves something does not happen / is refused) or "Regression" (proves something unchanged still behaves as before — only for regression behaviours).
- variation: the actor, application or data state this test covers ("" for none).
- basis: "Explicit" when the criteria / clarifications directly state the expected result; "Inferred" when you interpreted them to make a procedure. confidence: High / Medium / Low.
- behaviours: the BEHAVIOUR keys it proves (e.g. ["B1"]). criteria: the ACCEPTANCE CRITERIA it traces to. source_ids / clarification_ids / scope_note_ids: what it relies on.
- rationale: one sentence on why this proves the behaviour.
- gaps: for a behaviour that cannot be tested from the text without inventing detail — issue_type one of: ${TEST_GAP_TYPES.join(", ")}; description of what is missing; question: ONE specific question ending with "?".`;

const TEST_SHAPE = `{"tests":[{"behaviours":["B…"],"criteria":["A…"],"title":"…","objective":"…","preconditions":["…"],"steps":[{"action":"…","expected":"…"}],"expected_result":"…","test_type":"Positive|Negative|Regression","variation":"…","basis":"Explicit|Inferred","confidence":"High|Medium|Low","source_ids":["F…"],"clarification_ids":["H…"],"scope_note_ids":["N…"],"rationale":"…"}],"gaps":[{"behaviour":"B…","issue_type":"…","description":"…","question":"…?"}]}`;

export function testsPrompt(ctx) {
  return `TASK: design the manual test cases that prove every BEHAVIOUR below.

${TEST_GUIDANCE}

BEHAVIOURS:
${ctx.behavioursText}

${CONTEXT(ctx)}

Return ${TEST_SHAPE}.`;
}

export function coveragePrompt(ctx) {
  return `TASK: these BEHAVIOURS have no test case yet. Design the missing tests, or report a gap for a behaviour that cannot be tested from the text without inventing detail.

${TEST_GUIDANCE}

UNCOVERED BEHAVIOURS:
${ctx.behavioursText}

${CONTEXT(ctx)}

Return ${TEST_SHAPE}.`;
}

/** SHA-256 of every prompt template of this version — recorded on each run. */
export function testPromptFingerprint() {
  const sample = { requirementText: "{requirement}", criteriaText: "{criteria}", sourceText: "{source}", humanText: "{human}", clarificationsText: "{clarifications}",
    resolvedText: "{resolved}", scopeNotesText: "{notes}", openQuestionsText: "{questions}", behavioursText: "{behaviours}" };
  const text = [TEST_PROMPT_VERSION, TEST_SCHEMA_VERSION, TEST_SYSTEM_PROMPT, behavioursPrompt(sample), testsPrompt(sample), coveragePrompt(sample)].join("\n\u0000\n");
  return createHash("sha256").update(text).digest("hex");
}
