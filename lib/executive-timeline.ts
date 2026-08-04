// Executive Timeline — viewport windowing only.
//
// This module deliberately contains no schedule/business calculations —
// those all come from lib/schedule.ts (dateRangePosition/datePosition/
// scheduleBarPosition/todayPosition), ProjectState, and Project Intelligence.
// This file only answers "which dates is the viewport currently showing,
// and where do the weekend/week/month gridlines fall" — pure viewport
// geometry, not a second scheduling engine.
import type { ReadinessCheckResult } from "@/lib/go-live-readiness";
import { isDeliverableBlocked, isRiskHighOrCritical, isRiskOpen } from "@/lib/lifecycle";
import type { ProjectState } from "@/lib/project-state";
import { parseScheduleDate } from "@/lib/schedule";
import type { Deliverable, Milestone, RequirementSignOff, Risk } from "@/lib/types";

export type TimelineZoom = "Month" | "Quarter" | "Year";
export const TIMELINE_ZOOMS: TimelineZoom[] = ["Month", "Quarter", "Year"];

export type TimelineWindow = { start: string; end: string };
export type TimelineTick = { date: string; label: string };

function ymd(year: number, monthIndex0: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex0, day)).toISOString().slice(0, 10);
}

/**
 * The calendar Month/Quarter/Year window containing `center`, using
 * `center`'s local calendar fields (it's normally "now" or a target date
 * a user clicked) but returning stable UTC-normalised yyyy-mm-dd strings,
 * the same date format every other schedule helper expects.
 */
export function zoomWindow(center: Date, zoom: TimelineZoom): TimelineWindow {
  const y = center.getFullYear();
  const m = center.getMonth();
  if (zoom === "Month") return { start: ymd(y, m, 1), end: ymd(y, m + 1, 0) };
  if (zoom === "Quarter") {
    const quarterStart = Math.floor(m / 3) * 3;
    return { start: ymd(y, quarterStart, 1), end: ymd(y, quarterStart + 3, 0) };
  }
  return { start: ymd(y, 0, 1), end: ymd(y, 11, 31) };
}

/** Every Saturday–Sunday pair (clamped to the window) within [windowStart, windowEnd]. */
export function weekendRanges(windowStart: string, windowEnd: string): TimelineWindow[] {
  const start = parseScheduleDate(windowStart);
  const end = parseScheduleDate(windowEnd);
  if (!start || !end || end < start) return [];

  const ranges: TimelineWindow[] = [];
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() + ((6 - cursor.getUTCDay() + 7) % 7)); // first Saturday on/after start

  while (cursor <= end) {
    const saturday = new Date(cursor);
    const sunday = new Date(cursor);
    sunday.setUTCDate(sunday.getUTCDate() + 1);
    const clampedSunday = sunday > end ? end : sunday;
    ranges.push({ start: saturday.toISOString().slice(0, 10), end: clampedSunday.toISOString().slice(0, 10) });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return ranges;
}

/** The 1st of every month within [windowStart, windowEnd], for header scale labels. */
export function monthTicks(windowStart: string, windowEnd: string): TimelineTick[] {
  const start = parseScheduleDate(windowStart);
  const end = parseScheduleDate(windowEnd);
  if (!start || !end || end < start) return [];

  const spansMultipleYears = start.getUTCFullYear() !== end.getUTCFullYear();
  const ticks: TimelineTick[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const label = cursor.toLocaleDateString("en-GB", {
      month: "short",
      timeZone: "UTC",
      ...(spansMultipleYears ? { year: "2-digit" as const } : {}),
    });
    ticks.push({ date: cursor.toISOString().slice(0, 10), label });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

/** Every Monday within [windowStart, windowEnd], for the week-division gridlines. */
export function weekTicks(windowStart: string, windowEnd: string): string[] {
  const start = parseScheduleDate(windowStart);
  const end = parseScheduleDate(windowEnd);
  if (!start || !end || end < start) return [];

  const ticks: string[] = [];
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() + ((1 - cursor.getUTCDay() + 7) % 7)); // first Monday on/after start
  while (cursor <= end) {
    ticks.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return ticks;
}

// ── Timeline Intelligence panel ──────────────────────────────────────────────
// A pure projection of ProjectState — every field here is an existing
// ProjectState/scoped fact, filtered with the exact same lifecycle helpers
// every other page already uses. No new business logic, no new scoring.
export type TimelineIntelligence = {
  blockers: ReadinessCheckResult[];
  upcomingMilestones: Milestone[];
  openRisks: Risk[];
  outstandingApprovals: RequirementSignOff[];
  blockedDeliverables: Deliverable[];
};

export function buildTimelineIntelligence(state: ProjectState): TimelineIntelligence {
  const { scoped, goLive } = state;
  return {
    blockers: goLive.checks.filter((c) => c.effective === "Incomplete"),
    upcomingMilestones: [...scoped.milestones]
      .filter((m) => m.status !== "Complete")
      .sort((a, b) => String(a.target_date ?? "").localeCompare(String(b.target_date ?? "")))
      .slice(0, 5),
    openRisks: scoped.risks.filter((r) => isRiskHighOrCritical(r.impact) && isRiskOpen(r.status)),
    outstandingApprovals: (scoped.requirement_sign_offs ?? []).filter((s) => s.status !== "Approved"),
    blockedDeliverables: scoped.deliverables.filter((d) => isDeliverableBlocked(d)),
  };
}
