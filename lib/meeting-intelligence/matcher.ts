import type { DataStore } from "@/lib/data-store";
import { scopeProjectData, selectActiveProject } from "@/lib/project-scope";
import type { AISuggestion } from "@/lib/meeting-intelligence/types";

// Simple keyword overlap score (0–1)
function similarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

type MatchResult = {
  existingId: string;
  existingRef: string;
  score: number;
};

function findBestMatch(
  title: string,
  description: string | null,
  candidates: { id: string; ref: string; text: string }[],
): MatchResult | null {
  const needle = `${title} ${description ?? ""}`;
  let best: MatchResult | null = null;
  for (const c of candidates) {
    const score = similarity(needle, c.text);
    if (score > 0.4 && (!best || score > best.score)) {
      best = { existingId: c.id, existingRef: c.ref, score };
    }
  }
  return best;
}

export type EnrichedSuggestion = AISuggestion & {
  matched_existing_id: string | null;
  matched_existing_ref: string | null;
};

export function matchSuggestionsToExisting(
  suggestions: AISuggestion[],
  data: DataStore,
): EnrichedSuggestion[] {
  const project = selectActiveProject(data);
  if (!project) return suggestions.map((s) => ({ ...s, matched_existing_id: null, matched_existing_ref: null }));
  const scoped = scopeProjectData(data, project);

  // Build lookup tables per entity type
  const lookup: Record<string, { id: string; ref: string; text: string }[]> = {
    action: scoped.actions.filter((a) => !["Complete", "Closed"].includes(a.status)).map((a) => ({
      id: a.id, ref: a.action_ref, text: `${a.description} ${a.owner ?? ""}`,
    })),
    decision: scoped.decisions.filter((d) => !["Approved", "Closed"].includes(d.status)).map((d) => ({
      id: d.id, ref: d.decision_ref, text: `${d.question} ${d.decision ?? ""}`,
    })),
    risk: scoped.risks.filter((r) => !["Complete", "Closed"].includes(r.status)).map((r) => ({
      id: r.id, ref: r.risk_ref, text: r.description,
    })),
    discovery_question: scoped.discovery_questions.filter((q) => !["Answered", "Closed"].includes(q.status)).map((q) => ({
      id: q.id, ref: q.question_ref, text: q.question,
    })),
    requirement: scoped.requirements.map((r) => ({
      id: r.id, ref: r.requirement_ref, text: `${r.title} ${r.description ?? ""}`,
    })),
    milestone: scoped.milestones.filter((m) => !["Complete", "Closed"].includes(m.status)).map((m) => ({
      id: m.id, ref: m.milestone_ref, text: m.title,
    })),
    dependency: scoped.dependencies.filter((d) => !["Complete", "Closed"].includes(d.status)).map((d) => ({
      id: d.id, ref: d.id, text: `${d.name} ${d.notes ?? ""}`,
    })),
  };

  return suggestions.map((s): EnrichedSuggestion => {
    // If AI already supplied an existing ref, honour it
    if (s.existing_record_ref && s.action !== "create") {
      // Try to resolve the ID from the ref
      const candidates = lookup[s.entity_type] ?? [];
      const found = candidates.find((c) => c.ref === s.existing_record_ref);
      return {
        ...s,
        matched_existing_id: found?.id ?? null,
        matched_existing_ref: s.existing_record_ref,
      };
    }

    // Only try to match "create" suggestions
    if (s.action !== "create") {
      return { ...s, matched_existing_id: null, matched_existing_ref: null };
    }

    const candidates = lookup[s.entity_type] ?? [];
    const match = findBestMatch(s.title, s.description, candidates);

    if (match) {
      return {
        ...s,
        action: "update",
        matched_existing_id: match.existingId,
        matched_existing_ref: match.existingRef,
        reason: s.reason
          ? `${s.reason} (Similar record ${match.existingRef} already exists)`
          : `Similar record ${match.existingRef} already exists`,
      };
    }

    return { ...s, matched_existing_id: null, matched_existing_ref: null };
  });
}
