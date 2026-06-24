import type { DataStore } from "@/lib/data-store";
import { deliverableDaysUntil, isDeliverableComplete, isDevelopmentComplete, isSitComplete, isUatComplete } from "@/lib/delivery";
import { scopeProjectData } from "@/lib/project-scope";
import { calculateSchedule, formatScheduleDate, parseScheduleDate } from "@/lib/schedule";
import type { AuditLog, Project, ProjectSnapshot } from "@/lib/types";
import { isOverdue } from "@/lib/utils";

export type IntelligenceCategory = "Schedule" | "Risk" | "Governance" | "Delivery" | "Testing" | "Stakeholder";
export type IntelligenceSeverity = "Info" | "Warning" | "Critical";
export type IntelligenceTrend = "Increasing" | "Decreasing" | "Stable" | "Insufficient history";

export type IntelligenceFinding = {
  id: string;
  ruleId: string;
  projectId: string;
  category: IntelligenceCategory;
  severity: IntelligenceSeverity;
  title: string;
  detail: string;
  evidence: string;
  confidence: number;
  recommendation: string | null;
};

export type IntelligenceReport = {
  project: Project;
  generatedAt: Date;
  findings: IntelligenceFinding[];
  critical: IntelligenceFinding[];
  warnings: IntelligenceFinding[];
  recommendations: IntelligenceFinding[];
  positiveSignals: IntelligenceFinding[];
  averageConfidence: number;
  trend: { direction: IntelligenceTrend; currentPressure: number | null; previousPressure: number | null; detail: string };
  categoryCounts: Record<IntelligenceCategory, number>;
};

export type IntelligenceRuleDefinition = { id: string; category: IntelligenceCategory; sources: string[] };

export const INTELLIGENCE_SOURCES = ["requirements", "risks", "decisions", "actions", "discovery_questions", "milestones", "timeline_items", "deliverables", "test_cases", "project_snapshots", "activity_log", "meetings", "go_live_checklists"] as const;

export const INTELLIGENCE_RULES: IntelligenceRuleDefinition[] = [
  { id: "SCH-001", category: "Schedule", sources: ["timeline_items"] },
  { id: "SCH-002", category: "Schedule", sources: ["timeline_items", "project_snapshots"] },
  { id: "SCH-003", category: "Schedule", sources: ["projects", "timeline_items"] },
  { id: "SCH-004", category: "Schedule", sources: ["project_snapshots"] },
  { id: "RSK-001", category: "Risk", sources: ["risks"] },
  { id: "RSK-002", category: "Risk", sources: ["risks"] },
  { id: "RSK-003", category: "Risk", sources: ["risks", "project_snapshots"] },
  { id: "GOV-001", category: "Governance", sources: ["decisions"] },
  { id: "GOV-002", category: "Governance", sources: ["discovery_questions"] },
  { id: "GOV-003", category: "Governance", sources: ["milestones"] },
  { id: "GOV-004", category: "Governance", sources: ["requirements"] },
  { id: "DEL-001", category: "Delivery", sources: ["requirements", "milestones", "timeline_items"] },
  { id: "DEL-002", category: "Delivery", sources: ["timeline_items", "test_cases"] },
  { id: "DEL-003", category: "Delivery", sources: ["milestones"] },
  { id: "DEL-004", category: "Delivery", sources: ["actions"] },
  { id: "DLM-001", category: "Delivery", sources: ["deliverables"] },
  { id: "DLM-002", category: "Delivery", sources: ["deliverables"] },
  { id: "DLM-003", category: "Testing", sources: ["deliverables"] },
  { id: "DLM-004", category: "Testing", sources: ["deliverables"] },
  { id: "DLM-005", category: "Delivery", sources: ["deliverables"] },
  { id: "TST-001", category: "Testing", sources: ["test_cases"] },
  { id: "TST-002", category: "Testing", sources: ["test_cases"] },
  { id: "TST-003", category: "Testing", sources: ["milestones", "test_cases"] },
  { id: "STK-001", category: "Stakeholder", sources: ["activity_log"] },
  { id: "STK-002", category: "Stakeholder", sources: ["meetings"] },
  { id: "POS-SCH", category: "Schedule", sources: ["timeline_items"] },
  { id: "POS-RSK", category: "Risk", sources: ["risks"] },
  { id: "POS-GOV", category: "Governance", sources: ["requirements"] },
  { id: "POS-STK", category: "Stakeholder", sources: ["activity_log"] },
  { id: "POS-TST", category: "Testing", sources: ["test_cases"] },
  { id: "GLR-001", category: "Delivery", sources: ["go_live_checklists", "milestones"] },
  { id: "GLR-002", category: "Delivery", sources: ["go_live_checklists"] },
  { id: "GLR-003", category: "Delivery", sources: ["go_live_checklists"] },
  { id: "GLR-004", category: "Delivery", sources: ["go_live_checklists"] },
  { id: "GLR-005", category: "Risk", sources: ["go_live_checklists", "risks"] },
  { id: "GLR-006", category: "Delivery", sources: ["go_live_checklists"] },
];

