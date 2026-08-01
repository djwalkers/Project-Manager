import type { DataStore } from "@/lib/data-store";
import {
  isActionBlocked,
  isActionOpen,
  isDecisionOpen,
  isDecisionOverdue,
  isRiskHighOrCritical,
  isRiskOpen,
  isTestPassed,
} from "@/lib/lifecycle";
import { deliverablesRequiringAttention } from "@/lib/delivery";
import { buildDeliveryInsights } from "@/lib/recommendations";
import { selectActiveProject } from "@/lib/project-scope";
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

export function calculateProgress(data: DataStore, scheduleHealth: RagStatus | null) {
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
      score: score(data.test_cases.filter((item) => isTestPassed(item.status)).length, data.test_cases.length),
    },
    {
      label: "Discovery",
      weight: 10,
      score: score(data.discovery_questions.filter((item) => ["Answered", "Closed"].includes(item.status)).length, data.discovery_questions.length),
    },
  ];
  const overall = Math.round(components.reduce((total, component) => total + component.score * component.weight, 0));
  // Projects the central schedule health (lib/schedule.ts's calculateSchedule().health)
  // instead of re-deriving a variance threshold. Invalid/unset schedules (health: null,
  // e.g. bad dates) default to Amber, matching the historical fallback behaviour of the
  // `scheduleVariance ?? -1` callers this replaced (-1 always landed in the old "Amber" bucket).
  const effectiveHealth = scheduleHealth ?? "Amber";
  const trend = effectiveHealth === "Red"
    ? { direction: "down" as const, label: "Behind plan" }
    : effectiveHealth === "Amber"
      ? { direction: "flat" as const, label: "Schedule watch" }
      : overall > 0
        ? { direction: "up" as const, label: "Advancing" }
        : { direction: "flat" as const, label: "Baseline" };
  return { overall, components, trend };
}

// Projects calculateSchedule().health rather than re-deriving a variance
// threshold — see calculateProgress's comment for the null-schedule default.
export function calculateProjectHealth(overdueItems: number, blockedMilestones: number, scheduleHealth: RagStatus | null): RagStatus {
  const effectiveHealth = scheduleHealth ?? "Amber";
  if (overdueItems > 5 || blockedMilestones > 0 || effectiveHealth === "Red") return "Red";
  if (overdueItems > 0 || effectiveHealth === "Amber") return "Amber";
  return "Green";
}

// Retained for API compatibility — now a pure projection of the central
// schedule health, not an independent threshold. (No remaining callers in
// this codebase; kept exported in case external/future code relies on it.)
export function calculateScheduleHealth(scheduleHealth: RagStatus | null): RagStatus {
  return scheduleHealth ?? "Amber";
}

