import type { DataStore } from "@/lib/data-store";
import { scopeProjectData, selectCanonicalProjects } from "@/lib/project-scope";
import { calculateSchedule, formatScheduleDate } from "@/lib/schedule";
import { isOverdue } from "@/lib/utils";
import type { Project } from "@/lib/types";

export type ManagerRagStatus = "Green" | "Amber" | "Red";
export type DateConfidence = "On Track" | "At Risk" | "Delayed";
export type ManagementAction = "Required" | "Not Required";

export type ManagerProjectSummary = {
  project: Project;
  status: ManagerRagStatus;
  summary: string;
  attentionRequired: string | null;
  dateConfidence: DateConfidence;
  managementAction: ManagementAction;
};

export type ManagerExceptionReport = {
  generatedAt: Date;
  projects: ManagerProjectSummary[];
  requiresAction: ManagerProjectSummary[];
};

// ── Classification ────────────────────────────────────────────────────────────

function classifyProject(data: DataStore, project: Project, now: Date): ManagerProjectSummary {
  const scoped = scopeProjectData(data, project);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);

  // Key signals
  const criticalRisks = scoped.risks.filter(
    (r) => r.impact === "Critical" && !["Complete", "Closed"].includes(r.status),
  );
  const unmitgatedCritical = criticalRisks.filter((r) => !r.mitigation?.trim());
  const highRisks = scoped.risks.filter(
    (r) => r.impact === "High" && !["Complete", "Closed"].includes(r.status),
  );
  const blockedDeliverables = scoped.deliverables.filter(
    (d) => d.status === "Blocked" || [d.development_status, d.sit_status, d.uat_status, d.deployment_status].includes("Blocked"),
  );
  const overdueDecisions = scoped.decisions.filter((d) => isOverdue(d.due_date, d.status));
  const overdueActions = scoped.actions.filter((a) => isOverdue(a.due_date, a.status));
  const scheduleVariance = schedule.variance ?? 0;
  const daysRemaining = schedule.daysRemaining;
  const isComplete = project.status === "Complete" || project.status === "Closed";

  // ── RED conditions ──
  const isRed =
    !isComplete && (
      unmitgatedCritical.length > 0 ||
      (daysRemaining !== null && daysRemaining < 0) ||
      (scheduleVariance <= -15 && daysRemaining !== null && daysRemaining < 30) ||
      (blockedDeliverables.length > 0 && criticalRisks.length > 0)
    );

  // ── AMBER conditions ──
  const isAmber =
    !isRed &&
    !isComplete && (
      blockedDeliverables.length > 0 ||
      overdueDecisions.length > 0 ||
      (scheduleVariance < -5) ||
      schedule.health === "Amber" ||
      (highRisks.length > 0 && highRisks.some((r) => !r.mitigation?.trim())) ||
      (overdueActions.length >= 3)
    );

  const ragStatus: ManagerRagStatus = isRed ? "Red" : isAmber ? "Amber" : "Green";

  // ── Date confidence ──
  let dateConfidence: DateConfidence;
  if (isComplete || (daysRemaining === null)) {
    dateConfidence = "On Track";
  } else if (daysRemaining < 0 || scheduleVariance <= -15) {
    dateConfidence = "Delayed";
  } else if (scheduleVariance < -5 || schedule.health === "Amber") {
    dateConfidence = "At Risk";
  } else {
    dateConfidence = "On Track";
  }

  const managementAction: ManagementAction =
    isRed || unmitgatedCritical.length > 0 || (overdueDecisions.length > 0 && ragStatus !== "Green")
      ? "Required"
      : "Not Required";

  // ── Summary (max 3 sentences, plain English, no % or PM jargon) ──
  const summary = buildSummary(project, scoped, schedule, ragStatus, {
    criticalRisks,
    unmitgatedCritical,
    blockedDeliverables,
    overdueDecisions,
    overdueActions,
    daysRemaining,
    isComplete,
  });

  // ── Attention Required ──
  const attention = buildAttention({
    criticalRisks,
    unmitgatedCritical,
    blockedDeliverables,
    overdueDecisions,
    overdueActions,
    ragStatus,
  });

  return {
    project,
    status: ragStatus,
    summary,
    attentionRequired: attention,
    dateConfidence,
    managementAction,
  };
}

type SignalBag = {
  criticalRisks: ReturnType<typeof scopeProjectData>["risks"];
  unmitgatedCritical: ReturnType<typeof scopeProjectData>["risks"];
  blockedDeliverables: ReturnType<typeof scopeProjectData>["deliverables"];
  overdueDecisions: ReturnType<typeof scopeProjectData>["decisions"];
  overdueActions: ReturnType<typeof scopeProjectData>["actions"];
  daysRemaining: number | null;
  isComplete: boolean;
};

