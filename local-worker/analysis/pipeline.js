// Staged requirement analysis of ONE extraction run (Phase 1C, prompts 2.0.0).
//
//   Stage 1  classification   per chunk  — what each fragment is
//   Stage 2  requirements     per chunk  — candidates from requirement fragments only
//   Stage 2b coverage         per chunk  — statements the first pass left uncaptured
//   Stage 3  ambiguities      per batch  — material open questions, with a source trigger
//   Stage 4  consolidation    whole run  — requirement groups (duplicate / parts), issue groups
//   Stage 4b source_check     whole run  — is each question already answered in the document?
//   Stage 5  validation       deterministic — schema, provenance, IDs, enums
//
// Every model response is schema-checked and reference-checked here; an
// invalid response is retried (with the errors fed back) up to
// MAX_ATTEMPTS, and a stage that still cannot produce valid output fails
// the run cleanly. Each accepted stage output is persisted through
// `onStage` so a failed run can be retried without regenerating it.
//
// The model only ever sees short fragment labels (F<sequence>) from THIS
// extraction run; they are mapped back to fragment UUIDs deterministically.
// Any label outside the supplied set is treated as fabricated and refused.
// The model never chooses review status or requirement references.
//
// Quality rules (2.0.0):
//   * "No change required" statements become scope/regression NOTES, not
//     requirements; explicit negative constraints ("No X required") stay
//     requirements. The decision is deterministic, on the source wording.
//   * Consolidation is LOSSLESS: a merged proposal's description contains
//     every distinct clause of every member. Duplicate groups must share
//     their source wording; "parts" groups must stay within one area.
//   * An issue survives only with a verbatim source trigger, a material
//     impact, a specific question, no generic wording, and no answer
//     elsewhere in the document.

import { createHash } from "node:crypto";
import { aliasFor, buildChunks, documentOutline, sectionLabel } from "./chunk.js";
import {
  ANALYSIS_SCHEMA_VERSION, PROMPT_VERSION, SYSTEM_PROMPT,
  ambiguitiesPrompt, classificationPrompt, consolidationPrompt, coveragePrompt, requirementsPrompt, sourceCheckPrompt,
} from "./prompts.js";
import { STAGE_SCHEMAS, validateSchema } from "./schemas.js";

export const MAX_ATTEMPTS = 3;
export const CONTEXT_CHAR_BUDGET = 3000;
export const MAX_CONSOLIDATION_ITEMS = 150;
export const MAX_REQUIREMENTS_PER_AMBIGUITY_CALL = 8;
export const SOURCE_CHECK_CHAR_BUDGET = 24000;
export const MAX_PARTS_GROUP = 8;
// Duplicate groups must share their source wording (verbatim quotes) or
// near-identical descriptions; a distinct clause is one not near-identical
// to a clause already kept.
export const DUPLICATE_SIMILARITY = 0.8;
// Otherwise a paraphrased repeat may merge only when it operates on the same
// object (applies_to contained in the other's) and the wording overlaps.
export const SAME_OBJECT_CONTAINMENT = 0.8;
export const PARAPHRASE_SIMILARITY = 0.3;
export const SAME_CLAUSE_SIMILARITY = 0.85;
// Issue merges proposed by the model must share an impact and some wording;
// identical questions merge without asking.
export const ISSUE_MERGE_SIMILARITY = 0.3;

const STOPWORDS = new Set("the and for with that this from into onto than then there their they them shall should must will would could also any all are was were been being has have had not only its it's which when where what who whom whose each such other same after before while just very more most some can may does how".split(" "));

