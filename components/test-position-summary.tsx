import { countTests } from "@/lib/test-report-format";
import { cn } from "@/lib/utils";

type Metric = { label: string; value: string; className: string };

/**
 * Compact live test position for the Testing page header. Uses the same
 * canonical countTests() as the Test Status email and Print/PDF report:
 * Complete = (Passed + Failed) / Total; Remaining = Pending + In Progress;
 * Blocked is separate. Presentation only.
 */
export function TestPositionSummary({ tests, className }: { tests: { status: string }[]; className?: string }) {
  const c = countTests(tests);

  if (c.total === 0) {
    return (
      <p className={cn("rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground", className)} data-testid="test-position-empty">
        No tests recorded
      </p>
    );
  }

  const metrics: Metric[] = [
    { label: "Complete", value: `${c.executionPct}%`, className: "text-primary" },
    { label: "Passed", value: String(c.passed), className: c.passed > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-foreground" },
    { label: "Failed", value: String(c.failed), className: c.failed > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground" },
    { label: "Blocked", value: String(c.blocked), className: c.blocked > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground" },
    { label: "Remaining", value: String(c.remaining), className: "text-sky-700 dark:text-sky-400" },
  ];
  const pct = (n: number) => `${(n / c.total) * 100}%`;
  const summary = `${c.executionPct}% complete: ${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked, ${c.remaining} remaining of ${c.total} tests`;

  return (
    <div className={cn("min-w-0", className)} data-testid="test-position-summary">
      <dl className="flex flex-wrap items-end gap-x-4 gap-y-2" aria-label={summary}>
        {metrics.map((m, i) => (
          <div key={m.label} className={cn("min-w-0", i > 0 && "sm:border-l sm:pl-4")}>
            <dt className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{m.label}</dt>
            <dd className={cn("text-lg font-semibold leading-6 tabular-nums", m.className)}>{m.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={summary} title={summary}>
        {c.passed > 0 && <span className="h-full bg-emerald-600" style={{ width: pct(c.passed) }} />}
        {c.failed > 0 && <span className="h-full bg-red-600" style={{ width: pct(c.failed) }} />}
        {c.blocked > 0 && <span className="h-full bg-amber-500" style={{ width: pct(c.blocked) }} />}
      </div>
    </div>
  );
}
