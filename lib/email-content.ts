import type { DataStore } from "@/lib/data-store";
import type { AuditLog, Project } from "@/lib/types";
import { buildManagerExceptionReport, type ManagerProjectSummary } from "@/lib/manager-summary";
import { buildGoLiveDashboard } from "@/lib/go-live-readiness";
import { buildProjectIntelligence } from "@/lib/project-intelligence";
import { scopeProjectData, selectCanonicalProjects, selectEmailProjects } from "@/lib/project-scope";
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

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

function daysFromNow(dateStr: string, now: Date): number {
  return Math.round((new Date(`${dateStr}T12:00:00Z`).getTime() - now.getTime()) / 86_400_000);
}

function healthBadge(health: string) {
  const colors: Record<string, string> = { Green: "#16a34a", Amber: "#d97706", Red: "#dc2626" };
  const bg: Record<string, string> = { Green: "#f0fdf4", Amber: "#fffbeb", Red: "#fef2f2" };
  const c = colors[health] ?? "#64748b";
  const b = bg[health] ?? "#f8fafc";
  return `<span style="background:${b};color:${c};border:1px solid ${c};font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:4px">${escapeHtml(health)}</span>`;
}

function briefSection(title: string, body: string) {
  return `<div style="background:#fff;padding:20px 24px;border:1px solid #e2e8f0;border-top:0"><h2 style="margin:0 0 12px;font-size:16px;color:#0f172a;border-bottom:1px solid #f1f5f9;padding-bottom:8px">${escapeHtml(title)}</h2>${body}</div>`;
}

function attentionRow(label: string, count: number, urgent: boolean) {
  const color = urgent ? "#dc2626" : "#d97706";
  if (count === 0) return "";
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f8fafc"><span style="min-width:80px;font-size:22px;font-weight:700;color:${color}">${count}</span><span style="font-size:14px;color:#334155">${escapeHtml(label)}</span></div>`;
}

function briefList(items: string[], empty: string) {
  if (!items.length) return `<p style="margin:0;color:#94a3b8;font-size:13px">${escapeHtml(empty)}</p>`;
  return `<ul style="margin:0;padding-left:18px">${items.map((i) => `<li style="font-size:13px;color:#1e293b;margin-bottom:5px">${escapeHtml(i)}</li>`).join("")}</ul>`;
}

function kpiCell(label: string, value: string, sub?: string) {
  return `<td style="padding:0 16px 0 0;vertical-align:top"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(label)}</div><div style="font-size:22px;font-weight:700;color:#0f172a">${escapeHtml(value)}</div>${sub ? `<div style="font-size:11px;color:#64748b">${escapeHtml(sub)}</div>` : ""}</td>`;
}