function buildSummary(
  project: Project,
  scoped: ReturnType<typeof scopeProjectData>,
  schedule: ReturnType<typeof calculateSchedule>,
  rag: ManagerRagStatus,
  signals: SignalBag,
): string {
  const sentences: string[] = [];
  const { criticalRisks, blockedDeliverables, overdueDecisions, overdueActions, daysRemaining, isComplete } = signals;

  if (isComplete) {
    sentences.push(`${project.name} is complete.`);
    return sentences.join(" ");
  }

  // Sentence 1 — overall status driver
  if (rag === "Red") {
    if (signals.unmitgatedCritical.length > 0) {
      sentences.push(`The project has ${signals.unmitgatedCritical.length === 1 ? "a critical risk" : `${signals.unmitgatedCritical.length} critical risks`} without a mitigation plan in place.`);
    } else if (daysRemaining !== null && daysRemaining < 0) {
      sentences.push(`The target delivery date has passed and the project is ${Math.abs(daysRemaining)} ${Math.abs(daysRemaining) === 1 ? "day" : "days"} overdue.`);
    } else if (blockedDeliverables.length > 0 && criticalRisks.length > 0) {
      sentences.push(`Delivery is blocked and a critical risk is preventing progress.`);
    } else {
      sentences.push(`The project is significantly behind and the delivery date is at serious risk.`);
    }
  } else if (rag === "Amber") {
    if (blockedDeliverables.length > 0) {
      sentences.push(`${blockedDeliverables.length === 1 ? "One deliverable is" : `${blockedDeliverables.length} deliverables are`} currently blocked and need to be resolved before testing can continue.`);
    } else if (overdueDecisions.length > 0) {
      sentences.push(`${overdueDecisions.length === 1 ? "A decision is" : `${overdueDecisions.length} decisions are`} overdue and ${overdueDecisions.length === 1 ? "is" : "are"} holding up the team.`);
    } else if ((schedule.variance ?? 0) < -5) {
      const target = schedule.projectEnd ? ` against a target of ${formatScheduleDate(schedule.projectEnd)}` : "";
      sentences.push(`The project is running behind schedule${target} and needs to recover.`);
    } else {
      sentences.push(`The project is progressing but has items that need management attention.`);
    }
  } else {
    const activePhase = schedule.active[0] ?? schedule.atRisk[0];
    if (activePhase) {
      sentences.push(`The project is on track${schedule.projectEnd ? ` for ${formatScheduleDate(schedule.projectEnd)}` : ""}, currently in the ${activePhase.phase_name} phase.`);
    } else if (daysRemaining !== null && daysRemaining >= 0) {
      sentences.push(`The project is on track with ${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} remaining.`);
    } else {
      sentences.push(`The project is on track and no management action is required.`);
    }
  }

  // Sentence 2 — secondary concern or positive
  if (rag !== "Green" && overdueActions.length > 0 && blockedDeliverables.length === 0) {
    sentences.push(`${overdueActions.length} ${overdueActions.length === 1 ? "action is" : "actions are"} overdue and need to be closed or replanned.`);
  } else if (rag === "Green" && scoped.milestones.length > 0) {
    const nextMilestone = [...scoped.milestones]
      .filter((m) => m.status !== "Complete" && m.target_date)
      .sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)))[0];
    if (nextMilestone) {
      sentences.push(`The next milestone is ${nextMilestone.title}${nextMilestone.target_date ? `, due ${formatScheduleDate(nextMilestone.target_date)}` : ""}.`);
    }
  }

  // Sentence 3 — recommended action or deadline
  if (rag === "Red") {
    if (signals.unmitgatedCritical.length > 0) {
      sentences.push(`Immediate escalation and mitigation planning is required.`);
    } else {
      sentences.push(`Recovery planning and a revised delivery date are needed without delay.`);
    }
  } else if (rag === "Amber" && overdueDecisions.length > 0) {
    const d = overdueDecisions[0];
    sentences.push(`${d.decision_ref} — "${d.question.length > 60 ? d.question.slice(0, 57) + "…" : d.question}" — needs a decision.`);
  }

  return sentences.slice(0, 3).join(" ");
}

type AttentionSignals = Pick<SignalBag, "criticalRisks" | "unmitgatedCritical" | "blockedDeliverables" | "overdueDecisions" | "overdueActions"> & { ragStatus: ManagerRagStatus };

function buildAttention({ unmitgatedCritical, blockedDeliverables, overdueDecisions, ragStatus }: AttentionSignals): string | null {
  if (ragStatus === "Green") return null;
  const items: string[] = [];
  if (unmitgatedCritical.length > 0) {
    items.push(`Mitigate ${unmitgatedCritical.length === 1 ? "critical risk" : `${unmitgatedCritical.length} critical risks`}: ${unmitgatedCritical.map((r) => r.risk_ref).join(", ")}`);
  }
  if (overdueDecisions.length > 0) {
    items.push(`Approve overdue ${overdueDecisions.length === 1 ? "decision" : "decisions"}: ${overdueDecisions.map((d) => d.decision_ref).join(", ")}`);
  }
  if (blockedDeliverables.length > 0) {
    items.push(`Unblock ${blockedDeliverables.length === 1 ? "deliverable" : "deliverables"}: ${blockedDeliverables.map((d) => d.deliverable_ref).join(", ")}`);
  }
  return items.length ? items.join("; ") : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildManagerExceptionReport(data: DataStore, now = new Date()): ManagerExceptionReport {
  const projects = selectCanonicalProjects(data)
    .filter((p) => !["Complete", "Closed"].includes(p.status))
    .map((p) => classifyProject(data, p, now));

  // Include complete projects briefly if all active are clean
  const complete = selectCanonicalProjects(data)
    .filter((p) => ["Complete", "Closed"].includes(p.status))
    .map((p) => classifyProject(data, p, now));

  const all = [...projects, ...complete];

  return {
    generatedAt: now,
    projects: all,
    requiresAction: all.filter((p) => p.managementAction === "Required"),
  };
}