const DAY_MS = 86_400_000;
const severityRank: Record<IntelligenceSeverity, number> = { Critical: 3, Warning: 2, Info: 1 };

function dateOnlyMs(value: Date) {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
}

function ageInDays(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor((dateOnlyMs(now) - dateOnlyMs(parsed)) / DAY_MS);
}

function daysUntil(value: string | null | undefined, now: Date) {
  const parsed = parseScheduleDate(value);
  return parsed ? Math.ceil((parsed.getTime() - dateOnlyMs(now)) / DAY_MS) : null;
}

function pressure(snapshot: ProjectSnapshot) {
  return snapshot.open_risks * 2
    + snapshot.overdue_actions * 3
    + snapshot.overdue_decisions * 3
    + snapshot.open_questions
    + Math.max(0, -snapshot.schedule_variance) / 5;
}

function trendFromSnapshots(snapshots: ProjectSnapshot[]) {
  const ordered = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const current = ordered.at(-1);
  const previous = ordered.at(-2);
  if (!current || !previous) return { direction: "Insufficient history" as const, currentPressure: current ? pressure(current) : null, previousPressure: null, detail: "At least two daily snapshots are required to determine intelligence direction." };
  const currentPressure = Math.round(pressure(current) * 10) / 10;
  const previousPressure = Math.round(pressure(previous) * 10) / 10;
  const delta = Math.round((currentPressure - previousPressure) * 10) / 10;
  const direction: IntelligenceTrend = delta > 0 ? "Increasing" : delta < 0 ? "Decreasing" : "Stable";
  return { direction, currentPressure, previousPressure, detail: `Delivery pressure moved from ${previousPressure} to ${currentPressure} between ${previous.snapshot_date} and ${current.snapshot_date}.` };
}

function finding(project: Project, ruleId: string, category: IntelligenceCategory, severity: IntelligenceSeverity, title: string, detail: string, evidence: string, confidence: number, recommendation: string | null): IntelligenceFinding {
  return { id: `${project.id}-${ruleId}-${title}`, ruleId, projectId: project.id, category, severity, title, detail, evidence, confidence, recommendation };
}

