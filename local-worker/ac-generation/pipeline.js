// Staged Acceptance Criteria generation for ONE promoted Requirement
// (Phase 1E, prompts 1.0.0). Generation only — nothing here is canonical.
//
//   Stage 1  obligations   — behaviour decomposition: every distinct obligation needing coverage
//   Stage 2  criteria      — candidate criteria per obligation, or a gap when not testable
//   Stage 3  coverage      — obligations still uncovered get one more, focused pass
//   Stage 4  consolidation — deterministic, lossless deduplication
//   Stage 5  validation    — deterministic provenance, grounding and quality gates
//
// The model only ever sees short labels from THIS run's input — source
// fragments [F<sequence>], clarifications [C<n>], open questions [Q<n>] and
// scope notes [N<n>] — and they are mapped back to ids deterministically.
// Any label outside the supplied set is treated as fabricated and refused
// (the response is retried with the errors fed back, bounded). The model
// never chooses review status or AC references.
//
// Deterministic quality rules:
//   * Explicit needs grounding: a verbatim quote from a cited fragment, a
//     cited human clarification, or (Regression) a cited acknowledged scope
//     note. Otherwise the criterion is recorded as Inferred (Needs Review).
//   * Regression only from an acknowledged scope note or a "no change"
//     statement in the source; anything else is rejected.
//   * Negative needs negative wording (must not / no / not required …) in
//     its source; otherwise it is flagged for review.
//   * A value (number, duration, percentage) that appears nowhere in the
//     input is invention: the criterion is rejected and an "Insufficient
//     Source Support" issue records what was missing.
//   * Vague wording ("works correctly", "as expected" …) is flagged; a
//     criterion that is nothing but vague wording is rejected.
//   * Every supplied open question is classified against the criteria:
//     Blocking (a criterion's expected result needs the answer → that
//     criterion is Needs Review — the database decides), Additional
//     Coverage (related, does not block; a further criterion may be needed
//     once answered), Informational, or irrelevant (dropped). A criterion is
//     never marked Needs Review merely because a related question exists.
//   * Duplicates merge only when they are the same check (same type,
//     near-identical wording, no differing names or values); members are
//     kept in `consolidation`, so nothing is lost.
//   * Every obligation ends with at least one criterion or a recorded issue.

import { createHash } from "node:crypto";
import { aliasFor, buildChunks, fragmentBody } from "../analysis/chunk.js";
import { components, containment, isNoChangeStatement, normaliseForQuote, similarity, wordSet } from "../analysis/pipeline.js";
import { AC_PROMPT_VERSION, AC_SCHEMA_VERSION, AC_SYSTEM_PROMPT, coveragePrompt, criteriaPrompt, obligationsPrompt } from "./prompts.js";
import { AC_STAGE_SCHEMAS, validateSchema } from "./schemas.js";

export const AC_MAX_ATTEMPTS = 3;
export const MERGE_SIMILARITY = 0.5;

export class AcGenerationError extends Error {
  constructor(category, message, diagnostics = null) { super(message); this.category = category; this.diagnostics = diagnostics; }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const CONFIDENCE_RANK = { High: 3, Medium: 2, Low: 1 };

// Vague wording a tester cannot check.
const VAGUE = /\b(works?|working|functions?|operates?) (correctly|properly|as (expected|intended|designed))\b|\bbehaves? (correctly|properly|as expected)\b|\bas expected\b|\b(is|are|be) (updated|handled|processed|displayed|shown|saved|recorded) (correctly|properly|appropriately)\b|\b(data|everything|it) (is|are) correct\b|\bthe user can use\b|\bappropriate(ly)?\b|\bas (required|needed|necessary)\b|\b(reflects?|shows?|contains?|displays?|holds?|are|is|has|have) (the )?correct (user )?(names?|data|values?|details?|information|results?|users?)\b|\b(names?|data|values?|details?|information|results?)\s+(must be|are|is|should be|remains?)\s+correct\b/i;
// Negative / prohibitive wording.
const NEGATION = /\b(not|no|never|without|nor|cannot|can't|won't|isn't|aren't|doesn't|don't|unchanged|prohibit(ed)?|prevent(ed|s)?|only|otherwise|greyed out|grayed out|read-only|disabled)\b/i;
// Values a criterion could invent: numbers with optional units, and durations in words.
const VALUE = /\b\d+(?:[.,]\d+)?\s*(?:%|percent|ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)?(?![\w-])/gi;
const WORD_DURATION = /\b(within|under|less than|more than|at least|at most|no more than)\s+(one|two|three|four|five|ten|a few|several)\s+(seconds?|minutes?|hours?|days?)\b/i;
// The model sometimes appends its citations to prose ("… [F3, N1]").
const CITATIONS = /\s*\[(?:[FCQNO]\d{1,5}(?:\s*,\s*)?)+\]/g;

export function cleanText(text) {
  return String(text ?? "").replace(CITATIONS, "").replace(/\s+/g, " ").trim();
}

// Words that introduce an extra SITUATION into a question: several actors or
// records, repetition, rework, reversal, existing/historical data. A question
// about such a situation cannot block a criterion that does not claim to
// cover it (the criterion stays true for the situation it states).
const SITUATIONS = [
  /\b(multiple|several|many|more than one|two or more)\b/i, /\b(twice|again|repeat(ed|edly|s)?|repetition)\b/i,
  /\bre-[a-z]+|\b(rework(ed|s)?|reprocess(ed|es|ing)?|redo(ne)?|retr(y|ied))\b/i, /\b(existing|historic(al)?|previous(ly)?|already|legacy)\b/i,
  /\b(cancel(led|lation|s)?|revers(ed|al|es)?|undo(ne)?|delet(ed|ion))\b/i, /\b(another|both)\b/i,
];
/** The situations a question raises that a criterion does not mention (empty → the question may block it). */
export function extraSituations(question, criterion) {
  return SITUATIONS.filter((re) => re.test(String(question ?? "")) && !re.test(String(criterion ?? ""))).map((re) => String(question).match(re)[0]);
}

/** A vague criterion: matches vague wording. `hollow` when nothing concrete remains once it is removed. */
export function vagueness(criterion, contextWords) {
  const m = String(criterion ?? "").match(VAGUE);
  if (!m) return null;
  const rest = String(criterion).replace(VAGUE, " ");
  const concrete = [...wordSet(rest)].filter((w) => contextWords.has(w));
  return { phrase: m[0], hollow: concrete.length < 2 };
}

/** Values (numbers/durations) stated in `text` that appear nowhere in `context`. */
export function inventedValues(text, context) {
  const ctx = normaliseForQuote(context);
  const found = [];
  for (const m of String(text ?? "").matchAll(VALUE)) {
    const number = m[0].match(/\d+(?:[.,]\d+)?/)[0];
    if (!new RegExp(`(^|[^0-9])${number.replace(/[.,]/g, "[.,]")}([^0-9]|$)`).test(ctx)) found.push(m[0].trim());
  }
  const words = String(text ?? "").match(WORD_DURATION);
  if (words && !ctx.includes(normaliseForQuote(words[0]))) found.push(words[0]);
  return [...new Set(found)];
}

const LEADING = /^(the|a|an|on|in|at|after|before|when|for|from|to|of|and|or|all|any|each|every|this|these|that)\s+/i;
/** Names in a text: runs of two or more capitalised words ("Support User", "Pick Admin Dashboard") and all-caps codes ("MONO"). */
export function namedTerms(text) {
  const runs = (String(text ?? "").match(/\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)+\b/g) ?? []).map((r) => { let t = r; while (LEADING.test(t)) t = t.replace(LEADING, ""); return t; })
    .filter((t) => /\s/.test(t));
  const codes = String(text ?? "").match(/\b[A-Z]{3,}\b/g) ?? [];
  return [...new Set([...runs, ...codes])];
}
/**
 * The names an obligation's source clause attaches to it: the clause of its
 * verified quote that best matches the obligation (split at ";" and ", and"),
 * plus a label prefix ending in ":" ("Dashboard apps — Support User flagged:").
 */
