import { AlertTriangle, CalendarRange } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { calculateSchedule, formatScheduleDate, parseScheduleDate, scheduleBarPosition, todayPosition } from "@/lib/schedule";
import type { Project, TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const DAY_MS = 86_400_000;

function phaseRowTone(item: TimelineItem): string {
  if (item.status === "Complete") return "bg-emerald-50/60 dark:bg-emerald-950/10";
  if (item.status === "Blocked") return "bg-red-50/70 dark:bg-red-950/15";
  if (item.status === "At Risk") return "bg-amber-50/60 dark:bg-amber-950/15";
  if (item.status === "In Progress") return "bg-blue-50/50 dark:bg-blue-950/10";
  return "";
}

function phaseDaysLabel(item: TimelineItem): { label: string; warn: boolean } {
  const end = parseScheduleDate(item.end_date);
  if (!end) return { label: "", warn: false };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((end.getTime() - today.getTime()) / DAY_MS);
  if (item.status === "Complete") return { label: "Complete", warn: false };
  if (diff < 0) return { label: `${Math.abs(diff)}d overdue`, warn: true };
  if (diff === 0) return { label: "Due today", warn: true };
  return { label: `${diff}d remaining`, warn: diff <= 7 };
}

const barTone: Record<TimelineItem["status"], string> = {
  "Not Started": "bg-slate-400 dark:bg-slate-500",
  "In Progress": "bg-blue-600 dark:bg-blue-500",
  Complete: "bg-emerald-600 dark:bg-emerald-500",
  "At Risk": "bg-amber-500",
  Blocked: "bg-red-600 dark:bg-red-500",
};

export function TimelineSchedule({ project, items }: { project: Project; items: TimelineItem[] }) {
  const schedule = calculateSchedule(project, items);

  return (
    <section className="mb-5 min-w-0 rounded-lg border bg-card shadow-operational" aria-labelledby="visual-schedule-title">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <CalendarRange className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 id="visual-schedule-title" className="font-semibold">Visual Schedule</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Bars reposition automatically from the editable project and phase dates.</p>
        </div>
        <p className="text-sm font-medium tabular-nums">
          {formatScheduleDate(schedule.projectStart)} – {formatScheduleDate(schedule.projectEnd)}
        </p>
      </div>

      {!schedule.valid || !schedule.projectStart || !schedule.projectEnd ? (
        <div className="m-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div><p className="font-medium">Schedule dates need review</p><p className="mt-1 text-sm">Set valid project dates and ensure every phase ends on or after its start date.</p></div>
        </div>
      ) : items.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">No timeline phases have been added.</p>
      ) : (
        <div className="overflow-x-auto p-4">
          <div className="min-w-[760px]">
            <div className="mb-3 grid grid-cols-[240px_minmax(480px,1fr)] gap-4 text-xs font-semibold uppercase text-muted-foreground">
              <span>Phase</span>
              <div className="flex justify-between"><span>{formatScheduleDate(schedule.projectStart)}</span><span>{formatScheduleDate(schedule.projectEnd)}</span></div>
            </div>
            <div className="space-y-3">
              {items.map((item) => {
                const position = scheduleBarPosition(item, schedule.projectStart as string, schedule.projectEnd as string);
                const todayPct = todayPosition(schedule.projectStart as string, schedule.projectEnd as string);
                const { label: daysLabel, warn: daysWarn } = phaseDaysLabel(item);
                return (
                  <div key={item.id} className={cn("grid grid-cols-[240px_minmax(480px,1fr)] items-center gap-4 rounded-md px-1 py-0.5", phaseRowTone(item))}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><span className="text-xs font-semibold text-muted-foreground">{item.phase_ref}</span><StatusBadge value={item.status} /></div>
                      <p className="mt-1 truncate text-sm font-medium" title={item.phase_name}>{item.phase_name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{item.start_date} → {item.end_date}</p>
                      {daysLabel && (
                        <p className={cn("mt-0.5 text-xs font-semibold tabular-nums", daysWarn ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                          {daysLabel}
                        </p>
                      )}
                    </div>
                    <div className="relative h-10 overflow-hidden rounded-md border bg-muted/60" aria-label={`${item.phase_name}: ${item.start_date} to ${item.end_date}, ${item.progress_percent}% complete`}>
                      {todayPct !== null ? <span className="absolute inset-y-0 z-10 w-px bg-foreground/70" style={{ left: `${todayPct}%` }} title="Today" aria-hidden="true" /> : null}
                      {position ? (
                        <div className={cn("absolute top-2 flex h-6 items-center overflow-hidden rounded px-2 text-xs font-semibold text-white", barTone[item.status])} style={{ left: `${position.left}%`, width: `${position.width}%` }}>
                          <span className="truncate">{item.progress_percent}%</span>
                        </div>
                      ) : <span className="absolute inset-0 flex items-center px-3 text-xs text-destructive">Invalid phase dates</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {todayPosition(schedule.projectStart, schedule.projectEnd) !== null ? <p className="mt-4 text-right text-xs text-muted-foreground">Vertical marker indicates today</p> : null}
          </div>
        </div>
      )}
    </section>
  );
}
