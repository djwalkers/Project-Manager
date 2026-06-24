"use client";

import { useEffect, useState } from "react";
import { Activity, ArrowRight, CalendarClock, CheckCircle2, CircleDot, Flame, ShieldAlert, Trash2, TrendingDown } from "lucide-react";
import { getRecentChanges, formatAuditChange, relativeTime } from "@/lib/audit";
import type { AuditActionType, AuditLog } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTION_ICONS: Record<AuditActionType, typeof Activity> = {
  "Create": CheckCircle2,
  "Delete": Trash2,
  "Status Change": CircleDot,
  "Health Change": Flame,
  "Date Change": CalendarClock,
  "Severity Change": ShieldAlert,
  "Progress Change": Activity,
  "Schedule Change": TrendingDown,
  "Update": ArrowRight,
};

const ACTION_COLORS: Record<AuditActionType, string> = {
  "Create": "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40",
  "Delete": "text-destructive bg-destructive/10",
  "Status Change": "text-sky-600 bg-sky-50 dark:bg-sky-950/40",
  "Health Change": "text-amber-600 bg-amber-50 dark:bg-amber-950/40",
  "Date Change": "text-violet-600 bg-violet-50 dark:bg-violet-950/40",
  "Severity Change": "text-orange-600 bg-orange-50 dark:bg-orange-950/40",
  "Progress Change": "text-blue-600 bg-blue-50 dark:bg-blue-950/40",
  "Schedule Change": "text-rose-600 bg-rose-50 dark:bg-rose-950/40",
  "Update": "text-muted-foreground bg-muted",
};

function AuditRow({ entry }: { entry: AuditLog }) {
  const Icon = ACTION_ICONS[entry.action_type] ?? ArrowRight;
  const colorClass = ACTION_COLORS[entry.action_type] ?? ACTION_COLORS["Update"];

  return (
    <div className="flex items-start gap-3 py-2.5 first:pt-0">
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", colorClass)}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{formatAuditChange(entry)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.changed_by_name} · {relativeTime(entry.changed_at)}
        </p>
      </div>
    </div>
  );
}

interface RecentChangesPanelProps {
  projectId: string;
  limit?: number;
}

export function RecentChangesPanel({ projectId, limit = 10 }: RecentChangesPanelProps) {
  const [entries, setEntries] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getRecentChanges(projectId, limit).then((data) => {
      if (active) { setEntries(data); setLoading(false); }
    });
    return () => { active = false; };
  }, [projectId, limit]);

  return (
    <section className="rounded-lg border bg-card shadow-operational" aria-labelledby="recent-changes-title">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Activity className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 id="recent-changes-title" className="text-sm font-semibold">Recent Changes</h3>
      </div>
      <div className="p-4">
        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-6 w-6 rounded-full bg-muted animate-pulse" />
                <div className="flex-1 space-y-1">
                  <div className="h-3 w-4/5 rounded bg-muted animate-pulse" />
                  <div className="h-2.5 w-1/3 rounded bg-muted animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
        ) : (
          <div className="divide-y">
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
