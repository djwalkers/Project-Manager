// Versioned analysis prompts (Phase 1C). These are production artefacts:
// every analysis run records PROMPT_VERSION and the SHA-256 of the prompt
// text (promptFingerprint). Any change to the wording below MUST bump
// PROMPT_VERSION — tests/analysis.test.mjs pins the fingerprint of each
// released version and fails if the text changes without a new version.
//
// Nothing here is specific to any one project or document: the rules
// describe source *formats* (issue-tracker exports, structured
// specifications) generically.

import { createHash } from "node:crypto";

export const PROMPT_VERSION = "1.0.0";
export const ANALYSIS_SCHEMA_VERSION = "1.0.0";

export const CLASSIFICATIONS = ["requirement", "metadata", "context", "benefit", "test_information", "template_admin", "unknown"];
export const ISSUE_TYPES = ["Ambiguity", "Missing Information", "Contradiction", "Untestable Statement", "Assumption Required", "Duplicate / Repeated Requirement", "Out of Scope / Administrative Content"];
export const CATEGORIES = ["Business Rule", "Database", "Backend", "UI", "Performance", "Testing"];
export const PRIORITIES = ["Low", "Medium", "High", "Critical"];

export const SYSTEM_PROMPT = `You are a careful business analyst. You analyse ONE source document for a software delivery team, one part at a time. Your output is a PROPOSAL that a human will review; it is never final.

Rules — follow them exactly:
1. Use only the SOURCE and CONTEXT text you are given. Never use outside knowledge about the company, system, project or people.
2. NO INVENTION. Never fill a gap with plausible behaviour. If the text does not say what happens in a situation, that is an open question (an issue), not a requirement. Example: the text says "The approver's name must be shown on the invoice." It does not say what happens when an invoice is re-issued. Correct: raise Missing Information — "What approver name should a re-issued invoice show?". Wrong: a requirement "The system shall keep the original approver on re-issued invoices."
3. Every fragment is labelled with an ID in square brackets, e.g. [F3]. Cite only IDs that appear in the text you are given, exactly as written. Never make up an ID. Never invent requirement references such as REQ-001.
4. Keep the source's own terms (screen names, field names, roles). Do not rename things or add detail.
5. Respond with JSON only, matching the requested schema. No prose outside the JSON.`;

const FORMAT_NOTES = `About source formats:
- Issue-tracker / change-request exports list fields such as Status, Priority, Reporter, Assignee, Created, Labels, Components, links and epics. These fields are METADATA (context), never requirements by themselves. A Priority field may inform a requirement's priority but is not a requirement.
- Template headings with instructions or placeholder text that was never filled in (e.g. formatting instructions, "describe here") are template/admin content, not requirements.
- Business benefit, justification or "estimated gains" text explains WHY; it is context, not a requirement.
- The same requirement is often repeated in different sections (e.g. a summary and a detailed description). Treat each statement on its own here; repeats are consolidated later.
- Structured specifications: headings and numbered statements under them usually are requirement content. Neighbouring statements may be one requirement or several, depending on meaning.
- Project plans, deadlines, delivery dates and test schedules are not requirements.`;

export function classificationPrompt({ outline, sourceText }) {
  return `TASK: classify every fragment of this part of the document.

Classifications:
- requirement: states behaviour, a rule, a change or a constraint the system or business must satisfy ("must", "shall", "should", "we require", "needs to", a numbered business statement, a change description of current vs required behaviour, or an explicit statement that some named behaviour must stay unchanged). If a fragment contains ANY such statement, classify it requirement.
- metadata: document or issue-tracker fields (status, priority field, people, dates, IDs, labels, versions, links, epics, sprint).
- context: background or description of the current situation, with no required behaviour.
- benefit: business benefit, justification or expected gains.
- test_information: test approach, test steps, test evidence or test dates.
- template_admin: unfilled template text, instructions to the author, placeholders, formatting notes, project plans, deadlines and administrative notes.
- unknown: none of the above fits.

${FORMAT_NOTES}

DOCUMENT OUTLINE (section headings, for orientation only):
${outline}

SOURCE:
${sourceText}

Return {"fragments":[{"id":"F…","classification":"…","reason":"…"}]} with exactly one entry for every fragment ID in SOURCE. Keep each reason under 20 words.`;
}

