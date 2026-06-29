import { CheckCircle2, Circle, Clock3, Loader2, MinusCircle, ShieldAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  // Red — Critical / hard blockers
  Critical: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  Blocked:  "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  Red:      "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  "At Risk":"border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  Failed:   "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  // Orange — High priority
  High: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300",
  // Neutral/slate — open, not-started, pending
  Open:         "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  Pending:      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  "Not Started":"border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  Superseded:   "border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
  // Cyan — in-flight discovery / ready states
  Discovery:            "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-200",
  "In Analysis":        "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-200",
  "Ready for SIT":      "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-200",
  "Ready for UAT":      "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-200",
  "Ready for Deployment":"border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-200",
  // Amber — Medium priority / in-progress / awaiting
  "In Progress":        "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  "In Development":     "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  Amber:                "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  Warning:              "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  "Awaiting Business":  "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  "Awaiting Development":"border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  "Awaiting Response":  "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  Medium:               "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  // Blue — Low priority
  Low: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300",
  // Green — complete / approved / passed
  Complete:    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  "SIT Complete":"border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  "UAT Complete":"border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  Deployed: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  Approved: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  Closed:   "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  Green:    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  Answered: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  Passed:   "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
};

const icons: Record<string, typeof Circle> = {
  Critical: ShieldAlert,
  High: ShieldAlert,
  Blocked: XCircle,
  Red: ShieldAlert,
  "At Risk": ShieldAlert,
  Failed: XCircle,
  Open: Circle,
  Pending: Clock3,
  "Not Started": Circle,
  Superseded: MinusCircle,
  Discovery: Loader2,
  "In Analysis": Loader2,
  "Ready for SIT": Clock3,
  "Ready for UAT": Clock3,
  "Ready for Deployment": Clock3,
  "In Progress": Loader2,
  "In Development": Loader2,
  Amber: Clock3,
  Warning: Clock3,
  "Awaiting Business": Clock3,
  "Awaiting Development": Clock3,
  "Awaiting Response": Clock3,
  Medium: Clock3,
  Low: Circle,
  Complete: CheckCircle2,
  "SIT Complete": CheckCircle2,
  "UAT Complete": CheckCircle2,
  Deployed: CheckCircle2,
  Approved: CheckCircle2,
  Closed: CheckCircle2,
  Green: CheckCircle2,
  Answered: CheckCircle2,
  Passed: CheckCircle2,
};

export function StatusBadge({ value, className }: { value?: string | null; className?: string }) {
  const label = value || "Pending";
  const Icon = icons[label] ?? Circle;

  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold",
        statusStyles[label] ?? statusStyles.Pending,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PriorityBadge({ value }: { value?: string | null }) {
  return <StatusBadge value={value || "Medium"} />;
}
