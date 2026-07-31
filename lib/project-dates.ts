import type { DataStore } from "@/lib/data-store";
import { scopeProjectData } from "@/lib/project-scope";
import type { Milestone, Project } from "@/lib/types";

// Same pattern used everywhere a "Go Live" milestone has historically been
// matched (lib/go-live-readiness.ts, lib/project-intelligence.ts) — reused
// here rather than redefined, so this resolver picks the exact same
// milestone those call sites already picked before being migrated onto it.
const GO_LIVE_MILESTONE_PATTERN = /go.?live/i;

export type GoLiveDateSource = "milestone" | "go_live_date" | "planned_end_date" | "none";

export type GoLiveDateConflict = {
  source: Exclude<GoLiveDateSource, "none">;
  date: string;
  detail: string;
};

export type GoLiveDateResolution = {
  date: string | null;
  source: GoLiveDateSource;
  milestoneId: string | null;
  milestoneTitle: string | null;
  conflicts: GoLiveDateConflict[];
};

function isGoLiveMilestone(milestone: Milestone): boolean {
  return GO_LIVE_MILESTONE_PATTERN.test(milestone.title) && Boolean(milestone.target_date);
}

// When more than one milestone title matches, pick deterministically:
// an open (not Complete) milestone outranks a completed one — a completed
// go-live milestone from a prior plan shouldn't stay authoritative — then
// the latest target_date wins (the most recently (re)planned date), then a
// stable id-ordered tiebreak so the result never depends on array order.
function selectGoLiveMilestone(milestones: Milestone[]): Milestone | null {
  const candidates = milestones.filter(isGoLiveMilestone);
  if (!candidates.length) return null;

  const sorted = [...candidates].sort((a, b) => {
    const aOpenRank = a.status === "Complete" ? 1 : 0;
    const bOpenRank = b.status === "Complete" ? 1 : 0;
    if (aOpenRank !== bOpenRank) return aOpenRank - bOpenRank;

    const dateCompare = String(b.target_date).localeCompare(String(a.target_date));
    if (dateCompare !== 0) return dateCompare;

    return a.id.localeCompare(b.id);
  });

  return sorted[0];
}

/**
 * The single authoritative source for "when is this project going live",
 * replacing three previously-independent computations of the same
 * expression (lib/go-live-readiness.ts, lib/project-intelligence.ts,
 * lib/email-content.ts).
 *
 * Precedence: a live "Go Live" milestone, then the explicit
 * project.go_live_date override column, then project.planned_end_date as a
 * last resort, then none. calculateSchedule()'s use of planned_end_date for
 * internal progress/variance math is a separate concept and is untouched.
 *
 * Reports (does not prevent resolution) when multiple populated sources —
 * including multiple similarly-named milestones — disagree, so the
 * disagreement is visible rather than silently resolved.
 */
export function resolveGoLiveDate(data: DataStore, project: Project): GoLiveDateResolution {
  const scoped = scopeProjectData(data, project);
  const milestone = selectGoLiveMilestone(scoped.milestones);
  const conflicts: GoLiveDateConflict[] = [];

  const candidates: Array<{ source: Exclude<GoLiveDateSource, "none">; date: string | null; detail: string }> = [
    {
      source: "milestone",
      date: milestone?.target_date ?? null,
      detail: milestone ? `${milestone.milestone_ref}: "${milestone.title}"` : "",
    },
    { source: "go_live_date", date: project.go_live_date, detail: "project.go_live_date" },
    { source: "planned_end_date", date: project.planned_end_date, detail: "project.planned_end_date" },
  ];

  const populated = candidates.filter(
    (candidate): candidate is { source: Exclude<GoLiveDateSource, "none">; date: string; detail: string } =>
      Boolean(candidate.date),
  );

  // Other milestones matching the go-live pattern with a different date than
  // the selected one — a data-quality signal distinct from the cross-source
  // conflict check below (e.g. a stale duplicate milestone left behind after
  // a re-plan).
  scoped.milestones
    .filter((item) => item.id !== milestone?.id && isGoLiveMilestone(item) && item.target_date !== milestone?.target_date)
    .forEach((item) => {
      conflicts.push({
        source: "milestone",
        date: item.target_date as string,
        detail: `${item.milestone_ref}: "${item.title}" (not selected — see resolveGoLiveDate precedence)`,
      });
    });

  if (populated.length >= 2 && new Set(populated.map((candidate) => candidate.date)).size >= 2) {
    populated.forEach((candidate) => conflicts.push(candidate));
  }

  const winner = populated[0] ?? null;

  return {
    date: winner?.date ?? null,
    source: winner?.source ?? "none",
    milestoneId: winner?.source === "milestone" ? (milestone?.id ?? null) : null,
    milestoneTitle: winner?.source === "milestone" ? (milestone?.title ?? null) : null,
    conflicts,
  };
}
