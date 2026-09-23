import type { DataStore } from "@/lib/data-store";
import {
  computeTestVerification,
  isAcceptanceCriteriaFailed,
  isAcceptanceCriteriaMet,
  isActionOverdue,
  isDecisionOpen,
  isDeliverableBlocked,
  isDeliverableComplete,
  isDependencyOpen,
  isRiskHighOrCritical,
  isRiskOpen,
  isTestClosed,
  isTestPassed,
  summarizeVerificationStates,
  type VerificationState,
} from "@/lib/lifecycle";
import { REF_COLLATOR } from "@/lib/ref-sort";
import type { AuditLog, Project, TestCase } from "@/lib/types";
import { buildManagerExceptionReport, type ManagerProjectSummary } from "@/lib/manager-summary";
import { buildProjectIntelligence } from "@/lib/project-intelligence";
import { buildProjectState, type ProjectState } from "@/lib/project-state";
import { scopeProjectData, selectCanonicalProjects, selectEmailProjects } from "@/lib/project-scope";
import { buildSinceYesterday, buildTrendAnalysis, buildWeeklyExecutiveSummary } from "@/lib/project-trends";
import { groupTestsByRequirement, parseTestScenario, splitSteps } from "@/lib/test-report-format";

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

function buildProjectBriefSection(state: ProjectState, todayStr: string, in7DaysStr: string): { html: string; text: string; priorities: Array<{ label: string; score: number }> } {
  const { project, scoped, generatedAt: now } = state;
  const { deliverables, actions, risks, milestones, decisions, dependencies, discovery_questions, test_cases } = scoped;
  const allAC = scoped.acceptance_criteria ?? [];

  // Project Summary — deliverable-completion %, a distinct metric from
  // Control Tower's weighted overall progress; only the input counts are
  // shared via state.rollups, not the percentage itself.
  const totalDel = state.rollups.deliverables.total;
  const doneDel = state.rollups.deliverables.complete;
  const progressPct = totalDel > 0 ? Math.round((doneDel / totalDel) * 100) : 0;
  const goLive = state.goLiveDate;
  const days = goLive.date ? daysFromNow(goLive.date, now) : null;
  const daysLabel = days === null ? "—" : days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `${days}d`;

  // Today's Attention
  const overdueActions = actions.filter((a) => isActionOverdue(a.due_date, a.status));
  const highRisks = risks.filter((r) => isRiskHighOrCritical(r.impact) && isRiskOpen(r.status));
  const openQueries = discovery_questions.filter((q) => q.status === "Awaiting Response" || q.status === "Open" || q.status === "Awaiting Business" || q.status === "Awaiting Development");
  const upcomingDeliverables = deliverables.filter((d) => d.planned_completion_date && d.planned_completion_date >= todayStr && d.planned_completion_date <= in7DaysStr && !isDeliverableComplete(d));
  const upcomingMilestones = milestones.filter((m) => m.target_date && m.target_date >= todayStr && m.target_date <= in7DaysStr && m.status !== "Complete");

  // Development
  const inProgressDel = deliverables.filter((d) => d.status !== "Not Started" && d.status !== "Deployed" && d.status !== "Blocked");
  const blockedDel = deliverables.filter((d) => isDeliverableBlocked(d));

  // Testing
  const totalTests = test_cases.length;
  const passedTests = test_cases.filter((t) => isTestPassed(t.status)).length;
  const failedTests = test_cases.filter((t) => t.status === "Failed").length;
  const blockedTests = test_cases.filter((t) => t.status === "Blocked").length;
  const pendingTests = test_cases.filter((t) => t.status === "Pending").length;

  // Governance
  const openDecisions = decisions.filter((d) => isDecisionOpen(d.status));
  const openDependencies = dependencies.filter((d) => isDependencyOpen(d.status));

  // Build priorities (returned for top-3 aggregation)
  const priorities: Array<{ label: string; score: number }> = [];
  if (overdueActions.length > 0) priorities.push({ label: `${overdueActions.length} overdue action${overdueActions.length > 1 ? "s" : ""} — ${overdueActions[0].description.slice(0, 60)}`, score: 100 + overdueActions.length });
  highRisks.forEach((r) => priorities.push({ label: `${r.impact} risk: ${r.description.slice(0, 70)}`, score: r.impact === "Critical" ? 90 : 80 }));
  upcomingMilestones.forEach((m) => { const d = m.target_date ? daysFromNow(m.target_date, now) : 99; priorities.push({ label: `Milestone due in ${d}d: ${m.title}`, score: 70 - d }); });

  // HTML
  const projectHeader = `<div style="background:#1e293b;color:#fff;padding:16px 24px;border-top:3px solid #3b82f6;margin-top:16px"><strong style="font-size:15px">${escapeHtml(project.name)}</strong> &nbsp; ${healthBadge(project.health)}</div>`;

  const summaryHtml = `<table style="border-collapse:collapse"><tr>
    ${kpiCell("Progress", `${progressPct}%`, `${doneDel}/${totalDel} deployed`)}
    ${kpiCell("Go-Live", daysLabel, goLive.date ?? undefined)}
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
    allAC.some((ac) => ac.requirement_id === r.id && isAcceptanceCriteriaFailed(ac.status)),
  ).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);
  const signOffReadyReqs = scoped.requirements.filter((r) => {
    const acs = allAC.filter((ac) => ac.requirement_id === r.id);
    return acs.length > 0 && acs.every((ac) => isAcceptanceCriteriaMet(ac.status));
  }).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);
  const acHtml = allAC.length === 0
    ? `<p style="margin:0;color:#94a3b8;font-size:13px">No acceptance criteria recorded.</p>`
    : [
        `<table style="border-collapse:collapse;font-size:13px;margin-bottom:8px"><tr>
          <td style="padding:4px 20px 4px 0"><span style="color:#64748b">Total</span> <strong>${allAC.length}</strong></td>
          <td style="padding:4px 20px 4px 0"><span style="color:#16a34a">Met</span> <strong>${allAC.filter((ac) => ac.status === "Met").length}</strong></td>
          <td style="padding:4px 20px 4px 0"><span style="color:#dc2626">Failed</span> <strong>${allAC.filter((ac) => isAcceptanceCriteriaFailed(ac.status)).length}</strong></td>
          <td style="padding:4px 20px 4px 0"><span style="color:#64748b">Outstanding</span> <strong>${allAC.filter((ac) => !["Met", "Waived", "Failed"].includes(ac.status)).length}</strong></td>
        </tr></table>`,
        failedACReqs.length ? `<p style="margin:4px 0;font-size:12px;font-weight:700;color:#dc2626">Requirements with failed criteria:</p>${briefList(failedACReqs, "")}` : "",
        signOffReadyReqs.length ? `<p style="margin:8px 0 4px;font-size:12px;font-weight:700;color:#16a34a">Requirements ready for sign-off:</p>${briefList(signOffReadyReqs, "")}` : "",
      ].join("");

  if (failedACReqs.length > 0) priorities.push({ label: `${failedACReqs.length} requirement(s) with failed acceptance criteria`, score: 95 });

  // Sign-off & Evidence (Part 5)
  const allSignOffs = scoped.requirement_sign_offs ?? [];
  const allEvidence = scoped.evidence ?? [];

  const awaitingSignOffReqs = scoped.requirements.filter((r) =>
    allSignOffs.some((s) => s.requirement_id === r.id && s.status === "Pending"),
  ).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);

  const missingEvidenceReqs = scoped.requirements.filter((r) => {
    const acs = allAC.filter((ac) => ac.requirement_id === r.id);
    return acs.length > 0 && acs.every((ac) => !allEvidence.some((ev) => ev.ac_id === ac.id));
  }).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);

  const failedGateReqs = scoped.requirements.filter((r) => {
    const acs = allAC.filter((ac) => ac.requirement_id === r.id);
    const hasFailedAC = acs.some((ac) => isAcceptanceCriteriaFailed(ac.status));
    const noEvidence = acs.length > 0 && acs.every((ac) => !allEvidence.some((ev) => ev.ac_id === ac.id));
    return hasFailedAC || noEvidence;
  }).map((r) => `${r.requirement_ref}: ${r.title.slice(0, 70)}`);

  const readinessHtmlParts: string[] = [];
  if (awaitingSignOffReqs.length > 0) {
    readinessHtmlParts.push(`<p style="margin:4px 0;font-size:12px;font-weight:700;color:#d97706">Awaiting sign-off (${awaitingSignOffReqs.length}):</p>${briefList(awaitingSignOffReqs, "")}`);
    priorities.push({ label: `${awaitingSignOffReqs.length} requirement(s) awaiting sign-off`, score: 88 });
  }
  if (missingEvidenceReqs.length > 0) {
    readinessHtmlParts.push(`<p style="margin:8px 0 4px;font-size:12px;font-weight:700;color:#7c3aed">Missing evidence (${missingEvidenceReqs.length}):</p>${briefList(missingEvidenceReqs, "")}`);
    priorities.push({ label: `${missingEvidenceReqs.length} requirement(s) missing evidence`, score: 75 });
  }
  if (failedGateReqs.length > 0) {
    readinessHtmlParts.push(`<p style="margin:8px 0 4px;font-size:12px;font-weight:700;color:#dc2626">Failed readiness gates (${failedGateReqs.length}):</p>${briefList(failedGateReqs, "")}`);
  }
  const readinessHtml = readinessHtmlParts.length > 0
    ? readinessHtmlParts.join("")
    : `<p style="margin:0;color:#16a34a;font-size:13px">No sign-off or evidence gaps.</p>`;

  // Meeting Intelligence (Part 10)
  const projectMeetings = (scoped.meeting_intelligence ?? [])
    .sort((a, b) => (b.meeting_date ?? "").localeCompare(a.meeting_date ?? ""));
  const yesterdayStr = toDateStr(new Date(now.getTime() - 86_400_000));
  const meetingsYesterday = projectMeetings.filter((m) => m.meeting_date === yesterdayStr);
  const pendingSuggestionCount = (scoped.meeting_suggestions ?? []).filter(
    (s) => s.status === "Pending",
  ).length;
  const meetingHtmlParts: string[] = [];
  if (meetingsYesterday.length > 0) {
    meetingHtmlParts.push(
      `<p style="margin:4px 0;font-size:13px">${meetingsYesterday.length} meeting${meetingsYesterday.length > 1 ? "s" : ""} analysed yesterday: ${meetingsYesterday.map((m) => m.title).join(", ")}</p>`,
    );
  }
  if (pendingSuggestionCount > 0) {
    meetingHtmlParts.push(
      `<p style="margin:4px 0;font-size:13px;font-weight:700;color:#d97706">${pendingSuggestionCount} suggested update${pendingSuggestionCount > 1 ? "s" : ""} awaiting review</p>`,
    );
    priorities.push({ label: `${pendingSuggestionCount} meeting suggestion(s) pending review`, score: 70 });
  }
  const meetingHtml = meetingHtmlParts.length > 0
    ? meetingHtmlParts.join("")
    : `<p style="margin:0;color:#6b7280;font-size:13px">No meeting intelligence activity.</p>`;

  const html = [
    projectHeader,
    briefSection("Project Summary", summaryHtml),
    briefSection("Today's Attention", attentionHtml),
    briefSection("Development", briefList(devItems, "No deliverables in progress.")),
    briefSection("Testing", testHtml),
    briefSection("Acceptance Criteria", acHtml),
    briefSection("Sign-off & Evidence", readinessHtml),
    briefSection("Governance", briefList(govItems, "No open decisions or dependencies.")),
    briefSection("Meeting Intelligence", meetingHtml),
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
    const state = buildProjectState(data, project, now);
    const block = buildProjectBriefSection(state, todayStr, in7DaysStr);
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
  const topFailingCriteria = allAC.filter((ac) => isAcceptanceCriteriaFailed(ac.status)).slice(0, 5)
    .map((ac) => `${ac.ac_ref}: ${ac.criterion.slice(0, 80)}`);
  const reqsAwaitingAcceptance = data.requirements.filter((r) => {
    const acs = allAC.filter((ac) => ac.requirement_id === r.id);
    return acs.length > 0 && acs.some((ac) => !isAcceptanceCriteriaMet(ac.status));
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

// ── Test Status Email (manual, project-scoped) ──────────────────────────────
//
// Deliberately manual-only — no cron/scheduled path calls this. Reuses the
// ONE canonical verification calculation (lib/lifecycle/test-verification.ts)
// rather than re-deriving requirement/AC verification here, and scopes to
// the caller's explicit `project` via scopeProjectData() — never
// selectActiveProject(), never inferred by name, so this works identically
// for PL10, CR028, or any future project.

function subjectDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/London" }).format(date);
}

function reportLongDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(date);
}

// Semantic status colours — darker shades than the app's -500 palette so
// they stay legible on white paper and in greyscale print. Every badge also
// carries its status word (and a symbol), so colour is never the only cue.
const TEST_STATUS_STYLE: Record<string, { color: string; symbol: string }> = {
  Passed: { color: "#15803d", symbol: "✓" },
  Failed: { color: "#b91c1c", symbol: "✕" },
  Blocked: { color: "#b91c1c", symbol: "■" },
  "In Progress": { color: "#1d4ed8", symbol: "◐" },
  Pending: { color: "#475569", symbol: "○" },
};

const VERIFICATION_STYLE: Record<VerificationState, string> = {
  Verified: "#15803d",
  Testing: "#b45309",
  "Test Failure": "#b91c1c",
  "Testing Blocked": "#b91c1c",
  "No Tests Linked": "#64748b",
};

const VERIFICATION_DISPLAY_ORDER: VerificationState[] = ["Verified", "Testing", "Test Failure", "Testing Blocked", "No Tests Linked"];

const REPORT_CSS = `
body{margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%}
table{border-collapse:collapse}
.nw{white-space:nowrap}
.wrap{overflow-wrap:anywhere;word-break:normal}
@media (max-width:620px){.sheet{padding:18px 16px!important}.kpi td{display:inline-block!important;width:25%!important;box-sizing:border-box;margin-bottom:8px}.kpi .nw{white-space:normal!important}.vs td{display:inline-block!important;width:33%!important;box-sizing:border-box;margin-bottom:8px}.c-ac{display:none!important}.ac-m{display:block!important}.c-ref{width:58px!important}.c-st{width:84px!important}}
@page{size:A4;margin:14mm 12mm}
@media print{
  body{background:#fff!important}
  .page{max-width:none!important;padding:0!important}
  .sheet{border:0!important;padding:0!important}
  .keep,.proc,tr,.kpi,.vs,.exc{break-inside:avoid;page-break-inside:avoid}
  .rh,.gh{break-after:avoid;page-break-after:avoid}
  thead{display:table-header-group}
  .appendix{break-before:page;page-break-before:always}
  .badge,.bar td,.exc{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}`;

function statusBadge(status: string) {
  const s = TEST_STATUS_STYLE[status] ?? { color: "#475569", symbol: "•" };
  return `<span class="badge nw" style="display:inline-block;white-space:nowrap;padding:1px 8px;border:1px solid ${s.color};border-radius:10px;color:${s.color};font-size:11px;font-weight:700;line-height:16px">${s.symbol} ${escapeHtml(status)}</span>`;
}

function refHtml(ref: string, weight = 600) {
  return `<span class="nw" style="white-space:nowrap;font-weight:${weight}">${escapeHtml(ref)}</span>`;
}

function refListHtml(refs: string[]) {
  return refs.length ? refs.map((r) => refHtml(r, 400)).join(", ") : `<span style="color:#94a3b8">—</span>`;
}

function reportSection(title: string, body: string, className = "") {
  return `<section class="rs ${className}" style="margin-top:26px"><h2 class="rh" style="margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#334155">${escapeHtml(title)}</h2>${body}</section>`;
}

function kpiTile(label: string, value: string, accent: string, sub?: string) {
  return `<td style="padding:0 6px 0 0;vertical-align:top"><div style="border-left:3px solid ${accent};padding:4px 0 4px 8px"><div class="nw" style="font-size:10px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;white-space:nowrap">${escapeHtml(label)}</div><div style="font-size:24px;line-height:30px;font-weight:700;color:${accent === "#cbd5e1" ? "#0f172a" : accent}">${escapeHtml(value)}</div>${sub ? `<div class="nw" style="font-size:11px;color:#64748b;white-space:nowrap">${escapeHtml(sub)}</div>` : `<div style="font-size:11px">&nbsp;</div>`}</div></td>`;
}

// Current timeline phase (e.g. "System Testing") as report context. Display
// only — the earliest-starting In Progress timeline item, omitted entirely
// when the project has none. Never inferred from free text.
function currentPhaseName(timeline: { phase_name: string; status: string; start_date: string }[]): string | null {
  const active = timeline.filter((t) => t.status === "In Progress" && t.phase_name?.trim()).sort((a, b) => a.start_date.localeCompare(b.start_date));
  return active[0]?.phase_name.trim() ?? null;
}

export type TestStatusReportOptions = {
  /**
   * Append the Detailed Test Procedures appendix (objective, steps and
   * recorded result per test). Off by default so the emailed report — and
   * the preview of it — stays concise; the Print / PDF view turns it on.
   * The main report is rendered identically either way.
   */
  includeProcedures?: boolean;
};

export function buildTestStatusEmail(data: DataStore, project: Project, now = new Date(), options: TestStatusReportOptions = {}): EmailContent {
  const includeProcedures = options.includeProcedures === true;
  const scoped = scopeProjectData(data, project);
  const tests = [...scoped.test_cases].sort((a, b) => REF_COLLATOR.compare(a.test_ref, b.test_ref));
  const verification = computeTestVerification(scoped);
  const stateSummary = summarizeVerificationStates(verification);
  const grouped = groupTestsByRequirement(scoped.requirements, tests, verification);
  const acTitles = new Map((scoped.acceptance_criteria ?? []).map((ac) => [ac.ac_ref, ac.criterion] as const));
  const reqTitles = new Map(scoped.requirements.map((r) => [r.requirement_ref, r.title] as const));
  const parsed = new Map(tests.map((t) => [t.id, parseTestScenario(t.scenario)] as const));
  const titleOf = (t: TestCase) => parsed.get(t.id)?.title ?? "—";
  const phaseName = currentPhaseName(scoped.timeline_items ?? []);

  const total = tests.length;
  const passed = tests.filter((t) => isTestPassed(t.status)).length;
  const failed = tests.filter((t) => t.status === "Failed").length;
  const blocked = tests.filter((t) => t.status === "Blocked").length;
  const pending = tests.filter((t) => t.status === "Pending").length;
  const inProgress = tests.filter((t) => t.status === "In Progress").length;
  // Executed = Passed + Failed (lib/lifecycle/test-case.ts's existing
  // RESOLVED_TEST_STATUSES/isTestClosed) — Pending, In Progress and Blocked
  // are all still open, not a successfully-executed outcome either way.
  const executed = tests.filter((t) => isTestClosed(t.status)).length;
  const executionPct = total > 0 ? Math.round((executed / total) * 100) : 0;

  const requirementCount = scoped.requirements.length;
  const exceptions = tests.filter((t) => t.status === "Failed" || t.status === "Blocked");
  const reqRefsFor = (t: TestCase) => grouped.requirementRefsByTest.get(t.id) ?? [];
  const acRefsFor = (t: TestCase) => [...new Set(grouped.groups.flatMap((g) => g.rows.filter((r) => r.test.id === t.id).flatMap((r) => r.acRefs)))].sort((a, b) => REF_COLLATOR.compare(a, b));

  // Open (Pending / In Progress) tests per requirement — shown as neutral
  // context, never as defects.
  const openByRequirement = grouped.groups
    .map((g) => ({ ref: g.requirementRef, open: g.rows.filter((r) => r.test.status === "Pending" || r.test.status === "In Progress").length }))
    .filter((x) => x.open > 0);
  const unlinkedOpen = grouped.unlinkedTests.filter((t) => t.status === "Pending" || t.status === "In Progress").length;
  const openTotal = pending + inProgress;
  const openAreas = [...openByRequirement.map((x) => `${x.ref} (${x.open})`), ...(unlinkedOpen ? [`Unlinked (${unlinkedOpen})`] : [])];

  // ── HTML ───────────────────────────────────────────────────────────────
  const generated = subjectDateTime(now);
  const metaParts = [project.customer?.trim() || null, reportLongDate(now)].filter(Boolean) as string[];
  const header = `<header class="keep" style="padding-bottom:14px;border-bottom:2px solid #0f172a"><table role="presentation" width="100%"><tr>
    <td style="vertical-align:bottom">
      ${project.project_ref ? `<div class="nw" style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:#2563eb;white-space:nowrap">${escapeHtml(project.project_ref)}</div>` : ""}
      <div style="margin-top:2px;font-size:20px;line-height:26px;font-weight:700;color:#0f172a">${escapeHtml(project.name)}</div>
      <div style="margin-top:8px;font-size:15px;font-weight:600;color:#334155">Test Status Report${phaseName ? ` <span style="font-weight:400;color:#64748b">· ${escapeHtml(phaseName)}</span>` : ""}</div>
      <div style="margin-top:2px;font-size:12px;color:#64748b">${metaParts.map(escapeHtml).join(" · ")}</div>
    </td>
    <td class="nw" style="vertical-align:bottom;text-align:right;white-space:nowrap;font-size:11px;color:#64748b">Generated<br><span style="color:#334155">${escapeHtml(generated)}</span></td>
  </tr></table></header>`;

  const summaryHtml = `<table role="presentation" class="kpi" width="100%" style="table-layout:fixed"><tr>
    ${kpiTile("Total", String(total), "#cbd5e1")}
    ${kpiTile("Executed", String(executed), "#cbd5e1", `of ${total}`)}
    ${kpiTile("Passed", String(passed), passed ? TEST_STATUS_STYLE.Passed.color : "#cbd5e1")}
    ${kpiTile("Failed", String(failed), failed ? TEST_STATUS_STYLE.Failed.color : "#cbd5e1")}
    ${kpiTile("Blocked", String(blocked), blocked ? TEST_STATUS_STYLE.Blocked.color : "#cbd5e1")}
    ${kpiTile("In Progress", String(inProgress), inProgress ? TEST_STATUS_STYLE["In Progress"].color : "#cbd5e1")}
    ${kpiTile("Pending", String(pending), "#cbd5e1")}
    ${kpiTile("Execution", `${executionPct}%`, "#cbd5e1")}
  </tr></table><div style="margin-top:6px;font-size:11px;color:#64748b">Executed = Passed + Failed. Blocked, In Progress and Pending tests are not yet executed.</div>`;

  const verificationStates = VERIFICATION_DISPLAY_ORDER.filter((state) => state in stateSummary);
  const barCells = verificationStates
    .filter((state) => stateSummary[state] > 0)
    .map((state) => `<td title="${escapeHtml(state)}" style="width:${(stateSummary[state] / Math.max(requirementCount, 1)) * 100}%;height:8px;padding:0;background:${VERIFICATION_STYLE[state]};border-right:2px solid #fff"></td>`)
    .join("");
  const verificationHtml = requirementCount > 0
    ? `<div class="keep"><div style="font-size:13px;color:#334155;margin-bottom:6px"><strong style="color:#0f172a">${stateSummary.Verified} of ${requirementCount}</strong> requirements verified by linked tests</div>
      <table role="presentation" class="bar" width="100%" style="table-layout:fixed;margin-bottom:12px"><tr>${barCells}</tr></table>
      <table role="presentation" class="vs" width="100%" style="table-layout:fixed"><tr>${verificationStates.map((state) => {
        const count = stateSummary[state];
        const color = count > 0 ? VERIFICATION_STYLE[state] : "#94a3b8";
        return `<td style="vertical-align:top;padding-right:8px"><div style="border-top:1px solid #e2e8f0;padding-top:6px"><span style="font-size:20px;font-weight:700;color:${count > 0 ? "#0f172a" : "#94a3b8"}">${count}</span><div class="nw" style="font-size:11px;font-weight:700;color:${color};white-space:nowrap"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color};margin-right:5px;-webkit-print-color-adjust:exact;print-color-adjust:exact"></span>${escapeHtml(state)}</div></div></td>`;
      }).join("")}</tr></table></div>`
    : `<p style="margin:0;color:#64748b;font-size:13px">No requirements recorded for this project.</p>`;

  const exceptionRows = exceptions.map((t) => {
    const reqs = reqRefsFor(t);
    const reason = t.actual_result?.trim() || "No result or reason recorded.";
    return `<tr><td style="padding:8px 10px 8px 0;border-top:1px solid #fecaca;vertical-align:top">${refHtml(t.test_ref, 700)}</td>
      <td class="wrap" style="padding:8px 10px 8px 0;border-top:1px solid #fecaca;vertical-align:top;font-size:13px;color:#0f172a">${escapeHtml(titleOf(t))}<div style="margin-top:2px;font-size:11px;color:#64748b">Requirement: ${reqs.length ? reqs.map((r) => `${refHtml(r, 400)} ${escapeHtml(reqTitles.get(r) ?? "")}`).join("; ") : "—"}${acRefsFor(t).length ? ` · AC: ${refListHtml(acRefsFor(t))}` : ""}</div><div style="margin-top:4px;font-size:12px;color:#7f1d1d">${escapeHtml(reason)}</div></td>
      <td style="padding:8px 0;border-top:1px solid #fecaca;vertical-align:top;text-align:right">${statusBadge(t.status)}</td></tr>`;
  }).join("");
  const exceptionsCore = exceptions.length > 0
    ? `<div class="exc" style="border:1px solid #fecaca;border-left:4px solid #b91c1c;background:#fef2f2;border-radius:4px;padding:12px 14px"><div style="font-size:14px;font-weight:700;color:#991b1b;margin-bottom:6px">${failed} failed · ${blocked} blocked — ${exceptions.length === 1 ? "1 test needs" : `${exceptions.length} tests need`} attention</div><table role="presentation" width="100%">${exceptionRows}</table></div>`
    : `<p style="margin:0;font-size:14px;color:#15803d"><strong>✓</strong> No failed or blocked tests.</p>`;
  const openNote = openTotal > 0
    ? `<p style="margin:10px 0 0;font-size:12px;color:#475569"><strong style="color:#334155">Awaiting execution:</strong> ${openTotal} ${openTotal === 1 ? "test is" : "tests are"} pending or in progress${openAreas.length ? ` — ${openAreas.map(escapeHtml).join(", ")}` : ""}. These are open, not defects.</p>`
    : "";
  const exceptionsHtml = exceptionsCore + openNote;

  function testRowHtml(row: { test: TestCase; acRefs: string[]; alsoUnder: string[] }): string {
    const t = row.test;
    const acInline = row.acRefs.length ? `<div class="ac-m" style="display:none;margin-top:2px;font-size:11px;color:#64748b">AC: ${refListHtml(row.acRefs)}</div>` : "";
    const also = row.alsoUnder.length ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">Also under ${row.alsoUnder.map((r) => refHtml(r, 400)).join(", ")}</div>` : "";
    return `<tr>
      <td class="c-ref" style="width:72px;padding:6px 10px 6px 0;border-top:1px solid #f1f5f9;vertical-align:top;font-size:13px">${refHtml(t.test_ref)}</td>
      <td class="wrap" style="padding:6px 10px 6px 0;border-top:1px solid #f1f5f9;vertical-align:top;font-size:13px;color:#1e293b">${escapeHtml(titleOf(t))}${acInline}${also}</td>
      <td class="c-ac" style="width:92px;padding:6px 10px 6px 0;border-top:1px solid #f1f5f9;vertical-align:top;font-size:12px;color:#475569">${refListHtml(row.acRefs)}</td>
      <td class="c-st" style="width:98px;padding:6px 0;border-top:1px solid #f1f5f9;vertical-align:top;text-align:right">${statusBadge(t.status)}</td>
    </tr>`;
  }

  function groupHtml(ref: string | null, title: string, tally: string, stateLabel: string, stateColor: string, rows: string, rowCount: number): string {
    return `<div class="grp${rowCount <= 12 ? " keep" : ""}" style="margin-top:18px">
      <table role="presentation" class="gh" width="100%"><tr>
        <td style="vertical-align:bottom;padding-bottom:4px">${ref ? `<span class="nw" style="white-space:nowrap;font-size:12px;font-weight:700;color:#2563eb;margin-right:8px">${escapeHtml(ref)}</span>` : ""}<span style="font-size:14px;font-weight:700;color:#0f172a">${escapeHtml(title)}</span></td>
        <td class="nw" style="vertical-align:bottom;padding-bottom:4px;text-align:right;white-space:nowrap;font-size:12px;color:#475569">${escapeHtml(tally)}${stateLabel ? ` · <span style="font-weight:700;color:${stateColor}">${escapeHtml(stateLabel)}</span>` : ""}</td>
      </tr></table>
      <table role="presentation" width="100%" style="table-layout:fixed">${rows}</table>
    </div>`;
  }

  const groupsHtml = grouped.groups.map((g) => groupHtml(
    g.requirementRef, g.requirementTitle, `${g.passed} / ${g.testCount} passed`,
    g.state, VERIFICATION_STYLE[g.state],
    g.rows.map(testRowHtml).join(""), g.rows.length,
  )).join("");
  const unlinkedHtml = grouped.unlinkedTests.length
    ? groupHtml(null, "Not linked to a requirement", `${grouped.unlinkedTests.filter((t) => isTestPassed(t.status)).length} / ${grouped.unlinkedTests.length} passed`, "", "",
      grouped.unlinkedTests.map((t) => testRowHtml({ test: t, acRefs: [], alsoUnder: [] })).join(""), grouped.unlinkedTests.length)
    : "";
  const untestedHtml = grouped.untestedRequirements.length && total > 0
    ? `<p style="margin:16px 0 0;font-size:12px;color:#64748b"><strong style="color:#475569">No tests linked:</strong> ${grouped.untestedRequirements.map((r) => `${refHtml(r.requirementRef, 600)} ${escapeHtml(r.requirementTitle)}`).join("; ")}</p>`
    : "";
  const fullStatusHtml = total > 0
    ? `<div style="font-size:12px;color:#64748b">Grouped by requirement. A test linked to several requirements is listed under each.</div>${groupsHtml}${unlinkedHtml}${untestedHtml}`
    : `<p style="margin:0;color:#64748b;font-size:14px">No test cases recorded for this project.</p>`;

  const proceduresHtml = !includeProcedures ? "" : tests.map((t) => {
    const p = parsed.get(t.id)!;
    const steps = splitSteps(p.steps);
    const reqs = reqRefsFor(t);
    const acs = acRefsFor(t);
    const result = t.actual_result?.trim();
    return `<div class="proc" style="padding:10px 0;border-top:1px solid #e2e8f0">
      <table role="presentation" width="100%"><tr><td style="vertical-align:top;font-size:13px">${refHtml(t.test_ref, 700)} <span style="color:#334155">${escapeHtml(p.title)}</span></td><td style="width:98px;vertical-align:top;text-align:right">${statusBadge(t.status)}</td></tr></table>
      <div style="margin-top:3px;font-size:11px;color:#64748b">Requirement: ${refListHtml(reqs)} · AC: ${refListHtml(acs)}</div>
      <div class="wrap" style="margin-top:6px;font-size:12px;color:#334155"><span style="color:#64748b">Objective:</span> ${escapeHtml(p.objective)}</div>
      ${steps.length ? `<div style="margin-top:4px;font-size:12px;color:#64748b">Steps:</div><ol class="wrap" style="margin:2px 0 0;padding-left:20px;font-size:12px;color:#334155">${steps.map((s) => `<li style="margin:0 0 2px">${escapeHtml(s)}</li>`).join("")}</ol>` : ""}
      ${result ? `<div class="wrap" style="margin-top:4px;font-size:12px;color:#334155"><span style="color:#64748b">Recorded result:</span> ${escapeHtml(result)}</div>` : ""}
    </div>`;
  }).join("");
  const appendixHtml = includeProcedures && total > 0
    ? reportSection("Appendix — Detailed Test Procedures", `<div style="font-size:12px;color:#64748b;margin-bottom:4px">Full objective, steps and recorded result for each test, in reference order.</div>${proceduresHtml}`, "appendix")
    : "";

  const footer = `<footer style="margin-top:28px;padding-top:10px;border-top:1px solid #e2e8f0;text-align:center;font-size:11px;color:#94a3b8">Project Manager · Test Status Report · Generated ${escapeHtml(generated)}</footer>`;

  const docTitle = `${project.project_ref ?? project.name} Test Status Report`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(docTitle)}</title><style>${REPORT_CSS}</style></head><body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,Helvetica,sans-serif"><div class="page" style="max-width:780px;margin:0 auto;padding:24px 12px"><div class="sheet" style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:28px 32px">${header}${reportSection("Executive Test Summary", summaryHtml, "keep")}${reportSection("Requirement Verification Summary", verificationHtml)}${reportSection("Exceptions & Attention", exceptionsHtml)}${reportSection("Full Test Status", fullStatusHtml)}${appendixHtml}${footer}</div></div></body></html>`;

  // ── Plain text ─────────────────────────────────────────────────────────
  const acText = (refs: string[]) => refs.length ? refs.map((ref) => `${ref}: ${acTitles.get(ref) ?? ref}`).join("; ") : "—";
  const reqText = (refs: string[]) => refs.length ? refs.map((ref) => `${ref}: ${reqTitles.get(ref) ?? ref}`).join("; ") : "—";

  const verificationText = requirementCount > 0
    ? `${verificationStates.map((state) => `${state}: ${stateSummary[state]}`).join("\n")}\n(${stateSummary.Verified} of ${requirementCount} requirements verified)`
    : "No requirements recorded for this project.";

  const exceptionsText = [
    exceptions.length > 0
      ? exceptions.map((t) => `${t.test_ref} — ${titleOf(t)} — ${t.status} — Requirement: ${reqText(reqRefsFor(t))} — AC: ${acText(acRefsFor(t))} — Reason: ${t.actual_result?.trim() || "No result or reason recorded."}`).join("\n")
      : "No failed or blocked tests.",
    openTotal > 0 ? `Awaiting execution: ${openTotal} ${openTotal === 1 ? "test is" : "tests are"} pending or in progress${openAreas.length ? ` — ${openAreas.join(", ")}` : ""}. These are open, not defects.` : "",
  ].filter(Boolean).join("\n");

  const rowText = (t: TestCase, acRefs: string[]) => `${t.test_ref} — ${titleOf(t)} — ${t.status} — AC: ${acRefs.length ? acRefs.join(", ") : "—"}`;
  const fullStatusText = total > 0
    ? [
      ...grouped.groups.map((g) => `${g.requirementRef} — ${g.requirementTitle} — ${g.passed}/${g.testCount} passed — ${g.state}\n${g.rows.map((r) => rowText(r.test, r.acRefs)).join("\n")}`),
      grouped.unlinkedTests.length ? `Not linked to a requirement\n${grouped.unlinkedTests.map((t) => rowText(t, [])).join("\n")}` : "",
      grouped.untestedRequirements.length ? `No tests linked: ${grouped.untestedRequirements.map((r) => `${r.requirementRef} ${r.requirementTitle}`).join("; ")}` : "",
    ].filter(Boolean).join("\n\n")
    : "No test cases recorded for this project.";

  const proceduresText = !includeProcedures ? "" : tests.map((t) => {
    const p = parsed.get(t.id)!;
    const steps = splitSteps(p.steps);
    return [
      `[${t.test_ref}] ${p.title} (${t.status})`,
      `Requirement: ${reqRefsFor(t).join(", ") || "—"} | AC: ${acRefsFor(t).join(", ") || "—"}`,
      `Objective: ${p.objective}`,
      steps.length ? `Steps:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}` : "",
      t.actual_result?.trim() ? `Recorded result: ${t.actual_result.trim()}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const text = [
    `${project.project_ref ?? project.name} — TEST STATUS REPORT`,
    project.project_ref ? project.name : "",
    [...metaParts, phaseName ? `Current phase: ${phaseName}` : ""].filter(Boolean).join(" · "),
    `Generated ${generated}`,
    `${"=".repeat(60)}`,
    `EXECUTIVE TEST SUMMARY`,
    `Total: ${total}\nExecuted: ${executed} (${executionPct}%)\nPassed: ${passed}\nFailed: ${failed}\nBlocked: ${blocked}\nIn Progress: ${inProgress}\nPending: ${pending}`,
    `REQUIREMENT VERIFICATION SUMMARY\n${verificationText}`,
    `EXCEPTIONS & ATTENTION\n${exceptionsText}`,
    `FULL TEST STATUS (grouped by requirement)\n${fullStatusText}`,
    includeProcedures && total > 0 ? `APPENDIX — DETAILED TEST PROCEDURES\n${proceduresText}` : "",
    `Project Manager · Test Status Report · Generated ${generated}`,
  ].filter(Boolean).join("\n\n");

  return {
    subject: `[${project.project_ref || project.name}] Test Status - ${subjectDate(now)}`,
    html,
    text,
  };
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
    const dashboard = buildProjectState(data, project, now).goLive;
    const alerts: string[] = [];
    if (dashboard.status === "Red") alerts.push(`${project.name}: Go-live readiness is RED (${dashboard.readinessPercent}%).`);
    if (dashboard.daysToGoLive !== null && dashboard.daysToGoLive < 0) alerts.push(`${project.name}: Go-live date has passed — delayed.`);
    if (dashboard.checks.some((c) => c.key === "customer_approval" && c.effective === "Incomplete")) alerts.push(`${project.name}: Customer approval is missing.`);
    if (dashboard.openCriticalRisks > 0 && dashboard.daysToGoLive !== null && dashboard.daysToGoLive <= 14) alerts.push(`${project.name}: ${dashboard.openCriticalRisks} critical risk${dashboard.openCriticalRisks > 1 ? "s" : ""} open within ${dashboard.daysToGoLive} days of go-live.`);
    return alerts;
  });

  const redCount = report.projects.filter((p) => p.status === "Red").length;
  const amberCount = report.projects.filter((p) => p.status === "Amber").length;
  const notAssessedCount = report.projects.filter((p) => p.status === "Not Assessed").length;
  const actionCount = report.requiresAction.length;

  const intro = report.projects.length === 0
    ? "No active projects found."
    : actionCount > 0
      ? `${actionCount} ${actionCount === 1 ? "project requires" : "projects require"} management action. ${redCount > 0 ? `${redCount} Red. ` : ""}${amberCount > 0 ? `${amberCount} Amber.` : ""}`.trim()
      : notAssessedCount > 0
        ? `All assessed projects are on track. ${notAssessedCount} ${notAssessedCount === 1 ? "project has" : "projects have"} no delivery evidence recorded yet and ${notAssessedCount === 1 ? "is" : "are"} not yet assessed.`
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