function buildProjectBriefSection(project: Project, scoped: DataStore, todayStr: string, in7DaysStr: string, now: Date): { html: string; text: string; priorities: Array<{ label: string; score: number }> } {
  const { deliverables, actions, risks, milestones, decisions, dependencies, discovery_questions, test_cases } = scoped;
  const allAC = scoped.acceptance_criteria ?? [];

  // Project Summary
  const totalDel = deliverables.length;
  const doneDel = deliverables.filter((d) => d.status === "Deployed").length;
  const progressPct = totalDel > 0 ? Math.round((doneDel / totalDel) * 100) : 0;
  const days = project.planned_end_date ? daysFromNow(project.planned_end_date, now) : null;
  const daysLabel = days === null ? "—" : days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `${days}d`;

  // Today's Attention
  const overdueActions = actions.filter((a) => a.due_date && a.due_date < todayStr && a.status !== "Complete" && a.status !== "Closed");
  const highRisks = risks.filter((r) => (r.impact === "High" || r.impact === "Critical") && r.status !== "Complete" && r.status !== "Closed");
  const openQueries = discovery_questions.filter((q) => q.status === "Awaiting Response" || q.status === "Open" || q.status === "Awaiting Business" || q.status === "Awaiting Development");
  const upcomingDeliverables = deliverables.filter((d) => d.planned_completion_date && d.planned_completion_date >= todayStr && d.planned_completion_date <= in7DaysStr && d.status !== "Deployed");
  const upcomingMilestones = milestones.filter((m) => m.target_date && m.target_date >= todayStr && m.target_date <= in7DaysStr && m.status !== "Complete");

  // Development
  const inProgressDel = deliverables.filter((d) => d.status !== "Not Started" && d.status !== "Deployed" && d.status !== "Blocked");
  const blockedDel = deliverables.filter((d) => d.status === "Blocked");

  // Testing
  const totalTests = test_cases.length;
  const passedTests = test_cases.filter((t) => t.status === "Passed").length;
  const failedTests = test_cases.filter((t) => t.status === "Failed").length;
  const blockedTests = test_cases.filter((t) => t.status === "Blocked").length;
  const pendingTests = test_cases.filter((t) => t.status === "Pending").length;

  // Governance
  const openDecisions = decisions.filter((d) => d.status !== "Complete" && d.status !== "Closed" && d.status !== "Approved");
  const openDependencies = dependencies.filter((d) => d.status !== "Complete" && d.status !== "Closed");

  // Build priorities (returned for top-3 aggregation)
  const priorities: Array<{ label: string; score: number }> = [];
  if (overdueActions.length > 0) priorities.push({ label: `${overdueActions.length} overdue action${overdueActions.length > 1 ? "s" : ""} — ${overdueActions[0].description.slice(0, 60)}`, score: 100 + overdueActions.length });
  highRisks.forEach((r) => priorities.push({ label: `${r.impact} risk: ${r.description.slice(0, 70)}`, score: r.impact === "Critical" ? 90 : 80 }));
  upcomingMilestones.forEach((m) => { const d = m.target_date ? daysFromNow(m.target_date, now) : 99; priorities.push({ label: `Milestone due in ${d}d: ${m.title}`, score: 70 - d }); });

  // HTML
  const projectHeader = `<div style="background:#1e293b;color:#fff;padding:16px 24px;border-top:3px solid #3b82f6;margin-top:16px"><strong style="font-size:15px">${escapeHtml(project.name)}</strong> &nbsp; ${healthBadge(project.health)}</div>`;

  const summaryHtml = `<table style="border-collapse:collapse"><tr>
    ${kpiCell("Progress", `${progressPct}%`, `${doneDel}/${totalDel} deployed`)}
    ${kpiCell("Go-Live", daysLabel, project.planned_end_date ?? undefined)}
    ${kpiCell("Health", project.health)}
    ${kpiCell("Status", project.status)}
  </tr></table>`;

  const attentionItems = [
    attentionRow("Overdue Actions", overdueActions.length, true),
    attentionRow("High / Critical Risks", highRisks.length, highRisks.length > 2),
    attentionRow("Open Queries", openQueries.length, false),
    attentionRow("Deliverables due ≤7 days", upcomingDeliverables.length, false),
    attentionRow("Milestones due ≤7 days", upcomingMilestones.length, false),
  ].filter(Boolean).join("");
  const attentionHtml = attentionItems || `<p style="margin:0;color:#16a34a;font-size:14px">Nothing requires immediate attention.</p>`;

  const devItems = [
    ...inProgressDel.map((d) => `${d.deliverable_ref}: ${d.title} (${d.status})`),
    ...blockedDel.map((d) => `BLOCKED — ${d.deliverable_ref}: ${d.title}`),
  ];

  const testHtml = totalTests > 0
    ? `<table style="border-collapse:collapse;font-size:13px"><tr>
        <td style="padding:4px 20px 4px 0"><span style="color:#64748b">Total</span> <strong>${totalTests}</strong></td>
        <td style="padding:4px 20px 4px 0"><span style="color:#16a34a">Passed</span> <strong>${passedTests}</strong></td>
        <td style="padding:4px 20px 4px 0"><span style="color:#dc2626">Failed</span> <strong>${failedTests}</strong></td>
        <td style="padding:4px 20px 4px 0"><span style="color:#d97706">Blocked</span> <strong>${blockedTests}</strong></td>
        <td style="padding:4px 20px 4px 0"><span style="color:#64748b">Pending</span> <strong>${pendingTests}</strong></td>
      </tr></table>`
    : `<p style="margin:0;color:#94a3b8;font-size:13px">No test cases recorded.</p>`;

  const govItems = [
    ...openDecisions.map((d) => `${d.decision_ref}: ${d.question.slice(0, 80)}`),
    ...openDependencies.map((d) => `Dependency: ${d.name}${d.owner ? ` (${d.owner})` : ""}`),
  ];

  // Acceptance Criteria
  const failedACReqs = scoped.requirements.filter((r) =>
    allAC.some((ac) => ac.requirement_id === r.id && ac.status === "Failed"),
  ).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);
  const signOffReadyReqs = scoped.requirements.filter((r) => {
    const acs = allAC.filter((ac) => ac.requirement_id === r.id);
    return acs.length > 0 && acs.every((ac) => ac.status === "Met" || ac.status === "Waived");
  }).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);
  const acHtml = allAC.length === 0
    ? `<p style="margin:0;color:#94a3b8;font-size:13px">No acceptance criteria recorded.</p>`
    : [
        `<table style="border-collapse:collapse;font-size:13px;margin-bottom:8px"><tr>
          <td style="padding:4px 20px 4px 0"><span style="color:#64748b">Total</span> <strong>${allAC.length}</strong></td>
          <td style="padding:4px 20px 4px 0"><span style="color:#16a34a">Met</span> <strong>${allAC.filter((ac) => ac.status === "Met").length}</strong></td>
          <td style="padding:4px 20px 4px 0"><span style="color:#dc2626">Failed</span> <strong>${allAC.filter((ac) => ac.status === "Failed").length}</strong></td>
          <td style="padding:4px 20px 4px 0"><span style="color:#64748b">Outstanding</span> <strong>${allAC.filter((ac) => !["Met", "Waived", "Failed"].includes(ac.status)).length}</strong></td>
        </tr></table>`,
        failedACReqs.length ? `<p style="margin:4px 0;font-size:12px;font-weight:700;color:#dc2626">Requirements with failed criteria:</p>${briefList(failedACReqs, "")}` : "",
        signOffReadyReqs.length ? `<p style="margin:8px 0 4px;font-size:12px;font-weight:700;color:#16a34a">Requirements ready for sign-off:</p>${briefList(signOffReadyReqs, "")}` : "",
      ].join("");

  if (failedACReqs.length > 0) priorities.push({ label: `${failedACReqs.length} requirement(s) with failed acceptance criteria`, score: 95 });

  const html = [
    projectHeader,
    briefSection("Project Summary", summaryHtml),
    briefSection("Today's Attention", attentionHtml),
    briefSection("Development", briefList(devItems, "No deliverables in progress.")),
    briefSection("Testing", testHtml),
    briefSection("Acceptance Criteria", acHtml),
    briefSection("Governance", briefList(govItems, "No open decisions or dependencies.")),
  ].join("");

  const text = [
    `\n${"=".repeat(60)}\n${project.name.toUpperCase()} — ${project.health} | ${progressPct}% | Go-live: ${daysLabel}\n${"=".repeat(60)}`,
    `TODAY'S ATTENTION\n${[overdueActions.length ? `- ${overdueActions.length} overdue action(s)` : "", highRisks.length ? `- ${highRisks.length} high/critical risk(s)` : "", openQueries.length ? `- ${openQueries.length} open quer(ies)` : ""].filter(Boolean).join("\n") || "- Nothing requires immediate attention."}`,
    `DEVELOPMENT\n${devItems.map((i) => `- ${i}`).join("\n") || "- No deliverables in progress."}`,
    `TESTING\nTotal: ${totalTests}  Passed: ${passedTests}  Failed: ${failedTests}  Blocked: ${blockedTests}  Pending: ${pendingTests}`,
    `GOVERNANCE\n${govItems.map((i) => `- ${i}`).join("\n") || "- No open decisions or dependencies."}`,
  ].join("\n\n");

  return { html, text, priorities };
}

