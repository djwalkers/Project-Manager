// Versioned analysis prompts (Phase 1C). These are production artefacts:
// every analysis run records PROMPT_VERSION and the SHA-256 of the prompt
// text (promptFingerprint). Any change to the wording below MUST bump
// PROMPT_VERSION — tests/analysis.test.mjs pins the fingerprint of each
// released version and fails if the text changes without a new version.
// Earlier versions live in git history; runs that used them keep their
// recorded version and fingerprint.
//
// 2.0.0 (quality hardening): statement types (behaviour / constraint /
// no-change scope note), explicit negative constraints, obligation-based
// categories, a coverage pass for uncaptured statements, typed
// consolidation (duplicate vs parts of one requirement), and a material-
// only issue gate with a source trigger, an impact and a whole-document
// "already answered?" check.
//
// Nothing here is specific to any one project or document: the rules
// describe source *formats* (issue-tracker exports, structured
// specifications) generically.

import { createHash } from "node:crypto";

export const PROMPT_VERSION = "2.0.0";
export const ANALYSIS_SCHEMA_VERSION = "2.0.0";

export const CLASSIFICATIONS = ["requirement", "metadata", "context", "benefit", "test_information", "template_admin", "unknown"];
export const ISSUE_TYPES = ["Ambiguity", "Missing Information", "Contradiction", "Untestable Statement", "Assumption Required", "Duplicate / Repeated Requirement", "Out of Scope / Administrative Content"];
export const CATEGORIES = ["Business Rule", "Database", "Backend", "UI", "Performance", "Testing"];
export const PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const STATEMENT_TYPES = ["behaviour", "constraint", "no_change"];
export const ISSUE_IMPACTS = ["implementation", "test_design", "acceptance_criteria", "data_migration", "integration", "scope", "operational"];

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

const CATEGORY_GUIDE = `category — classify by the NATURE of the obligation, not by where it will be seen:
- "Business Rule": defaulting rules, role- or flag-driven behaviour (who may do what), relationships and constraints between data items, calculation or decision rules.
- "Database": adding or changing a table, column, field or flag in the data model; stored master data.
- "Backend": scheduled jobs, batch processing, interfaces/integrations, server-side processing.
- "UI": what a screen displays, filters, sorts or lets the user select, where no deeper rule is involved.
- "Performance": speed, volume or capacity obligations. "Testing": obligations about testing itself.
- "Unknown" when none fits clearly.`;

const STATEMENT_GUIDE = `statement_type:
- "behaviour": something the system must do or show.
- "constraint": an explicit NEGATIVE or limiting requirement that defines intended behaviour of a named screen, field, job or process — e.g. "No <feature> required on <screen>", "<X> must not <do Y>", "<field> shall not be changeable", "<X> is not required". These ARE requirements: capture them.
- "no_change": the source says a named area, application or behaviour needs NO CHANGE / remains as it is / is unchanged (e.g. "No change required", "<area> remains as is"). This is scope/regression information, not a new requirement. Still capture it, citing the area it applies to.
Do not confuse the two: "No change required" (a whole area left alone) is no_change; "No <specific thing> required" (a specific capability deliberately absent) is a constraint.`;