export function wordSet(text) {
  return new Set(normaliseForQuote(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
}
/** Share of the smaller word set found in the larger (1 = one is contained in the other). */
export function containment(a, b) {
  const x = wordSet(a), y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}
export function similarity(a, b) {
  const x = wordSet(a), y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Connected components of `members` under a pairwise "may merge" predicate. */
export function components(members, mayMerge) {
  const parent = new Map(members.map((m) => [m, m]));
  const find = (m) => (parent.get(m) === m ? m : find(parent.get(m)));
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    if (mayMerge(members[i], members[j])) parent.set(find(members[j]), find(members[i]));
  }
  const groups = new Map();
  for (const m of members) groups.set(find(m), [...(groups.get(find(m)) ?? []), m]);
  return [...groups.values()];
}

export class AnalysisError extends Error {
  constructor(category, message, diagnostics = null) { super(message); this.category = category; this.diagnostics = diagnostics; }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const CONFIDENCE_RANK = { High: 3, Medium: 2, Low: 1 };
const SEVERITY_RANK = { High: 3, Medium: 2, Low: 1 };
const REQUIREMENT_LIKE = new Set(["requirement"]);
const CONTEXT_LIKE = new Set(["metadata", "context", "benefit"]);
const aliasNumber = (a) => Number(String(a).slice(1));

/** Whitespace/quote/case-insensitive normalisation for the verbatim-quote check. */
export function normaliseForQuote(text) {
  return String(text ?? "").normalize("NFKC").replace(/[‘’´`]/g, "'").replace(/[“”]/g, "\"")
    .replace(/[‐‑‒–—]/g, "-").toLowerCase().replace(/\s+/g, " ").replace(/^[\s"'.,;:…-]+|[\s"'.,;:…-]+$/g, "").trim();
}
const quotedIn = (quote, text) => normaliseForQuote(quote).length >= 6 && normaliseForQuote(text).includes(normaliseForQuote(quote));

// ── Statement types ────────────────────────────────────────────────────────

// "No change required" / "remains as it is" / "unchanged" for an area →
// a scope/regression note. Decided on the SOURCE wording, not the model's
// label, so a negative constraint ("No temperature filter required") can
// never be downgraded to a note, and a no-change can never inflate the
// requirement count.
const NO_CHANGE = /\bno\s+changes?\b(\s+(is|are))?\s+(required|needed|necessary)\b|\b(remains?|stays?|keeps?|kept|left)\b[^.;]{0,40}\bas\s+(it|they)\s+(is|are)\b|\bwith\s+no\s+changes?\b|\b(is|are|remains?)\s+unchanged\b/i;
export function isNoChangeStatement(text) {
  return NO_CHANGE.test(String(text ?? ""));
}

// Project plans, delivery status and dates ("UI complete by 18th Sept",
// "Test in F20 w/c 21st Sept", "All services complete.") are not
// obligations. Generic date/status wording without an obligation verb.
const DATE_WORDING = /\b(w\/c|week commencing|wk\s?\d)\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/i;
const STATUS_WORDING = /\b(complete|completed|done|finished|delivered|signed off)\s*[.!]?\s*$|\bmove(d)? to\s+[A-Z0-9]{2,}\b|\bgo[- ]live\b/i;
const OBLIGATION_VERB = /\b(shall|must|should|will need|needs? to|required|require[sd]?|is to|are to|to be|add|allow|enable|display|show|sort|filter|default|remain|prevent|restrict)\b/i;
export function isPlanStatement(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/\bno changes?\b|\bremains?\b|\bkeeps?\b/i.test(t)) return false; // scope statements are handled separately
  return (DATE_WORDING.test(t) || STATUS_WORDING.test(t)) && !(OBLIGATION_VERB.test(t.replace(STATUS_WORDING, "")) && !DATE_WORDING.test(t));
}

// Rule language that makes an obligation a Business Rule even where the
// model labelled it by the screen it shows up on.
const RULE_WORDING = /\bdefault(s|ed|ing)?\s+(from|to)\b|\bonly\s+(where|when|if|for)\b|\bflag(ged)?\b|\bcannot\s+change\b|\bnot\s+be\s+(able|changeable|editable)\b|\bone[- ]to[- ]one\b|\bregardless\s+of\b/i;

// ── Priority (unchanged from 1.0.0) ────────────────────────────────────────

// A tracker/specification "Priority: X" field (any source format). Used only
// to check the model's proposed priority — never to create a requirement.
const PRIORITY_FIELD = /(?:^|\n)[\s*]*priority[\s*]*[:：]\s*(low|medium|high|critical)\b/gi;
export function priorityFields(fragments) {
  return fragments.flatMap((f) => [...String(f.text).matchAll(PRIORITY_FIELD)].map((m) => ({ alias: aliasFor(f), value: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() })));
}

// ── Obligation units for the coverage pass ─────────────────────────────────

/** Deterministic statement units of a fragment: list items / lines, long lines split into sentences. */
export function statementUnits(fragment) {
  const units = [];
  for (const rawLine of String(fragment.text).split(/\n+/)) {
    const line = rawLine.replace(/^\s*(\(?\d{1,3}[.)]|[-•*])\s+/, "").trim();
    if (!line) continue;
    const parts = line.length > 220 ? line.split(/(?<=[.;])\s+(?=[A-Z])/) : [line];
    for (const p of parts) if (p.replace(/[^A-Za-z]/g, "").length >= 8 && !isPlanStatement(p)) units.push(p.trim());
  }
  return units;
}

function unitCovered(unit, candidates) {
  const u = normaliseForQuote(unit);
  return candidates.some((c) => [c.quote, ...(c.restatements ?? []).map((r) => r.quote)].some((quote) => {
    const q = normaliseForQuote(quote ?? "");
    if (q.length >= 8 && (u.includes(q) || q.includes(u))) return true;
    return similarity(unit, quote ?? "") >= 0.5;
  }) || similarity(unit, c.description) >= 0.5);
}

// ── Issue gate ─────────────────────────────────────────────────────────────

// Questions that could be asked of any system, with no source trigger.
const GENERIC_ISSUE = /\bedge[- ]cases?\b|\berror handling\b|\b(if|when) (an? )?(error|errors|failure|exception)s? (occurs?|happens?)\b|\binvalid (data|input|values?|entries)\b|\b(if|when) [^?]{0,40}\b(fails|crashes|is down|goes down)\b|\bwhat happens (when|if) [^?]{0,60}\b(is |are )?(changed|updated|modified|re-?processed|sorted|added)\s*\??$/i;
const SPECULATIVE_ISSUE = /\b(inadvertently|accidentally|by mistake|misuse[ds]?|despite (the|this|that) (restriction|rule|requirement))\b|\b(multiple|duplicate|conflicting) (entries|records|rows) (exist|are present)\b|\bexempt(ed|ion)?\b/i;
/** Removes trailing citations the model sometimes appends ("…? [F3, R4]", "…? (Loading Dashboard)?"). */
export function cleanQuestion(question) {
  let q = String(question ?? "").trim();
  for (let i = 0; i < 3; i++) {
    q = q.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\?\s*\([^)]*\)\s*\?*\s*$/, "?").trim();
  }
  return q.replace(/(\s*\?)+$/, "?");
}
export function isGenericIssue(issue) {
  if (SPECULATIVE_ISSUE.test(`${issue.suggested_question ?? ""} ${issue.description ?? ""}`)) return true;
  return GENERIC_ISSUE.test(`${issue.suggested_question ?? ""}`) || /\bedge[- ]cases?\b/i.test(issue.description ?? "");
}

// Vague references a customer cannot answer without guessing what is meant.
const VAGUE_QUESTION = /\b(specific|certain|particular|some) (ones|cases|scenarios|contexts|views|situations|dashboards|apps|applications|screens|conditions)\b|\ball contexts\b|\bin general\b|\bwhat (is|are) the exact behaviou?rs?\b/i;

/** A question specific enough for a BA/customer to answer: a real question naming something from the source. */
export function isSpecificQuestion(question, sourceText) {
  const q = String(question ?? "").trim();
  if (!q.endsWith("?")) return false;
  if (VAGUE_QUESTION.test(q)) return false;
  if (q.split(/\s+/).length < 7) return false;
  const src = wordSet(sourceText);
  return [...wordSet(q)].some((w) => src.has(w));
}

/** Same operated object (one applies_to contained in the other). */
export function sameObject(x, y) {
  return Boolean(x.applies_to && y.applies_to) && containment(x.applies_to, y.applies_to) >= SAME_OBJECT_CONTAINMENT;
}
/** Two candidates state the same obligation: the same rule (near-identical wording), or a restatement of the same object. */
export function sameObligation(x, y) {
  const best = Math.max(x.quote && y.quote ? similarity(x.quote, y.quote) : 0, similarity(x.description, y.description));
  return best >= DUPLICATE_SIMILARITY || (sameObject(x, y) && best >= PARAPHRASE_SIMILARITY);
}

function render(fragments) {
  return buildChunks(fragments, Number.MAX_SAFE_INTEGER).map((c) => c.text).join("\n\n");
}

function truncate(text, budget) {
  return text.length <= budget ? text : `${text.slice(0, budget)}\n… (context truncated)`;
}

/** Distinct clauses (sentences) of several descriptions, in order, dropping near-identical repeats. */
export function distinctClauses(texts) {
  const kept = [];
  for (const text of texts) {
    for (const clause of String(text).split(/(?<=\.)\s+(?=[A-Z])|\n+/).map((c) => c.trim()).filter(Boolean)) {
      if (!kept.some((k) => normaliseForQuote(k) === normaliseForQuote(clause) || similarity(k, clause) >= SAME_CLAUSE_SIMILARITY)) kept.push(clause);
    }
  }
  return kept;
}

/**
 * @param run       { id, model }
 * @param fragments the run's extraction fragments (id, sequence, section_path, text, …)
 * @param llm       { chat({ messages, schema }) → { content, durationMs } }
 * @param reusable  earlier validated stage results [{ run_id, stage, chunk_key, input_hash, output }]
 * @param onStage   async ({ stage, chunk_key, input_hash, attempts, reused_from, output }) persist hook
 */
export async function runAnalysis({ run, fragments, llm, reusable = [], onStage = async () => {}, log = () => {} }) {
  if (!Array.isArray(fragments) || fragments.length === 0) throw new AnalysisError("validation_failed", "The extraction run has no fragments to analyse.");
  const byAlias = new Map(fragments.map((f) => [aliasFor(f), f]));
  const warnings = [];
  const stageCalls = [];
  const suppressedIssues = [];
  const uncaptured = [];
  const excludedPlans = [];
  const chunks = buildChunks(fragments);
  const outline = documentOutline(fragments);

  async function callStage(stage, chunkKey, userPrompt, checkRefs) {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }];
    const inputHash = sha256(JSON.stringify({ stage, prompt_version: PROMPT_VERSION, schema_version: ANALYSIS_SCHEMA_VERSION, model: run.model, messages }));
    const schema = STAGE_SCHEMAS[stage];

    const prior = reusable.find((r) => r.stage === stage && r.chunk_key === chunkKey && r.input_hash === inputHash);
    if (prior && validateSchema(schema, prior.output).length === 0 && checkRefs(prior.output).errors.length === 0) {
      if (prior.run_id !== run.id) await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: 1, reused_from: prior.run_id, output: prior.output });
      stageCalls.push({ stage, chunk: chunkKey, attempts: 0, reused: true });
      return prior.output;
    }

    const conversation = [...messages];
    let lastErrors = [];
    let fallback = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { content, durationMs } = await llm.chat({ messages: conversation, schema });
      let parsed = null;
      let errors;
      try { parsed = JSON.parse(content); errors = validateSchema(schema, parsed); } catch { errors = ["the response is not valid JSON"]; }
      let checked = null;
      if (errors.length === 0) {
        checked = checkRefs(parsed);
        errors = checked.errors;
        fallback = checked;
      }
      if (errors.length === 0) {
        await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: attempt, reused_from: null, output: parsed });
        stageCalls.push({ stage, chunk: chunkKey, attempts: attempt, reused: false, duration_ms: durationMs });
        return parsed;
      }
      lastErrors = errors;
      log(`${stage} ${chunkKey}: attempt ${attempt} rejected (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
      conversation.push({ role: "assistant", content: content.slice(0, 8000) });
      conversation.push({ role: "user", content: `Your JSON was rejected:\n- ${errors.slice(0, 12).join("\n- ")}\nReturn the corrected JSON only, using only the IDs shown in the text.` });
    }
    // Structurally valid but with bad references: keep only the valid items.
    if (fallback) {
      warnings.push(`${stage} ${chunkKey}: after ${MAX_ATTEMPTS} attempts ${fallback.errors.length} invalid item reference(s) were dropped (${fallback.errors.slice(0, 3).join("; ")})`);
      await onStage({ stage, chunk_key: chunkKey, input_hash: inputHash, attempts: MAX_ATTEMPTS, reused_from: null, output: fallback.cleaned });
      stageCalls.push({ stage, chunk: chunkKey, attempts: MAX_ATTEMPTS, reused: false, dropped: fallback.errors.length });
      return fallback.cleaned;
    }
    throw new AnalysisError("invalid_model_output", `The model could not produce valid ${stage} output for ${chunkKey} after ${MAX_ATTEMPTS} attempts: ${lastErrors.slice(0, 3).join("; ")}`.slice(0, 900), { stage_calls: stageCalls, warnings });
  }

  // ── Stage 1: classification ────────────────────────────────────────────
  const classification = new Map();
  for (const chunk of chunks) {
    const expected = new Set(chunk.aliases);
    const out = await callStage("classification", chunk.key, classificationPrompt({ outline, sourceText: chunk.text }), (o) => {
      const errors = [];
      const seen = new Set();
      const kept = [];
      for (const item of o.fragments) {
        if (!expected.has(item.id)) errors.push(`${item.id} is not a fragment in SOURCE`);
        else if (seen.has(item.id)) errors.push(`${item.id} is listed more than once`);
        else { seen.add(item.id); kept.push(item); }
      }
      for (const alias of expected) if (!seen.has(alias)) errors.push(`${alias} is missing — classify every fragment`);
      const missing = [...expected].filter((a) => !seen.has(a)).map((id) => ({ id, classification: "unknown", reason: "not classified by the model" }));
      return { errors, cleaned: { fragments: [...kept, ...missing] } };
    });
    for (const item of out.fragments) classification.set(item.id, item.classification);
  }
  const classOf = (alias) => classification.get(alias) ?? "unknown";
  const contextFragments = fragments.filter((f) => CONTEXT_LIKE.has(classOf(aliasFor(f))));
  const priorityStatements = priorityFields(fragments);
  const statedPriorities = [...new Set(priorityStatements.map((p) => p.value))];

  const droppedPriorities = new Map();
  /** Keeps a proposed priority only when the document states it unambiguously. */
  function checkedPriority(key, value, aliases) {
    if (!value) return { value: null, support: [] };
    const citedText = aliases.map((a) => byAlias.get(a)?.text ?? "").join("\n").toLowerCase();
    const inline = new RegExp(`\\b(${value.toLowerCase()} priority|priority[^\\n]{0,3}${value.toLowerCase()})\\b`).test(citedText);
    if (statedPriorities.length === 1 && statedPriorities[0] === value) return { value, support: priorityStatements.map((p) => p.alias) };
    if (statedPriorities.length === 0 && inline) return { value, support: [] };
    const note = `proposed priority dropped — ${statedPriorities.length > 1 ? `the document states different priorities (${statedPriorities.join(", ")})` : `${value} is not stated in the source`}`;
    droppedPriorities.set(note, [...(droppedPriorities.get(note) ?? []), key]);
    return { value: null, support: [] };
  }

  // ── Stage 2 / 2b / 3 per chunk ─────────────────────────────────────────
  const candidates = [];   // requirement candidates (behaviour + constraint)
  const scopeNotes = [];   // no-change statements
  const rawIssues = [];
  const contextText = truncate(render([...contextFragments].sort((a, b) => a.sequence - b.sequence)), CONTEXT_CHAR_BUDGET);

  for (const chunk of chunks) {
    const inChunk = chunk.fragmentIds.map((id) => fragments.find((f) => f.id === id));
    const reqFragments = inChunk.filter((f) => REQUIREMENT_LIKE.has(classOf(aliasFor(f))));
    if (reqFragments.length === 0) continue;
    const reqAliases = new Set(reqFragments.map(aliasFor));
    const contextAliases = new Set([...contextFragments, ...inChunk.filter((f) => CONTEXT_LIKE.has(classOf(aliasFor(f))))].map(aliasFor));

    const checkRequirements = (o) => {
      const errors = [];
      const kept = [];
      o.requirements.forEach((r, i) => {
        const bad = r.source_ids.filter((id) => !reqAliases.has(id) && !contextAliases.has(id));
        const itemErrors = bad.map((id) => `requirements[${i}] cites ${id}, which is not in SOURCE or CONTEXT`);
        if (!reqAliases.has(r.primary_source_id)) itemErrors.push(`requirements[${i}].primary_source_id ${r.primary_source_id} must be a SOURCE fragment`);
        errors.push(...itemErrors);
        if (itemErrors.length === 0) kept.push(r);
      });
      return { errors, cleaned: { requirements: kept } };
    };

    const chunkItems = [];
    const accept = (r, origin) => {
      const ids = [...new Set([r.primary_source_id, ...r.source_ids])];
      const cited = ids.map((a) => byAlias.get(a)?.text ?? "").join("\n");
      const quoteOk = normaliseForQuote(r.source_quote).length >= 8 && normaliseForQuote(cited).includes(normaliseForQuote(r.source_quote));
      const wording = quoteOk ? r.source_quote : `${r.source_quote} ${r.description}`;
      const section = sectionLabel(byAlias.get(r.primary_source_id));
      if (isPlanStatement(quoteOk ? r.source_quote : r.description)) {
        excludedPlans.push({ fragment_id: byAlias.get(r.primary_source_id)?.id, text: (quoteOk ? r.source_quote : r.description).slice(0, 300) });
        return;
      }
      if (isNoChangeStatement(wording)) {
        scopeNotes.push({
          chunk: chunk.key, section, aliases: ids, description: r.description.trim(), quote: quoteOk ? r.source_quote.trim() : null, applies_to: (r.applies_to ?? "").trim(),
          model_statement_type: r.statement_type, origin,
        });
        return;
      }
      if (origin === "coverage") {
        const probe = { quote: quoteOk ? r.source_quote : null, description: r.description, applies_to: (r.applies_to ?? "").trim() };
        const existing = chunkItems.find((c) => sameObligation(c, probe));
        if (existing) {
          // A restatement found by the coverage pass: add its provenance, and any genuinely new clause.
          existing.aliases = [...new Set([...existing.aliases, ...ids])];
          if (containment(r.description, existing.description) < 0.7) existing.description = distinctClauses([existing.description, r.description]).join(" ");
          existing.restatements = [...(existing.restatements ?? []), { quote: probe.quote, source_ids: ids }];
          return;
        }
      }
      const key = `R${candidates.length + 1}`;
      let evidence = r.evidence_basis;
      if (evidence === "Explicit" && !quoteOk) {
        evidence = "Inferred";
        warnings.push(`${key}: marked Explicit but its quote was not found verbatim in the cited fragments — recorded as Inferred (Needs Review)`);
      }
      const priority = checkedPriority(key, r.priority === "Not stated" ? null : r.priority, ids);
      const candidate = {
        key, chunk: chunk.key, section, aliases: [...new Set([...ids, ...priority.support])],
        title: r.title.trim(), description: r.description.trim(), applies_to: (r.applies_to ?? "").trim(), primary: r.primary_source_id,
        quote: quoteOk ? r.source_quote.trim() : (r.source_quote.trim() || null), evidence_basis: evidence, confidence: r.confidence,
        category: r.category === "Unknown" ? null : r.category, priority: priority.value, rationale: r.rationale.trim(),
        model_category: r.category,
        statement_type: r.statement_type === "no_change" ? "constraint" : r.statement_type, origin,
      };
      // Obligation-based category: rule language (defaults, flags, only-where, one-to-one) is a Business Rule.
      if ((candidate.category === "UI" || candidate.category === null) && RULE_WORDING.test(`${candidate.quote ?? ""} ${candidate.description}`)) candidate.category = "Business Rule";
      candidates.push(candidate);
      chunkItems.push(candidate);
    };

    const req = await callStage("requirements", chunk.key, requirementsPrompt({ sourceText: render(reqFragments), contextText }), checkRequirements);
    for (const r of req.requirements) accept(r, "requirements");

    // Stage 2b: statements of requirement fragments not yet covered by any candidate or note.
    const covered = () => [...chunkItems, ...scopeNotes.filter((n) => n.chunk === chunk.key)];
    const gaps = reqFragments.flatMap((f) => statementUnits(f).filter((u) => !unitCovered(u, covered().filter((c) => c.aliases.includes(aliasFor(f))))).map((u) => ({ fragment: f, text: u })));
    if (gaps.length) {
      const statementsText = gaps.map((g) => `- [${aliasFor(g.fragment)}] (${sectionLabel(g.fragment)}) ${g.text}`).join("\n");
      const cov = await callStage("coverage", chunk.key, coveragePrompt({ statementsText, contextText }), checkRequirements);
      for (const r of cov.requirements) accept(r, "coverage");
      for (const g of gaps) {
        if (!unitCovered(g.text, covered().filter((c) => c.aliases.includes(aliasFor(g.fragment))))) uncaptured.push({ fragment_id: g.fragment.id, text: g.text.slice(0, 300) });
      }
    }

    // Stage 3 runs per batch of consecutive sections (≤ MAX_REQUIREMENTS_PER_AMBIGUITY_CALL
    // candidates each) so a long chunk does not collapse onto its last section.
    const batches = [];
    for (const label of chunk.sections) {
      const sectionFragments = inChunk.filter((f) => sectionLabel(f) === label);
      const sectionCandidates = chunkItems.filter((c) => sectionFragments.some((f) => aliasFor(f) === c.primary));
      const last = batches.at(-1);
      if (last && last.candidates.length + sectionCandidates.length <= MAX_REQUIREMENTS_PER_AMBIGUITY_CALL) {
        last.fragments.push(...sectionFragments); last.candidates.push(...sectionCandidates);
      } else batches.push({ fragments: [...sectionFragments], candidates: [...sectionCandidates] });
    }
    for (const [b, batch] of batches.entries()) {
      if (!batch.fragments.some((f) => REQUIREMENT_LIKE.has(classOf(aliasFor(f))))) continue;
      const batchKey = batches.length === 1 ? chunk.key : `${chunk.key}.a${b + 1}`;
      const allowed = new Set([...batch.fragments.map(aliasFor), ...contextAliases]);
      const keys = new Set(batch.candidates.map((c) => c.key));
      const requirementsText = batch.candidates.map((c) => `${c.key}: ${c.title} — ${c.description} [${c.aliases.join(", ")}]`).join("\n");
      const batchSource = render(batch.fragments);
      const amb = await callStage("ambiguities", batchKey, ambiguitiesPrompt({ sourceText: batchSource, contextText, requirementsText }), (o) => {
        const errors = [];
        const kept = [];
        o.issues.forEach((issue, i) => {
          const bad = issue.source_ids.filter((id) => !allowed.has(id));
          if (bad.length) errors.push(...bad.map((id) => `issues[${i}] cites ${id}, which is not in SOURCE or CONTEXT`));
          else kept.push({ ...issue, related_requirements: issue.related_requirements.filter((k) => keys.has(k)) });
        });
        return { errors, cleaned: { issues: kept } };
      });
      for (const issue of amb.issues) {
        // Models sometimes append citations ("…? [F3, F8]") — strip them before the checks.
        const question = cleanQuestion(issue.suggested_question);
        const cited = issue.source_ids.map((a) => byAlias.get(a)?.text ?? "").join("\n");
        const suppress = (reason) => suppressedIssues.push({ question, reason, source_fragment_ids: issue.source_ids.map((a) => byAlias.get(a)?.id).filter(Boolean) });
        // The issue gate: a verbatim source trigger, no generic wording, a specific question.
        if (!quotedIn(issue.trigger_quote, `${cited}\n${batchSource}`)) { suppress("no verbatim source trigger"); continue; }
        // About requirement content (benefit/metadata/background alone cannot raise a build question; a Contradiction may).
        if (issue.issue_type !== "Contradiction" && !issue.source_ids.some((a) => REQUIREMENT_LIKE.has(classOf(a)))) { suppress("not about requirement content"); continue; }
        // A contradiction needs two statements that conflict.
        if (issue.issue_type === "Contradiction" && new Set(issue.source_ids).size < 2) { suppress("contradiction without two conflicting statements"); continue; }
        if (isGenericIssue({ ...issue, suggested_question: question })) { suppress("generic / speculative question"); continue; }
        if (!isSpecificQuestion(question, `${cited}\n${issue.trigger_quote}`)) { suppress("question not specific to the source"); continue; }
        rawIssues.push({
          key: `I${rawIssues.length + 1}`, chunk: batchKey, ...issue, suggested_question: question,
          impact: [...new Set(issue.impact)], trigger_quote: issue.trigger_quote.trim(),
          related_requirements: issue.related_requirements.filter((k) => keys.has(k)),
        });
      }
    }
  }
  for (const [note, keys] of droppedPriorities) warnings.push(`${keys.join(", ")}: ${note}`);

  // ── Stage 4: consolidation across the whole run ────────────────────────
  const consolidationOverrides = [];
  async function proposeGroups(kind, items, describe) {
    if (items.length < 2) return [];
    if (items.length > MAX_CONSOLIDATION_ITEMS) {
      warnings.push(`consolidation of ${kind} skipped: ${items.length} items exceed the limit of ${MAX_CONSOLIDATION_ITEMS}`);
      return [];
    }
    const keys = new Set(items.map((i) => i.key));
    const out = await callStage("consolidation", kind, consolidationPrompt({ kind, itemsText: items.map(describe).join("\n") }), (o) => {
      const errors = [];
      const seen = new Set();
      const groups = [];
      for (const g of o.groups) {
        const members = [];
        for (const m of g.members) {
          if (!keys.has(m)) errors.push(`${m} is not one of the ITEMS`);
          else if (seen.has(m)) errors.push(`${m} appears in more than one group`);
          else { seen.add(m); members.push(m); }
        }
        if (members.length >= 2) groups.push({ ...g, members });
      }
      return { errors, cleaned: { groups } };
    });
    return out.groups;
  }

  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const leaf = (section) => section.split(" › ").at(-1);
  const sameWording = (a, b) => sameObligation(byKey.get(a), byKey.get(b));

  /** Deterministic acceptance of a model-proposed requirement group; returns accepted sub-groups. */
  function verifyRequirementGroup(g) {
    // "parts" whose wording is near-identical are really one repeated obligation.
    const identicalWording = (a, b) => {
      const x = byKey.get(a), y = byKey.get(b);
      return Math.max(x.quote && y.quote ? similarity(x.quote, y.quote) : 0, similarity(x.description, y.description)) >= DUPLICATE_SIMILARITY;
    };
    const allSame = g.members.every((a, i) => g.members.slice(i + 1).every((b) => identicalWording(a, b)));
    if (g.kind === "duplicate" || allSame) {
      // Same obligation: members must share their wording — differing objects or behaviour stay apart.
      return components(g.members, sameWording).map((members) => ({ kind: "duplicate", members }));
    }
    // "parts" of ONE requirement: every clause operates on the same object (same section when an
    // object is not stated); a data-model definition (a new field/flag) may join the rule that uses it.
    const definitions = g.members.filter((k) => byKey.get(k).category === "Database");
    const rules = g.members.filter((k) => !definitions.includes(k));
    const compatible = (a, b) => {
      const x = byKey.get(a), y = byKey.get(b);
      return x.applies_to && y.applies_to ? sameObject(x, y) : x.section === y.section;
    };
    const coherent = rules.every((a, i) => rules.slice(i + 1).every((b) => compatible(a, b)));
    if (coherent && g.members.length <= MAX_PARTS_GROUP && (rules.length > 0 || definitions.length > 1)) return [{ kind: "parts", members: g.members }];
    // Split into coherent sub-groups; definitions then stand alone.
    return [...components(rules, compatible), ...definitions.map((d) => [d])].map((members) => ({ kind: "parts", members: members.slice(0, MAX_PARTS_GROUP) }));
  }

  // The same source wording in several sections is one shared rule: grouped deterministically.
  const identical = components(candidates.map((c) => c.key), (a, b) => {
    const x = byKey.get(a), y = byKey.get(b);
    return Boolean(x.quote && y.quote) && normaliseForQuote(x.quote).length >= 15 && normaliseForQuote(x.quote) === normaliseForQuote(y.quote);
  });
  const identicalOf = new Map(identical.flatMap((g) => g.map((k) => [k, g])));
  const proposedGroups = await proposeGroups("requirements", identical.map((g) => byKey.get(g[0])),
    (c) => `${c.key} [section: ${c.section}] [applies to: ${c.applies_to || "?"}] [${c.category ?? "no category"}] ${c.title} — ${c.description}${c.quote ? ` (source: "${c.quote}")` : ""}`);
  const accepted = [];
  for (const raw of proposedGroups) {
    // A representative of identical statements stands for all of them in a duplicate group;
    // in a "parts" group the identical set (spanning several areas) cannot join.
    const g = raw.kind === "duplicate"
      ? { ...raw, members: raw.members.flatMap((k) => identicalOf.get(k)) }
      : { ...raw, members: raw.members.filter((k) => identicalOf.get(k).length === 1) };
    if (g.members.length < 2) continue;
    const parts = verifyRequirementGroup(g);
    const merged = parts.filter((p) => p.members.length > 1);
    if (parts.length !== 1 || parts[0].members.length !== g.members.length) consolidationOverrides.push({ kind: "requirements", group_kind: g.kind, proposed: g.members, kept: parts.map((p) => p.members) });
    for (const p of merged) accepted.push({ ...p, title: parts.length === 1 ? g.title : null, reason: g.reason });
  }
  const grouped = new Set(accepted.flatMap((g) => g.members));
  for (const g of identical) if (g.length > 1 && !g.some((k) => grouped.has(k))) { accepted.push({ kind: "duplicate", members: g, title: null, reason: "identical source wording" }); g.forEach((k) => grouped.add(k)); }
  const groups = [...accepted, ...candidates.filter((c) => !grouped.has(c.key)).map((c) => ({ kind: "single", members: [c.key], title: null, reason: "unique" }))]
    .sort((x, y) => Math.min(...x.members.map((k) => Number(k.slice(1)))) - Math.min(...y.members.map((k) => Number(k.slice(1)))));

  const proposals = [];
  const keyToSequence = new Map();
  const derivedIssues = [];
  for (const g of groups) {
    const members = g.members.map((k) => byKey.get(k)).sort((a, b) => aliasNumber(a.primary) - aliasNumber(b.primary) || Number(a.key.slice(1)) - Number(b.key.slice(1)));
    const strongest = [...members].sort((a, b) =>
      (a.evidence_basis === "Explicit" ? 0 : 1) - (b.evidence_basis === "Explicit" ? 0 : 1) || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])[0];
    const sections = [...new Set(members.map((m) => m.section))];
    const aliases = [...new Set(members.flatMap((m) => [m.primary, ...m.aliases]))].sort((a, b) => aliasNumber(a) - aliasNumber(b));
    const priorities = [...new Set(members.map((m) => m.priority).filter(Boolean))];
    const sequence = proposals.length + 1;
    members.forEach((m) => keyToSequence.set(m.key, sequence));

    // LOSSLESS description: every distinct clause of every member.
    let description;
    const quotesIdentical = g.kind === "duplicate" && members.every((m) => m.quote && normaliseForQuote(m.quote) === normaliseForQuote(members[0].quote));
    if (members.length === 1) description = members[0].description;
    else if (g.kind === "duplicate") {
      // One obligation repeated: the shared source wording when identical, else all distinct clauses.
      const body = quotesIdentical ? members[0].quote : distinctClauses(members.map((m) => m.description)).join(" ");
      description = sections.length > 1 ? `${body}\n\nApplies to: ${sections.map(leaf).join("; ")}.` : body;
    } else {
      const lines = [];
      for (const m of members) for (const clause of distinctClauses([m.description])) {
        if (!lines.some((l) => normaliseForQuote(l) === normaliseForQuote(clause) || similarity(l, clause) >= SAME_CLAUSE_SIMILARITY)) lines.push(clause);
      }
      description = lines.map((l) => `- ${l}`).join("\n") + (sections.length > 1 ? `\n\nStated in: ${sections.map(leaf).join("; ")}.` : "");
    }
    const quotes = [...new Set(members.map((m) => m.quote).filter(Boolean).map((q) => q.trim()))];
    const categories = members.map((m) => m.category).filter(Boolean);
    const category = categories.includes("Business Rule") && members.length > 1 ? "Business Rule"
      : strongest.category ?? categories.sort((a, b) => categories.filter((c) => c === b).length - categories.filter((c) => c === a).length)[0] ?? null;
    proposals.push({
      sequence,
      proposed_title: members.length > 1 && g.title?.trim() ? g.title.trim() : strongest.title,
      proposed_description: description,
      proposed_category: category,
      proposed_priority: priorities.length === 1 ? priorities[0] : null,
      aliases, primary: strongest.primary, source_quote: quotes.length ? quotes.join(" … ") : null,
      rationale: members.length > 1 ? `${strongest.rationale} Consolidated from ${members.length} statements (${g.kind === "duplicate" ? "the same obligation repeated" : "parts of one requirement"}).` : strongest.rationale,
      evidence_basis: members.every((m) => m.evidence_basis === "Explicit") ? "Explicit" : "Inferred",
      confidence: [...members].sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence])[0].confidence,
      consolidation: {
        merged: members.length > 1, kind: g.kind, member_count: members.length, reason: g.reason, sections,
        priority_conflict: priorities.length > 1 ? priorities : undefined,
        members: members.map((m) => ({
          key: m.key, title: m.title, description: m.description, quote: m.quote, section: m.section, applies_to: m.applies_to,
          statement_type: m.statement_type, category: m.category, evidence_basis: m.evidence_basis, confidence: m.confidence, source_ids: m.aliases,
        })),
      },
    });
    // Repeats that are worded differently may disagree — worth one confirmation question.
    if (g.kind === "duplicate" && members.length > 1 && !quotesIdentical && sections.length > 1) {
      derivedIssues.push({
        issue_type: "Duplicate / Repeated Requirement", severity: "Low", aliases, related: [sequence], impact: ["acceptance_criteria"], trigger_quote: members[0].quote,
        description: `The same obligation is stated ${members.length} times with different wording (${sections.map(leaf).join("; ")}). The statements were consolidated; confirm they mean the same.`,
        suggested_question: `Do the ${members.length} differently worded statements in ${sections.map(leaf).join(", ")} describe exactly the same requirement?`,
        consolidation: {},
      });
    }
  }

  // ── Stage 4 (issues): whole-run issue deduplication ────────────────────
  const issueByKey = new Map(rawIssues.map((i) => [i.key, i]));
  const issueText = (i) => `${i.suggested_question} ${i.description}`;
  // Identical questions merge without asking the model.
  const exact = components(rawIssues.map((i) => i.key), (a, b) => normaliseForQuote(issueByKey.get(a).suggested_question) === normaliseForQuote(issueByKey.get(b).suggested_question));
  const exactOf = new Map(exact.flatMap((g) => g.map((k) => [k, g])));
  const representatives = exact.map((g) => issueByKey.get(g[0]));
  const issueGroups = await proposeGroups("issues", representatives, (i) => `${i.key} [${i.issue_type}; impact: ${i.impact.join(", ")}] Q: ${i.suggested_question} — ${i.description}`);
  const mayMergeIssues = (a, b) => {
    const x = issueByKey.get(a), y = issueByKey.get(b);
    return x.impact.some((m) => y.impact.includes(m)) && similarity(issueText(x), issueText(y)) >= ISSUE_MERGE_SIMILARITY;
  };
  const acceptedIssueGroups = [];
  for (const g of issueGroups) {
    const parts = components(g.members, mayMergeIssues);
    if (parts.length > 1) consolidationOverrides.push({ kind: "issues", proposed: g.members, kept: parts });
    for (const p of parts) acceptedIssueGroups.push({ members: p.flatMap((k) => exactOf.get(k)), title: parts.length === 1 ? g.title : null, reason: g.reason });
  }
  const inIssueGroup = new Set(acceptedIssueGroups.flatMap((g) => g.members));
  const allIssueGroups = [...acceptedIssueGroups, ...exact.filter((g) => !inIssueGroup.has(g[0])).map((members) => ({ members, title: null, reason: members.length > 1 ? "identical question" : "unique" }))]
    .sort((x, y) => Math.min(...x.members.map((k) => Number(k.slice(1)))) - Math.min(...y.members.map((k) => Number(k.slice(1)))));

  let consolidatedIssues = allIssueGroups.map((g, n) => {
    const members = g.members.map((k) => issueByKey.get(k)).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Number(a.key.slice(1)) - Number(b.key.slice(1)));
    const rep = members[0];
    const aliases = [...new Set(members.flatMap((m) => m.source_ids))].sort((a, b) => aliasNumber(a) - aliasNumber(b));
    const allSource = aliases.map((a) => byAlias.get(a)?.text ?? "").join("\n");
    // The merged question must cover every member: the model's merged question, unless it is just
    // one member's wording — then every distinct member question is kept.
    const distinctQuestions = [...new Map(members.map((m) => [normaliseForQuote(m.suggested_question), m.suggested_question])).values()];
    const title = g.title ? cleanQuestion(g.title) : null;
    const titleIsOneMember = title && distinctQuestions.some((q) => normaliseForQuote(q) === normaliseForQuote(title));
    const mergedQuestion = members.length > 1 && title && !titleIsOneMember && isSpecificQuestion(title, allSource) ? title
      : distinctQuestions.join(" ");
    return {
      key: `I${n + 1}`, issue_type: rep.issue_type, severity: rep.severity, description: members.length > 1 ? distinctClauses(members.map((m) => m.description)).slice(0, 6).join(" ") : rep.description,
      suggested_question: mergedQuestion, aliases, trigger_quote: rep.trigger_quote, impact: [...new Set(members.flatMap((m) => m.impact))],
      related: [...new Set(members.flatMap((m) => m.related_requirements).map((k) => keyToSequence.get(k)).filter(Boolean))],
      consolidation: members.length > 1 ? { merged: true, reason: g.reason, members: members.map((m) => ({ question: m.suggested_question, description: m.description, source_ids: m.source_ids, impact: m.impact })) } : {},
    };
  });

  // ── Stage 4b: is each question already answered somewhere in the document? ──
  if (consolidatedIssues.length) {
    const documentText = render(fragments);
    const text = documentText.length <= SOURCE_CHECK_CHAR_BUDGET ? documentText : truncate(documentText, SOURCE_CHECK_CHAR_BUDGET);
    if (documentText.length > SOURCE_CHECK_CHAR_BUDGET) warnings.push("source check: the document exceeds the source-check budget; only its first part was checked");
    const keys = new Set(consolidatedIssues.map((i) => i.key));
    const check = await callStage("source_check", "issues", sourceCheckPrompt({ documentText: text, issuesText: consolidatedIssues.map((i) => `${i.key}: ${i.suggested_question} (${i.description})`).join("\n") }), (o) => {
      const errors = o.checks.filter((c) => !keys.has(c.key)).map((c) => `${c.key} is not one of the QUESTIONS`);
      return { errors, cleaned: { checks: o.checks.filter((c) => keys.has(c.key)) } };
    });
    const answered = new Map();
    for (const c of check.checks) {
      const fragment = byAlias.get(c.answer_id);
      // Suppress only on a verifiable answer: a real fragment quoted word-for-word.
      const issue = consolidatedIssues.find((i) => i.key === c.key);
      // The sentence that raised the question cannot be its answer.
      const isTrigger = issue?.trigger_quote && (quotedIn(issue.trigger_quote, c.answer_quote) || quotedIn(c.answer_quote, issue.trigger_quote) || similarity(issue.trigger_quote, c.answer_quote) >= 0.5);
      if (c.answered && fragment && !isTrigger && normaliseForQuote(c.answer_quote).length >= 10 && quotedIn(c.answer_quote, fragment.text)) answered.set(c.key, { fragment, quote: c.answer_quote });
    }
    consolidatedIssues = consolidatedIssues.filter((i) => {
      const a = answered.get(i.key);
      if (!a) return true;
      suppressedIssues.push({ question: i.suggested_question, reason: "answered by the source", answered_by: a.fragment.id, answer_quote: a.quote.slice(0, 300), source_fragment_ids: i.aliases.map((x) => byAlias.get(x)?.id).filter(Boolean) });
      return false;
    });
  }

  const issues = [...consolidatedIssues, ...derivedIssues];
  if (statedPriorities.length > 1) {
    issues.push({
      issue_type: "Contradiction", severity: "Medium", aliases: [...new Set(priorityStatements.map((p) => p.alias))], related: [], impact: ["scope"],
      trigger_quote: priorityStatements.map((p) => `Priority: ${p.value}`).join(" / "),
      description: `The document states different priorities: ${priorityStatements.map((p) => `${p.value} (${p.alias})`).join(", ")}. No priority was proposed.`,
      suggested_question: `Which priority applies: ${statedPriorities.join(" or ")}?`, consolidation: {},
    });
  }
  const adminAliases = fragments.map(aliasFor).filter((a) => classOf(a) === "template_admin");
  if (adminAliases.length) {
    const sections = [...new Set(adminAliases.map((a) => sectionLabel(byAlias.get(a))))];
    issues.push({
      issue_type: "Out of Scope / Administrative Content", severity: "Low", aliases: adminAliases, related: [], impact: ["scope"], trigger_quote: null,
      description: `${adminAliases.length} fragment(s) were classified as template or administrative content and were not treated as requirements (${sections.join("; ")}).`,
      suggested_question: "Can you confirm this content contains no requirements?", consolidation: {},
    });
  }

  // Scope / regression notes: identical statements for the same area collapse; provenance kept.
  const notes = [];
  for (const n of scopeNotes) {
    const existing = notes.find((x) => x.section === n.section && normaliseForQuote(x.quote ?? x.description) === normaliseForQuote(n.quote ?? n.description));
    if (existing) existing.aliases = [...new Set([...existing.aliases, ...n.aliases])];
    else notes.push({ ...n });
  }

  // ── Stage 5: deterministic validation and ID mapping ───────────────────
  const toId = (alias) => byAlias.get(alias)?.id;
  const result = {
    proposals: proposals.map((p) => ({
      sequence: p.sequence, proposal_type: "requirement", proposed_title: p.proposed_title.slice(0, 300), proposed_description: p.proposed_description.slice(0, 4000),
      proposed_category: p.proposed_category, proposed_priority: p.proposed_priority,
      source_fragment_ids: p.aliases.map(toId), primary_source_fragment_id: toId(p.primary),
      source_quote: p.source_quote ? p.source_quote.slice(0, 2000) : null, rationale: p.rationale.slice(0, 2000),
      evidence_basis: p.evidence_basis, confidence: p.confidence,
      consolidation: { ...p.consolidation, members: p.consolidation.members.map((m) => ({ ...m, source_ids: m.source_ids.map(toId) })) },
    })),
    issues: issues.map((i, n) => ({
      sequence: n + 1, issue_type: i.issue_type, severity: i.severity, description: i.description.slice(0, 2000),
      suggested_question: i.suggested_question ? i.suggested_question.slice(0, 1000) : null,
      source_fragment_ids: i.aliases.map(toId), related_proposal_sequences: i.related,
      impact: i.impact, trigger_quote: i.trigger_quote ? String(i.trigger_quote).slice(0, 400) : null,
      consolidation: i.consolidation?.merged ? { ...i.consolidation, members: i.consolidation.members.map((m) => ({ ...m, source_ids: m.source_ids.map(toId) })) } : {},
    })),
    scope_notes: notes.map((n, i) => ({
      sequence: i + 1, note_type: "No Change", area: (n.applies_to || leaf(n.section)).slice(0, 300), description: n.description.slice(0, 2000),
      source_quote: n.quote ? n.quote.slice(0, 2000) : null, source_fragment_ids: n.aliases.map(toId),
    })),
  };
  const problems = validateAnalysisOutput(result, new Set(fragments.map((f) => f.id)));
  const counts = {};
  for (const f of fragments) counts[classOf(aliasFor(f))] = (counts[classOf(aliasFor(f))] ?? 0) + 1;
  const diagnostics = {
    prompt_version: PROMPT_VERSION, analysis_schema_version: ANALYSIS_SCHEMA_VERSION,
    fragment_count: fragments.length, chunk_count: chunks.length, section_count: new Set(fragments.map(sectionLabel)).size,
    classifications: counts,
    fragment_classifications: Object.fromEntries(fragments.map((f) => [f.id, classOf(aliasFor(f))])),
    candidates_before_consolidation: candidates.length, coverage_candidates: candidates.filter((c) => c.origin === "coverage").length,
    issues_before_consolidation: rawIssues.length,
    proposal_count: result.proposals.length, issue_count: result.issues.length, scope_note_count: result.scope_notes.length,
    uncaptured_statements: uncaptured, excluded_plan_statements: excludedPlans, suppressed_issues: suppressedIssues,
    consolidation_overrides: consolidationOverrides,
    stage_calls: stageCalls, warnings,
  };
  if (problems.length) throw new AnalysisError("validation_failed", `Deterministic validation failed: ${problems.slice(0, 3).join("; ")}`.slice(0, 900), diagnostics);
  return { ...result, diagnostics, withWarnings: warnings.length > 0 };
}