export function buildAutomatedDailyBrief(data: DataStore, now = new Date(), recentAuditChanges: AuditLog[] = []): EmailContent {
  const projects = selectEmailProjects(data);
  const todayStr = toDateStr(now);
  const in7DaysStr = toDateStr(new Date(now.getTime() + 7 * 86_400_000));

  const allPriorities: Array<{ label: string; score: number }> = [];
  const projectBlocks: string[] = [];
  const projectTexts: string[] = [];

  for (const project of projects) {
    const scoped = scopeProjectData(data, project);
    const block = buildProjectBriefSection(project, scoped, todayStr, in7DaysStr, now);
    projectBlocks.push(block.html);
    projectTexts.push(block.text);
    allPriorities.push(...block.priorities);
  }

  // Recent Activity (24h from audit log)
  const activityItems = recentAuditChanges.slice(0, 10).map((e) => `[${e.entity_type}] ${e.entity_name} — ${e.action_type}${e.field_name ? ` (${e.field_name})` : ""}${e.old_value && e.new_value ? `: ${e.old_value} → ${e.new_value}` : ""}`);

  // Top 3 Priorities
  const top3 = allPriorities.sort((a, b) => b.score - a.score).slice(0, 3).map((p, i) => `${i + 1}. ${p.label}`);

  const recentHtml = briefSection("Recent Activity (Last 24 Hours)", briefList(activityItems, "No changes recorded in the last 24 hours."));
  const top3Html = briefSection("Top 3 Priorities", briefList(top3, "No priorities identified."));

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily Brief</title></head><body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,sans-serif"><div style="max-width:700px;margin:0 auto;padding:24px"><header style="background:#0f172a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0"><p style="margin:0 0 4px;color:#93c5fd;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Project Manager / Control Centre</p><h1 style="margin:0;font-size:22px">Daily Brief</h1><p style="margin:6px 0 0;color:#cbd5e1;font-size:13px">${escapeHtml(subjectDate(now))}</p></header>${projectBlocks.join("")}${recentHtml}${top3Html}<p style="text-align:center;color:#94a3b8;font-size:11px;margin-top:16px">Prepared by Project Manager / Control Centre</p></div></body></html>`;

  const text = `DAILY BRIEF — ${subjectDate(now).toUpperCase()}\n${projectTexts.join("\n")}\n\nRECENT ACTIVITY (LAST 24H)\n${activityItems.map((i) => `- ${i}`).join("\n") || "- No changes recorded."}\n\nTOP 3 PRIORITIES\n${top3.join("\n") || "- No priorities identified."}`;

  return {
    subject: `[Project Manager] Daily Brief — ${subjectDate(now)}`,
    html,
    text,
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

  // Acceptance Criteria weekly summary
  const allAC = data.acceptance_criteria ?? [];
  const acTotal = allAC.length;
  const acMet = allAC.filter((ac) => ac.status === "Met").length;
  const acPct = acTotal > 0 ? Math.round((acMet / acTotal) * 100) : 0;
  const acceptanceProgress = acTotal > 0 ? [`${acMet}/${acTotal} criteria met (${acPct}%)`] : [];
  const topFailingCriteria = allAC.filter((ac) => ac.status === "Failed").slice(0, 5)
    .map((ac) => `${ac.ac_ref}: ${ac.criterion.slice(0, 80)}`);
  const reqsAwaitingAcceptance = data.requirements.filter((r) => {
    const acs = allAC.filter((ac) => ac.requirement_id === r.id);
    return acs.length > 0 && acs.some((ac) => !["Met", "Waived"].includes(ac.status));
  }).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);

  const groups: [string, string[], string][] = [
    ["Project Progress Trends", progressTrends, "Snapshot history is still building."],
    ["Health Changes", healthChanges, "No health changes recorded."],
    ["Acceptance Progress", acceptanceProgress, "No acceptance criteria recorded."],
    ["Requirements with Failed Criteria", topFailingCriteria, "No failed acceptance criteria."],
    ["Requirements Awaiting Acceptance", reqsAwaitingAcceptance.slice(0, 10), "All requirements have acceptance criteria met."],
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

  // Go-live alerts: only RED readiness, delayed go-live, missing approvals, critical blockers
  const goLiveAlerts = selectCanonicalProjects(data).flatMap((project) => {
    const dashboard = buildGoLiveDashboard(data, project, now);
    const alerts: string[] = [];
    if (dashboard.status === "Red") alerts.push(`${project.name}: Go-live readiness is RED (${dashboard.readinessPercent}%).`);
    if (dashboard.daysToGoLive !== null && dashboard.daysToGoLive < 0) alerts.push(`${project.name}: Go-live date has passed — delayed.`);
    if (dashboard.wmsChecks.some((c) => c.id === "customer_approval" && !c.complete && !c.waived)) alerts.push(`${project.name}: Customer approval is missing.`);
    if (dashboard.openCriticalRisks > 0 && dashboard.daysToGoLive !== null && dashboard.daysToGoLive <= 14) alerts.push(`${project.name}: ${dashboard.openCriticalRisks} critical risk${dashboard.openCriticalRisks > 1 ? "s" : ""} open within ${dashboard.daysToGoLive} days of go-live.`);
    return alerts;
  });

  const redCount = report.projects.filter((p) => p.status === "Red").length;
  const amberCount = report.projects.filter((p) => p.status === "Amber").length;
  const actionCount = report.requiresAction.length;

  const intro = report.projects.length === 0
    ? "No active projects found."
    : actionCount > 0
      ? `${actionCount} ${actionCount === 1 ? "project requires" : "projects require"} management action. ${redCount > 0 ? `${redCount} Red. ` : ""}${amberCount > 0 ? `${amberCount} Amber.` : ""}`.trim()
      : "All projects are on track. No management action is required.";

  const goLiveHtml = goLiveAlerts.length ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:14px 16px;margin-bottom:16px"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:0.05em">Go-Live Alerts</p><ul style="margin:0;padding-left:20px">${goLiveAlerts.map((a) => `<li style="font-size:13px;color:#7f1d1d;margin-bottom:4px">${escapeHtml(a)}</li>`).join("")}</ul></div>` : "";

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
    ${goLiveHtml}${projectHtml || `<p style="color:#64748b;font-size:14px">No projects to report.</p>`}
  </div>
  <p style="margin:0;text-align:center;color:#94a3b8;font-size:11px">Prepared by Project Manager / Control Centre — exceptions only</p>
</div>
</body></html>`;

  const goLiveText = goLiveAlerts.length ? `\n\nGO-LIVE ALERTS\n${goLiveAlerts.map((a) => `• ${a}`).join("\n")}` : "";
  const text = `MANAGER EXCEPTION REPORT — ${subjectDate(now).toUpperCase()}\n\n${intro}${goLiveText}\n\n${"=".repeat(60)}\n\n${projectText || "No projects to report."}`;

  return {
    subject: `[Manager] Exception Report — ${subjectDate(now)}`,
    html,
    text,
  };
}
