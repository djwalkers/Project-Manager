import type { AISuggestion, AIAnalysisResponse } from "@/lib/meeting-intelligence/types";

const CONFIDENCE_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().replace(/\s+/g, " ");
}

function wordSet(s: string): Set<string> {
  return new Set(normalizeTitle(s).split(" ").filter((w) => w.length > 2));
}

/** Jaccard-style overlap between title word sets. */
function wordOverlap(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

function areDuplicates(a: AISuggestion, b: AISuggestion): boolean {
  if (a.entity_type !== b.entity_type) return false;

  const na = normalizeTitle(a.title);
  const nb = normalizeTitle(b.title);
  if (na === nb) return true;
  if (wordOverlap(a.title, b.title) >= 0.6) return true;

  // Same target record + same action is a definite duplicate
  if (
    a.existing_record_ref &&
    b.existing_record_ref &&
    a.existing_record_ref === b.existing_record_ref &&
    a.action === b.action
  ) return true;

  return false;
}

/** Merge two duplicates, keeping the higher-confidence version as the primary. */
function mergePair(a: AISuggestion, b: AISuggestion): AISuggestion {
  const rankA = CONFIDENCE_RANK[a.confidence] ?? 2;
  const rankB = CONFIDENCE_RANK[b.confidence] ?? 2;
  const [primary, secondary] = rankA >= rankB ? [a, b] : [b, a];
  return {
    ...primary,
    description: primary.description ?? secondary.description,
    reason: primary.reason ?? secondary.reason,
    existing_record_ref: primary.existing_record_ref ?? secondary.existing_record_ref,
    data_payload: primary.data_payload ?? secondary.data_payload,
  };
}

/**
 * Merge per-chunk analysis results into a single deduplicated response.
 * Summaries are joined; suggestions are flattened and deduplicated by
 * entity_type + title similarity.
 */
export function mergeAnalysisResults(results: AIAnalysisResponse[]): AIAnalysisResponse {
  if (results.length === 0) return { summary: "", suggestions: [] };
  if (results.length === 1) return results[0];

  const summary = results.map((r) => r.summary).filter(Boolean).join(" ");

  // Flatten all suggestions then greedily deduplicate
  const all: AISuggestion[] = results.flatMap((r) => r.suggestions);
  const merged: AISuggestion[] = [];

  for (const candidate of all) {
    const idx = merged.findIndex((m) => areDuplicates(m, candidate));
    if (idx !== -1) {
      merged[idx] = mergePair(merged[idx], candidate);
    } else {
      merged.push({ ...candidate });
    }
  }

  console.log(
    `[merger] chunks=${results.length} totalRaw=${all.length} afterDedup=${merged.length}`,
  );

  return { summary, suggestions: merged };
}
