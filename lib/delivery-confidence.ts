import type { DataStore } from "@/lib/data-store";
import { buildDeliveryInsightAnalysis, recommendationPenalty } from "@/lib/recommendations";
import { selectActiveProject } from "@/lib/project-scope";
import type { Project } from "@/lib/types";

export type DeliveryConfidenceResult = {
  score: number;
  reasons: string[];
  rag: "Green" | "Amber" | "Red";
};

// project defaults to selectActiveProject(data) — every existing caller
// that doesn't pass one keeps today's behaviour unchanged. Callers that
// have already resolved an exact project (e.g. lib/project-state.ts) pass
// it explicitly so this never re-selects a different project underneath.
export function computeDeliveryConfidence(data: DataStore, project: Project | null = selectActiveProject(data)): DeliveryConfidenceResult {
  if (!project) return { score: 0, reasons: ["No active project"], rag: "Red" };

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
