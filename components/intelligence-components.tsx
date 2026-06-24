import { AlertTriangle, CheckCircle2, CircleAlert, Lightbulb } from "lucide-react";
import type { IntelligenceFinding } from "@/lib/project-intelligence";
import { cn } from "@/lib/utils";

export function IntelligenceFindingCard({ finding, compact = false, showRecommendation = true }: { finding: IntelligenceFinding; compact?: boolean; showRecommendation?: boolean }) {
  const Icon = finding.severity === "Critical" ? CircleAlert : finding.severity === "Warning" ? AlertTriangle : CheckCircle2;
  return (
    <article className={cn("rounded-md border p-3", finding.severity === "Critical" ? "border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20" : finding.severity === "Warning" ? "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20" : "border-emerald-300 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20")}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", finding.severity === "Critical" ? "text-red-700 dark:text-red-300" : finding.severity === "Warning" ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{finding.category} · {finding.ruleId}</p><span className="text-xs font-semibold tabular-nums">{finding.confidence}% confidence</span></div>
          <h4 className="mt-1 text-sm font-semibold">{finding.title}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{finding.detail}</p>
          {!compact ? <p className="mt-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">Evidence:</span> {finding.evidence}</p> : null}
          {showRecommendation && finding.recommendation ? <div className="mt-3 flex items-start gap-2 rounded-md border bg-background/70 p-2 text-sm"><Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><p>{finding.recommendation}</p></div> : null}
        </div>
      </div>
    </article>
  );
}

