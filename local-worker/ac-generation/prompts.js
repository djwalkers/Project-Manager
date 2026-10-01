// Versioned Acceptance Criteria generation prompts (Phase 1E). A separate
// workflow from requirement analysis (analysis/prompts.js) with its own
// versions: every generation run records AC_PROMPT_VERSION and the SHA-256
// of the prompt text (acPromptFingerprint). Any change to the wording below
// MUST bump AC_PROMPT_VERSION — tests/ac-generation.test.mjs pins the
// fingerprint of each released version and fails if the text changes
// without a new version.
//
// 1.1.0: an open question no longer attaches to every criterion of the
// requirement. The criteria stage decides, for every open question, whether
// it BLOCKS a criterion (its expected result needs the answer), is related
// ADDITIONAL COVERAGE (an extra situation the criteria do not claim to
// cover), informational, or irrelevant; each criterion lists only the
// questions that block it.
//
// Nothing here is specific to any one project or document.

import { createHash } from "node:crypto";

export const AC_PROMPT_VERSION = "1.1.0";
export const AC_SCHEMA_VERSION = "1.1.0";
export const QUESTION_RELATIONS = ["blocking", "additional_coverage", "informational", "irrelevant"];

export const OBLIGATION_KINDS = ["positive", "negative", "regression"];
export const CRITERION_TYPES = ["Positive", "Negative", "Regression"];
export const GAP_TYPES = ["Missing Testable Outcome", "Missing Preconditions", "Ambiguous Expected Result", "Unresolved Existing Analysis Issue", "Conflicting Source/Resolution", "Insufficient Source Support"];

export const AC_SYSTEM_PROMPT = `You are a careful test analyst. You write ACCEPTANCE CRITERIA for ONE approved requirement of a software delivery team. Your output is a PROPOSAL that a human will review; it is never final.

Rules — follow them exactly:
1. Use only the REQUIREMENT, SOURCE, CLARIFICATIONS, OPEN QUESTIONS and SCOPE NOTES you are given. Never use outside knowledge about the company, system, project or people.
2. NO INVENTION. Never add screens, fields, statuses, workflows, error messages, roles, thresholds, timings, numbers, integrations, database behaviour or exception handling that the text does not state. If a criterion cannot be made testable without such a detail, report a gap instead. Example: the requirement says "The approver's name must be shown on the invoice." Correct criterion: "When an approved invoice is viewed, the approver's name is shown on it." Wrong: "The approver's name is shown within 2 seconds in bold at the top of the invoice."
3. An OPEN QUESTION is not a fact. Never write a criterion that assumes its answer, and never write a criterion for the unanswered situation itself. A CLARIFICATION is a human answer to an earlier question: it is authoritative and may be used.
4. Every item is labelled with an ID in square brackets — SOURCE fragments [F3], CLARIFICATIONS [C1], OPEN QUESTIONS [Q1], SCOPE NOTES [N1]. Cite only IDs that appear in the text you are given, exactly as written. Never make up an ID. Never assign acceptance criterion references such as AC-001.
5. Keep the source's own terms (screen names, field names, roles, record names). Do not rename things.
6. Respond with JSON only, matching the requested schema. No prose outside the JSON.`;

const KIND_GUIDE = `Kinds of obligation:
- "positive": behaviour or an outcome that must happen.
- "negative": something the text explicitly says must NOT happen, must not change, is not required or is prohibited (e.g. "X must not update", "No Y required on Z"). A "must not" clause inside a positive sentence is its own negative obligation (e.g. "the name must remain, and not be replaced by the editor's name" → a positive obligation AND a negative one).
- "regression": an existing area or behaviour the text (or an acknowledged SCOPE NOTE) says must remain unchanged. Only when the text or a SCOPE NOTE says so — never as a generic "nothing else breaks" check.`;

