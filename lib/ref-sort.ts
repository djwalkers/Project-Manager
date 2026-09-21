import type { ModuleConfig } from "@/lib/modules";

type Row = Record<string, unknown>;

// Natural/alphanumeric comparator for reference codes (TST-9 before TST-10,
// TST-034 before TST-034a before TST-034b) — plain string sort would put
// TST-10 before TST-9 whenever a ref isn't uniformly zero-padded. Built once
// and reused (an Intl.Collator instance is expensive to construct per call).
const REF_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Every module's system-generated reference field (milestone_ref, test_ref,
// requirement_ref, ...) is the one with `refPrefix` set (lib/modules.ts) —
// used generically here so every ref-bearing module defaults to Ref
// ascending, not just Test Cases, with no per-module or per-project special
// casing. Modules with no ref field (dependencies, meetings, documents) fall
// through unsorted, exactly as before.
export function sortRowsByRef<T extends Row>(rows: T[], config: ModuleConfig): T[] {
  const refKey = config.fields.find((field) => field.refPrefix)?.key;
  if (!refKey) return rows;
  return [...rows].sort((a, b) => REF_COLLATOR.compare(String(a[refKey] ?? ""), String(b[refKey] ?? "")));
}
