import type { DataStore } from "@/lib/data-store";
import { buildDeliveryInsightAnalysis, recommendationPenalty } from "@/lib/recommendations";
import { hasDeliveryEvidence, scopeProjectData, selectActiveProject } from "@/lib/project-scope";
import type { Project } from "@/lib/types";

export type DeliveryConfidenceResult = {
  score: number | null;
  reasons: string[];
  rag: "Green" | "Amber" | "Red" | "Not Assessed";
};

// project defaults to selectActiveProject(data) — every existing caller
// that doesn't pass one keeps today's behaviour unchanged. Callers that
// have already resolved an exact project (e.g. lib/project-state.ts) pass
// it explicitly so this never re-selects a different project underneath.
export function computeDeliveryConfidence(data: DataStore, project: Project | null = selectActiveProject(data)): DeliveryConfidenceResult {
  if (!project) return { score: 0, reasons: ["No active project"], rag: "Red" };

  // A project with zero delivery evidence of any kind has nothing for the
  // analysis below to flag — its candidate generation comes back empty by
  // construction, which previously read as a false 100%/Green ("all
  // checks passed"). Absence of evidence is not evidence of good (or bad)
  // delivery: report it as genuinely unassessed instead. See
  // hasDeliveryEvidence's doc comment for the exact threshold.
  if (!hasDeliveryEvidence(scopeProjectData(data, project))) {
    return { score: null, reasons: ["No delivery evidence recorded yet for this project"], rag: "Not Assessed" };
  }

  const analysis = buildDeliveryInsightAnalysis(data, 10, new Date(), project);
  const scoredGaps = analysis.insights
    .map((item) => ({ item, penalty: recommendationPenalty(item) }))
    .filter((entry) => entry.penalty > 0);

  const totalPenalty = Math.min(
    scoredGaps.reduce((total, entry) => total + entry.penalty, 0),
    45,
  );
  const final = Math.max(0, Math.min(100, 100 - totalPenalty));
  const rag: "Green" | "Amber" | "Red" =
    final >= 70 ? "Green" : final >= 40 ? "Amber" : "Red";

  const phaseLabel = analysis.phase
    ? `${analysis.phase.phase} phase (${analysis.phase.detail})`
    : "current phase could not be determined";
  const reasons = scoredGaps.length
    ? [
        `Phase-aware assessment: ${phaseLabel}`,
        ...scoredGaps.slice(0, 5).map(({ item }) =>
          item.entityId
            ? `${item.entityId}: ${item.title}`
            : item.title,
        ),
      ]
    : [];

  return { score: final, reasons, rag };
}
