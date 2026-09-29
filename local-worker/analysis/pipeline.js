// Staged requirement analysis of ONE extraction run (Phase 1C).
//
//   Stage 1 classification   per chunk  — what each fragment is
//   Stage 2 requirements     per chunk  — candidates from requirement fragments only
//   Stage 3 ambiguities      per chunk  — open questions / gaps / conflicts
//   Stage 4 consolidation    whole run  — group duplicate candidates and issues
//   Stage 5 validation       deterministic — schema, provenance, IDs, enums
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
// The model never chooses review status, never produces requirement
// references, and never writes consolidated text: a merged proposal takes
// the wording of its strongest member verbatim.

import { createHash } from "node:crypto";
import { aliasFor, buildChunks, documentOutline, sectionLabel } from "./chunk.js";
import { ANALYSIS_SCHEMA_VERSION, PROMPT_VERSION, SYSTEM_PROMPT, ambiguitiesPrompt, classificationPrompt, consolidationPrompt, requirementsPrompt } from "./prompts.js";
import { STAGE_SCHEMAS, validateSchema } from "./schemas.js";

export const MAX_ATTEMPTS = 3;
export const CONTEXT_CHAR_BUDGET = 3000;
export const MAX_CONSOLIDATION_ITEMS = 150;
export const MAX_REQUIREMENTS_PER_AMBIGUITY_CALL = 8;
// A model-proposed merge is accepted only between items whose wording
// overlaps enough. Items from the SAME source section were listed as
// distinct by the model there, so they must be near-identical to merge
// (measured: distinct statements of one sentence score ≈0.45, genuine
// repeats in different sections ≈0.5); across sections a moderate overlap.
export const SAME_SECTION_MERGE_SIMILARITY = 0.6;
export const CROSS_SECTION_MERGE_SIMILARITY = 0.35;
const STOPWORDS = new Set("the and for with that this from into onto than then there their they them shall should must will would could also any all are was were been being has have had not only its it's which when where what who whom whose each such other same after before while just very more most some can may".split(" "));

