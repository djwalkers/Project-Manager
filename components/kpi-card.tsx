import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

export function KpiCard({
  title,
  value,
  helper,
  icon: Icon,
  tone = "neutral",
}: {
  title: string;
  value: number | string;
  helper: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone?: "neutral" | "good" | "warn" | "danger";
}) {
  const tones = {
    neutral: "bg-cyan-50 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200",
    good: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
    warn: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
    danger: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
  };

  return (
    <section className="rounded-lg border bg-card p-4 shadow-operational">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
        </div>
        <span className={cn("inline-flex h-10 w-10 items-center justify-center rounded-md", tones[tone])}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{helper}</p>
    </section>
  );
}