export function classificationPrompt({ outline, sourceText }) {
  return `TASK: classify every fragment of this part of the document.

Classifications:
- requirement: states behaviour, a rule, a change or a constraint the system or business must satisfy ("must", "shall", "should", "we require", "needs to", a numbered business statement, a change description of current vs required behaviour, an explicit negative constraint, or an explicit statement that some named area needs no change). If a fragment contains ANY such statement, classify it requirement.
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

const REQUIREMENT_GUIDANCE = `Guidance:
- Work through the SOURCE sentence by sentence, list item by list item, clause by clause. Every sentence that states a required behaviour, outcome, negative constraint or "no change" must be covered by an item. Do not stop after the main statement: secondary statements (about other records, users, screens, reports or exports, behaviour that must stay unchanged, or capabilities that are deliberately NOT required) are items too.
- One item = one independently testable obligation. Statements about different things (different records, users, screens, reports, data or processes) are separate items.
- If the SAME obligation is stated in more than one SOURCE fragment (e.g. a summary and a detailed description, or two pages), return it ONCE: cite every fragment that states it in source_ids, and make the description include every distinct detail that any of them adds (e.g. an extra export or screen mentioned only in one).
- ${STATEMENT_GUIDE.replace(/\n/g, "\n  ")}
- evidence_basis:
  - "Explicit" — the SOURCE directly states this. source_quote MUST be copied word-for-word from the primary fragment (at most 300 characters).
  - "Inferred" — a reasonable interpretation needed to make the source testable, but NOT directly stated. Use this sparingly and never to answer an open question. source_quote is the nearest supporting words, copied word-for-word.
- applies_to: the specific screen, record, list, field, job or process the obligation operates on, in the source's own words (e.g. "suggested moves display", "palletised pick task", "Loading Dashboard plant field").
- title: a short summary (at most 12 words) naming the screen/area it applies to. description: restate the obligation faithfully in the source's own terms, naming the screen/area — add no conditions, examples, error handling or behaviour the source does not state.
- ${CATEGORY_GUIDE.replace(/\n/g, "\n  ")}
- priority: one of ${PRIORITIES.join(", ")} only when the SOURCE or CONTEXT explicitly states a priority that applies; otherwise "Not stated". If different priorities are stated, use "Not stated".
- source_ids: every fragment that states or directly supports this item (SOURCE IDs, plus CONTEXT IDs only if they support it, e.g. a priority field). primary_source_id: the SOURCE fragment that states it most directly.
- confidence: High (clear, unambiguous statement), Medium (clear intent, some interpretation), Low (uncertain).
- rationale: one sentence on why this is an obligation, citing the wording.
- Metadata, benefit statements, template text, plans and dates are NOT items. If SOURCE states none, return an empty list.`;

const REQUIREMENT_SHAPE = `{"requirements":[{"title":"…","description":"…","applies_to":"…","statement_type":"behaviour|constraint|no_change","source_ids":["F…"],"primary_source_id":"F…","source_quote":"…","evidence_basis":"Explicit|Inferred","confidence":"High|Medium|Low","category":"…","priority":"…","rationale":"…"}]}`;

export function requirementsPrompt({ sourceText, contextText }) {
  return `TASK: identify each distinct requirement, negative constraint and no-change statement in the SOURCE fragments.

${REQUIREMENT_GUIDANCE}

${FORMAT_NOTES}

CONTEXT (not requirements; may inform priority or meaning):
${contextText || "(none)"}

SOURCE:
${sourceText}

Return ${REQUIREMENT_SHAPE}.`;
}

export function coveragePrompt({ statementsText, contextText }) {
  return `TASK: the statements below come from the SOURCE but no requirement was captured for them yet. For each statement that states a requirement, a negative constraint or a no-change, return an item. Statements that are plans, dates, headings or administrative notes need no item.

${REQUIREMENT_GUIDANCE}

CONTEXT (not requirements; may inform priority or meaning):
${contextText || "(none)"}

UNCAPTURED STATEMENTS (each shown with the fragment it comes from):
${statementsText}

Return ${REQUIREMENT_SHAPE} — an empty list if none of the statements is an obligation.`;
}

export function ambiguitiesPrompt({ sourceText, contextText, requirementsText }) {
  return `TASK: find the questions that MUST be answered before this can be built and tested correctly — gaps a business analyst would genuinely raise with the customer.

An issue qualifies ONLY if the answer could materially change at least one of: implementation, test design, acceptance criteria, data migration, integration behaviour, scope, or operational behaviour. Name that as its impact.

Issue types:
- Ambiguity: specific wording that can reasonably be read in more than one way.
- Missing Information: a specific scope, data item, value set or rule the text leaves unstated — for example: which values a field can hold and how they order; which named screens, reports or exports are included when the text says "all" or "any"; whether records created before the change must be corrected; what the required result is when the process the text describes is repeated, reversed or reworked, or involves more than one of the people or records it names.
- Contradiction: two statements (or a statement and a field) that conflict.
- Untestable Statement: a statement with no observable, checkable outcome.
- Assumption Required: something a tester would have to assume to proceed.

Do NOT raise:
- generic questions that could be asked of any system, with nothing in the SOURCE pointing to them: "what happens on error?", "what if the data is invalid?", "what about edge cases?", "what if it fails?";
- speculative situations that nothing in the SOURCE points to;
- questions that any sentence in SOURCE or CONTEXT already answers;
- several issues asking the same question in different words;
- issues about metadata, dates or plans.

For every issue:
- trigger_quote: the exact words from SOURCE (copied word-for-word, at most 200 characters) that create the question.
- impact: one or more of ${ISSUE_IMPACTS.join(", ")}.
- description: what is unclear or missing, in one or two sentences, citing the wording.
- suggested_question: ONE specific question a business analyst or customer can answer, naming the screen, field, record or rule concerned, ending with "?". Good: "Which temperature values are supported, and in what order must they sort?". Bad: "What happens in edge cases?".
- severity: High (blocks writing tests or could cause wrong behaviour), Medium (needs a decision before build/test), Low (clarification).
- source_ids: the fragment IDs the issue is about. related_requirements: keys from REQUIREMENTS (e.g. "R2") the issue affects, or [].
Raise at most 5 issues, most important first. An empty list is a normal, good answer.

CONTEXT (metadata / background):
${contextText || "(none)"}

REQUIREMENTS already identified from this part (for reference):
${requirementsText || "(none)"}

SOURCE:
${sourceText}

Return {"issues":[{"issue_type":"…","severity":"High|Medium|Low","impact":["…"],"trigger_quote":"…","description":"…","suggested_question":"…?","source_ids":["F…"],"related_requirements":["R…"]}]}.`;
}

export function consolidationPrompt({ kind, itemsText }) {
  if (kind === "issues") {
    return `TASK: these open questions were raised in different parts of the same document. Find the groups that ask materially the SAME question — the same decision the business has to make — even if worded differently or about different places.

Rules:
- Group only questions that ONE answer would settle.
- List ONLY groups of two or more. Any item you do not list is unique. An empty list is a normal answer.
- An item may appear in at most one group.
- reason: one short sentence. title: the single merged question (at most 30 words), naming everything it covers, ending with "?".

ITEMS:
${itemsText}

Return {"groups":[{"kind":"duplicate","members":["…","…"],"reason":"…","title":"…"}]}.`;
  }
  return `TASK: these requirement candidates were found in different parts of the same document. Group them into governed requirements. A governed requirement describes ONE coherent obligation within ONE functional behaviour or application context.

Two kinds of group:
- "duplicate": the SAME obligation stated more than once (repeated in several sections, or restated), with the same behaviour for the same kind of object. It may span several applications only if the wording is the same and remains complete and testable for every one of them.
- "parts": separate clauses that together form ONE coherent requirement of ONE area — for example a new field or flag together with the rule that uses it, or the display rule and the default rule of the same screen.

Do NOT group when:
- the object operated on differs (e.g. sorting one list vs sorting a different list, one screen vs another screen with different behaviour);
- the expected behaviour differs between the applications;
- a merged requirement would need vague wording to cover them;
- the items are merely related by topic.

Rules:
- List ONLY groups of two or more. Any item you do not list stays on its own. An empty list is a normal answer.
- An item may appear in at most one group.
- reason: one short sentence on why the members belong together.
- title: a short title (at most 12 words) that covers every member, using their own words.

ITEMS:
${itemsText}

Return {"groups":[{"kind":"duplicate|parts","members":["…","…"],"reason":"…","title":"…"}]}.`;
}

export function sourceCheckPrompt({ documentText, issuesText }) {
  return `TASK: for each open question below, check whether the DOCUMENT already answers it.

Rules:
- answered = true ONLY if a specific sentence in the DOCUMENT gives the answer. Quote that sentence word-for-word in answer_quote (at most 300 characters) and give its fragment ID in answer_id.
- If the DOCUMENT does not answer it, answered = false, answer_quote = "" and answer_id = "".
- Do not guess. A related sentence that does not settle the question is NOT an answer.
- The sentence the question is ABOUT is not its answer: vague wording such as "any", "all", "etc." or "as required" does not answer a question asking to make it specific.

DOCUMENT:
${documentText}

QUESTIONS:
${issuesText}

Return {"checks":[{"key":"I…","answered":true|false,"answer_id":"F…","answer_quote":"…"}]} with one entry per question.`;
}

/** SHA-256 of every prompt template of this version — recorded on each run. */
export function promptFingerprint() {
  const sample = { outline: "{outline}", sourceText: "{source}", contextText: "{context}", requirementsText: "{requirements}", itemsText: "{items}", statementsText: "{statements}", documentText: "{document}", issuesText: "{issues}" };
  const text = [
    PROMPT_VERSION, ANALYSIS_SCHEMA_VERSION, SYSTEM_PROMPT,
    classificationPrompt(sample), requirementsPrompt(sample), coveragePrompt(sample), ambiguitiesPrompt(sample),
    consolidationPrompt({ kind: "requirements", ...sample }), consolidationPrompt({ kind: "issues", ...sample }), sourceCheckPrompt(sample),
  ].join("\n\u0000\n");
  return createHash("sha256").update(text).digest("hex");
}