export function clauseTerms(quote, statement) {
  const parts = String(quote ?? "").split(/;\s*|,\s+and\s+/).filter(Boolean);
  if (!parts.length) return [];
  const best = parts.reduce((a, b) => (similarity(b, statement) > similarity(a, statement) ? b : a));
  const colon = best.slice(0, 120).lastIndexOf(":");
  const prefix = colon > 0 ? best.slice(0, colon) : (String(quote).slice(0, 120).includes(":") ? String(quote).slice(0, String(quote).slice(0, 120).lastIndexOf(":")) : "");
  return namedTerms(`${prefix} ${best}`);
}
/** "Applies to: A; B; C." (Phase 1C consolidation of one obligation across several applications). */
export function appliesTo(text) {
  const m = String(text ?? "").match(/(?:^|\n)\s*Applies to:\s*([^\n]+?)\.?\s*$/m);
  return m ? m[1].split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean) : [];
}

/** Names/values that differ between two criteria (capitalised terms, all-caps codes, numbers) — they are then different checks. */
export function distinctTerms(a, b) {
  // Names: capitalised words that do not start a sentence, all-caps codes, mixed-case identifiers, numbers.
  const terms = (t) => new Set(String(t).split(/(?<=[.!?])\s+/).flatMap((sentence) => sentence.split(/[^A-Za-z0-9.,]+/).filter(Boolean)
    .filter((w, i) => /^\d/.test(w) || /^[A-Z]{2,}$/.test(w) || /^[A-Za-z][a-z0-9]*[A-Z]/.test(w) || (i > 0 && /^[A-Z]/.test(w))))
    .map((x) => x.replace(/[.,]+$/, "").toLowerCase()));
  const x = terms(a), y = terms(b);
  for (const v of x) if (!y.has(v)) return true;
  for (const v of y) if (!x.has(v)) return true;
  return false;
}

/**
 * Two candidates are the same check: same type, no differing names/values,
 * and one's wording wholly contained in the other's (a restatement). A
 * different actor, record or outcome ("picker" vs "palletiser") always adds
 * a word the other lacks, so it never merges.
 */
export function sameCheck(a, b) {
  if (a.criterion_type !== b.criterion_type) return false;
  if (normaliseForQuote(a.criterion) === normaliseForQuote(b.criterion)) return true;
  if (distinctTerms(a.criterion, b.criterion)) return false;
  return containment(a.criterion, b.criterion) === 1 && similarity(a.criterion, b.criterion) >= MERGE_SIMILARITY;
}

function render(fragments) {
  return buildChunks(fragments, Number.MAX_SAFE_INTEGER).map((c) => c.text).join("\n\n");
}

// A sentence is shown when it contains (or is) a verbatim anchor, or is a
// near-identical restatement of one. Mere shared vocabulary is not enough:
// sibling requirements of one change request share most of their words.
export const EXCERPT_RESTATEMENT = 0.6;
export const EXCERPT_FALLBACK = 0.3;
const quotedWithin = (a, b) => normaliseForQuote(a).length >= 8 && normaliseForQuote(b).includes(normaliseForQuote(a));

/**
 * The sentences of a cited fragment that state THIS requirement — anchored on
 * the promoted proposal's verbatim quotes and the (reviewed) description. A
 * fragment often holds a whole change request; the other sentences describe
 * other requirements and are not shown (provenance stays the fragment id).
 * Tables are kept whole.
 */
// A selected sentence that opens with a reference ("This detail…", "It…")
// needs the sentence(s) it refers to: shown separately as referenced context.
const ANAPHORA = /^(this|these|that|those|it|they|such|the same|the above|as above)\b/i;
export const REFERENCED_SENTENCES = 2;

