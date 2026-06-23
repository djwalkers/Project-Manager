import type { Project, TimelineItem } from "@/lib/types";

const DAY_MS = 86_400_000;

export type ScheduleHealth = "Green" | "Amber" | "Red";

export type ScheduleMetrics = {
  valid: boolean;
  message: string | null;
  projectStart: string | null;
  projectEnd: string | null;
  daysRemaining: number | null;
  plannedProgress: number | null;
  actualProgress: number | null;
  variance: number | null;
  health: ScheduleHealth | null;
  active: TimelineItem[];
  upcoming: TimelineItem[];
  atRisk: TimelineItem[];
  blocked: TimelineItem[];
  projectComplete: boolean;
};

export function parseScheduleDate(value?: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) return null;
  const iso = value.slice(0, 10);
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : date;
}

export function formatScheduleDate(value?: string | null) {
  const date = parseScheduleDate(value);
  return date
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date)
    : "Not set";
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function dateOnly(date: Date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

function durationDays(start: Date, end: Date) {
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

export function calculateSchedule(project: Project, items: TimelineItem[], now = new Date()): ScheduleMetrics {
  const validItems = items
    .map((item) => ({ item, start: parseScheduleDate(item.start_date), end: parseScheduleDate(item.end_date) }))
    .filter((entry): entry is { item: TimelineItem; start: Date; end: Date } => Boolean(entry.start && entry.end && entry.end >= entry.start));

  const earliest = [...validItems].sort((a, b) => a.start.getTime() - b.start.getTime())[0]?.start ?? null;
  const latest = [...validItems].sort((a, b) => b.end.getTime() - a.end.getTime())[0]?.end ?? null;
  const savedStart = project.planned_start_date ? parseScheduleDate(project.planned_start_date) : null;
  const savedEnd = project.planned_end_date ? parseScheduleDate(project.planned_end_date) : null;
  const invalidSavedDate = Boolean((project.planned_start_date && !savedStart) || (project.planned_end_date && !savedEnd));
  const start = savedStart ?? earliest;
  const end = savedEnd ?? latest;
  const invalidItemDates = validItems.length !== items.length;
  const valid = Boolean(start && end && end >= start && !invalidSavedDate && !invalidItemDates);
  const projectComplete = project.status === "Complete" || (items.length > 0 && items.every((item) => item.status === "Complete"));
  const active = items.filter((item) => item.status === "In Progress").sort((a, b) => a.start_date.localeCompare(b.start_date));
  const atRisk = items.filter((item) => item.status === "At Risk").sort((a, b) => a.start_date.localeCompare(b.start_date));
  const blocked = items.filter((item) => item.status === "Blocked").sort((a, b) => a.start_date.localeCompare(b.start_date));
  const today = dateOnly(now);
  const upcoming = items
    .filter((item) => item.status === "Not Started" && (parseScheduleDate(item.start_date)?.getTime() ?? 0) >= today.getTime())
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (!valid || !start || !end) {
    return {
      valid: false,
      message: "Schedule dates need review",
      projectStart: start?.toISOString().slice(0, 10) ?? null,
      projectEnd: end?.toISOString().slice(0, 10) ?? null,
      daysRemaining: null,
      plannedProgress: null,
      actualProgress: null,
      variance: null,
      health: null,
      active,
      upcoming,
      atRisk,
      blocked,
      projectComplete,
    };
  }

  const totalProjectDays = durationDays(start, end);
  const elapsedDays = durationDays(start, today);
  const plannedProgress = rounded(clamp((elapsedDays / totalProjectDays) * 100));
  const weightedDurations = validItems.map((entry) => ({
    duration: durationDays(entry.start, entry.end),
    progress: clamp(Number(entry.item.progress_percent) || 0),
  }));
  const totalPhaseDays = weightedDurations.reduce((total, item) => total + item.duration, 0);
  const actualProgress = rounded(totalPhaseDays
    ? weightedDurations.reduce((total, item) => total + item.progress * item.duration, 0) / totalPhaseDays
    : 0);
  const variance = rounded(actualProgress - plannedProgress);
  const isPastEnd = today.getTime() > end.getTime();
  const health: ScheduleHealth = isPastEnd && !projectComplete
    ? "Red"
    : variance >= 0
      ? "Green"
      : variance >= -10
        ? "Amber"
        : "Red";

  return {
    valid: true,
    message: null,
    projectStart: start.toISOString().slice(0, 10),
    projectEnd: end.toISOString().slice(0, 10),
    daysRemaining: Math.max(0, Math.ceil((end.getTime() - today.getTime()) / DAY_MS)),
    plannedProgress,
    actualProgress,
    variance,
    health,
    active,
    upcoming,
    atRisk,
    blocked,
    projectComplete,
  };
}

export function scheduleBarPosition(item: TimelineItem, startValue: string, endValue: string) {
  const rangeStart = parseScheduleDate(startValue);
  const rangeEnd = parseScheduleDate(endValue);
  const itemStart = parseScheduleDate(item.start_date);
  const itemEnd = parseScheduleDate(item.end_date);
  if (!rangeStart || !rangeEnd || !itemStart || !itemEnd || rangeEnd < rangeStart || itemEnd < itemStart) return null;
  const total = Math.max(1, durationDays(rangeStart, rangeEnd));
  const left = clamp((Math.max(0, (itemStart.getTime() - rangeStart.getTime()) / DAY_MS) / total) * 100);
  const width = clamp((durationDays(itemStart, itemEnd) / total) * 100, 0.8, 100 - left);
  return { left, width };
}

export function todayPosition(startValue: string, endValue: string, now = new Date()) {
  const start = parseScheduleDate(startValue);
  const end = parseScheduleDate(endValue);
  const today = dateOnly(now);
  if (!start || !end || today < start || today > end) return null;
  return clamp(((today.getTime() - start.getTime()) / Math.max(DAY_MS, end.getTime() - start.getTime())) * 100);
}
