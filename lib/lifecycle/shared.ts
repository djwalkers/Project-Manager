export function normaliseStatus(status: string | null | undefined): string {
  return String(status ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