export function buildProjectIntelligence(data: DataStore, project: Project, now = new Date(), auditEntries: AuditLog[] = []): IntelligenceReport {
  const scoped = scopeProjectData(data, project);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);
  const findings: IntelligenceFinding[] = [];
  const add = (...args: Parameters<typeof finding>) => findings.push(finding(...args));
  const snapshots = [...scoped.project_snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const latest = snapshots.at(-1);
  const previous = snapshots.at(-2);
  const activePhase = schedule.active[0] ?? schedule.atRisk[0] ?? schedule.blocked[0] ?? null;

  if (!activePhase) add(project, "SCH-001", "Schedule", "Critical", "No active phase detected", "The schedule has no phase marked In Progress, At Risk, or Blocked.", `${scoped.timeline_items.length} timeline phases were analysed.`, scoped.timeline_items.length ? 96 : 82, "Assign the current delivery phase and update its progress.");
  if (activePhase && snapshots.length >= 2) {
    const baseline = [...snapshots].reverse().find((item) => (ageInDays(item.snapshot_date, new Date(`${latest!.snapshot_date}T12:00:00Z`)) ?? 0) >= 7);
    if (baseline && latest?.active_phase === baseline.active_phase && latest.progress_percent <= baseline.progress_percent) add(project, "SCH-002", "Schedule", "Warning", "Active phase progress appears unchanged for 7 days", `${activePhase.phase_name} remains active while overall recorded progress has not increased.`, `Progress was ${baseline.progress_percent}% on ${baseline.snapshot_date} and ${latest.progress_percent}% on ${latest.snapshot_date}.`, 78, `Update ${activePhase.phase_name} progress or record the blocker preventing movement.`);
  }
  if (schedule.daysRemaining !== null && schedule.daysRemaining <= 14 && schedule.daysRemaining >= 0 && (schedule.actualProgress ?? 0) < 70) add(project, "SCH-003", "Schedule", "Critical", "Project end date is approaching with low progress", `${schedule.daysRemaining} days remain, but actual schedule progress is ${schedule.actualProgress ?? 0}%.`, `Target end date is ${formatScheduleDate(schedule.projectEnd)}.`, 94, "Replan remaining phases and agree a recovery path before the target date.");
  if (latest && previous && latest.schedule_variance < previous.schedule_variance) add(project, "SCH-004", "Schedule", latest.schedule_variance <= -11 ? "Critical" : "Warning", "Schedule variance is worsening", `Schedule variance deteriorated by ${Math.abs(Math.round((latest.schedule_variance - previous.schedule_variance) * 10) / 10)} points.`, `${previous.schedule_variance}% on ${previous.snapshot_date}; ${latest.schedule_variance}% on ${latest.snapshot_date}.`, 98, "Review phase estimates and agree corrective actions for the deteriorating schedule.");

  const highRisks = scoped.risks.filter((item) => ["High", "Critical"].includes(item.impact) && !["Complete", "Closed"].includes(item.status));
  highRisks.filter((item) => !item.mitigation?.trim()).forEach((item) => add(project, "RSK-001", "Risk", "Critical", `${item.risk_ref} has no mitigation`, item.description, `${item.impact} impact / ${item.probability} probability.`, 100, `Define and assign mitigation for ${item.risk_ref}.`));
  highRisks.filter((item) => (ageInDays(item.updated_at, now) ?? 0) >= 14).forEach((item) => add(project, "RSK-002", "Risk", "Warning", `${item.risk_ref} has not changed for 14 days`, item.description, `Last updated ${ageInDays(item.updated_at, now)} days ago.`, 92, `Review ${item.risk_ref} with ${item.owner || "the project team"} and confirm its current exposure.`));
  if (latest && previous && latest.open_risks > previous.open_risks) add(project, "RSK-003", "Risk", "Warning", "Open risk count is increasing", `Open risks increased from ${previous.open_risks} to ${latest.open_risks}.`, `Snapshot comparison: ${previous.snapshot_date} to ${latest.snapshot_date}.`, 99, "Review newly opened risks and confirm mitigation owners.");

  const openDecisions = scoped.decisions.filter((item) => !["Approved", "Closed"].includes(item.status));
  if (openDecisions.length && openDecisions.every((item) => (ageInDays(item.updated_at, now) ?? 0) >= 7)) add(project, "GOV-001", "Governance", "Warning", "Open decisions have not been reviewed recently", `${openDecisions.length} open decisions have no update in the last 7 days.`, `Oldest update is ${Math.max(...openDecisions.map((item) => ageInDays(item.updated_at, now) ?? 0))} days old.`, 90, `Review ${openDecisions[0].decision_ref} and the remaining open decision log.`);
  scoped.discovery_questions.filter((item) => isOverdue(item.due_date, item.status)).forEach((item) => add(project, "GOV-002", "Governance", "Warning", `${item.question_ref} is overdue`, item.question, `Due ${formatScheduleDate(item.due_date)}; status ${item.status}.`, 100, `Obtain an answer or revise the due date for ${item.question_ref}.`));
  scoped.milestones.filter((item) => !item.owner?.trim()).forEach((item) => add(project, "GOV-003", "Governance", "Warning", `${item.milestone_ref} has no owner`, item.title, `Target ${formatScheduleDate(item.target_date)}.`, 100, `Assign an accountable owner to ${item.milestone_ref}.`));
  const ownerlessRequirements = scoped.requirements.filter((item) => !item.owner?.trim() && item.status !== "Complete");
  if (ownerlessRequirements.length) add(project, "GOV-004", "Governance", "Warning", "Requirements are missing owners", `${ownerlessRequirements.length} incomplete requirements have no accountable owner.`, ownerlessRequirements.slice(0, 3).map((item) => item.requirement_ref).join(", "), 100, "Assign owners to incomplete requirements before sign-off.");

  const developmentActive = scoped.timeline_items.find((item) => item.status === "In Progress" && /develop/i.test(item.phase_name));
  const requirementsSignedOff = scoped.requirements.length > 0 && scoped.requirements.every((item) => ["Approved", "Complete", "Closed"].includes(item.status));
  if (developmentActive && !requirementsSignedOff) add(project, "DEL-001", "Delivery", "Critical", "Development started without requirements sign-off", `${developmentActive.phase_name} is active while requirements remain incomplete.`, `${scoped.requirements.filter((item) => !["Approved", "Complete", "Closed"].includes(item.status)).length} requirements are not signed off.`, 97, "Complete requirements sign-off or formally accept the delivery risk.");
  const testingScheduled = scoped.timeline_items.some((item) => /test|uat|sit/i.test(item.phase_name));
  if (testingScheduled && !scoped.test_cases.length) add(project, "DEL-002", "Delivery", "Critical", "Testing is scheduled but test cases are missing", "The timeline contains testing work without a supporting test inventory.", `${scoped.timeline_items.filter((item) => /test|uat|sit/i.test(item.phase_name)).length} testing phases were found.`, 99, "Create test cases before the testing phase begins.");
  scoped.milestones.filter((item) => item.status === "Not Started" && (daysUntil(item.target_date, now) ?? 99) >= 0 && (daysUntil(item.target_date, now) ?? 99) <= 7).forEach((item) => add(project, "DEL-003", "Delivery", "Warning", `${item.milestone_ref} is approaching without progress`, `${item.title} is still Not Started.`, `Target date ${formatScheduleDate(item.target_date)}.`, 100, `Confirm readiness and next actions for ${item.milestone_ref}.`));
  const overdueActions = scoped.actions.filter((item) => isOverdue(item.due_date, item.status));
  if (overdueActions.length) add(project, "DEL-004", "Delivery", overdueActions.length >= 3 ? "Critical" : "Warning", "Delivery actions are overdue", `${overdueActions.length} ${overdueActions.length === 1 ? "action is" : "actions are"} past the agreed due date.`, overdueActions.map((item) => `${item.action_ref} (${formatScheduleDate(item.due_date)})`).join(", "), 100, `Complete or replan ${overdueActions[0].action_ref}${overdueActions.length > 1 ? " and the remaining overdue actions" : ""}.`);

  scoped.deliverables.filter((item) => !isDeliverableComplete(item) && (deliverableDaysUntil(item.planned_completion_date, now) ?? 99) >= 0 && (deliverableDaysUntil(item.planned_completion_date, now) ?? 99) <= 7).forEach((item) => add(project, "DLM-001", "Delivery", "Warning", `${item.deliverable_ref} is approaching its target date`, `${item.title} is due ${formatScheduleDate(item.planned_completion_date)} and is currently ${item.status}.`, `${deliverableDaysUntil(item.planned_completion_date, now)} days remain; owner ${item.owner || "unassigned"}.`, 100, `Confirm the completion plan and dependencies for ${item.deliverable_ref}.`));
  scoped.deliverables.filter((item) => item.status === "Blocked" || [item.development_status, item.sit_status, item.uat_status, item.deployment_status].includes("Blocked")).forEach((item) => add(project, "DLM-002", "Delivery", "Critical", `${item.deliverable_ref} is blocked`, item.title, `Overall ${item.status}; development ${item.development_status}; SIT ${item.sit_status}; UAT ${item.uat_status}; deployment ${item.deployment_status}.`, 100, `Resolve and record the blocker for ${item.deliverable_ref}.`));
  scoped.deliverables.filter((item) => (["Ready for SIT", "SIT Complete"].includes(item.status) || ["Ready", "In Progress", "Passed"].includes(item.sit_status)) && !isDevelopmentComplete(item)).forEach((item) => add(project, "DLM-003", "Testing", "Critical", `${item.deliverable_ref} is entering SIT before development is complete`, item.title, `Development status is ${item.development_status}; SIT status is ${item.sit_status}.`, 100, `Complete development evidence before ${item.deliverable_ref} enters SIT.`));
  scoped.deliverables.filter((item) => (["Ready for UAT", "UAT Complete"].includes(item.status) || ["Ready", "In Progress", "Passed"].includes(item.uat_status)) && !isSitComplete(item)).forEach((item) => add(project, "DLM-004", "Testing", "Critical", `${item.deliverable_ref} is entering UAT before SIT is complete`, item.title, `SIT status is ${item.sit_status}; UAT status is ${item.uat_status}.`, 100, `Complete SIT evidence before ${item.deliverable_ref} enters UAT.`));
  scoped.deliverables.filter((item) => {
    const approachingWithoutReadiness = !isDeliverableComplete(item) && (deliverableDaysUntil(item.planned_completion_date, now) ?? 99) <= 7 && !["Ready for Deployment", "Deployed"].includes(item.status);
    const deploymentWithoutUat = ["Ready", "Scheduled", "Deployed"].includes(item.deployment_status) && !isUatComplete(item);
    return approachingWithoutReadiness || deploymentWithoutUat;
  }).forEach((item) => add(project, "DLM-005", "Delivery", "Warning", `${item.deliverable_ref} is not deployment ready`, `${item.title} is approaching completion but remains ${item.status}.`, `UAT ${item.uat_status}; deployment ${item.deployment_status}.`, 96, `Confirm UAT and deployment readiness for ${item.deliverable_ref}.`));

  if (!scoped.test_cases.length) add(project, "TST-001", "Testing", "Critical", "No tests have been created", "The project has no test cases recorded.", "Test case count is 0.", 100, "Create a minimum test inventory covering the accepted requirements.");
  const pendingTests = scoped.test_cases.filter((item) => ["Pending", "In Progress"].includes(item.status));
  if (scoped.test_cases.length >= 3 && pendingTests.length / scoped.test_cases.length >= 0.7) add(project, "TST-002", "Testing", "Warning", "Most test cases remain pending", `${pendingTests.length} of ${scoped.test_cases.length} tests are Pending or In Progress.`, `${scoped.test_cases.filter((item) => item.status === "Passed").length} tests have passed.`, 100, "Agree test execution dates and owners for the pending inventory.");
  const uatMilestone = scoped.milestones.find((item) => /uat/i.test(item.title) && item.status !== "Complete" && (daysUntil(item.target_date, now) ?? 99) >= 0 && (daysUntil(item.target_date, now) ?? 99) <= 14);
  if (uatMilestone && !scoped.test_cases.some((item) => item.status === "Passed")) add(project, "TST-003", "Testing", "Critical", "UAT is approaching without completed tests", `${uatMilestone.title} is due ${formatScheduleDate(uatMilestone.target_date)}.`, "No test case currently has Passed status.", 99, "Complete prerequisite testing and confirm UAT entry criteria.");

  const newestActivity = [...scoped.activity_log].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!newestActivity || (ageInDays(newestActivity.created_at, now) ?? 99) >= 7) add(project, "STK-001", "Stakeholder", "Warning", "No project activity has been logged recently", newestActivity ? "The latest activity is more than 7 days old." : "No activity entries exist for this project.", newestActivity ? `Latest entry: ${newestActivity.activity_type}, ${ageInDays(newestActivity.created_at, now)} days ago.` : "Activity log count is 0.", newestActivity ? 94 : 100, "Record the latest project update and management decisions.");
  const recentMeeting = scoped.meetings.some((item) => (ageInDays(item.meeting_date, now) ?? 99) <= 14);
  if (!recentMeeting) add(project, "STK-002", "Stakeholder", "Warning", "No meeting has been recorded in 14 days", "Stakeholder engagement may not be visible in the control record.", `${scoped.meetings.length} meetings were analysed.`, scoped.meetings.length ? 92 : 86, "Record the latest governance meeting or schedule the next project review.");

  if (schedule.health === "Green") add(project, "POS-SCH", "Schedule", "Info", "Schedule health is Green", "Actual schedule progress is on or ahead of plan.", `Variance is ${schedule.variance ?? 0}%.`, 98, null);
  if (highRisks.length && highRisks.every((item) => Boolean(item.mitigation?.trim()))) add(project, "POS-RSK", "Risk", "Info", "All high risks have mitigation", `${highRisks.length} high or critical risks include mitigation actions.`, highRisks.map((item) => item.risk_ref).join(", "), 100, null);
  if (scoped.requirements.length && scoped.requirements.every((item) => Boolean(item.owner?.trim()))) add(project, "POS-GOV", "Governance", "Info", "All requirements have owners", `${scoped.requirements.length} requirements have accountable owners.`, "Requirement ownership coverage is 100%.", 100, null);
  if (newestActivity && (ageInDays(newestActivity.created_at, now) ?? 99) < 7) add(project, "POS-STK", "Stakeholder", "Info", "Project activity is current", "A project update has been recorded within the last 7 days.", `${newestActivity.activity_type}: ${newestActivity.description}`, 96, null);
  if (scoped.test_cases.some((item) => item.status === "Passed")) add(project, "POS-TST", "Testing", "Info", "Test execution has produced passed cases", `${scoped.test_cases.filter((item) => item.status === "Passed").length} test cases have passed.`, "Testing progress is evidenced in the test inventory.", 100, null);

  // ── Go-Live Readiness rules ───────────────────────────────────────────────────
  const goLiveChecklists = (data.go_live_checklists ?? []).filter((c) => c.project_id === project.id);
  if (goLiveChecklists.length > 0) {
    const goLiveMilestone = scoped.milestones.find((m) => /go.?live/i.test(m.title));
    const goLiveDate = goLiveMilestone?.target_date ?? project.planned_end_date;
    const daysToGoLive = daysUntil(goLiveDate, now);

    // GLR-001: UAT incomplete within 7 days of go-live
    const uatItems = goLiveChecklists.filter((c) => c.category === "UAT" || /uat/i.test(c.item));
    const uatIncomplete = uatItems.some((c) => !["Complete", "Waived"].includes(c.status));
    if (uatIncomplete && daysToGoLive !== null && daysToGoLive <= 7 && daysToGoLive >= 0) {
      add(project, "GLR-001", "Delivery", "Critical", "UAT is incomplete within 7 days of go-live",
        `Go-live is in ${daysToGoLive} day${daysToGoLive === 1 ? "" : "s"} and UAT has not been signed off.`,
        `UAT checklist items: ${uatItems.map((c) => c.item).join(", ") || "none recorded"}.`,
        100, "Complete UAT sign-off or escalate to delay go-live.");
    }

    // GLR-002: Rollback plan missing
    const rollbackItems = goLiveChecklists.filter((c) => c.category === "Rollback" || /rollback/i.test(c.item));
    const rollbackMissing = rollbackItems.length === 0 || rollbackItems.every((c) => c.status === "Not Started");
    if (rollbackMissing) {
      add(project, "GLR-002", "Delivery", "Critical", "No rollback plan has been recorded",
        "Go-live readiness requires an approved rollback plan. None has been recorded.",
        `${goLiveChecklists.length} checklist items exist; none are categorised as Rollback.`,
        97, "Create and approve a rollback plan before go-live.");
    }

    // GLR-003: Hypercare owner missing
    const hypercareItems = goLiveChecklists.filter((c) => c.category === "Hypercare" || /hypercare/i.test(c.item));
    const hypercareMissing = hypercareItems.length === 0 || hypercareItems.some((c) => !c.owner?.trim() && c.status !== "Waived");
    if (hypercareMissing) {
      add(project, "GLR-003", "Delivery", "Warning", "Hypercare owner has not been assigned",
        "A named hypercare owner is required before go-live to ensure post-deployment support.",
        "Hypercare checklist items have no owner recorded.",
        95, "Assign a named hypercare owner and confirm coverage hours.");
    }

    // GLR-004: Customer approval missing
    const approvalItems = goLiveChecklists.filter((c) => c.category === "Customer Approval" || /customer.*approval|approval.*customer/i.test(c.item));
    const approvalMissing = approvalItems.length === 0 || approvalItems.every((c) => !["Complete", "Waived"].includes(c.status));
    if (approvalMissing) {
      add(project, "GLR-004", "Delivery", "Critical", "Customer approval has not been completed",
        "Go-live should not proceed without documented customer sign-off.",
        `${approvalItems.length} customer approval items recorded; none are Complete or Waived.`,
        100, "Obtain customer sign-off or formally document a waiver.");
    }

    // GLR-005: Critical risk open before go-live (cross-reference with risk register)
    const openCriticalRisks = scoped.risks.filter((r) => !["Complete", "Closed"].includes(r.status) && r.impact === "Critical");
    if (openCriticalRisks.length > 0 && daysToGoLive !== null && daysToGoLive <= 14) {
      add(project, "GLR-005", "Risk", "Critical", `${openCriticalRisks.length} critical risk${openCriticalRisks.length > 1 ? "s" : ""} open within ${daysToGoLive} days of go-live`,
        "Critical risks must be mitigated or accepted before go-live proceeds.",
        openCriticalRisks.slice(0, 3).map((r) => `${r.risk_ref}: ${r.description}`).join("; "),
        100, "Resolve or formally accept all critical risks with management sign-off.");
    }

    // GLR-006: Training incomplete
    const trainingItems = goLiveChecklists.filter((c) => c.category === "Training" || /training/i.test(c.item));
    const trainingIncomplete = trainingItems.length === 0 || trainingItems.some((c) => !["Complete", "Waived"].includes(c.status));
    if (trainingIncomplete && daysToGoLive !== null && daysToGoLive <= 14) {
      add(project, "GLR-006", "Delivery", "Warning", "Training is incomplete within 14 days of go-live",
        "Warehouse and user training must be complete before go-live to ensure operational readiness.",
        `${trainingItems.filter((c) => !["Complete", "Waived"].includes(c.status)).length} training items outstanding.`,
        93, "Complete outstanding training or confirm a waiver with the business.");
    }
  }

  // ── Audit-based intelligence rules ───────────────────────────────────────────
  if (auditEntries.length) {
    const projectAudit = auditEntries.filter((e) => e.project_id === project.id);
    const cutoff7d = new Date(now.getTime() - 7 * 86_400_000).toISOString();

    // AUD-001: Multiple date changes in 7 days
    const recentDateChanges = projectAudit.filter((e) => e.action_type === "Date Change" && e.changed_at >= cutoff7d);
    if (recentDateChanges.length >= 3) {
      add(project, "AUD-001", "Schedule", "Warning",
        "Repeated date changes suggest unstable planning",
        `${recentDateChanges.length} date changes recorded in the last 7 days.`,
        `Dates have been moved on: ${[...new Set(recentDateChanges.map((e) => e.entity_name))].slice(0, 3).join(", ")}.`,
        85,
        "Review the planning baseline and agree firm dates before continuing delivery.");
    }

    // AUD-002: Frequent health changes (≥2 in 7 days)
    const recentHealthChanges = projectAudit.filter((e) => e.action_type === "Health Change" && e.changed_at >= cutoff7d);
    if (recentHealthChanges.length >= 2) {
      const directions = recentHealthChanges.map((e) => `${e.old_value ?? "—"} → ${e.new_value ?? "—"}`);
      add(project, "AUD-002", "Risk", "Warning",
        "Project health is fluctuating — possible instability",
        `Health changed ${recentHealthChanges.length} times in 7 days.`,
        `Changes: ${directions.slice(0, 3).join("; ")}.`,
        88,
        "Stabilise the underlying issues driving health changes before the next management review.");
    }

    // AUD-003: Risk repeatedly escalated to High / Critical
    const riskEscalations = projectAudit.filter((e) =>
      e.action_type === "Severity Change" &&
      e.entity_type === "risks" &&
      ["High", "Critical"].includes(e.new_value ?? "") &&
      e.changed_at >= cutoff7d,
    );
    const escalatedRisks = [...new Set(riskEscalations.map((e) => e.entity_name))];
    if (escalatedRisks.length >= 2) {
      add(project, "AUD-003", "Risk", "Critical",
        "Multiple risks escalated to High or Critical this week",
        `${escalatedRisks.length} distinct risks have been escalated in the last 7 days.`,
        `Risks: ${escalatedRisks.slice(0, 3).join(", ")}.`,
        93,
        "Convene a risk review meeting and agree mitigation actions for all escalated risks.");
    }

    // AUD-004: Excessive schedule movement (≥3 schedule_variance changes in 7 days)
    const scheduleChanges = projectAudit.filter((e) => e.action_type === "Schedule Change" && e.changed_at >= cutoff7d);
    if (scheduleChanges.length >= 3) {
      add(project, "AUD-004", "Schedule", "Warning",
        "Schedule variance has been adjusted repeatedly",
        `Schedule variance changed ${scheduleChanges.length} times in 7 days — baseline may be unstable.`,
        scheduleChanges.slice(0, 2).map((e) => `${e.old_value ?? "—"} → ${e.new_value ?? "—"}`).join("; "),
        82,
        "Lock the schedule baseline and track changes through a formal change control process.");
    }
  }

  findings.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.confidence - a.confidence || a.ruleId.localeCompare(b.ruleId));
  const actionable = findings.filter((item) => item.severity !== "Info");
  const categories: IntelligenceCategory[] = ["Schedule", "Risk", "Governance", "Delivery", "Testing", "Stakeholder"];
  return {
    project,
    generatedAt: now,
    findings,
    critical: findings.filter((item) => item.severity === "Critical"),
    warnings: findings.filter((item) => item.severity === "Warning"),
    recommendations: actionable.filter((item) => item.recommendation),
    positiveSignals: findings.filter((item) => item.severity === "Info"),
    averageConfidence: actionable.length ? Math.round(actionable.reduce((total, item) => total + item.confidence, 0) / actionable.length) : 100,
    trend: trendFromSnapshots(snapshots),
    categoryCounts: Object.fromEntries(categories.map((category) => [category, actionable.filter((item) => item.category === category).length])) as Record<IntelligenceCategory, number>,
  };
}

export function intelligenceEngineValidation() {
  const covered = new Set(INTELLIGENCE_RULES.flatMap((rule) => rule.sources));
  const missingSources = INTELLIGENCE_SOURCES.filter((source) => !covered.has(source));
  const duplicateRuleIds = INTELLIGENCE_RULES.map((rule) => rule.id).filter((id, index, values) => values.indexOf(id) !== index);
  return { valid: missingSources.length === 0 && duplicateRuleIds.length === 0, ruleCount: INTELLIGENCE_RULES.length, sourceCount: INTELLIGENCE_SOURCES.length, missingSources, duplicateRuleIds };
}
