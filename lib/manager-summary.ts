import type { DataStore } from "@/lib/data-store";
import { isDecisionOverdue, isDeliverableBlocked, isRiskOpen } from "@/lib/lifecycle";
import { materialAcceptanceCriteriaFailures, materialTestFailures } from "@/lib/delivery-materiality";
import { deriveProjectPhase, type ProjectPhase } from "@/lib/project-phase";
import { resolveGoLiveDate } from "@/lib/project-dates";
import { scopeProjectData, selectCanonicalProjects } from "@/lib/project-scope";
import { calculateSchedule, formatScheduleDate } from "@/lib/schedule";
import { isOverdue } from "@/lib/utils";
import type { AcceptanceCriteria, Deliverable, Project, TestCase } from "@/lib/types";

const DAY_MS = 86_400_000;

function daysUntil(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const date = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.ceil((date.getTime() - today.getTime()) / DAY_MS);
}

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

// Exported so lib/project-state.ts can classify a single, explicit project
// directly — the same function buildManagerExceptionReport already uses
// per-project internally, not a second implementation of the RAG rule.
export function classifyProject(data: DataStore, project: Project, now: Date): ManagerProjectSummary {
  const scoped = scopeProjectData(data, project);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);
  const phase = deriveProjectPhase(data, project, now);
  const goLive = resolveGoLiveDate(data, project);
  const daysToGoLive = daysUntil(goLive.date, now);

  // Key signals
  const criticalRisks = scoped.risks.filter(
    (r) => r.impact === "Critical" && isRiskOpen(r.status),
  );
  const unmitgatedCritical = criticalRisks.filter((r) => !r.mitigation?.trim());
  const highRisks = scoped.risks.filter(
    (r) => r.impact === "High" && isRiskOpen(r.status),
  );
  const blockedDeliverables = scoped.deliverables.filter((d) => isDeliverableBlocked(d));
  const blockedCriticalDeliverables = blockedDeliverables.filter((d) => ["High", "Critical"].includes(d.priority));
  const overdueDecisions = scoped.decisions.filter((d) => isDecisionOverdue(d.due_date, d.status, now));
  const overdueActions = scoped.actions.filter((a) => isOverdue(a.due_date, a.status));
  const materialTests = materialTestFailures(scoped.test_cases, phase.phase);
  const materialAC = materialAcceptanceCriteriaFailures(scoped.acceptance_criteria ?? [], scoped.requirements);
  // schedule.daysRemaining is always clamped to a minimum of zero by calculateSchedule()
  // — a project literally past its planned end date is instead reflected in
  // schedule.health being "Red" (via isPastEnd). A negative-daysRemaining branch here
  // could never be true; it was dead code and has been removed, not kept as a no-op.
  const daysRemaining = schedule.daysRemaining;
  const isComplete = project.status === "Complete" || project.status === "Closed";

  // ── RED conditions — approved compound rule ──
  // Red only when not complete and at least one applies:
  //  1. central schedule health is Red AND the authoritative go-live date
  //     (resolveGoLiveDate — never planned_end_date directly) is within 30 days
  //  2. an unmitigated Critical risk is open
  //  3. a High/Critical priority deliverable is blocked
  //  4. a material test or acceptance-criteria failure exists (lib/delivery-materiality.ts)
  const scheduleRedNearGoLive = schedule.health === "Red" && daysToGoLive !== null && daysToGoLive <= 30;
  const isRed =
    !isComplete && (
      scheduleRedNearGoLive ||
      unmitgatedCritical.length > 0 ||
      blockedCriticalDeliverables.length > 0 ||
      materialTests.length > 0 ||
      materialAC.length > 0
    );

  // ── AMBER conditions ──
  // Deliberately broader/softer than Red: any blocked deliverable (any
  // priority), any overdue decision, Amber schedule health, an unmitigated
  // High risk, or 3+ overdue actions. None of these alone reach Red.
  const isAmber =
    !isRed &&
    !isComplete && (
      blockedDeliverables.length > 0 ||
      overdueDecisions.length > 0 ||
      schedule.health === "Amber" ||
      (highRisks.length > 0 && highRisks.some((r) => !r.mitigation?.trim())) ||
      (overdueActions.length >= 3)
    );

  // ── GREEN — everything else ──
  // Normal UAT progression, an outstanding customer approval, and future
  // deployment work are not Red or Amber signals by themselves — none of the
  // conditions above reference "in UAT" or "approval pending" as a trigger.
  const ragStatus: ManagerRagStatus = isRed ? "Red" : isAmber ? "Amber" : "Green";

  // ── Date confidence — now projects schedule.health directly, no independent thresholds ──
  let dateConfidence: DateConfidence;
  if (isComplete || (daysRemaining === null)) {
    dateConfidence = "On Track";
  } else if (schedule.health === "Red") {
    dateConfidence = "Delayed";
  } else if (schedule.health === "Amber") {
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
    blockedCriticalDeliverables,
    overdueDecisions,
    overdueActions,
    daysRemaining,
    isComplete,
    scheduleRedNearGoLive,
    daysToGoLive,
    materialTests,
    materialAC,
    phase: phase.phase,
  });

  // ── Attention Required ──
  const attention = buildAttention({
    criticalRisks,
    unmitgatedCritical,
    blockedDeliverables,
    overdueDecisions,
    overdueActions,
    materialTests,
    materialAC,
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
  blockedDeliverables: Deliverable[];
  blockedCriticalDeliverables: Deliverable[];
  overdueDecisions: ReturnType<typeof scopeProjectData>["decisions"];
  overdueActions: ReturnType<typeof scopeProjectData>["actions"];
  daysRemaining: number | null;
  isComplete: boolean;
  scheduleRedNearGoLive: boolean;
  daysToGoLive: number | null;
  materialTests: TestCase[];
  materialAC: AcceptanceCriteria[];
  phase: ProjectPhase;
};

function buildSummary(
  project: Project,
  scoped: ReturnType<typeof scopeProjectData>,
  schedule: ReturnType<typeof calculateSchedule>,
  rag: ManagerRagStatus,
  signals: SignalBag,
): string {
  const sentences: string[] = [];
  const { blockedDeliverables, overdueDecisions, overdueActions, daysRemaining, isComplete } = signals;

  if (isComplete) {
    sentences.push(`${project.name} is complete.`);
    return sentences.join(" ");
  }

  // Sentence 1 — overall status driver
  if (rag === "Red") {
    if (signals.unmitgatedCritical.length > 0) {
      sentences.push(`The project has ${signals.unmitgatedCritical.length === 1 ? "a critical risk" : `${signals.unmitgatedCritical.length} critical risks`} without a mitigation plan in place.`);
    } else if (signals.materialTests.length > 0) {
      sentences.push(`${signals.materialTests.length === 1 ? "A test has" : `${signals.materialTests.length} tests have`} failed or ${signals.materialTests.length === 1 ? "is" : "are"} blocked during ${signals.phase}, a material delivery gap.`);
    } else if (signals.materialAC.length > 0) {
      sentences.push(`${signals.materialAC.length === 1 ? "An acceptance criterion has" : `${signals.materialAC.length} acceptance criteria have`} failed on a High or Critical priority requirement.`);
    } else if (signals.blockedCriticalDeliverables.length > 0) {
      sentences.push(`${signals.blockedCriticalDeliverables.length === 1 ? "A High/Critical priority deliverable is" : `${signals.blockedCriticalDeliverables.length} High/Critical priority deliverables are`} blocked.`);
    } else if (signals.scheduleRedNearGoLive) {
      sentences.push(`Schedule health is Red with go-live in ${signals.daysToGoLive} ${signals.daysToGoLive === 1 ? "day" : "days"}, and the delivery date is at serious risk.`);
    } else {
      sentences.push(`The project is significantly behind and the delivery date is at serious risk.`);
    }
  } else if (rag === "Amber") {
    if (blockedDeliverables.length > 0) {
      sentences.push(`${blockedDeliverables.length === 1 ? "One deliverable is" : `${blockedDeliverables.length} deliverables are`} currently blocked and need to be resolved before testing can continue.`);
    } else if (overdueDecisions.length > 0) {
      sentences.push(`${overdueDecisions.length === 1 ? "A decision is" : `${overdueDecisions.length} decisions are`} overdue and ${overdueDecisions.length === 1 ? "is" : "are"} holding up the team.`);
    } else if (schedule.health === "Amber") {
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
    } else if (signals.materialTests.length > 0 || signals.materialAC.length > 0) {
      sentences.push(`Investigate and resolve the failed testing evidence before proceeding.`);
    } else {
      sentences.push(`Recovery planning and a revised delivery date are needed without delay.`);
    }
  } else if (rag === "Amber" && overdueDecisions.length > 0) {
    const d = overdueDecisions[0];
    sentences.push(`${d.decision_ref} — "${d.question.length > 60 ? d.question.slice(0, 57) + "…" : d.question}" — needs a decision.`);
  }

  return sentences.slice(0, 3).join(" ");
}

type AttentionSignals = Pick<SignalBag, "criticalRisks" | "unmitgatedCritical" | "blockedDeliverables" | "overdueDecisions" | "overdueActions" | "materialTests" | "materialAC"> & { ragStatus: ManagerRagStatus };

function buildAttention({ unmitgatedCritical, blockedDeliverables, overdueDecisions, materialTests, materialAC, ragStatus }: AttentionSignals): string | null {
  if (ragStatus === "Green") return null;
  const items: string[] = [];
  if (unmitgatedCritical.length > 0) {
    items.push(`Mitigate ${unmitgatedCritical.length === 1 ? "critical risk" : `${unmitgatedCritical.length} critical risks`}: ${unmitgatedCritical.map((r) => r.risk_ref).join(", ")}`);
  }
  if (materialTests.length > 0) {
    items.push(`Resolve failed/blocked ${materialTests.length === 1 ? "test" : "tests"}: ${materialTests.map((t) => t.test_ref).join(", ")}`);
  }
  if (materialAC.length > 0) {
    items.push(`Resolve failed acceptance ${materialAC.length === 1 ? "criterion" : "criteria"}: ${materialAC.map((ac) => ac.ac_ref).join(", ")}`);
  }
  if (overdueDecisions.length > 0) {
    items.push(`Resolve overdue ${overdueDecisions.length === 1 ? "decision" : "decisions"}: ${overdueDecisions.map((d) => d.decision_ref).join(", ")}`);
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