export function requirementsPrompt({ sourceText, contextText }) {
  return `TASK: identify each distinct requirement stated in the SOURCE fragments.

Guidance:
- Work through the SOURCE sentence by sentence and clause by clause. Every sentence that states a required behaviour, outcome or constraint must be covered by a requirement. Do not stop after the main statement: secondary statements (e.g. about other records, other users, reports or exports, or behaviour that must stay unchanged) are requirements too.
- One requirement = one independently testable behaviour or rule. Statements about different things (different records, users, screens, reports, data or processes) are separate requirements. Split a sentence that states several independently testable behaviours; keep together what is one rule.
- An explicit statement that a named existing behaviour must remain unchanged IS a requirement (it protects that behaviour).
- evidence_basis:
  - "Explicit" — the SOURCE directly states this behaviour. source_quote MUST be copied word-for-word from the primary fragment (at most 300 characters).
  - "Inferred" — a reasonable interpretation needed to make the source testable, but NOT directly stated. Use this sparingly and never to answer an open question. source_quote is the nearest supporting words, copied word-for-word.
- title: a short summary (at most 12 words). description: restate the requirement faithfully in the source's own terms — add no conditions, examples, error handling or behaviour the source does not state.
- category: one of ${CATEGORIES.join(", ")} only when clearly appropriate, otherwise "Unknown".
- priority: one of ${PRIORITIES.join(", ")} only when the SOURCE or CONTEXT explicitly states a priority that applies; otherwise "Not stated". If different priorities are stated, use "Not stated".
- source_ids: every fragment that states or directly supports this requirement (SOURCE IDs, plus CONTEXT IDs only if they support it, e.g. a priority field). primary_source_id: the SOURCE fragment that states it most directly.
- confidence: High (clear, unambiguous statement), Medium (clear intent, some interpretation), Low (uncertain).
- rationale: one sentence on why this is a requirement, citing the wording.
- Metadata, benefit statements, template text, plans and dates are NOT requirements. If SOURCE states no requirements, return an empty list.

${FORMAT_NOTES}

CONTEXT (not requirements; may inform priority or meaning):
${contextText || "(none)"}

SOURCE:
${sourceText}

Return {"requirements":[{"title":"…","description":"…","source_ids":["F…"],"primary_source_id":"F…","source_quote":"…","evidence_basis":"Explicit|Inferred","confidence":"High|Medium|Low","category":"…","priority":"…","rationale":"…"}]}.`;
}

export function ambiguitiesPrompt({ sourceText, contextText, requirementsText }) {
  return `TASK: find what a tester or developer could NOT decide from this text alone — the questions that must be answered before acceptance tests can be written.

Issue types:
- Ambiguity: wording that can reasonably be read in more than one way.
- Missing Information: a situation, scope, data item or rule the text leaves unstated (e.g. which records, screens, reports or exports are in scope; what happens in an edge case; whether existing data is affected).
- Contradiction: two statements (or a statement and a field) that conflict.
- Untestable Statement: a statement with no observable, checkable outcome.
- Assumption Required: something a tester would have to assume to proceed.
- Out of Scope / Administrative Content: content that looks like a requirement but is administrative or outside the change.

Check each requirement against these areas and raise an issue for each one the text leaves open:
- Scope: exactly which screens, records, reports, exports, extracts or interfaces are included (words like "any", "all", "etc." usually need a list).
- Definitions: terms, fields or records whose exact meaning or content is not defined.
- Lifecycle and edge cases: what happens when the item is changed, reversed, repeated, re-processed or reworked, or when a step fails.
- Existing data: whether records created before the change must be corrected or migrated.
- Conflicts: statements or fields (e.g. two different priorities or dates) that disagree.
- Acceptance: what observable result proves the requirement is met.

Rules:
- Only raise an issue that the SOURCE and CONTEXT genuinely leave open. Before raising an issue, check that no sentence in SOURCE or CONTEXT already answers it; if one does, do not raise it.
- Do not raise several issues that ask the same question in different words.
- Do not answer the question yourself and do not propose behaviour.
- description: what is unclear or missing, in one or two sentences, citing the wording. suggested_question: one question to ask the business, ending with "?".
- severity: High (blocks writing tests or could cause wrong behaviour), Medium (needs a decision before build/test), Low (clarification).
- source_ids: the fragment IDs the issue is about. related_requirements: keys from REQUIREMENTS (e.g. "R2") the issue affects, or [].
- Raise at most 8 issues, most important first. If there is nothing genuinely open, return an empty list.

CONTEXT (metadata / background):
${contextText || "(none)"}

REQUIREMENTS already identified from this part (for reference):
${requirementsText || "(none)"}

SOURCE:
${sourceText}

Return {"issues":[{"issue_type":"…","severity":"High|Medium|Low","description":"…","suggested_question":"…?","source_ids":["F…"],"related_requirements":["R…"]}]}.`;
}

export function consolidationPrompt({ kind, itemsText }) {
  const noun = kind === "requirements" ? "requirement candidates" : "issues";
  return `TASK: these ${noun} were found in different parts of the same document. Find the groups of items that say the SAME thing (the same behaviour or the same question), even if worded differently or found in different sections.

Rules:
- Group only true duplicates: items are duplicates only if ONE test would verify all of them. If in doubt, leave them out.
- Items that are merely related — about the same screen, process, record or user but requiring different behaviour or a different outcome — are NOT duplicates.
- List ONLY groups of two or more duplicates. Do not list unique items; any item you do not list is treated as unique. Most items are unique; an empty list is a normal answer.
- An item may appear in at most one group.
- reason: one short sentence on why the members are the same.
- title: a short title (at most 12 words) that covers every member of the group, using their own words — do not name only one member's section.

ITEMS:
${itemsText}

Return {"duplicates":[{"members":["…","…"],"reason":"…","title":"…"}]}.`;
}

/** SHA-256 of every prompt template of this version — recorded on each run. */
export function promptFingerprint() {
  const sample = { outline: "{outline}", sourceText: "{source}", contextText: "{context}", requirementsText: "{requirements}", itemsText: "{items}" };
  const text = [
    PROMPT_VERSION, ANALYSIS_SCHEMA_VERSION, SYSTEM_PROMPT,
    classificationPrompt(sample), requirementsPrompt(sample), ambiguitiesPrompt(sample),
    consolidationPrompt({ kind: "requirements", ...sample }), consolidationPrompt({ kind: "issues", ...sample }),
  ].join("\n\u0000\n");
  return createHash("sha256").update(text).digest("hex");
}