export function wordSet(text) {
  return new Set(normaliseForQuote(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
}
export function similarity(a, b) {
  const x = wordSet(a), y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Splits a model-proposed group into connected components of allowed merges. */
export function verifyGroup(members, textOf, sectionOf) {
  const parent = new Map(members.map((m) => [m, m]));
  const find = (m) => (parent.get(m) === m ? m : find(parent.get(m)));
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const threshold = sectionOf(members[i]) === sectionOf(members[j]) ? SAME_SECTION_MERGE_SIMILARITY : CROSS_SECTION_MERGE_SIMILARITY;
    if (similarity(textOf(members[i]), textOf(members[j])) >= threshold) parent.set(find(members[j]), find(members[i]));
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

/** Whitespace/quote/case-insensitive normalisation for the verbatim-quote check. */
export function normaliseForQuote(text) {
  return String(text ?? "").normalize("NFKC").replace(/[‘’´`]/g, "'").replace(/[“”]/g, "\"")
    .replace(/[‐‑‒–—]/g, "-").toLowerCase().replace(/\s+/g, " ").replace(/^[\s"'.,;:…-]+|[\s"'.,;:…-]+$/g, "").trim();
}

// A tracker/specification "Priority: X" field (any source format). Used only
// to check the model's proposed priority — never to create a requirement.
const PRIORITY_FIELD = /(?:^|\n)[\s*]*priority[\s*]*[:：]\s*(low|medium|high|critical)\b/gi;
export function priorityFields(fragments) {
  return fragments.flatMap((f) => [...String(f.text).matchAll(PRIORITY_FIELD)].map((m) => ({ alias: aliasFor(f), value: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() })));
}

function render(fragments) {
  return buildChunks(fragments, Number.MAX_SAFE_INTEGER).map((c) => c.text).join("\n\n");
}

function truncate(text, budget) {
  return text.length <= budget ? text : `${text.slice(0, budget)}\n… (context truncated)`;
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
      conversation.push({ role: "user", content: `Your JSON was rejected:\n- ${errors.slice(0, 12).join("\n- ")}\nReturn the corrected JSON only, using only the fragment IDs shown in the text.` });
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

  // ── Stage 2 + 3 per chunk ──────────────────────────────────────────────
  const candidates = [];
  const rawIssues = [];
  for (const chunk of chunks) {
    const inChunk = chunk.fragmentIds.map((id) => fragments.find((f) => f.id === id));
    const reqFragments = inChunk.filter((f) => REQUIREMENT_LIKE.has(classOf(aliasFor(f))));
    if (reqFragments.length === 0) continue;
    const reqAliases = new Set(reqFragments.map(aliasFor));
    const contextHere = contextFragments.filter((f) => !chunk.fragmentIds.includes(f.id));
    const contextAliases = new Set([...contextHere, ...inChunk.filter((f) => CONTEXT_LIKE.has(classOf(aliasFor(f))))].map(aliasFor));
    const contextText = truncate(render([...contextFragments].sort((a, b) => a.sequence - b.sequence)), CONTEXT_CHAR_BUDGET);

    const req = await callStage("requirements", chunk.key, requirementsPrompt({ sourceText: render(reqFragments), contextText }), (o) => {
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
    });

    const chunkCandidates = req.requirements.map((r) => {
      const ids = [...new Set([r.primary_source_id, ...r.source_ids])];
      const key = `R${candidates.length + 1}`;
      let evidence = r.evidence_basis;
      const cited = ids.map((a) => byAlias.get(a)?.text ?? "").join("\n");
      const quoteOk = normaliseForQuote(r.source_quote).length >= 8 && normaliseForQuote(cited).includes(normaliseForQuote(r.source_quote));
      if (evidence === "Explicit" && !quoteOk) {
        evidence = "Inferred";
        warnings.push(`${key}: marked Explicit but its quote was not found verbatim in the cited fragments — recorded as Inferred (Needs Review)`);
      }
      const candidate = {
        key, chunk: chunk.key, section: sectionLabel(byAlias.get(r.primary_source_id)), aliases: ids,
        title: r.title.trim(), description: r.description.trim(), primary: r.primary_source_id,
        quote: quoteOk ? r.source_quote.trim() : (r.source_quote.trim() || null), evidence_basis: evidence, confidence: r.confidence,
        category: r.category === "Unknown" ? null : r.category, priority: null,
        rationale: r.rationale.trim(),
      };
      const priority = checkedPriority(key, r.priority === "Not stated" ? null : r.priority, ids);
      candidate.priority = priority.value;
      candidate.aliases = [...new Set([...ids, ...priority.support])];
      candidates.push(candidate);
      return candidate;
    });

    // Stage 3 runs per batch of consecutive sections (≤ MAX_REQUIREMENTS_PER_AMBIGUITY_CALL
    // candidates each) so a long chunk does not collapse onto its last section.
    const batches = [];
    for (const label of chunk.sections) {
      const sectionFragments = inChunk.filter((f) => sectionLabel(f) === label);
      const sectionCandidates = chunkCandidates.filter((c) => sectionFragments.some((f) => aliasFor(f) === c.primary));
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
      const amb = await callStage("ambiguities", batchKey, ambiguitiesPrompt({ sourceText: render(batch.fragments), contextText, requirementsText }), (o) => {
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
        rawIssues.push({
          key: `I${rawIssues.length + 1}`, chunk: batchKey, ...issue,
          suggested_question: issue.suggested_question.trim().replace(/(\s*\?)+$/, "?"),
          related_requirements: issue.related_requirements.filter((k) => keys.has(k)),
        });
      }
    }
  }

  for (const [note, keys] of droppedPriorities) warnings.push(`${keys.join(", ")}: ${note}`);

  // ── Stage 4: consolidation across the whole run ────────────────────────
  const consolidationOverrides = [];
  async function group(kind, items, describe, textOf, sectionOf) {
    if (items.length < 2) return items.map((item) => ({ members: [item.key], reason: "unique" }));
    if (items.length > MAX_CONSOLIDATION_ITEMS) {
      warnings.push(`consolidation of ${kind} skipped: ${items.length} items exceed the limit of ${MAX_CONSOLIDATION_ITEMS}`);
      return items.map((item) => ({ members: [item.key], reason: "not consolidated" }));
    }
    const keys = new Set(items.map((i) => i.key));
    const out = await callStage("consolidation", kind, consolidationPrompt({ kind, itemsText: items.map(describe).join("\n") }), (o) => {
      const errors = [];
      const seen = new Set();
      const duplicates = [];
      for (const g of o.duplicates) {
        const members = [];
        for (const m of g.members) {
          if (!keys.has(m)) errors.push(`${m} is not one of the ITEMS`);
          else if (seen.has(m)) errors.push(`${m} appears in more than one group`);
          else { seen.add(m); members.push(m); }
        }
        if (members.length >= 2) duplicates.push({ ...g, members });
      }
      return { errors, cleaned: { duplicates } };
    });
    // Unlisted items are unique.
    const listed = new Set(out.duplicates.flatMap((g) => g.members));
    const proposedGroups = [...out.duplicates, ...items.filter((i) => !listed.has(i.key)).map((i) => ({ members: [i.key], reason: "unique", title: null }))]
      .sort((x, y) => Math.min(...x.members.map((k) => Number(k.slice(1)))) - Math.min(...y.members.map((k) => Number(k.slice(1)))));
    const verified = [];
    for (const g of proposedGroups) {
      const parts = verifyGroup(g.members, (k) => textOf(k), (k) => sectionOf(k));
      if (parts.length > 1) consolidationOverrides.push({ kind, proposed: g.members, kept_separate: parts });
      for (const members of parts) verified.push({ members, title: parts.length > 1 ? null : g.title, reason: parts.length > 1 ? (members.length > 1 ? `${g.reason} (partly accepted)` : "unique") : g.reason });
    }
    return verified;
  }

  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const requirementGroups = await group("requirements", candidates,
    (c) => `${c.key} [section: ${c.section}] ${c.title} — ${c.description}${c.quote ? ` (source: "${c.quote}")` : ""}`,
    (k) => { const c = byKey.get(k); return `${c.title} ${c.description}`; }, (k) => byKey.get(k).section);
  const proposals = [];
  const keyToSequence = new Map();
  const derivedIssues = [];
  for (const g of requirementGroups) {
    const members = g.members.map((k) => byKey.get(k)).sort((a, b) =>
      (a.evidence_basis === "Explicit" ? 0 : 1) - (b.evidence_basis === "Explicit" ? 0 : 1)
      || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
      || Number(a.key.slice(1)) - Number(b.key.slice(1)));
    const rep = members[0];
    const aliases = [...new Set([rep.primary, ...members.flatMap((m) => m.aliases)])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const priorities = [...new Set(members.map((m) => m.priority).filter(Boolean))];
    const sections = [...new Set(members.map((m) => m.section))];
    const sequence = proposals.length + 1;
    members.forEach((m) => keyToSequence.set(m.key, sequence));
    proposals.push({
      sequence,
      proposed_title: members.length > 1 && g.title?.trim() ? g.title.trim() : rep.title,
      proposed_description: sections.length > 1 ? `${rep.description}\n\nStated in: ${sections.map((l) => l.split(" › ").at(-1)).join("; ")}.` : rep.description,
      proposed_category: rep.category ?? members.map((m) => m.category).find(Boolean) ?? null,
      proposed_priority: priorities.length === 1 ? priorities[0] : null,
      aliases, primary: rep.primary, source_quote: rep.quote,
      rationale: members.length > 1 ? `${rep.rationale} Stated ${members.length} times in the source; consolidated into one proposal.` : rep.rationale,
      evidence_basis: rep.evidence_basis, confidence: rep.confidence,
      consolidation: {
        merged: members.length > 1, member_count: members.length, reason: g.reason,
        representative: rep.key, sections, priority_conflict: priorities.length > 1 ? priorities : undefined,
        members: members.map((m) => ({ key: m.key, title: m.title, section: m.section, evidence_basis: m.evidence_basis, confidence: m.confidence, source_ids: m.aliases })),
      },
    });
    if (members.length > 1 && sections.length > 1) {
      derivedIssues.push({
        issue_type: "Duplicate / Repeated Requirement", severity: "Low", aliases,
        description: `The same requirement ("${rep.title}") is stated ${members.length} times, in: ${sections.join("; ")}. The statements were consolidated into one proposal.`,
        suggested_question: `Do these ${members.length} statements describe one and the same requirement?`,
        related: [sequence],
      });
    }
  }

  const issueByKey = new Map(rawIssues.map((i) => [i.key, i]));
  const issueGroups = await group("issues", rawIssues, (i) => `${i.key} [${i.issue_type}] ${i.description} Q: ${i.suggested_question}`,
    (k) => { const i = issueByKey.get(k); return `${i.description} ${i.suggested_question}`; }, (k) => k); // issues: the moderate threshold
  const issues = [];
  for (const g of issueGroups) {
    const members = g.members.map((k) => issueByKey.get(k)).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Number(a.key.slice(1)) - Number(b.key.slice(1)));
    const rep = members[0];
    issues.push({
      issue_type: rep.issue_type, severity: rep.severity, description: rep.description, suggested_question: rep.suggested_question,
      aliases: [...new Set(members.flatMap((m) => m.source_ids))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      related: [...new Set(members.flatMap((m) => m.related_requirements).map((k) => keyToSequence.get(k)).filter(Boolean))],
    });
  }
  issues.push(...derivedIssues);

  if (statedPriorities.length > 1) {
    issues.push({
      issue_type: "Contradiction", severity: "Medium", aliases: [...new Set(priorityStatements.map((p) => p.alias))], related: [],
      description: `The document states different priorities: ${priorityStatements.map((p) => `${p.value} (${p.alias})`).join(", ")}. No priority was proposed.`,
      suggested_question: `Which priority applies: ${statedPriorities.join(" or ")}?`,
    });
  }

  const adminAliases = fragments.map(aliasFor).filter((a) => classOf(a) === "template_admin");
  if (adminAliases.length) {
    const sections = [...new Set(adminAliases.map((a) => sectionLabel(byAlias.get(a))))];
    issues.push({
      issue_type: "Out of Scope / Administrative Content", severity: "Low", aliases: adminAliases, related: [],
      description: `${adminAliases.length} fragment(s) were classified as template or administrative content and were not treated as requirements (${sections.join("; ")}).`,
      suggested_question: "Can you confirm this content contains no requirements?",
    });
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
    candidates_before_consolidation: candidates.length, issues_before_consolidation: rawIssues.length,
    proposal_count: result.proposals.length, issue_count: result.issues.length,
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
};

/** Stage 5 — also re-applied by the server before anything is stored. */
export function validateAnalysisOutput({ proposals, issues }, fragmentIds) {
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
    if ((issue.related_proposal_sequences ?? []).some((s) => !seq.has(s))) problems.push(`${where}: refers to a proposal that does not exist`);
  });
  return problems;
}
