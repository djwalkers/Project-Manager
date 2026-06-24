import {
  buildNeedsAttention,
  buildUpcomingThisWeek,
  calculateProgress,
  calculateProjectHealth,
  type InsightItem,
  type RagStatus,
} from "@/lib/control-tower";
import type { DataStore } from "@/lib/data-store";
import { selectCanonicalProjects, selectTimelineItems } from "@/lib/project-scope";
import { buildSinceYesterday, buildWeeklyExecutiveSummary, type SinceYesterday, type WeeklyExecutiveSummary } from "@/lib/project-trends";
import { calculateSchedule, formatScheduleDate } from "@/lib/schedule";
import type { Milestone, Project } from "@/lib/types";
import { isOverdue } from "@/lib/utils";

export type DailyBriefProject = {
  project: Project;
  health: RagStatus;
  scheduleHealth: RagStatus | "Review";
  progress: number;
  activePhase: string;
  daysRemaining: number | null;
  openRisks: number;
  openDecisions: number;
  overdueActions: number;
  upcomingMilestone: Milestone | null;
};

export type DailyBrief = {
  generatedAt: Date;
  projects: DailyBriefProject[];
  attention: InsightItem[];
  upcoming: InsightItem[];
  executiveSummary: string;
  sinceYesterday: SinceYesterday[];
  weeklySummary: WeeklyExecutiveSummary;
  subject: string;
  plainText: string;
  html: string;
};

export function scopeProjectData(data: DataStore, project: Project): DataStore {
  const belongsToProject = <T extends { project_id: string }>(rows: T[]) => rows.filter((row) => row.project_id === project.id);
  return {
    projects: [project],
    requirements: belongsToProject(data.requirements),
    risks: belongsToProject(data.risks),
    decisions: belongsToProject(data.decisions),
    actions: belongsToProject(data.actions),
    dependencies: belongsToProject(data.dependencies),
    discovery_questions: belongsToProject(data.discovery_questions),
    milestones: belongsToProject(data.milestones),
    timeline_items: selectTimelineItems(data, project).items,
    test_cases: belongsToProject(data.test_cases),
    meetings: belongsToProject(data.meetings),
    documents: belongsToProject(data.documents),
    activity_log: belongsToProject(data.activity_log),
    project_snapshots: belongsToProject(data.project_snapshots),
  };
}

function upcomingMilestone(milestones: Milestone[], now: Date) {
  const today = now.toISOString().slice(0, 10);
  const incomplete = milestones.filter((item) => item.status !== "Complete" && item.target_date);
  return [...incomplete].sort((a, b) => {
    const aFuture = String(a.target_date) >= today ? 0 : 1;
    const bFuture = String(b.target_date) >= today ? 0 : 1;
    return aFuture - bFuture || String(a.target_date).localeCompare(String(b.target_date));
  })[0] ?? null;
}

function escapeHtml(value: string | number | null) {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function healthColor(value: RagStatus | "Review") {
  if (value === "Red") return "#b91c1c";
  if (value === "Amber" || value === "Review") return "#b45309";
  return "#047857";
}

function emailDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(value);
}