export function obligationsPrompt({ requirementText, sourceText, referencedText, clarificationsText, openQuestionsText, scopeNotesText }) {
  return `TASK: list every distinct obligation in this REQUIREMENT that needs acceptance coverage — what a tester must be able to observe to prove the requirement is satisfied.

Guidance:
- Work through the requirement clause by clause. Separate obligations about different records, screens, reports, exports, users or processes. Do not split one obligation just because it is stated in two places, and do not count sentences: one sentence can hold two obligations, and two sentences can state one.
- SOURCE shows the sentences of the requirement's source fragments that state THIS requirement. Every obligation must belong to THIS requirement — never add obligations about other requirements of the same document.
- For EVERY SCOPE NOTE, decide in scope_notes whether it is relevant to this requirement: relevant = true only if it concerns the same application, process or records this requirement changes; give a one-sentence reason. For each relevant note, add a "regression" obligation citing it.
- REFERENCED CONTEXT (when present) only explains what words such as "this" or "it" in SOURCE refer to. Use it to understand the requirement; never add an obligation that comes only from it.
- ${KIND_GUIDE.replace(/\n/g, "\n  ")}
- statement: the obligation in one sentence, in the source's own terms.
- source_ids: the SOURCE fragments that state it. scope_note_ids / clarification_ids: SCOPE NOTES or CLARIFICATIONS it relies on. open_question_ids: OPEN QUESTIONS about this obligation ([] if none) — for information only.
- source_quote: the words from SOURCE (copied word-for-word, at most 300 characters) that state it, or "" if it comes only from a SCOPE NOTE or CLARIFICATION.

REQUIREMENT:
${requirementText}

SOURCE (the sentences that state this requirement):
${sourceText}

REFERENCED CONTEXT (explains references in SOURCE; not obligations):
${referencedText || "(none)"}

CLARIFICATIONS (authoritative human answers):
${clarificationsText || "(none)"}

OPEN QUESTIONS (unanswered — not facts):
${openQuestionsText || "(none)"}

SCOPE NOTES (acknowledged — areas that must stay unchanged):
${scopeNotesText || "(none)"}

Return {"obligations":[{"statement":"…","kind":"positive|negative|regression","source_ids":["F…"],"scope_note_ids":["N…"],"clarification_ids":["C…"],"open_question_ids":["Q…"],"source_quote":"…"}],"scope_notes":[{"id":"N…","relevant":true|false,"reason":"…"}]}.`;
}

const CRITERIA_GUIDANCE = `Guidance:
- Write at least one acceptance criterion for every OBLIGATION, unless it cannot be made testable — then report a gap for it instead (never fill the gap yourself).
- When SOURCE refers to something with "this" or "it", use REFERENCED CONTEXT to state concretely what must be observed.
- A good criterion is specific, observable and testable: it names the screen, record, report or export concerned and the result a tester can check. It answers "what observable result proves this obligation is satisfied?". Prefer the outcome over how it is implemented.
- Never write vague criteria such as "works correctly", "behaves as expected", "is updated correctly", "the user can use the feature".
- When the REQUIREMENT applies to several applications or screens (e.g. "Applies to: …"), every one of them must be covered, and each criterion names the application(s) it checks.
- One criterion per distinct observable result. Do not write two criteria that check the same thing; do not merge results about different records, screens, applications or users.
- given / when / then: the precondition or context, the action or event, and the expected observable result, in the source's terms. Use "" for a part the text does not support — never invent a precondition or action. criterion: the whole criterion as one plain sentence.
- criterion_type: "Positive" for a positive obligation, "Negative" for a negative one, "Regression" for a regression one.
- basis: "Explicit" when the SOURCE, a CLARIFICATION or a SCOPE NOTE directly states the expected result (source_quote copied word-for-word from SOURCE, or "" when it rests on a CLARIFICATION or SCOPE NOTE); "Inferred" when you interpreted the text to make it testable.
- confidence: High (directly stated), Medium (clear intent, some interpretation), Low (uncertain).
- obligations: the OBLIGATION keys it covers (e.g. ["O1"]). source_ids / scope_note_ids / clarification_ids: what it relies on.
- blocking_question_ids: ONLY the OPEN QUESTIONS without whose answer THIS criterion's expected result cannot be stated correctly ([] almost always). A question about a different or additional situation does not block a criterion that does not claim to cover that situation.
- questions: decide for EVERY OPEN QUESTION how it relates to the criteria, with a one-sentence reason:
  - "blocking": a criterion's expected result depends on the answer (e.g. the text says a list must be sorted but not in which order — the expected order cannot be stated). List it in that criterion's blocking_question_ids.
  - "additional_coverage": related, but about an extra situation the criteria do not claim to cover (e.g. what happens when the process is repeated, reversed, or involves several people or records). The proposed criteria stay correct; a further criterion may be needed once it is answered.
  - "informational": related background that changes no expected result.
  - "irrelevant": not about this requirement.
- rationale: one sentence on why this proves the obligation, citing the wording.
- gaps: for an obligation that cannot be made testable from the text — issue_type one of: ${GAP_TYPES.join(", ")}; description of what is missing; question: ONE specific question naming the screen, record or rule concerned, ending with "?".`;