const ENUMS = {
  evidence_basis: ["Explicit", "Inferred"], confidence: ["High", "Medium", "Low"], severity: ["High", "Medium", "Low"],
  category: ["Business Rule", "Database", "Backend", "UI", "Performance", "Testing"], priority: ["Low", "Medium", "High", "Critical"],
  issue_type: ["Ambiguity", "Missing Information", "Contradiction", "Untestable Statement", "Assumption Required", "Duplicate / Repeated Requirement", "Out of Scope / Administrative Content"],
  impact: ["implementation", "test_design", "acceptance_criteria", "data_migration", "integration", "scope", "operational"],
};

/** Stage 5 — also re-applied by the server before anything is stored. */
export function validateAnalysisOutput({ proposals, issues, scope_notes: scopeNotes = [] }, fragmentIds) {
  const problems = [];
  const seq = new Set();
  proposals.forEach((p, i) => {
    const where = `proposal ${i + 1}`;
    if (!Number.isInteger(p.sequence) || seq.has(p.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    seq.add(p.sequence);
    if (!Array.isArray(p.source_fragment_ids) || p.source_fragment_ids.length === 0) problems.push(`${where}: no source fragments (provenance required)`);
    else if (p.source_fragment_ids.some((id) => !fragmentIds.has(id))) problems.push(`${where}: cites a fragment that is not in this extraction run`);
    if (!p.source_fragment_ids?.includes(p.primary_source_fragment_id)) problems.push(`${where}: primary fragment is not one of its sources`);
    if (!String(p.proposed_title ?? "").trim() || !String(p.proposed_description ?? "").trim() || !String(p.rationale ?? "").trim()) problems.push(`${where}: title, description and rationale are required`);
    if (!ENUMS.evidence_basis.includes(p.evidence_basis)) problems.push(`${where}: invalid evidence_basis`);
    if (!ENUMS.confidence.includes(p.confidence)) problems.push(`${where}: invalid confidence`);
    if (p.proposed_category != null && !ENUMS.category.includes(p.proposed_category)) problems.push(`${where}: invalid category`);
    if (p.proposed_priority != null && !ENUMS.priority.includes(p.proposed_priority)) problems.push(`${where}: invalid priority`);
    if ("review_status" in p || "requirement_ref" in p) problems.push(`${where}: review status and references are not chosen by the analysis`);
  });
  const iseq = new Set();
  issues.forEach((issue, i) => {
    const where = `issue ${i + 1}`;
    if (!Number.isInteger(issue.sequence) || iseq.has(issue.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    iseq.add(issue.sequence);
    if (!Array.isArray(issue.source_fragment_ids) || issue.source_fragment_ids.length === 0) problems.push(`${where}: no source fragments`);
    else if (issue.source_fragment_ids.some((id) => !fragmentIds.has(id))) problems.push(`${where}: cites a fragment that is not in this extraction run`);
    if (!ENUMS.issue_type.includes(issue.issue_type)) problems.push(`${where}: invalid issue_type`);
    if (!ENUMS.severity.includes(issue.severity)) problems.push(`${where}: invalid severity`);
    if (!String(issue.description ?? "").trim()) problems.push(`${where}: description is required`);
    if ((issue.impact ?? []).some((m) => !ENUMS.impact.includes(m))) problems.push(`${where}: invalid impact`);
    if ((issue.related_proposal_sequences ?? []).some((s) => !seq.has(s))) problems.push(`${where}: refers to a proposal that does not exist`);
  });
  const nseq = new Set();
  scopeNotes.forEach((n, i) => {
    const where = `scope note ${i + 1}`;
    if (!Number.isInteger(n.sequence) || nseq.has(n.sequence)) problems.push(`${where}: duplicate or missing sequence`);
    nseq.add(n.sequence);
    if (!Array.isArray(n.source_fragment_ids) || n.source_fragment_ids.length === 0) problems.push(`${where}: no source fragments`);
    else if (n.source_fragment_ids.some((id) => !fragmentIds.has(id))) problems.push(`${where}: cites a fragment that is not in this extraction run`);
    if (!String(n.description ?? "").trim()) problems.push(`${where}: description is required`);
  });
  return problems;
}
