import {
  buildNeedsAttention,
  calculateProgress,
  calculateProjectHealth,
  type InsightItem,
  type RagStatus,
} from "@/lib/control-tower";
import type { DataStore } from "@/lib/data-store";
import { scopeProjectData } from "@/lib/project-scope";
import { calculateSchedule, formatScheduleDate, parseScheduleDate, type ScheduleMetrics } from "@/lib/schedule";
import type { ActionItem, Milestone, Project } from "@/lib/types";
import { isOverdue } from "@/lib/utils";

const DAY_MS = 86_400_000;

export type WorkspaceActionColumn = "Open" | "In Progress" | "Complete";

export type WorkspaceModel = {
  project: Project;
  scoped: DataStore;
  schedule: ScheduleMetrics;
  projectHealth: RagStatus;
  scheduleHealth: RagStatus | "Review";
  progress: number;
  activePhase: string;
  activePhaseProgress: number | null;
  nextMilestone: Milestone | null;
  attention: InsightItem[];
  openDecisions: DataStore["decisions"];
  openQuestions: DataStore["discovery_questions"];
  actionColumns: Record<WorkspaceActionColumn, ActionItem[]>;
  highRisks: DataStore["risks"];
  upcomingMilestones: Milestone[];
  recentActivity: DataStore["activity_log"];
  warnings: string[];
  narrative: string;
};

function todayUtc(now: Date) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysUntil(value: string | null, now: Date) {
  const date = parseScheduleDate(value);
  return date ? Math.ceil((date.getTime() - todayUtc(now)) / DAY_MS) : null;
}

function nextMilestone(milestones: Milestone[], now: Date) {
  return [...milestones]
    .filter((item) => item.status !== "Complete" && item.target_date)
    .sort((a, b) => {
      const aDays = daysUntil(a.target_date, now) ?? Number.MAX_SAFE_INTEGER;
      const bDays = daysUntil(b.target_date, now) ?? Number.MAX_SAFE_INTEGER;
      const aPast = aDays < 0 ? 1 : 0;
      const bPast = bDays < 0 ? 1 : 0;
      return aPast - bPast || aDays - bDays;
    })[0] ?? null;
}

function actionColumn(status: string): WorkspaceActionColumn {
  if (["Complete", "Closed"].includes(status)) return "Complete";
  if (status === "In Progress") return "In Progress";
  return "Open";
}

function buildNarrative(model: Omit<WorkspaceModel, "narrative">) {
  const projectRef = model.project.name.replace(" - Delivery Date Range", "");
  const target = model.schedule.projectEnd ? `the target delivery date of ${formatScheduleDate(model.schedule.projectEnd)}` : "a delivery date that still needs review";
  const phaseProgress = model.activePhaseProgress === null ? "" : ` at ${model.activePhaseProgress}%`;
  const decisionCount = model.openDecisions.length;
  const milestoneWithinWeek = model.upcomingMilestones.filter((item) => {
    const days = daysUntil(item.target_date, new Date());
    return days !== null && days >= 0 && days <= 7;
  }).length;
  const variance = model.schedule.variance === null
    ? "Schedule dates need review."
    : model.schedule.variance > 0
      ? `Schedule variance remains positive at +${model.schedule.variance}%.`
      : model.schedule.variance === 0
        ? "Schedule variance is on plan."
        : `Schedule variance is ${model.schedule.variance}%.`;
  return `${projectRef} is currently ${model.projectHealth} and ${model.schedule.daysRemaining === 0 && !model.schedule.projectComplete ? "has reached" : "remains within"} ${target}. ${model.activePhase} is the active phase${phaseProgress}. ${decisionCount} key ${decisionCount === 1 ? "decision remains" : "decisions remain"} open. ${milestoneWithinWeek} ${milestoneWithinWeek === 1 ? "milestone is" : "milestones are"} due within the next week. ${variance}`;
}

export function buildProjectWorkspace(data: DataStore, project: Project, now = new Date()): WorkspaceModel {
  const scoped = scopeProjectData(data, project);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);
  const overdueActions = scoped.actions.filter((item) => isOverdue(item.due_date, item.status)).length;
  const overdueDecisions = scoped.decisions.filter((item) => isOverdue(item.due_date, item.status)).length;
  const blocked = scoped.milestones.filter((item) => item.status === "Blocked").length + schedule.blocked.length;
  const variance = schedule.variance ?? -1;
  const activeItem = schedule.active[0] ?? schedule.atRisk[0] ?? schedule.blocked[0] ?? null;
  const upcomingMilestones = scoped.milestones
    .filter((item) => item.status !== "Complete")
    .filter((item) => {
      const days = daysUntil(item.target_date, now);
      return days !== null && days >= 0 && days <= 14;
    })
    .sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)));
  const actionColumns: WorkspaceModel["actionColumns"] = { Open: [], "In Progress": [], Complete: [] };
  scoped.actions.forEach((item) => actionColumns[actionColumn(item.status)].push(item));
  const warnings = [
    !activeItem ? "No active timeline phase" : null,
    !scoped.milestones.length ? "No milestones" : null,
    !scoped.requirements.length ? "No requirements" : null,
    !scoped.decisions.length ? "No decisions" : null,
    !scoped.actions.length ? "No actions" : null,
    !scoped.discovery_questions.length ? "No discovery questions" : null,
  ].filter((item): item is string => Boolean(item));

  const base = {
    project,
    scoped,
    schedule,
    projectHealth: calculateProjectHealth(overdueActions + overdueDecisions, blocked, variance),
    scheduleHealth: schedule.health ?? "Review" as RagStatus | "Review",
    progress: calculateProgress(scoped, variance).overall,
    activePhase: activeItem?.phase_name ?? "No active phase",
    activePhaseProgress: activeItem ? Number(activeItem.progress_percent) : null,
    nextMilestone: nextMilestone(scoped.milestones, now),
    attention: buildNeedsAttention(scoped),
    openDecisions: scoped.decisions.filter((item) => !["Approved", "Closed"].includes(item.status)),
    openQuestions: scoped.discovery_questions.filter((item) => !["Answered", "Closed"].includes(item.status)),
    actionColumns,
    highRisks: scoped.risks.filter((item) => ["High", "Critical"].includes(item.impact) && !["Complete", "Closed"].includes(item.status)),
    upcomingMilestones,
    recentActivity: [...scoped.activity_log].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10),
    warnings,
  };

  return { ...base, narrative: buildNarrative(base) };
}

