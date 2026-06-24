import { buildDailyBrief } from "@/lib/daily-brief";
import type { DataStore } from "@/lib/data-store";
import type { AuditLog } from "@/lib/types";
import { buildManagerExceptionReport, type ManagerProjectSummary } from "@/lib/manager-summary";
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

export function buildAutomatedDailyBrief(data: DataStore, now = new Date(), recentAuditChanges: AuditLog[] = []): EmailContent {
  const brief = buildDailyBrief(data, now, recentAuditChanges);
  const intelligence = intelligenceLines(data, now);
  const readiness = readinessLines(data);
  const additions = `${section("Project Intelligence Findings", listHtml(intelligence, "No critical or warning findings."))}${section("Delivery Readiness KPI", listHtml(readiness, "No deliverables are available."))}`;
  return {
    subject: `[Project Manager] Daily Brief - ${subjectDate(now)}`,
    html: brief.html.replace("</body>", `${additions}</body>`),
    text: `${brief.plainText}\n\n${plainList("Project Intelligence Findings", intelligence, "No critical or warning findings.")}\n\n${plainList("Delivery Readiness KPI", readiness, "No deliverables are available.")}`,
  };
}

export function buildAutomatedWeeklySummary(data: DataStore, now = new Date(), weeklyAuditChanges: AuditLog[] = []): EmailContent {
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

  // Project Change Log from audit — group by project then action type
  const projectChangeLog = weeklyAuditChanges.length
    ? Object.entries(
        weeklyAuditChanges.reduce<Record<string, string[]>>((acc, e) => {
          const key = e.entity_type;
          const line = `[${e.action_type}] ${e.entity_name}: ${e.old_value ?? "—"} → ${e.new_value ?? "—"} (${e.changed_by_name})`;
          acc[key] = [...(acc[key] ?? []), line];
          return acc;
        }, {}),
      ).flatMap(([type, lines]) => [`${type.replace("_", " ").toUpperCase()}`, ...lines.slice(0, 3)])
    : [];

  const groups: [string, string[], string][] = [
    ["Project Progress Trends", progressTrends, "Snapshot history is still building."],
    ["Health Changes", healthChanges, "No health changes recorded."],
    ["Risks Added / Closed", risks, "No comparable snapshots are available."],
    ["Decisions Made", decisions, "No decisions were recorded this week."],
    ["Deliverables Completed", deliverables, "No deliverables were completed this week."],
    ["Project Change Log (Audit)", projectChangeLog, "No data changes recorded this week."],
    ["Milestones Due", [...summary.upcomingMilestones], "No upcoming milestones."],
    ["Projects Requiring Attention", [...summary.projectsRequiringAttention], "No projects require attention."],
    ["What Improved", [...summary.improved], "No measured improvements yet."],
    ["What Worsened", [...summary.worsened], "No measured deterioration."],
    ["Intelligence Summary", intelligence, "No critical or warning findings."],
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly Executive Summary</title></head><body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,sans-serif"><div style="max-width:900px;margin:0 auto;padding:24px"><header style="background:#0f172a;color:#fff;padding:24px;border-radius:8px 8px 0 0"><p style="margin:0 0 6px;color:#93c5fd;font-size:13px;font-weight:bold;text-transform:uppercase">Project Manager / Control Centre</p><h1 style="margin:0;font-size:26px">Weekly Executive Summary</h1><p style="margin:8px 0 0;color:#cbd5e1">${escapeHtml(subjectDate(now))}</p></header>${groups.map(([title, items, empty]) => section(title, listHtml(items, empty))).join("")}<p style="text-align:center;color:#64748b;font-size:12px">Prepared by Project Manager / Control Centre</p></div></body></html>`;
  return {
    subject: `[Project Manager] Weekly Executive Summary - ${subjectDate(now)}`,
    html,
    text: groups.map(([title, items, empty]) => plainList(title, items, empty)).join("\n\n"),
  };
}

export function buildTestEmail(now = new Date()): EmailContent {
  const subject = `[Project Manager] Test Email - ${subjectDate(now)}`;
  return { subject, html: `<div style="font-family:Arial,sans-serif;max-width:640px;padding:24px"><h1>Project Manager email delivery is working</h1><p>This test was generated by CR028 Control Centre on ${escapeHtml(subjectDate(now))}.</p></div>`, text: `Project Manager email delivery is working. Test generated ${subjectDate(now)}.` };
}

// ── Manager Exception Email ───────────────────────────────────────────────────

const RAG_COLOR: Record<string, string> = {
  Green: "#16a34a",
  Amber: "#d97706",
  Red: "#dc2626",
};

const RAG_BG: Record<string, string> = {
  Green: "#f0fdf4",
  Amber: "#fffbeb",
  Red: "#fef2f2",
};

function projectBlock(p: ManagerProjectSummary): string {
  const color = RAG_COLOR[p.status] ?? "#64748b";
  const bg = RAG_BG[p.status] ?? "#f8fafc";
  const attentionHtml = p.attentionRequired
    ? `<p style="margin:10px 0 0;padding:10px;background:#fff3cd;border-left:3px solid #d97706;font-size:14px"><strong>Attention required:</strong> ${escapeHtml(p.attentionRequired)}</p>`
    : "";
  return `<div style="background:${bg};border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:6px;padding:16px 20px;margin-bottom:16px">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
    <span style="background:${color};color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;padding:3px 10px;border-radius:4px">${escapeHtml(p.status)}</span>
    <strong style="font-size:16px">${escapeHtml(p.project.name)}</strong>
  </div>
  <p style="margin:0;font-size:14px;line-height:1.6;color:#1e293b">${escapeHtml(p.summary)}</p>
  ${attentionHtml}
  <table style="margin-top:12px;border-collapse:collapse;font-size:13px">
    <tr>
      <td style="padding:2px 16px 2px 0;color:#64748b">Date confidence</td>
      <td style="padding:2px 0;font-weight:600">${escapeHtml(p.dateConfidence)}</td>
    </tr>
    <tr>
      <td style="padding:2px 16px 2px 0;color:#64748b">Management action</td>
      <td style="padding:2px 0;font-weight:600;color:${p.managementAction === "Required" ? "#dc2626" : "#16a34a"}">${escapeHtml(p.managementAction)}</td>
    </tr>
  </table>
</div>`;
}

function projectBlockText(p: ManagerProjectSummary): string {
  const lines = [
    `${p.project.name} — ${p.status.toUpperCase()}`,
    p.summary,
  ];
  if (p.attentionRequired) lines.push(`ACTION NEEDED: ${p.attentionRequired}`);
  lines.push(`Date confidence: ${p.dateConfidence}  |  Management action: ${p.managementAction}`);
  return lines.join("\n");
}

export function buildManagerSummaryEmail(data: DataStore, now = new Date()): EmailContent {
  const report = buildManagerExceptionReport(data, now);

  const redCount = report.projects.filter((p) => p.status === "Red").length;
  const amberCount = report.projects.filter((p) => p.status === "Amber").length;
  const actionCount = report.requiresAction.length;

  const intro = report.projects.length === 0
    ? "No active projects found."
    : actionCount > 0
      ? `${actionCount} ${actionCount === 1 ? "project requires" : "projects require"} management action. ${redCount > 0 ? `${redCount} Red. ` : ""}${amberCount > 0 ? `${amberCount} Amber.` : ""}`.trim()
      : "All projects are on track. No management action is required.";

  const projectHtml = report.projects.map(projectBlock).join("");
  const projectText = report.projects.map(projectBlockText).join("\n\n---\n\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manager Exception Report</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a">
<div style="max-width:700px;margin:0 auto;padding:24px">
  <div style="background:#0f172a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <p style="margin:0 0 4px;color:#93c5fd;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Project Manager / Control Centre</p>
    <h1 style="margin:0;font-size:22px">Manager Exception Report</h1>
    <p style="margin:6px 0 0;color:#cbd5e1;font-size:13px">${escapeHtml(subjectDate(now))}</p>
  </div>
  <div style="background:#fff;padding:20px 24px;border:1px solid #e2e8f0;border-top:0">
    <p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(intro)}</p>
  </div>
  <div style="padding:16px 0">
    ${projectHtml || `<p style="color:#64748b;font-size:14px">No projects to report.</p>`}
  </div>
  <p style="margin:0;text-align:center;color:#94a3b8;font-size:11px">Prepared by Project Manager / Control Centre — exceptions only</p>
</div>
</body></html>`;

  const text = `MANAGER EXCEPTION REPORT — ${subjectDate(now).toUpperCase()}\n\n${intro}\n\n${"=".repeat(60)}\n\n${projectText || "No projects to report."}`;

  return {
    subject: `[Manager] Exception Report — ${subjectDate(now)}`,
    html,
    text,
  };
}
