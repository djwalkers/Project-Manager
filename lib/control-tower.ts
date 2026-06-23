import type { DataStore } from "@/lib/data-store";
import type { Project } from "@/lib/types";
import { formatScheduleDate, type ScheduleMetrics } from "@/lib/schedule";

export type RagStatus = "Green" | "Amber" | "Red";
export type InsightSeverity = "Critical" | "High" | "Medium";

export type InsightItem = {
  id: string;
  severity: InsightSeverity;
  kind: string;
  title: string;
  meta: string;
  date?: string | null;
};

export type ProgressComponent = {
  label: string;
  weight: number;
  score: number;
};

const dayMs = 24 * 60 * 60 * 1000;

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function dateAtMidnight(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysFromToday(value?: string | null) {
  const date = dateAtMidnight(value);
  if (!date) return null;
  return Math.ceil((date.getTime() - startOfToday().getTime()) / dayMs);
}

function formatDate(value?: string | null) {
  const date = dateAtMidnight(value);
  return date ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date) : "No date";
}

function score(completed: number, total: number) {
  return total ? completed / total : 0;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

export function calculateProgress(data: DataStore, scheduleVariance: number) {
  const components: ProgressComponent[] = [
    {
      label: "Requirements",
      weight: 30,
      score: score(data.requirements.filter((item) => item.status === "Complete").length, data.requirements.length),
    },
    {
      label: "Milestones",
      weight: 25,
      score: score(data.milestones.filter((item) => item.status === "Complete").length, data.milestones.length),
    },
    {
      label: "Actions",
      weight: 20,
      score: score(data.actions.filter((item) => item.status === "Complete").length, data.actions.length),
    },
    {
      label: "Testing",
      weight: 15,
      score: score(data.test_cases.filter((item) => item.status === "Passed").length, data.test_cases.length),
    },
    {
      label: "Discovery",
      weight: 10,
      score: score(data.discovery_questions.filter((item) => ["Answered", "Closed"].includes(item.status)).length, data.discovery_questions.length),
    },
  ];
  const overall = Math.round(components.reduce((total, component) => total + component.score * component.weight, 0));
  const trend = scheduleVariance <= -11
    ? { direction: "down" as const, label: "Behind plan" }
    : scheduleVariance < 0
      ? { direction: "flat" as const, label: "Schedule watch" }
      : overall > 0
        ? { direction: "up" as const, label: "Advancing" }
        : { direction: "flat" as const, label: "Baseline" };
  return { overall, components, trend };
}

export function calculateProjectHealth(overdueItems: number, blockedMilestones: number, scheduleVariance: number): RagStatus {
  if (overdueItems > 5 || blockedMilestones > 0 || scheduleVariance <= -11) return "Red";
  if (overdueItems > 0 || scheduleVariance < 0) return "Amber";
  return "Green";
}

export function calculateScheduleHealth(scheduleVariance: number): RagStatus {
  if (scheduleVariance <= -11) return "Red";
  if (scheduleVariance < 0) return "Amber";
  return "Green";
}

export function buildNeedsAttention(data: DataStore): InsightItem[] {
  const items: InsightItem[] = [];
  const today = startOfToday();
  const olderThanSevenDays = today.getTime() - 7 * dayMs;

  data.actions.filter((item) => daysFromToday(item.due_date) !== null && (daysFromToday(item.due_date) as number) < 0 && !["Complete", "Closed"].includes(item.status)).forEach((item) => {
    items.push({ id: `action-${item.id}`, severity: "High", kind: "Overdue action", title: item.description, meta: `${item.action_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.decisions.filter((item) => daysFromToday(item.due_date) !== null && (daysFromToday(item.due_date) as number) < 0 && !["Approved", "Closed"].includes(item.status)).forEach((item) => {
    items.push({ id: `decision-${item.id}`, severity: "High", kind: "Overdue decision", title: item.question, meta: `${item.decision_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.risks.filter((item) => ["High", "Critical"].includes(item.impact) && !["Complete", "Closed"].includes(item.status)).forEach((item) => {
    items.push({ id: `risk-${item.id}`, severity: item.impact === "Critical" ? "Critical" : "High", kind: "High risk", title: item.description, meta: `${item.risk_ref} · ${item.probability} probability · ${item.owner}` });
  });
  data.milestones.filter((item) => ["Blocked", "At Risk"].includes(item.status)).forEach((item) => {
    items.push({ id: `milestone-${item.id}`, severity: item.status === "Blocked" ? "Critical" : "High", kind: `${item.status} milestone`, title: item.title, meta: `${item.milestone_ref} · Target ${formatDate(item.target_date)} · ${item.owner}`, date: item.target_date });
  });
  data.discovery_questions.filter((item) => !["Answered", "Closed"].includes(item.status) && new Date(item.created_at).getTime() < olderThanSevenDays).forEach((item) => {
    items.push({ id: `question-${item.id}`, severity: "Medium", kind: "Aged discovery question", title: item.question, meta: `${item.question_ref} · Open more than 7 days · ${item.owner}`, date: item.due_date });
  });

  const severityOrder: Record<InsightSeverity, number> = { Critical: 3, High: 2, Medium: 1 };
  return items.sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity] || String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

export function buildUpcomingThisWeek(data: DataStore): InsightItem[] {
  const items: InsightItem[] = [];
  const upcoming = (date?: string | null) => {
    const days = daysFromToday(date);
    return days !== null && days >= 0 && days <= 7;
  };

  data.actions.filter((item) => upcoming(item.due_date) && !["Complete", "Closed"].includes(item.status)).forEach((item) => {
    items.push({ id: `action-${item.id}`, severity: "Medium", kind: "Action", title: item.description, meta: `${item.action_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.decisions.filter((item) => upcoming(item.due_date) && !["Approved", "Closed"].includes(item.status)).forEach((item) => {
    items.push({ id: `decision-${item.id}`, severity: "Medium", kind: "Decision", title: item.question, meta: `${item.decision_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.milestones.filter((item) => upcoming(item.target_date) && item.status !== "Complete").forEach((item) => {
    items.push({ id: `milestone-${item.id}`, severity: item.status === "Blocked" ? "Critical" : item.status === "At Risk" ? "High" : "Medium", kind: "Milestone", title: item.title, meta: `${item.milestone_ref} · Target ${formatDate(item.target_date)} · ${item.owner}`, date: item.target_date });
  });

  return items.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

export function buildManagementSummary(project: Project, health: RagStatus, data: DataStore, overdueActions: number, schedule: ScheduleMetrics) {
  const activePhase = schedule.active[0]?.phase_name ?? schedule.atRisk[0]?.phase_name ?? schedule.blocked[0]?.phase_name ?? "No active phase";
  const outstandingDecisions = data.decisions.filter((item) => !["Approved", "Closed"].includes(item.status)).length;
  if (!schedule.valid || schedule.variance === null) {
    return `${project.name.replace(" - Delivery Date Range", "")} is currently ${health}. Schedule dates need review. ${activePhase} is the current phase. ${plural(outstandingDecisions, "decision")} remain outstanding and ${plural(overdueActions, "action")} ${overdueActions === 1 ? "is" : "are"} overdue.`;
  }
  const varianceLabel = schedule.variance > 0 ? `+${schedule.variance}%` : `${schedule.variance}%`;
  return `${project.name.replace(" - Delivery Date Range", "")} is currently ${health}. ${activePhase} is the active phase. The project ends ${formatScheduleDate(schedule.projectEnd)} with ${schedule.daysRemaining} days remaining. Planned progress is ${schedule.plannedProgress}% and actual progress is ${schedule.actualProgress}%, giving a schedule variance of ${varianceLabel}. ${plural(outstandingDecisions, "decision")} remain outstanding and ${plural(overdueActions, "action")} ${overdueActions === 1 ? "is" : "are"} overdue.`;
}