export function buildNeedsAttention(data: DataStore): InsightItem[] {
  const items: InsightItem[] = [];
  const today = startOfToday();
  const olderThanSevenDays = today.getTime() - 7 * dayMs;

  data.actions.filter((item) => daysFromToday(item.due_date) !== null && (daysFromToday(item.due_date) as number) < 0 && isActionOpen(item.status)).forEach((item) => {
    items.push({ id: `action-${item.id}`, severity: "High", kind: "Overdue action", title: item.description, meta: `${item.action_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.decisions.filter((item) => isDecisionOverdue(item.due_date, item.status)).forEach((item) => {
    items.push({ id: `decision-${item.id}`, severity: "High", kind: "Overdue decision", title: item.question, meta: `${item.decision_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.risks.filter((item) => isRiskHighOrCritical(item.impact) && isRiskOpen(item.status)).forEach((item) => {
    items.push({ id: `risk-${item.id}`, severity: item.impact === "Critical" ? "Critical" : "High", kind: "High risk", title: item.description, meta: `${item.risk_ref} · ${item.probability} probability · ${item.owner}` });
  });
  data.milestones.filter((item) => ["Blocked", "At Risk"].includes(item.status)).forEach((item) => {
    items.push({ id: `milestone-${item.id}`, severity: item.status === "Blocked" ? "Critical" : "High", kind: `${item.status} milestone`, title: item.title, meta: `${item.milestone_ref} · Target ${formatDate(item.target_date)} · ${item.owner}`, date: item.target_date });
  });
  data.discovery_questions.filter((item) => !["Answered", "Closed"].includes(item.status) && new Date(item.created_at).getTime() < olderThanSevenDays).forEach((item) => {
    items.push({ id: `question-${item.id}`, severity: "Medium", kind: "Aged discovery question", title: item.question, meta: `${item.question_ref} · Open more than 7 days · ${item.owner}`, date: item.due_date });
  });
  deliverablesRequiringAttention(data.deliverables).forEach((item) => {
    items.push({ id: `deliverable-${item.id}`, severity: item.severity === "Critical" ? "Critical" : "High", kind: "Deliverable", title: item.deliverable.title, meta: `${item.deliverable.deliverable_ref} · ${item.reason} · ${item.deliverable.owner || "Unassigned"}`, date: item.deliverable.planned_completion_date });
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

  data.actions.filter((item) => upcoming(item.due_date) && isActionOpen(item.status)).forEach((item) => {
    items.push({ id: `action-${item.id}`, severity: "Medium", kind: "Action", title: item.description, meta: `${item.action_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.decisions.filter((item) => upcoming(item.due_date) && isDecisionOpen(item.status)).forEach((item) => {
    items.push({ id: `decision-${item.id}`, severity: "Medium", kind: "Decision", title: item.question, meta: `${item.decision_ref} · Due ${formatDate(item.due_date)} · ${item.owner}`, date: item.due_date });
  });
  data.milestones.filter((item) => upcoming(item.target_date) && item.status !== "Complete").forEach((item) => {
    items.push({ id: `milestone-${item.id}`, severity: item.status === "Blocked" ? "Critical" : item.status === "At Risk" ? "High" : "Medium", kind: "Milestone", title: item.title, meta: `${item.milestone_ref} · Target ${formatDate(item.target_date)} · ${item.owner}`, date: item.target_date });
  });

  return items.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

export type PriorityItem = {
  rank: number;
  title: string;
  detail: string;
  score: number;
};

export type WaitingGroup = {
  owner: string;
  items: { label: string; href: string }[];
};

// project defaults to selectActiveProject(data) — every existing caller
// that doesn't pass one keeps today's behaviour unchanged. Callers that
// have already resolved an exact project pass it explicitly so this never
// re-selects a different project underneath them.
export function buildTodaysPriorities(data: DataStore, project = selectActiveProject(data)): PriorityItem[] {
  return buildDeliveryInsights(data, 3, new Date(), project).map((item, i) => ({
    rank: i + 1,
    title: item.title,
    detail: `${item.reason} · ${item.currentPhase} relevance ${item.phaseRelevance}% · ${item.confidence}% confidence`,
    score: item.score,
  }));
}

export function buildWaitingOnOthersGrouped(data: DataStore): WaitingGroup[] {
  const ownerMap = new Map<string, { label: string; href: string }[]>();

  function add(owner: string | null, label: string, href: string) {
    const key = (owner ?? "").trim() || "Unassigned";
    if (!ownerMap.has(key)) ownerMap.set(key, []);
    ownerMap.get(key)!.push({ label, href });
  }

  const qGroups = new Map<string, number>();
  data.discovery_questions.filter((q) => ["Awaiting Business", "Awaiting Development", "Awaiting Response"].includes(q.status))
    .forEach((q) => { const k = (q.owner ?? "").trim() || "Unassigned"; qGroups.set(k, (qGroups.get(k) ?? 0) + 1); });
  qGroups.forEach((count, owner) => add(owner, `${count} ${count === 1 ? "Query" : "Queries"}`, "/discovery-questions"));

  const dGroups = new Map<string, number>();
  data.decisions.filter((d) => isDecisionOpen(d.status))
    .forEach((d) => { const k = (d.owner ?? "").trim() || "Unassigned"; dGroups.set(k, (dGroups.get(k) ?? 0) + 1); });
  dGroups.forEach((count, owner) => add(owner, `${count} ${count === 1 ? "Decision" : "Decisions"}`, "/decisions"));

  const depGroups = new Map<string, number>();
  data.dependencies.filter((d) => d.status === "Open")
    .forEach((d) => { const k = (d.owner ?? "").trim() || "Unassigned"; depGroups.set(k, (depGroups.get(k) ?? 0) + 1); });
  depGroups.forEach((count, owner) => add(owner, `${count} ${count === 1 ? "Dependency" : "Dependencies"}`, "/dependencies"));

  const aGroups = new Map<string, number>();
  data.actions.filter((a) => isActionBlocked(a.status))
    .forEach((a) => { const k = (a.owner ?? "").trim() || "Unassigned"; aGroups.set(k, (aGroups.get(k) ?? 0) + 1); });
  aGroups.forEach((count, owner) => add(owner, `${count} Blocked ${count === 1 ? "Action" : "Actions"}`, "/actions"));

  return Array.from(ownerMap.entries())
    .map(([owner, items]) => ({ owner, items }))
    .sort((a, b) => b.items.length - a.items.length);
}

export function buildManagementSummary(project: Project, health: RagStatus, data: DataStore, overdueActions: number, schedule: ScheduleMetrics) {
  const activePhase = schedule.active[0]?.phase_name ?? schedule.atRisk[0]?.phase_name ?? schedule.blocked[0]?.phase_name ?? "No active phase";
  const outstandingDecisions = data.decisions.filter((item) => isDecisionOpen(item.status)).length;
  if (!schedule.valid || schedule.variance === null) {
    return `${project.name.replace(" - Delivery Date Range", "")} is currently ${health}. Schedule dates need review. ${activePhase} is the current phase. ${plural(outstandingDecisions, "decision")} remain outstanding and ${plural(overdueActions, "action")} ${overdueActions === 1 ? "is" : "are"} overdue.`;
  }
  const varianceLabel = schedule.variance > 0 ? `+${schedule.variance}%` : `${schedule.variance}%`;
  return `${project.name.replace(" - Delivery Date Range", "")} is currently ${health}. ${activePhase} is the active phase. The project ends ${formatScheduleDate(schedule.projectEnd)} with ${schedule.daysRemaining} days remaining. Planned progress is ${schedule.plannedProgress}% and actual progress is ${schedule.actualProgress}%, giving a schedule variance of ${varianceLabel}. ${plural(outstandingDecisions, "decision")} remain outstanding and ${plural(overdueActions, "action")} ${overdueActions === 1 ? "is" : "are"} overdue.`;
}
