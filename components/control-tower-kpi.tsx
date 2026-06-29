import type { ComponentType, SVGProps } from "react";
import Link from "next/link";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "good" | "warn" | "danger";

const toneStyles: Record<Tone, string> = {
  neutral: "bg-cyan-50 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200",
  good: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  warn: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  danger: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
};

export function ControlTowerKpi({
  title,
  value,
  helper,
  icon: Icon,
  tone = "neutral",
  rag,
  progress,
  trend,
  href,
}: {
  title: string;
  value?: number | string;
  helper: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone?: Tone;
  rag?: "Green" | "Amber" | "Red";
  progress?: number;
  trend?: { direction: "up" | "flat" | "down"; label: string };
  href?: string;
}) {
  const TrendIcon = trend?.direction === "up" ? TrendingUp : trend?.direction === "down" ? TrendingDown : Minus;
  const Wrapper = href
    ? ({ children, className }: { children: React.ReactNode; className: string }) => (
        <Link href={href} className={cn(className, "transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/20")}>{children}</Link>
      )
    : ({ children, className }: { children: React.ReactNode; className: string }) => (
        <section className={className}>{children}</section>
      );
  return (
    <Wrapper className="rounded-lg border bg-card p-4 shadow-operational">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="mt-2">
            {rag ? <StatusBadge value={rag} className="min-h-8 px-3 text-sm" /> : <p className="text-3xl font-semibold tabular-nums">{value}</p>}
          </div>
        </div>
        <span className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md", toneStyles[tone])}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
      {progress !== undefined ? (
        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </div>
          {trend ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {trend.label}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="mt-3 text-sm text-muted-foreground">{helper}</p>
    </Wrapper>
  );
}
