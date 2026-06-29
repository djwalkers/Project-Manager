import type { DataStore } from "@/lib/data-store";
import { deliverablesRequiringAttention } from "@/lib/delivery";
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

export function buildTodaysPriorities(data: DataStore): PriorityItem[] {
  const scored: { title: string; detail: string; score: number }[] = [];

  const overdueActions = data.actions.filter(
    (a) => daysFromToday(a.due_date) !== null && (daysFromToday(a.due_date) as number) < 0 && !["Complete", "Closed"].includes(a.status),
  );
  if (overdueActions.length > 0) {
    scored.push({
      title: overdueActions.length > 1 ? `Complete ${overdueActions.length} overdue actions` : `Complete "${overdueActions[0].description.slice(0, 60)}"`,
      detail: overdueActions.slice(0, 3).map((a) => `${a.action_ref} (${Math.abs(daysFromToday(a.due_date) as number)}d overdue)`).join(" · "),
      score: 100 + overdueActions.length * 5,
    });
  }

  const blockedActions = data.actions.filter((a) => a.status === "Blocked");
  if (blockedActions.length > 0) {
    scored.push({
      title: blockedActions.length > 1 ? `Unblock ${blockedActions.length} blocked actions` : `Unblock "${blockedActions[0].description.slice(0, 60)}"`,
      detail: blockedActions.slice(0, 3).map((a) => a.action_ref).join(" · "),
      score: 90 + blockedActions.length * 3,
    });
  }

  const overdueDecisions = data.decisions.filter(
    (d) => daysFromToday(d.due_date) !== null && (daysFromToday(d.due_date) as number) < 0 && !["Approved", "Closed"].includes(d.status),
  );
  if (overdueDecisions.length > 0) {
    scored.push({
      title: `Resolve ${overdueDecisions.length} overdue ${overdueDecisions.length === 1 ? "decision" : "decisions"}`,
      detail: overdueDecisions.slice(0, 3).map((d) => d.decision_ref).join(" · "),
      score: 75 + overdueDecisions.length * 2,
    });
  }

  const highRisks = data.risks.filter(
    (r) => ["High", "Critical"].includes(r.impact) && !["Complete", "Closed"].includes(r.status),
  );
  if (highRisks.length > 0) {
    scored.push({
      title: `Mitigate ${highRisks.length} high-exposure ${highRisks.length === 1 ? "risk" : "risks"}`,
      detail: highRisks.slice(0, 3).map((r) => `${r.risk_ref} (${r.impact})`).join(" · "),
      score: 80 + highRisks.length * 2,
    });
  }

  const awaitingQueries = data.discovery_questions.filter(
    (q) => ["Awaiting Business", "Awaiting Development", "Awaiting Response"].includes(q.status),
  );
  if (awaitingQueries.length > 0) {
    scored.push({
      title: `Respond to ${awaitingQueries.length} outstanding ${awaitingQueries.length === 1 ? "query" : "queries"}`,
      detail: awaitingQueries.slice(0, 3).map((q) => q.question_ref).join(" · "),
      score: 70 + awaitingQueries.length,
    });
  }

  const nearDeliverables = data.deliverables.filter((d) => {
    const days = daysFromToday(d.planned_completion_date);
    return days !== null && days >= 0 && days <= 7 && d.status !== "Deployed";
  });
  if (nearDeliverables.length > 0) {
    scored.push({
      title: nearDeliverables.length > 1 ? `Progress ${nearDeliverables.length} deliverables due this week` : `Progress "${nearDeliverables[0].title.slice(0, 50)}" due in ${daysFromToday(nearDeliverables[0].planned_completion_date)}d`,
      detail: nearDeliverables.slice(0, 3).map((d) => `${d.deliverable_ref} (${daysFromToday(d.planned_completion_date)}d)`).join(" · "),
      score: 60 + nearDeliverables.length * 2,
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map((item, i) => ({ ...item, rank: i + 1 }));
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
  data.decisions.filter((d) => ["Open", "Pending"].includes(d.status))
    .forEach((d) => { const k = (d.owner ?? "").trim() || "Unassigned"; dGroups.set(k, (dGroups.get(k) ?? 0) + 1); });
  dGroups.forEach((count, owner) => add(owner, `${count} ${count === 1 ? "Decision" : "Decisions"}`, "/decisions"));

  const depGroups = new Map<string, number>();
  data.dependencies.filter((d) => d.status === "Open")
    .forEach((d) => { const k = (d.owner ?? "").trim() || "Unassigned"; depGroups.set(k, (depGroups.get(k) ?? 0) + 1); });
  depGroups.forEach((count, owner) => add(owner, `${count} ${count === 1 ? "Dependency" : "Dependencies"}`, "/dependencies"));

  const aGroups = new Map<string, number>();
  data.actions.filter((a) => a.status === "Blocked")
    .forEach((a) => { const k = (a.owner ?? "").trim() || "Unassigned"; aGroups.set(k, (aGroups.get(k) ?? 0) + 1); });
  aGroups.forEach((count, owner) => add(owner, `${count} Blocked ${count === 1 ? "Action" : "Actions"}`, "/actions"));

  return Array.from(ownerMap.entries())
    .map(([owner, items]) => ({ owner, items }))
    .sort((a, b) => b.items.length - a.items.length);
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