export function requirementExcerpt(fragment, anchors, threshold = EXCERPT_RESTATEMENT) {
  if (fragment.fragment_type === "table") return { text: fragmentBody(fragment), context: "" };
  const sentences = String(fragment.text).split(/(?<=[.!?;])\s+(?=\S)|\n+/).map((x) => x.trim()).filter(Boolean);
  const keep = sentences.map((sentence) => anchors.some((a) => quotedWithin(a, sentence) || quotedWithin(sentence, a) || similarity(sentence, a) >= threshold));
  const first = keep.indexOf(true);
  const context = first > 0 && ANAPHORA.test(sentences[first]) ? sentences.slice(Math.max(0, first - REFERENCED_SENTENCES), first).filter((_, i, all) => !keep[first - all.length + i]) : [];
  return { text: sentences.filter((_, i) => keep[i]).join(" "), context: context.join(" ") };
}

/** The context labels shown to the model, built deterministically from the claimed input. */
export function buildContext(input) {
  const fragments = [...input.fragments].sort((a, b) => a.sequence - b.sequence);
  const byAlias = new Map(fragments.map((f) => [aliasFor(f), f]));
  const p0 = input.proposal ?? {};
  const anchors = [...new Set([...(p0.source_quotes ?? []), p0.source_quote, input.requirement.description, p0.description].filter((x) => String(x ?? "").trim()))];
  const excerptAt = (threshold) => fragments.map((f) => ({ f, x: requirementExcerpt(f, anchors, threshold) })).filter(({ x }) => x.text);
  const toShown = (list) => list.map(({ f, x }) => ({ ...f, fragment_type: "text", metadata: {}, text: x.text }));
  let picked = excerptAt(EXCERPT_RESTATEMENT);
  let shown = toShown(picked);
  let excerpted = shown.length ? "anchored" : null;
  if (!shown.length) { picked = excerptAt(EXCERPT_FALLBACK); shown = toShown(picked); excerpted = shown.length ? "related" : null; }
  if (!shown.length) shown = fragments;
  const referencedText = picked.filter(({ x }) => x.context).map(({ f, x }) => `[${aliasFor(f)}] ${x.context}`).join("\n");
  const label = (prefix, list) => new Map(list.map((x, i) => [`${prefix}${i + 1}`, x]));
  const clarifications = label("C", input.clarifications ?? []);
  const openQuestions = label("Q", input.open_questions ?? []);
  const scopeNotes = label("N", input.scope_notes ?? []);
  const r = input.requirement, p = input.proposal ?? {};
  const requirementText = [
    `Reference: ${r.ref ?? "(none)"}`,
    `Title: ${r.title}`,
    `Description: ${r.description ?? p.description ?? ""}`,
    r.category ? `Category: ${r.category}` : null,
    r.priority ? `Priority: ${r.priority}` : null,
    p.edited && p.original_description && normaliseForQuote(p.original_description) !== normaliseForQuote(r.description ?? p.description)
      ? `(A reviewer edited the AI's wording; the original was: "${p.original_description}". Use the reviewed requirement above.)` : null,
  ].filter(Boolean).join("\n");
  const clarificationsText = [...clarifications].map(([k, c]) => `[${k}] Question: ${c.question ?? c.description} — Human resolution: ${c.resolution_note}`).join("\n");
  const openQuestionsText = [...openQuestions].map(([k, q]) => `[${k}] ${q.question ?? q.description}`).join("\n");
  const scopeNotesText = [...scopeNotes].map(([k, n]) => `[${k}] ${n.area ? `${n.area}: ` : ""}${n.description}${n.source_quote && normaliseForQuote(n.source_quote) !== normaliseForQuote(n.description) ? ` (source: "${n.source_quote}")` : ""}`).join("\n");
  const contextCorpus = [requirementText, ...fragments.map((f) => f.text), ...[...clarifications.values()].map((c) => `${c.question ?? ""} ${c.description ?? ""} ${c.resolution_note ?? ""}`),
    ...[...scopeNotes.values()].map((n) => `${n.area ?? ""} ${n.description ?? ""} ${n.source_quote ?? ""}`)].join("\n");
  return { fragments, byAlias, clarifications, openQuestions, scopeNotes, requirementText, sourceText: render(shown), referencedText, excerpted, clarificationsText, openQuestionsText, scopeNotesText, contextCorpus };
}

/**
 * @param input    { run:{id, model}, requirement, proposal, fragments, clarifications, open_questions, scope_notes }
 * @param llm      { chat({ messages, schema }) → { content, durationMs } }
 * @param reusable earlier validated stage results [{ run_id, stage, chunk_key, input_hash, output }]
 * @param onStage  async ({ stage, chunk_key, input_hash, attempts, reused_from, output }) persist hook
 */
