import { buildDailyBrief } from "@/lib/daily-brief";
import type { DataStore } from "@/lib/data-store";
import { calculateDeliveryReadiness } from "@/lib/delivery";
import { buildProjectIntelligence } from "@/lib/project-intelligence";
import { scopeProjectData, selectCanonicalProjects } from "@/lib/project-scope";
import { buildSinceYesterday, buildTrendAnalysis, buildWeeklyExecutiveSummary } from "@/lib/project-trends";

export type EmailContent = { subject: string; html: string; text: string };

function subjectDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/London" }).format(date);
}

function escapeHtml(value: unknown) {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function listHtml(items: string[], empty: string) {
  return items.length
    ? `<ul style="margin:0;padding-left:20px">${items.map((item) => `<li style="margin:0 0 8px">${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p style="margin:0;color:#64748b">${escapeHtml(empty)}</p>`;
}

function section(title: string, body: string) {
  return `<section style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:0"><h2 style="margin:0 0 14px;font-size:18px">${escapeHtml(title)}</h2>${body}</section>`;
}

function plainList(title: string, items: string[], empty: string) {
  return `${title.toUpperCase()}\n${items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`}`;
}

function intelligenceLines(data: DataStore, now: Date) {
  return selectCanonicalProjects(data).flatMap((project) => {
    const report = buildProjectIntelligence(data, project, now);
    return [...report.critical, ...report.warnings].slice(0, 3).map((finding) => `${project.name}: [${finding.severity}] ${finding.title} — ${finding.recommendation ?? finding.detail}`);
  }).slice(0, 8);
}

function readinessLines(data: DataStore) {
  return selectCanonicalProjects(data).map((project) => {
    const readiness = calculateDeliveryReadiness(scopeProjectData(data, project).deliverables);
    return `${project.name}: ${readiness.percent}% (${readiness.completed} of ${readiness.total} deliverables deployed).`;
  });
}

export function buildAutomatedDailyBrief(data: DataStore, now = new Date()): EmailContent {
  const brief = buildDailyBrief(data, now);
  const intelligence = intelligenceLines(data, now);
  const readiness = readinessLines(data);
  const additions = `${section("Project Intelligence Findings", listHtml(intelligence, "No critical or warning findings."))}${section("Delivery Readiness KPI", listHtml(readiness, "No deliverables are available."))}`;
  return {
    subject: `[Project Manager] Daily Brief - ${subjectDate(now)}`,
    html: brief.html.replace("</body>", `${additions}</body>`),
    text: `${brief.plainText}\n\n${plainList("Project Intelligence Findings", intelligence, "No critical or warning findings.")}\n\n${plainList("Delivery Readiness KPI", readiness, "No deliverables are available.")}`,
  };
}

export function buildAutomatedWeeklySummary(data: DataStore, now = new Date()): EmailContent {
  const summary = buildWeeklyExecutiveSummary(data);
  const sinceYesterday = buildSinceYesterday(data);
  const projects = selectCanonicalProjects(data);
  const progressTrends = projects.map((project) => buildTrendAnalysis(project, data.project_snapshots).narrative);
  const healthChanges = sinceYesterday.filter((item) => item.healthChange).map((item) => `${item.projectName}: ${item.healthChange}.`);
  const risks = sinceYesterday.filter((item) => item.available).map((item) => `${item.projectName}: ${item.newRisks} added / ${item.closedRisks} closed.`);
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const decisions = data.decisions.filter((item) => item.decision_date && new Date(`${item.decision_date}T12:00:00Z`).getTime() >= weekAgo).map((item) => `${item.decision_ref}: ${item.decision || item.question}`);
  const deliverables = data.deliverables.filter((item) => item.actual_completion_date && new Date(`${item.actual_completion_date}T12:00:00Z`).getTime() >= weekAgo).map((item) => `${item.deliverable_ref}: ${item.title}`);
  const intelligence = intelligenceLines(data, now);
  const groups = [
    ["Project Progress Trends", progressTrends, "Snapshot history is still building."],
    ["Health Changes", healthChanges, "No health changes recorded."],
    ["Risks Added / Closed", risks, "No comparable snapshots are available."],
    ["Decisions Made", decisions, "No decisions were recorded this week."],
    ["Deliverables Completed", deliverables, "No deliverables were completed this week."],
    ["Milestones Due", summary.upcomingMilestones, "No upcoming milestones."],
    ["Projects Requiring Attention", summary.projectsRequiringAttention, "No projects require attention."],
    ["What Improved", summary.improved, "No measured improvements yet."],
    ["What Worsened", summary.worsened, "No measured deterioration."],
    ["Intelligence Summary", intelligence, "No critical or warning findings."],
  ] as const;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly Executive Summary</title></head><body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,sans-serif"><div style="max-width:900px;margin:0 auto;padding:24px"><header style="background:#0f172a;color:#fff;padding:24px;border-radius:8px 8px 0 0"><p style="margin:0 0 6px;color:#93c5fd;font-size:13px;font-weight:bold;text-transform:uppercase">Project Manager / Control Centre</p><h1 style="margin:0;font-size:26px">Weekly Executive Summary</h1><p style="margin:8px 0 0;color:#cbd5e1">${escapeHtml(subjectDate(now))}</p></header>${groups.map(([title, items, empty]) => section(title, listHtml([...items], empty))).join("")}<p style="text-align:center;color:#64748b;font-size:12px">Prepared by Project Manager / Control Centre</p></div></body></html>`;
  return {
    subject: `[Project Manager] Weekly Executive Summary - ${subjectDate(now)}`,
    html,
    text: groups.map(([title, items, empty]) => plainList(title, [...items], empty)).join("\n\n"),
  };
}

export function buildTestEmail(now = new Date()): EmailContent {
  const subject = `[Project Manager] Test Email - ${subjectDate(now)}`;
  return { subject, html: `<div style="font-family:Arial,sans-serif;max-width:640px;padding:24px"><h1>Project Manager email delivery is working</h1><p>This test was generated by CR028 Control Centre on ${escapeHtml(subjectDate(now))}.</p></div>`, text: `Project Manager email delivery is working. Test generated ${subjectDate(now)}.` };
}