const CRITERIA_SHAPE = `{"criteria":[{"obligations":["O…"],"criterion":"…","given":"…","when":"…","then":"…","criterion_type":"Positive|Negative|Regression","basis":"Explicit|Inferred","confidence":"High|Medium|Low","source_ids":["F…"],"scope_note_ids":["N…"],"clarification_ids":["C…"],"blocking_question_ids":["Q…"],"source_quote":"…","rationale":"…"}],"gaps":[{"obligation":"O…","issue_type":"…","description":"…","question":"…?"}],"questions":[{"id":"Q…","relation":"blocking|additional_coverage|informational|irrelevant","reason":"…"}]}`;

export function criteriaPrompt({ requirementText, obligationsText, sourceText, referencedText, clarificationsText, openQuestionsText, scopeNotesText }) {
  return `TASK: write the acceptance criteria for this REQUIREMENT, covering every OBLIGATION.

${CRITERIA_GUIDANCE}

REQUIREMENT:
${requirementText}

OBLIGATIONS:
${obligationsText}

SOURCE (the sentences that state this requirement):
${sourceText}

REFERENCED CONTEXT (explains references in SOURCE; not obligations):
${referencedText || "(none)"}

CLARIFICATIONS (authoritative human answers):
${clarificationsText || "(none)"}

OPEN QUESTIONS (unanswered — not facts):
${openQuestionsText || "(none)"}

SCOPE NOTES (acknowledged — areas that must stay unchanged):
${scopeNotesText || "(none)"}

Return ${CRITERIA_SHAPE}.`;
}

export function coveragePrompt({ requirementText, obligationsText, sourceText, referencedText, clarificationsText, openQuestionsText, scopeNotesText }) {
  return `TASK: these OBLIGATIONS of the REQUIREMENT have no acceptance criterion yet. Write the missing criteria, or report a gap for an obligation that cannot be made testable from the text.

${CRITERIA_GUIDANCE}

REQUIREMENT:
${requirementText}

UNCOVERED OBLIGATIONS:
${obligationsText}

SOURCE (the sentences that state this requirement):
${sourceText}

REFERENCED CONTEXT (explains references in SOURCE; not obligations):
${referencedText || "(none)"}

CLARIFICATIONS (authoritative human answers):
${clarificationsText || "(none)"}

OPEN QUESTIONS (unanswered — not facts):
${openQuestionsText || "(none)"}

SCOPE NOTES (acknowledged — areas that must stay unchanged):
${scopeNotesText || "(none)"}

Return ${CRITERIA_SHAPE}.`;
}

/** SHA-256 of every prompt template of this version — recorded on each run. */
export function acPromptFingerprint() {
  const sample = { requirementText: "{requirement}", sourceText: "{source}", referencedText: "{referenced}", clarificationsText: "{clarifications}", openQuestionsText: "{questions}", scopeNotesText: "{notes}", obligationsText: "{obligations}" };
  const text = [AC_PROMPT_VERSION, AC_SCHEMA_VERSION, AC_SYSTEM_PROMPT, obligationsPrompt(sample), criteriaPrompt(sample), coveragePrompt(sample)].join("\n\u0000\n");
  return createHash("sha256").update(text).digest("hex");
}