export async function runAcGeneration({ input, llm, reusable = [], onStage = async () => {}, log = () => {} }) {
  const { run } = input;
  if (!input.requirement?.title) throw new AcGenerationError("validation_failed", "The generation input has no Requirement.");
  if (!Array.isArray(input.fragments) || input.fragments.length === 0) throw new AcGenerationError("validation_failed", "The Requirement's source provenance (fragments) is missing.");
  const ctx = buildContext(input);
  const warnings = [];
  if (ctx.excerpted !== "anchored") warnings.push(ctx.excerpted === "related"
    ? "no sentence of the cited fragments matched the requirement's wording verbatim — sentences with related wording were shown"
    : "no sentence of the cited fragments matched the requirement's wording — the whole fragments were shown");
  const stageCalls = [];
  const rejected = [];
  const contextWords = wordSet(ctx.contextCorpus);
  const F = new Set(ctx.byAlias.keys()), C = new Set(ctx.clarifications.keys()), Q = new Set(ctx.openQuestions.keys()), N = new Set(ctx.scopeNotes.keys());

  async function callStage(stage, chunkKey, userPrompt, checkRefs) {
    const messages = [{ role: "system", content: AC_SYSTEM_PROMPT }, { role: "user", content: userPrompt }];
    const inputHash = sha256(JSON.stringify({ stage, prompt_version: AC_PROMPT_VERSION, schema_version: AC_SCHEMA_VERSION, model: run.model, messages }));
    const schema = AC_STAGE_SCHEMAS[stage];
    // checkRefs normalises (re-files labels, maps field names) a COPY: the
    // model's original response is what is stored, so a retry can reuse it.
    const check = (output) => checkRefs(structuredClone(output));
    const prior = reusable.find((r) => r.stage === stage && r.chunk_key === chunkKey && r.input_hash === inputHash);
    const reused = prior && validateSchema(schema, prior.output).length === 0 ? check(prior.output) : null;
    if (reused && reused.errors.length === 0) {
      if (prior.run_id !== run.id) await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: 1, reused_from: prior.run_id, output: prior.output });
      stageCalls.push({ stage, chunk: chunkKey, attempts: 0, reused: true });
      return reused.cleaned;
    }
    const conversation = [...messages];
    let lastErrors = [];
    let fallback = null;
    for (let attempt = 1; attempt <= AC_MAX_ATTEMPTS; attempt++) {
      const { content, durationMs } = await llm.chat({ messages: conversation, schema });
      let parsed = null;
      let errors;
      try { parsed = JSON.parse(content); errors = validateSchema(schema, parsed); } catch { errors = ["the response is not valid JSON"]; }
      let checked = null;
      if (errors.length === 0) {
        checked = check(parsed);
        errors = checked.errors;
        fallback = checked;
      }
      if (errors.length === 0) {
        await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: attempt, reused_from: null, output: parsed });
        stageCalls.push({ stage, chunk: chunkKey, attempts: attempt, reused: false, duration_ms: durationMs });
        return checked.cleaned;
      }
      lastErrors = errors;
      log(`${stage}: attempt ${attempt} rejected (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
      conversation.push({ role: "assistant", content: content.slice(0, 8000) });
      conversation.push({ role: "user", content: `Your JSON was rejected:\n- ${errors.slice(0, 12).join("\n- ")}\nReturn the corrected JSON only, using only the IDs shown in the text.` });
    }
    if (fallback) {
      warnings.push(`${stage}: after ${AC_MAX_ATTEMPTS} attempts ${fallback.errors.length} invalid item(s) were dropped (${fallback.errors.slice(0, 3).join("; ")})`);
      await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: AC_MAX_ATTEMPTS, reused_from: null, output: fallback.cleaned });
      stageCalls.push({ stage, chunk: chunkKey, attempts: AC_MAX_ATTEMPTS, reused: false, dropped: fallback.errors.length });
      return fallback.cleaned;
    }
    throw new AcGenerationError("invalid_model_output", `The model could not produce valid ${stage} output after ${AC_MAX_ATTEMPTS} attempts: ${lastErrors.slice(0, 3).join("; ")}`.slice(0, 900), { stage_calls: stageCalls, warnings });
  }

  // A real label filed under the wrong list (e.g. "N1" in source_ids) is
  // unambiguous by its prefix: move it. Labels that do not exist stay errors.
  const LISTS = { F: "source_ids", N: "scope_note_ids", C: "clarification_ids", Q: "open_question_ids" };
  const refile = (item) => {
    const all = Object.values(LISTS).flatMap((k) => item[k]);
    for (const [prefix, key] of Object.entries(LISTS)) item[key] = [...new Set(all.filter((l) => l.startsWith(prefix)))];
    return item;
  };
  const refErrors = (item, where) => [
    ...item.source_ids.filter((id) => !F.has(id)).map((id) => `${where} cites ${id}, which is not a SOURCE fragment`),
    ...item.scope_note_ids.filter((id) => !N.has(id)).map((id) => `${where} cites ${id}, which is not a SCOPE NOTE`),
    ...item.clarification_ids.filter((id) => !C.has(id)).map((id) => `${where} cites ${id}, which is not a CLARIFICATION`),
    ...item.open_question_ids.filter((id) => !Q.has(id)).map((id) => `${where} cites ${id}, which is not an OPEN QUESTION`),
  ];
  const citedText = (ids) => ids.map((a) => ctx.byAlias.get(a)?.text ?? "").join("\n");
  const quoteIn = (quote, ids) => normaliseForQuote(quote).length >= 8 && normaliseForQuote(citedText(ids)).includes(normaliseForQuote(quote));

  // ── Stage 1: obligations ───────────────────────────────────────────────
  const base = { requirementText: ctx.requirementText, sourceText: ctx.sourceText, referencedText: ctx.referencedText, clarificationsText: ctx.clarificationsText, openQuestionsText: ctx.openQuestionsText, scopeNotesText: ctx.scopeNotesText };
  const obl = await callStage("obligations", "requirement", obligationsPrompt(base), (o) => {
    const errors = [];
    const kept = [];
    o.obligations.forEach((x, i) => {
      refile(x);
      const e = refErrors(x, `obligations[${i}]`);
      if (!x.source_ids.length && !x.scope_note_ids.length && !x.clarification_ids.length) e.push(`obligations[${i}] cites no SOURCE fragment, SCOPE NOTE or CLARIFICATION`);
      errors.push(...e);
      if (!e.length) kept.push(x);
    });
    const decided = new Set();
    const decisions = [];
    for (const d of o.scope_notes) {
      if (!N.has(d.id)) errors.push(`scope_notes cites ${d.id}, which is not a SCOPE NOTE`);
      else if (!decided.has(d.id)) { decided.add(d.id); decisions.push(d); }
    }
    for (const n of N) if (!decided.has(n)) errors.push(`${n} is missing from scope_notes — decide whether it is relevant`);
    return { errors, cleaned: { obligations: kept, scope_notes: decisions } };
  });
  // A scope note judged relevant always yields regression coverage; one
  // judged not relevant never does. Both decisions are recorded.
  const noteDecisions = (obl.scope_notes ?? []).map((d) => ({ note: d.id, relevant: d.relevant, reason: cleanText(d.reason).slice(0, 300) }));
  const relevantNotes = new Set(noteDecisions.filter((d) => d.relevant).map((d) => d.note));
  for (const x of obl.obligations) if (x.kind === "regression") x.scope_note_ids = x.scope_note_ids.filter((n) => relevantNotes.has(n));
  for (const n of relevantNotes) {
    if (!obl.obligations.some((x) => x.kind === "regression" && x.scope_note_ids.includes(n))) {
      const note = ctx.scopeNotes.get(n);
      obl.obligations.push({ statement: note.description, kind: "regression", source_ids: [], scope_note_ids: [n], clarification_ids: [], open_question_ids: [], source_quote: "" });
      warnings.push(`${n} was judged relevant but had no regression obligation — one was added from the scope note`);
    }
  }
  const obligations = [];
  for (const x of obl.obligations) {
    const statement = cleanText(x.statement);
    const quoteOk = quoteIn(x.source_quote, x.source_ids);
    const noChange = isNoChangeStatement(x.source_quote) || isNoChangeStatement(statement) && x.scope_note_ids.length > 0;
    if (x.kind === "regression" && !x.scope_note_ids.length && !(quoteOk && isNoChangeStatement(x.source_quote))) {
      rejected.push({ stage: "obligations", text: statement.slice(0, 300), reason: "regression obligation without an acknowledged scope note or a no-change statement in the source" });
      continue;
    }
    const probe = { statement, kind: x.kind };
    // The same obligation twice (e.g. stated in two fragments) is one obligation.
    const same = obligations.find((o) => o.kind === probe.kind && (normaliseForQuote(o.statement) === normaliseForQuote(statement) || (!distinctTerms(o.statement, statement) && similarity(o.statement, statement) >= 0.8)));
    if (same) {
      for (const k of ["source_ids", "scope_note_ids", "clarification_ids", "open_question_ids"]) same[k] = [...new Set([...same[k], ...x[k]])];
      same.restatements.push(statement);
      continue;
    }
    obligations.push({ key: `O${obligations.length + 1}`, statement, kind: x.kind, source_ids: x.source_ids, scope_note_ids: x.scope_note_ids, clarification_ids: x.clarification_ids,
      open_question_ids: x.open_question_ids, source_quote: quoteOk ? x.source_quote.trim() : null, no_change: noChange, restatements: [] });
  }
  if (!obligations.length) throw new AcGenerationError("validation_failed", "No obligation of the Requirement could be identified with provenance.", { stage_calls: stageCalls, warnings, rejected });
  const byKey = new Map(obligations.map((o) => [o.key, o]));
  const obligationsText = (list) => list.map((o) => `${o.key} (${o.kind}): ${o.statement} [${[...o.source_ids, ...o.scope_note_ids, ...o.clarification_ids].join(", ")}]${o.open_question_ids.length ? ` — related open question: ${o.open_question_ids.join(", ")}` : ""}`).join("\n");

  // ── Stage 2 / 3: criteria and coverage ─────────────────────────────────
  const checkCriteria = (keys, decideAll) => (o) => {
    const errors = [];
    const kept = [];
    o.criteria.forEach((c, i) => {
      if ("blocking_question_ids" in c) { c.open_question_ids = c.blocking_question_ids; delete c.blocking_question_ids; }
      refile(c);
      const e = refErrors(c, `criteria[${i}]`);
      e.push(...c.obligations.filter((k) => !keys.has(k)).map((k) => `criteria[${i}] covers ${k}, which is not one of the OBLIGATIONS`));
      errors.push(...e);
      if (!e.length) kept.push(c);
    });
    const gaps = [];
    o.gaps.forEach((g, i) => { if (keys.has(g.obligation)) gaps.push(g); else errors.push(`gaps[${i}] is for ${g.obligation}, which is not one of the OBLIGATIONS`); });
    const decided = new Set();
    const questions = [];
    for (const d of o.questions ?? []) {
      if (!Q.has(d.id)) errors.push(`questions cites ${d.id}, which is not an OPEN QUESTION`);
      else if (!decided.has(d.id)) { decided.add(d.id); questions.push(d); }
    }
    if (decideAll) for (const q of Q) if (!decided.has(q)) errors.push(`${q} is missing from questions — decide how it relates to the criteria`);
    return { errors, cleaned: { criteria: kept, gaps, questions } };
  };

  const candidates = [];
  const gaps = [];
  const issues = [];
  const situationOverrides = [];
  const accept = (c, origin) => {
    const covered = [...new Set(c.obligations)].map((k) => byKey.get(k));
    const inherit = (k) => [...new Set([...c[k], ...(c[k].length ? [] : covered.flatMap((o) => o[k]))])];
    const sourceIds = inherit("source_ids"), noteIds = inherit("scope_note_ids"), clarIds = [...new Set([...c.clarification_ids, ...covered.flatMap((o) => o.clarification_ids)])];
    // Only the questions this criterion's expected result depends on (no
    // inheritance from its obligation) — and never one about an extra
    // situation this criterion does not claim to cover.
    const openIds = [...new Set(c.open_question_ids)].filter((q) => {
      const question = ctx.openQuestions.get(q);
      const extra = extraSituations(`${question?.question ?? ""} ${question?.description ?? ""}`, [c.criterion, c.given, c.when, c.then].join(" "));
      if (extra.length) situationOverrides.push({ question: q, criterion: cleanText(c.criterion).slice(0, 200), situations: extra });
      return extra.length === 0;
    });
    const text = cleanText(c.criterion);
    const given = cleanText(c.given), when = cleanText(c.when), then = cleanText(c.then);
    const reasons = [];
    const all = [text, given, when, then].join(" ");
    const type = c.criterion_type;
    const quoteOk = quoteIn(c.source_quote, sourceIds);

    // Invention: a value no input states.
    const invented = inventedValues(all, ctx.contextCorpus);
    if (invented.length) {
      rejected.push({ stage: origin, text: text.slice(0, 300), reason: `states ${invented.join(", ")}, which the source does not give` });
      issues.push({ issue_type: "Insufficient Source Support", severity: "Medium", obligation: covered.map((o) => o.statement).join(" / ").slice(0, 1000),
        description: `A proposed criterion stated ${invented.join(", ")}, which nothing in the requirement, its source, clarifications or scope notes gives. It was not proposed; the expected value must come from the business.`.slice(0, 2000),
        suggested_question: null, source_ids: [...new Set(covered.flatMap((o) => o.source_ids))], open_question_ids: openIds });
      return;
    }
    // Regression only from a scope note or a no-change statement.
    if (type === "Regression" && !noteIds.length && !covered.some((o) => o.no_change) && !(quoteOk && isNoChangeStatement(c.source_quote))) {
      rejected.push({ stage: origin, text: text.slice(0, 300), reason: "Regression criterion without an acknowledged scope note or no-change statement" });
      return;
    }
    // Vague wording.
    const vague = vagueness(text, contextWords);
    if (vague?.hollow) { rejected.push({ stage: origin, text: text.slice(0, 300), reason: `vague: "${vague.phrase}" with nothing concrete to check` }); return; }
    if (vague) reasons.push(`Vague wording ("${vague.phrase}") — make the expected result specific.`);
    // Grounding for Explicit.
    let basis = c.basis;
    const obligationQuoted = covered.some((o) => o.source_quote && o.source_ids.some((x) => sourceIds.includes(x)));
    const grounded = quoteOk || obligationQuoted || clarIds.length > 0 || (type === "Regression" && noteIds.length > 0) || (noteIds.length > 0 && !sourceIds.length);
    if (basis === "Explicit" && !grounded) {
      basis = "Inferred";
      warnings.push(`criterion "${text.slice(0, 60)}…": marked Explicit but not grounded in a verbatim source quote, clarification or scope note — recorded as Inferred`);
    }
    if (type === "Negative" && !NEGATION.test(`${c.source_quote} ${covered.map((o) => `${o.statement} ${o.source_quote ?? ""}`).join(" ")}`)) {
      reasons.push("Marked Negative, but no negative or prohibiting statement was found in its source.");
    }
    // A name or condition its source clause attaches to the obligation, missing from the criterion.
    const said = normaliseForQuote(all);
    const omitted = [...new Set(covered.flatMap((o) => (o.source_quote ? clauseTerms(o.source_quote, o.statement) : [])))].filter((t) => !said.includes(normaliseForQuote(t)));
    if (omitted.length) reasons.push(`Omits ${omitted.map((t) => `"${t}"`).join(", ")}, named in its source — check the condition is not lost.`);
    if (openIds.length) reasons.push(`Blocked by an open question: ${openIds.map((k) => ctx.openQuestions.get(k)?.question ?? k).join(" / ")}`.slice(0, 500));
    if (!sourceIds.length && !noteIds.length && !clarIds.length) { rejected.push({ stage: origin, text: text.slice(0, 300), reason: "no provenance" }); return; }
    candidates.push({
      criterion: text, given, when, then, criterion_type: type, basis, confidence: c.confidence,
      reasons, source_ids: sourceIds, scope_note_ids: noteIds, clarification_ids: clarIds, open_question_ids: openIds,
      source_quote: quoteOk ? c.source_quote.trim() : null, rationale: cleanText(c.rationale) || "Covers the obligation.",
      obligations: covered.map((o) => o.key), origin,
    });
  };

  const allKeys = new Set(obligations.map((o) => o.key));
  const crit = await callStage("criteria", "requirement", criteriaPrompt({ ...base, obligationsText: obligationsText(obligations) }), checkCriteria(allKeys, true));
  for (const c of crit.criteria) accept(c, "criteria");
  gaps.push(...crit.gaps);
  const questionDecisions = new Map((crit.questions ?? []).map((d) => [d.id, d]));

  const covered = () => new Set([...candidates.flatMap((c) => c.obligations), ...gaps.map((g) => g.obligation)]);
  const uncovered = obligations.filter((o) => !covered().has(o.key));

  // Every application the requirement applies to must be named by a criterion.
  // An uncovered application gets its own obligations (from its own fragment)
  // for the coverage pass; a criterion naming several applications covers each.
  const apps = appliesTo(input.requirement.description ?? input.proposal?.description);
  const named = (app) => candidates.some((c) => normaliseForQuote([c.criterion, c.given, c.when, c.then].join(" ")).includes(normaliseForQuote(app)));
  const leafOf = (f) => normaliseForQuote((f.section_path ?? []).at(-1) ?? f.section_heading ?? "");
  const appObligations = [];
  if (apps.length > 1) {
    for (const app of apps.filter((a) => !named(a))) {
      const own = ctx.fragments.filter((f) => leafOf(f) === normaliseForQuote(app)).map(aliasFor);
      for (const o of obligations.filter((x) => x.kind !== "regression")) {
        const extra = { ...o, key: `O${obligations.length + appObligations.length + 1}`, statement: `In ${app}: ${o.statement}`, source_ids: own.length ? own : o.source_ids, restatements: [], application: app };
        appObligations.push(extra);
      }
    }
    for (const o of appObligations) { obligations.push(o); byKey.set(o.key, o); }
  }
  if (uncovered.length || appObligations.length) {
    uncovered.push(...appObligations);
    const keys = new Set(uncovered.map((o) => o.key));
    const cov = await callStage("coverage", "requirement", coveragePrompt({ ...base, obligationsText: obligationsText(uncovered) }), checkCriteria(keys, false));
    for (const c of cov.criteria) accept(c, "coverage");
    gaps.push(...cov.gaps);
    for (const d of cov.questions ?? []) if (!questionDecisions.has(d.id)) questionDecisions.set(d.id, d);
  }
  for (const o of obligations.filter((x) => !covered().has(x.key) && !(x.application && named(x.application)))) {
    warnings.push(`${o.key}: no acceptable criterion and no gap — recorded as Missing Testable Outcome`);
    issues.push({ issue_type: "Missing Testable Outcome", severity: "Medium", obligation: o.statement,
      description: `No testable acceptance criterion could be written for this obligation from the source: "${o.statement}". A human must define the observable result.`.slice(0, 2000),
      suggested_question: null, source_ids: o.source_ids, open_question_ids: o.open_question_ids });
  }

  // ── Stage 4: lossless consolidation ────────────────────────────────────
  const order = (c) => Math.min(...c.obligations.map((k) => Number(k.slice(1))));
  const groups = components(candidates.map((_, i) => i), (a, b) => sameCheck(candidates[a], candidates[b]));
  const merged = groups.map((members) => {
    const list = members.map((i) => candidates[i]);
    // The most complete wording represents the group (every member's words are in it); members are kept.
    const rep = [...list].sort((a, b) => wordSet(b.criterion).size - wordSet(a.criterion).size || (a.basis === "Explicit" ? 0 : 1) - (b.basis === "Explicit" ? 0 : 1) || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])[0];
    const union = (k) => [...new Set(list.flatMap((c) => c[k]))];
    return {
      ...rep,
      reasons: [...new Set(list.flatMap((c) => c.reasons))],
      source_ids: union("source_ids"), scope_note_ids: union("scope_note_ids"), clarification_ids: union("clarification_ids"), open_question_ids: union("open_question_ids"),
      obligations: union("obligations").sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      consolidation: list.length > 1 ? { merged: true, member_count: list.length, reason: "the same check proposed more than once", members: list.map((c) => ({ criterion: c.criterion, given: c.given, when: c.when, then: c.then, basis: c.basis, confidence: c.confidence, source_ids: c.source_ids, origin: c.origin })) } : {},
    };
  }).sort((a, b) => order(a) - order(b) || ["Positive", "Negative", "Regression"].indexOf(a.criterion_type) - ["Positive", "Negative", "Regression"].indexOf(b.criterion_type));

  // ── Issues: gaps and the open questions criteria depend on ─────────────
  // A gap for an obligation that has a criterion is noise (open questions are
  // reported deterministically below) — unless it reports a conflict.
  const withCriteria = new Set(merged.flatMap((c) => c.obligations));
  const suppressedGaps = [];
  const seenGaps = new Set();
  for (const g of gaps) {
    const o = byKey.get(g.obligation);
    const key = `${g.obligation}|${normaliseForQuote(g.question || g.description)}`;
    if ((withCriteria.has(g.obligation) && g.issue_type !== "Conflicting Source/Resolution") || seenGaps.has(key)) {
      suppressedGaps.push({ obligation: g.obligation, issue_type: g.issue_type, description: cleanText(g.description).slice(0, 300) });
      continue;
    }
    seenGaps.add(key);
    issues.push({ issue_type: g.issue_type, severity: g.issue_type === "Conflicting Source/Resolution" ? "High" : "Medium", obligation: o.statement,
      description: cleanText(g.description), suggested_question: cleanText(g.question) || null, source_ids: o.source_ids, open_question_ids: o.open_question_ids });
  }
  // Every open question, classified against the criteria actually proposed.
  // Blocking = some criterion's expected result depends on it (that is what
  // makes the criterion Needs Review). A question the model called blocking
  // that no criterion depends on blocks nothing proposed → Additional Coverage.
  const questionRelations = [];
  for (const [q, question] of ctx.openQuestions) {
    const decision = questionDecisions.get(q);
    const affected = merged.filter((c) => c.open_question_ids.includes(q)).length;
    // A question the model judged irrelevant but that it still cited on a criterion is kept (not dropped).
    const cited = situationOverrides.some((o) => o.question === q);
    const RELATION_OF = { blocking: "Additional Coverage", additional_coverage: "Additional Coverage", informational: "Informational", irrelevant: cited ? "Additional Coverage" : null };
    const relation = affected ? "Blocking" : decision && decision.relation in RELATION_OF ? RELATION_OF[decision.relation] : "Additional Coverage";
    if (!decision && !affected) warnings.push(`${q}: not classified by the model — recorded as Additional Coverage`);
    const overridden = situationOverrides.filter((o) => o.question === q);
    questionRelations.push({ question: question.id, decided: decision?.relation ?? null, relation, reason: cleanText(decision?.reason).slice(0, 300),
      ...(overridden.length ? { not_blocking_because: `asks about ${[...new Set(overridden.flatMap((o) => o.situations))].join(", ")}, which the criterion does not claim to cover` } : {}) });
    if (!relation) continue;
    const text = question.question ?? question.description;
    const description = relation === "Blocking"
      ? `Blocking — this open analysis question must be answered before ${affected === 1 ? "1 criterion" : `${affected} criteria`} can be confirmed: "${text}". ${affected === 1 ? "It is" : "They are"} marked Needs Review.`
      : relation === "Additional Coverage"
        ? `Additional coverage question — does not block the proposed criteria: "${text}". A further acceptance criterion may be required once it is answered in the analysis review.`
        : `Related question — informational, it changes no proposed criterion: "${text}".`;
    issues.push({ issue_type: "Unresolved Existing Analysis Issue", severity: relation === "Blocking" ? "Medium" : "Low", relation,
      obligation: null, description: description.slice(0, 2000), suggested_question: text ?? null, source_ids: [], open_question_ids: [q] });
  }

  // ── Stage 5: id mapping and deterministic validation ───────────────────
  const id = { F: (a) => ctx.byAlias.get(a).id, N: (a) => ctx.scopeNotes.get(a).id, C: (a) => ctx.clarifications.get(a).id, Q: (a) => ctx.openQuestions.get(a).id };
  const proposals = merged.map((c, i) => ({
    sequence: i + 1,
    criterion: c.criterion.slice(0, 2000), given_text: c.given ? c.given.slice(0, 1000) : null, when_text: c.when ? c.when.slice(0, 1000) : null, then_text: c.then ? c.then.slice(0, 1000) : null,
    criterion_type: c.criterion_type, basis: c.basis, confidence: c.confidence, needs_review_reasons: c.reasons.map((r) => r.slice(0, 500)),
    source_fragment_ids: c.source_ids.map(id.F), scope_note_ids: c.scope_note_ids.map(id.N), clarification_issue_ids: c.clarification_ids.map(id.C), open_issue_ids: c.open_question_ids.map(id.Q),
    source_quote: c.source_quote ? c.source_quote.slice(0, 2000) : null, rationale: c.rationale.slice(0, 2000),
    obligations: c.obligations.map((k) => ({ key: k, statement: byKey.get(k).statement, kind: byKey.get(k).kind })),
    consolidation: c.consolidation.merged ? { ...c.consolidation, members: c.consolidation.members.map((m) => ({ ...m, source_ids: m.source_ids.map(id.F) })) } : {},
  }));
  const outIssues = issues.map((x, i) => ({
    sequence: i + 1, issue_type: x.issue_type, severity: x.severity, relation: x.relation ?? null, description: x.description.slice(0, 2000) || "Needs review.",
    obligation: x.obligation ? x.obligation.slice(0, 1000) : null, suggested_question: x.suggested_question ? x.suggested_question.slice(0, 1000) : null,
    source_fragment_ids: x.source_ids.map(id.F), analysis_issue_ids: x.open_question_ids.map(id.Q), related_proposal_sequences: [],
  }));
  const allowed = {
    fragments: new Set(ctx.fragments.map((f) => f.id)), scopeNotes: new Set([...ctx.scopeNotes.values()].map((n) => n.id)),
    clarifications: new Set([...ctx.clarifications.values()].map((c) => c.id)), openQuestions: new Set([...ctx.openQuestions.values()].map((q) => q.id)),
  };
  const problems = validateAcGenerationOutput({ proposals, issues: outIssues }, allowed);
  const diagnostics = {
    prompt_version: AC_PROMPT_VERSION, schema_version: AC_SCHEMA_VERSION,
    fragment_count: ctx.fragments.length, clarification_count: ctx.clarifications.size, open_question_count: ctx.openQuestions.size, scope_note_count: ctx.scopeNotes.size,
    obligations: obligations.map((o) => ({ key: o.key, statement: o.statement, kind: o.kind, restatements: o.restatements.length,
      covered_by: proposals.filter((p) => p.obligations.some((x) => x.key === o.key)).map((p) => p.sequence), gap: gaps.some((g) => g.obligation === o.key) })),
    question_relations: questionRelations,
    scope_note_decisions: noteDecisions.map((d) => ({ ...d, note: ctx.scopeNotes.get(d.note)?.id })),
    candidates_before_consolidation: candidates.length, proposal_count: proposals.length, issue_count: outIssues.length,
    needs_review_count: proposals.filter((p) => p.basis === "Inferred" || p.confidence === "Low" || p.open_issue_ids.length || p.needs_review_reasons.length).length,
    source_excerpted: ctx.excerpted, rejected_criteria: rejected, suppressed_gaps: suppressedGaps, stage_calls: stageCalls, warnings,
  };
  if (problems.length) throw new AcGenerationError("validation_failed", `Deterministic validation failed: ${problems.slice(0, 3).join("; ")}`.slice(0, 900), diagnostics);
  return { proposals, issues: outIssues, diagnostics, withWarnings: warnings.length > 0 };
}

const ENUMS = {
  criterion_type: ["Positive", "Negative", "Regression"], basis: ["Explicit", "Inferred"], confidence: ["High", "Medium", "Low"], severity: ["High", "Medium", "Low"],
  issue_type: ["Missing Testable Outcome", "Missing Preconditions", "Ambiguous Expected Result", "Unresolved Existing Analysis Issue", "Conflicting Source/Resolution", "Insufficient Source Support"],
};

/** Stage 5 — mirrored by the server (lib/ac-generation.ts) before anything is stored. */
export function validateAcGenerationOutput({ proposals, issues }, allowed) {
  const problems = [];
  const seq = new Set();
  const subset = (list, set) => Array.isArray(list) && list.every((x) => set.has(x));
  proposals.forEach((p, i) => {
    const where = `criterion ${i + 1}`;
    if (!Number.isInteger(p.sequence) || seq.has(p.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    seq.add(p.sequence);
    if (!String(p.criterion ?? "").trim() || !String(p.rationale ?? "").trim()) problems.push(`${where}: criterion and rationale are required`);
    if (!ENUMS.criterion_type.includes(p.criterion_type)) problems.push(`${where}: invalid criterion_type`);
    if (!ENUMS.basis.includes(p.basis)) problems.push(`${where}: invalid basis`);
    if (!ENUMS.confidence.includes(p.confidence)) problems.push(`${where}: invalid confidence`);
    if (!subset(p.source_fragment_ids, allowed.fragments)) problems.push(`${where}: cites a fragment outside the Requirement's provenance`);
    if (!subset(p.scope_note_ids, allowed.scopeNotes)) problems.push(`${where}: cites a scope note that was not supplied`);
    if (!subset(p.clarification_issue_ids, allowed.clarifications)) problems.push(`${where}: cites a clarification that was not supplied`);
    if (!subset(p.open_issue_ids, allowed.openQuestions)) problems.push(`${where}: cites an open question that was not supplied`);
    if ((p.source_fragment_ids?.length ?? 0) + (p.scope_note_ids?.length ?? 0) + (p.clarification_issue_ids?.length ?? 0) === 0) problems.push(`${where}: no provenance`);
    if ("review_status" in p || "ac_ref" in p) problems.push(`${where}: review status and references are not chosen by generation`);
  });
  const iseq = new Set();
  issues.forEach((x, i) => {
    const where = `issue ${i + 1}`;
    if (!Number.isInteger(x.sequence) || iseq.has(x.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    iseq.add(x.sequence);
    if (!ENUMS.issue_type.includes(x.issue_type)) problems.push(`${where}: invalid issue_type`);
    if (!ENUMS.severity.includes(x.severity)) problems.push(`${where}: invalid severity`);
    if (x.relation != null && !["Blocking", "Additional Coverage", "Informational"].includes(x.relation)) problems.push(`${where}: invalid relation`);
    if (!String(x.description ?? "").trim()) problems.push(`${where}: description is required`);
    if (!subset(x.source_fragment_ids, allowed.fragments)) problems.push(`${where}: cites a fragment outside the Requirement's provenance`);
    if (!subset(x.analysis_issue_ids, new Set([...allowed.openQuestions, ...allowed.clarifications]))) problems.push(`${where}: cites an analysis issue that was not supplied`);
  });
  return problems;
}
