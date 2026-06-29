import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function titleCase(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function nextRef(records: Record<string, unknown>[], refField: string, prefix: string): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`, "i");
  let max = 0;
  for (const record of records) {
    const match = pattern.exec(String(record[refField] ?? ""));
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Format any date/timestamptz string to the YYYY-MM-DD value that
 * <input type="date"> requires.  Slices the first 10 characters — safe
 * across "2026-06-29", "2026-06-29T00:00:00+00:00", "2026-06-29 00:00:00+00"
 * without any timezone conversion that might shift the day.
 */
export function toDateInputValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value).trim();
  // YYYY-MM-DD is always the first 10 characters of any ISO-like date string
  const candidate = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

export function isOverdue(date?: string | null, status?: string) {
  if (!date || ["Complete", "Approved", "Closed"].includes(status ?? "")) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${date}T00:00:00`) < today;
}
