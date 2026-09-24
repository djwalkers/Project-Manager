import { calendarDaysUntil } from "@/lib/calendar-days";
import type { ProjectPhase } from "@/lib/project-phase";

// ── Display helpers for the automated Daily Brief email ─────────────────────
//
// Presentation only: every input comes from the canonical ProjectState
// (phase, go-live date, hypercare dates, rollups) — nothing here derives a
// lifecycle outcome of its own.

export type BriefFocus = "discovery" | "development" | "testing" | "go-live" | "hypercare";

/** Which position the brief leads with for a canonical project phase. */
export function briefFocus(phase: ProjectPhase): BriefFocus {
  switch (phase) {
    case "Discovery":
    case "Analysis":
    case "Design":
      return "discovery";
    case "Development":
      return "development";
    case "SIT":
    case "UAT":
      return "testing";
    case "Deployment":
      return "go-live";
    default:
      return "hypercare"; // Hypercare, Closed
  }
}

export const BRIEF_FOCUS_TITLE: Record<BriefFocus, string> = {
  discovery: "Discovery & Analysis Position",
  development: "Development Position",
  testing: "Testing Position",
  "go-live": "Go-Live Position",
  hypercare: "Hypercare Position",
};

/** Calendar days from today to a YYYY-MM-DD date (canonical lib/calendar-days helper). */
export function daysUntil(dateStr: string, now: Date): number {
  return calendarDaysUntil(dateStr, now) ?? 0;
}

export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `in ${days}d`;
}

export type KeyDate = { label: string; date: string; days: number };

/**
 * The next not-complete milestone on or after today (earliest first), or
 * null. Ties on date keep the milestone_ref order.
 */
export function nextMilestone(
  milestones: { milestone_ref: string; title: string; target_date: string | null; status: string }[],
  todayStr: string,
  now: Date,
): KeyDate | null {
  const upcoming = milestones
    .filter((m) => m.target_date && m.target_date >= todayStr && m.status !== "Complete")
    .sort((a, b) => (a.target_date as string).localeCompare(b.target_date as string) || a.milestone_ref.localeCompare(b.milestone_ref));
  const m = upcoming[0];
  return m ? { label: `${m.milestone_ref} ${m.title}`, date: m.target_date as string, days: daysUntil(m.target_date as string, now) } : null;
}

/** Hypercare window when today falls inside it (canonical resolveHypercareDates output). */
export function activeHypercare(hypercare: { start: string | null; end: string | null }, todayStr: string, now: Date): KeyDate | null {
  if (!hypercare.end || hypercare.end < todayStr) return null;
  if (hypercare.start && hypercare.start > todayStr) return null;
  return { label: "Hypercare ends", date: hypercare.end, days: daysUntil(hypercare.end, now) };
}

/** First `max` items plus a "+N more" marker, so attention lists stay short. */
export function capList(items: string[], max = 3): string[] {
  return items.length > max ? [...items.slice(0, max), `+${items.length - max} more`] : items;
}

/** Percentage, or null when the denominator is zero (never a misleading 0%). */
export function percentOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : null;
}

export function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
