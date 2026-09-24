// Canonical calendar-day arithmetic for countdowns (days to go-live,
// days to a milestone, …). "Today" is the calendar date in the business
// time zone, and both sides are compared as whole calendar dates, so a
// countdown never changes with the time of day or with the server/browser
// clock's time zone. Europe/London matches the dates already printed in
// emails and reports (subjectDate / reportLongDate).

export const BUSINESS_TIME_ZONE = "Europe/London";

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Today's calendar date (YYYY-MM-DD) in the business time zone. */
export function businessDate(now: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function dateOnlyUtcMs(value: string): number | null {
  const m = DATE_ONLY.exec(value.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject impossible dates (e.g. 2026-02-30) instead of rolling them over.
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== m[0] ? null : ms;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD, time parts ignored). */
export function calendarDaysBetween(from: string, to: string): number | null {
  const a = dateOnlyUtcMs(from);
  const b = dateOnlyUtcMs(to);
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS);
}

/** Calendar days from today (business time zone) to `target`; negative once past, null when unset/invalid. */
export function calendarDaysUntil(target: string | null | undefined, now: Date = new Date()): number | null {
  if (!target) return null;
  return calendarDaysBetween(businessDate(now), target);
}