function buildPlainText(date: Date, summary: string, projects: DailyBriefProject[], attention: InsightItem[], upcoming: InsightItem[], sinceYesterday: SinceYesterday[], weekly: WeeklyExecutiveSummary) {
  const projectLines = projects.map((item) => [
    item.project.name,
    `Health: ${item.health} | Schedule: ${item.scheduleHealth} | Progress: ${item.progress}%`,
    `Active phase: ${item.activePhase} | Days remaining: ${item.daysRemaining ?? "Review"}`,
    `Open risks: ${item.openRisks} | Open decisions: ${item.openDecisions} | Overdue actions: ${item.overdueActions}`,
    `Upcoming milestone: ${item.upcomingMilestone ? `${item.upcomingMilestone.title} (${formatScheduleDate(item.upcomingMilestone.target_date)})` : "None scheduled"}`,
  ].join("\n")).join("\n\n");
  const list = (items: InsightItem[], empty: string) => items.length
    ? items.map((item) => `- [${item.severity}] ${item.kind}: ${item.title} — ${item.meta}`).join("\n")
    : `- ${empty}`;

  const yesterday = sinceYesterday.map((item) => item.available
    ? `- ${item.projectName}: progress ${item.progressChange > 0 ? "+" : ""}${item.progressChange} points; ${item.newRisks} new / ${item.closedRisks} closed risks; ${item.newActions} new / ${item.completedActions} completed actions${item.healthChange ? `; health ${item.healthChange}` : ""}${item.milestoneChange ? `; milestone ${item.milestoneChange}` : ""}.`
    : `- ${item.projectName}: another daily snapshot is required before comparison.`).join("\n");
  const weeklyList = (label: string, items: string[], empty: string) => `${label}\n${items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`}`;

  return `DAILY PROJECT BRIEF — ${emailDate(date).toUpperCase()}\n\nEXECUTIVE SUMMARY\n${summary}\n\nSINCE YESTERDAY\n${yesterday || "- Snapshot history is still building."}\n\nPROJECT STATUS\n${projectLines || "No projects available."}\n\nATTENTION REQUIRED\n${list(attention, "No items require attention.")}\n\nUPCOMING THIS WEEK\n${list(upcoming, "No items are due in the next seven days.")}\n\nWEEKLY EXECUTIVE SUMMARY\n${weeklyList("WHAT IMPROVED", weekly.improved, "No measured improvements yet.")}\n${weeklyList("WHAT WORSENED", weekly.worsened, "No measured deterioration.")}\n${weeklyList("UPCOMING MILESTONES", weekly.upcomingMilestones, "No milestones scheduled.")}\n${weeklyList("PROJECTS REQUIRING ATTENTION", weekly.projectsRequiringAttention, "No projects require attention.")}\n\nPrepared by Project Manager / Control Centre`;
}

function buildHtml(date: Date, summary: string, projects: DailyBriefProject[], attention: InsightItem[], upcoming: InsightItem[], sinceYesterday: SinceYesterday[], weekly: WeeklyExecutiveSummary) {
  const projectRows = projects.map((item) => `<tr>
    <td style="padding:14px;border-top:1px solid #e2e8f0;"><strong>${escapeHtml(item.project.name)}</strong><br><span style="color:#64748b;">${escapeHtml(item.activePhase)}</span></td>
    <td style="padding:14px;border-top:1px solid #e2e8f0;color:${healthColor(item.health)};"><strong>${item.health}</strong></td>
    <td style="padding:14px;border-top:1px solid #e2e8f0;color:${healthColor(item.scheduleHealth)};"><strong>${item.scheduleHealth}</strong></td>
    <td style="padding:14px;border-top:1px solid #e2e8f0;">${item.progress}%</td>
    <td style="padding:14px;border-top:1px solid #e2e8f0;">${item.daysRemaining ?? "Review"}</td>
    <td style="padding:14px;border-top:1px solid #e2e8f0;">${item.openRisks} / ${item.openDecisions} / ${item.overdueActions}</td>
    <td style="padding:14px;border-top:1px solid #e2e8f0;">${item.upcomingMilestone ? `${escapeHtml(item.upcomingMilestone.title)}<br><span style="color:#64748b;">${escapeHtml(formatScheduleDate(item.upcomingMilestone.target_date))}</span>` : "None scheduled"}</td>
  </tr>`).join("");
  const list = (items: InsightItem[], empty: string) => items.length
    ? `<ul style="margin:0;padding-left:20px;">${items.map((item) => `<li style="margin:0 0 10px;"><strong>${escapeHtml(item.kind)}:</strong> ${escapeHtml(item.title)}<br><span style="color:#64748b;">${escapeHtml(item.meta)}</span></li>`).join("")}</ul>`
    : `<p style="margin:0;color:#64748b;">${escapeHtml(empty)}</p>`;
  const textList = (items: string[], empty: string) => items.length
    ? `<ul style="margin:0;padding-left:20px;">${items.map((item) => `<li style="margin:0 0 8px;">${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p style="margin:0;color:#64748b;">${escapeHtml(empty)}</p>`;
  const sinceYesterdayHtml = sinceYesterday.length
    ? `<ul style="margin:0;padding-left:20px;">${sinceYesterday.map((item) => `<li style="margin:0 0 8px;"><strong>${escapeHtml(item.projectName)}:</strong> ${item.available ? `progress ${item.progressChange > 0 ? "+" : ""}${item.progressChange} points; ${item.newRisks} new and ${item.closedRisks} closed risks; ${item.newActions} new and ${item.completedActions} completed actions${item.healthChange ? `; health ${escapeHtml(item.healthChange)}` : ""}${item.milestoneChange ? `; milestone ${escapeHtml(item.milestoneChange)}` : ""}` : "another daily snapshot is required before comparison"}.</li>`).join("")}</ul>`
    : `<p style="margin:0;color:#64748b;">Snapshot history is still building.</p>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily Project Brief</title></head>
<body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,sans-serif;"><div style="max-width:960px;margin:0 auto;padding:24px;">
  <div style="background:#0f172a;color:#fff;padding:24px;border-radius:8px 8px 0 0;"><p style="margin:0 0 6px;color:#93c5fd;font-size:13px;font-weight:bold;text-transform:uppercase;">Project Manager / Control Centre</p><h1 style="margin:0;font-size:26px;">Daily Project Brief</h1><p style="margin:8px 0 0;color:#cbd5e1;">${escapeHtml(emailDate(date))}</p></div>
  <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;"><h2 style="margin:0 0 10px;font-size:18px;">Executive Summary</h2><p style="margin:0;line-height:1.6;">${escapeHtml(summary)}</p></div>
  <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:0;"><h2 style="margin:0 0 14px;font-size:18px;">Since Yesterday</h2>${sinceYesterdayHtml}</div>
  <div style="background:#fff;padding:0 24px 24px;border:1px solid #e2e8f0;border-top:0;overflow-x:auto;"><h2 style="margin:0 0 14px;padding-top:24px;font-size:18px;">Project Status</h2><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="background:#f8fafc;text-align:left;"><th style="padding:12px;">Project / Phase</th><th style="padding:12px;">Health</th><th style="padding:12px;">Schedule</th><th style="padding:12px;">Progress</th><th style="padding:12px;">Days</th><th style="padding:12px;">Risks / Decisions / Actions</th><th style="padding:12px;">Next Milestone</th></tr></thead><tbody>${projectRows || '<tr><td colspan="7" style="padding:14px;">No projects available.</td></tr>'}</tbody></table></div>
  <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:0;"><h2 style="margin:0 0 14px;font-size:18px;">Attention Required</h2>${list(attention, "No items require attention.")}</div>
  <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:0;"><h2 style="margin:0 0 14px;font-size:18px;">Upcoming This Week</h2>${list(upcoming, "No items are due in the next seven days.")}</div>
  <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 8px 8px;"><h2 style="margin:0 0 14px;font-size:18px;">Weekly Executive Summary</h2><h3 style="font-size:14px;">What improved</h3>${textList(weekly.improved, "No measured improvements yet.")}<h3 style="font-size:14px;">What worsened</h3>${textList(weekly.worsened, "No measured deterioration.")}<h3 style="font-size:14px;">Upcoming milestones</h3>${textList(weekly.upcomingMilestones, "No milestones scheduled.")}<h3 style="font-size:14px;">Projects requiring attention</h3>${textList(weekly.projectsRequiringAttention, "No projects require attention.")}</div>
  <p style="margin:18px 0 0;text-align:center;color:#64748b;font-size:12px;">Prepared by Project Manager / Control Centre</p>
</div></body></html>`;
}

export function buildDailyBrief(data: DataStore, now = new Date()): DailyBrief {
  const projects = selectCanonicalProjects(data).map((project): DailyBriefProject => {
    const scoped = scopeProjectData(data, project);
    const schedule = calculateSchedule(project, scoped.timeline_items, now);
    const overdueActions = scoped.actions.filter((item) => isOverdue(item.due_date, item.status)).length;
    const overdueDecisions = scoped.decisions.filter((item) => isOverdue(item.due_date, item.status)).length;
    const blocked = scoped.milestones.filter((item) => item.status === "Blocked").length + schedule.blocked.length;
    const variance = schedule.variance ?? -1;
    return {
      project,
      health: calculateProjectHealth(overdueActions + overdueDecisions, blocked, variance),
      scheduleHealth: schedule.health ?? "Review",
      progress: calculateProgress(scoped, variance).overall,
      activePhase: schedule.active[0]?.phase_name ?? schedule.atRisk[0]?.phase_name ?? schedule.blocked[0]?.phase_name ?? project.status,
      daysRemaining: schedule.daysRemaining,
      openRisks: scoped.risks.filter((item) => !["Complete", "Closed"].includes(item.status)).length,
      openDecisions: scoped.decisions.filter((item) => !["Approved", "Closed"].includes(item.status)).length,
      overdueActions,
      upcomingMilestone: upcomingMilestone(scoped.milestones, now),
    };
  });

  const attention = selectCanonicalProjects(data).flatMap((project) => buildNeedsAttention(scopeProjectData(data, project)).map((item) => ({ ...item, id: `${project.id}-${item.id}`, meta: `${project.name} · ${item.meta}` })));
  const upcoming = selectCanonicalProjects(data).flatMap((project) => buildUpcomingThisWeek(scopeProjectData(data, project)).map((item) => ({ ...item, id: `${project.id}-${item.id}`, meta: `${project.name} · ${item.meta}` })));
  const red = projects.filter((item) => item.health === "Red").length;
  const amber = projects.filter((item) => item.health === "Amber").length;
  const green = projects.filter((item) => item.health === "Green").length;
  const executiveSummary = projects.length
    ? `${projects.length} ${projects.length === 1 ? "project is" : "projects are"} in scope: ${green} Green, ${amber} Amber and ${red} Red. ${attention.length} ${attention.length === 1 ? "item requires" : "items require"} management attention, with ${upcoming.length} due in the next seven days.`
    : "No projects are currently available for the daily brief.";
  const subject = `Daily Project Brief — ${emailDate(now)}`;
  const sinceYesterday = buildSinceYesterday(data);
  const weeklySummary = buildWeeklyExecutiveSummary(data);
  const plainText = buildPlainText(now, executiveSummary, projects, attention, upcoming, sinceYesterday, weeklySummary);
  const html = buildHtml(now, executiveSummary, projects, attention, upcoming, sinceYesterday, weeklySummary);

  return { generatedAt: now, projects, attention, upcoming, executiveSummary, sinceYesterday, weeklySummary, subject, plainText, html };
}
