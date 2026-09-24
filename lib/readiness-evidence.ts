import { phaseFromText } from "@/lib/project-phase";
import type { Milestone, TimelineItem } from "@/lib/types";

// ── Lifecycle evidence for Go-Live readiness gates ──────────────────────────
//
// Controlled signals only: a milestone is a structured lifecycle record
// with an explicit status, so a *completed* gate milestone is real
// evidence. Free-text evidence notes are never read here — a note saying
// "development done" must not silently complete a gate.
//
// Title vocabulary reuses phaseFromText() (lib/project-phase.ts) so a
// milestone counts toward a gate only when phase detection would place it
// in that same stage.

export type GateSignal = "Complete" | "Incomplete" | null;

const SIGN_OFF = /\bsign(?:ed)?[\s-]?off\b|\bsignoff\b/i;
const COMPLETION = /\b(?:complete|completed|completion|exit|finished)\b/i;
const HANDOVER = /\bhand[\s-]?over\b/i;
const DEV_TERM = /\b(?:dev|development|build|code)\b/i;

type Matcher = (title: string) => boolean;

/**
 * Decides a gate from its milestones. Tier 1 (formal sign-off) outranks
 * tier 2 (completion/handover markers): when any tier-1 milestone exists,
 * only tier 1 is used. Within the chosen tier the gate is Complete only
 * when every matching milestone is Complete; null when no milestone
 * matches at all (no lifecycle evidence either way).
 */
function tieredSignal(milestones: Pick<Milestone, "title" | "status">[], tiers: Matcher[]): GateSignal {
  for (const matches of tiers) {
    const hits = milestones.filter((m) => matches(m.title ?? ""));
    if (hits.length > 0) return hits.every((m) => m.status === "Complete") ? "Complete" : "Incomplete";
  }
  return null;
}

const isSitTitle = (title: string) => phaseFromText(title) === "SIT";

/** SIT stage evidence: a SIT/testing sign-off milestone, else a SIT completion milestone. */
export function sitMilestoneSignal(milestones: Pick<Milestone, "title" | "status">[]): GateSignal {
  return tieredSignal(milestones, [
    (t) => isSitTitle(t) && SIGN_OFF.test(t),
    (t) => isSitTitle(t) && COMPLETION.test(t),
  ]);
}

/**
 * Development stage evidence: a development/build sign-off, else a
 * development completion or handover milestone. A title that phase
 * detection places in a later stage (SIT, UAT, Deployment) never counts.
 */
export function developmentMilestoneSignal(milestones: Pick<Milestone, "title" | "status">[]): GateSignal {
  const isDevTitle = (t: string) => {
    const phase = phaseFromText(t);
    return (phase === "Development" || (phase === null && DEV_TERM.test(t))) && DEV_TERM.test(t);
  };
  return tieredSignal(milestones, [
    (t) => isDevTitle(t) && SIGN_OFF.test(t),
    (t) => isDevTitle(t) && (COMPLETION.test(t) || HANDOVER.test(t)),
  ]);
}

// ── Pre-deployment decision point ──────────────────────────────────────────
//
// A go/no-go decision is the gate BEFORE deployment ("are we safe and
// authorised to deploy?"). It is not itself a lifecycle phase, so it never
// changes the derived phase — it only marks that the deployment-readiness
// controls must now be answerable. "Reached" means the step is active or
// complete; a future (Not Started) go/no-go step is not reached.

const GO_NO_GO = /\bgo\s*[/-]?\s*no\s*[/-]?\s*go\b/i;
const REACHED_STATUSES = new Set(["In Progress", "At Risk", "Blocked", "Complete"]);

export function preDeploymentDecisionReached(
  timeline: Pick<TimelineItem, "phase_name" | "phase_ref" | "status">[],
  milestones: Pick<Milestone, "title" | "status">[],
): boolean {
  return timeline.some((t) => REACHED_STATUSES.has(t.status) && GO_NO_GO.test(`${t.phase_ref} ${t.phase_name}`))
    || milestones.some((m) => REACHED_STATUSES.has(m.status) && GO_NO_GO.test(m.title ?? ""));
}
