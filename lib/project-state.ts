import type { DataStore } from "@/lib/data-store";
import {
  isAcceptanceCriteriaFailed,
  isAcceptanceCriteriaMet,
  isActionBlocked,
  isActionOpen,
  isDecisionOpen,
  isDecisionOverdue,
  isDeliverableBlocked,
  isDeliverableComplete,
  isDependencyBlocked,
  isDependencyOpen,
  isDevelopmentComplete,
  isRequirementSignedOff,
  isRiskClosed,
  isRiskHighOrCritical,
  isRiskOpen,
  isRiskUnmitigated,
  isSitComplete,
  isTestPassed,
  isUatComplete,
} from "@/lib/lifecycle";
import { calculateProgress, calculateProjectHealth, type ProgressComponent, type RagStatus } from "@/lib/control-tower";
import { computeDeliveryConfidence, type DeliveryConfidenceResult } from "@/lib/delivery-confidence";
import { buildGoLiveDashboard, type GoLiveDashboard } from "@/lib/go-live-readiness";
import { classifyProject, type ManagerProjectSummary } from "@/lib/manager-summary";
import { deriveProjectPhase, type ProjectPhaseEvidence } from "@/lib/project-phase";
import { resolveGoLiveDate, type GoLiveDateResolution } from "@/lib/project-dates";
import { buildProjectIntelligence, type IntelligenceReport } from "@/lib/project-intelligence";
import { scopeProjectData } from "@/lib/project-scope";
import { buildDeliveryDiagnostics, buildRecommendationAnalysis, type DeliveryInsightDiagnostics, type Recommendation } from "@/lib/recommendations";
import { calculateSchedule, type ScheduleMetrics } from "@/lib/schedule";
import type { Project } from "@/lib/types";
import { isOverdue } from "@/lib/utils";

// ── Shared lifecycle roll-ups (Phase 7 §2) ──────────────────────────────────
//
// Computed once per project, from the same scoped data every consumer used
// to re-filter independently. These are facts, not verdicts — "Project
// Health", "Schedule Health", "Delivery Confidence" and "Go-Live Readiness"
// each interpret these (and other) facts differently and deliberately keep
// answering different questions; see the ProjectState doc comment below.
export type LifecycleRollups = {
  risks: { open: number; closed: number; critical: number; highOrCritical: number; unmitigatedHighOrCritical: number };
  actions: { open: number; overdue: number; blocked: number };
  decisions: { open: number; overdue: number };
  requirements: { signedOff: number; outstanding: number; ownerless: number };
  deliverables: { total: number; complete: number; blocked: number; developmentComplete: number; sitComplete: number; uatComplete: number };
  tests: { total: number; passed: number; failed: number; blocked: number; pending: number; allPassed: boolean };
  acceptanceCriteria: { total: number; met: number; failed: number; outstanding: number; allMet: boolean };
  dependencies: { open: number; blocked: number };
};

function buildLifecycleRollups(scoped: DataStore): LifecycleRollups {
  const openRisks = scoped.risks.filter((r) => isRiskOpen(r.status));
  const highOrCriticalOpenRisks = openRisks.filter((r) => isRiskHighOrCritical(r.impact));

  const scopedAC = scoped.acceptance_criteria ?? [];
  const metAC = scopedAC.filter((ac) => isAcceptanceCriteriaMet(ac.status));

  const passedTests = scoped.test_cases.filter((t) => isTestPassed(t.status));

  return {
    risks: {
      open: openRisks.length,
      closed: scoped.risks.filter((r) => isRiskClosed(r.status)).length,
      critical: openRisks.filter((r) => r.impact === "Critical").length,
      highOrCritical: highOrCriticalOpenRisks.length,
      unmitigatedHighOrCritical: highOrCriticalOpenRisks.filter((r) => isRiskUnmitigated(r)).length,
    },
    actions: {
      open: scoped.actions.filter((a) => isActionOpen(a.status)).length,
      overdue: scoped.actions.filter((a) => isOverdue(a.due_date, a.status)).length,
      blocked: scoped.actions.filter((a) => isActionBlocked(a.status)).length,
    },
    decisions: {
      open: scoped.decisions.filter((d) => isDecisionOpen(d.status)).length,
      overdue: scoped.decisions.filter((d) => isDecisionOverdue(d.due_date, d.status)).length,
    },
    requirements: {
      signedOff: scoped.requirements.filter((r) => isRequirementSignedOff(r.status)).length,
      outstanding: scoped.requirements.filter((r) => !isRequirementSignedOff(r.status)).length,
      ownerless: scoped.requirements.filter((r) => !r.owner?.trim() && r.status !== "Complete").length,
    },
    deliverables: {
      total: scoped.deliverables.length,
      complete: scoped.deliverables.filter((d) => isDeliverableComplete(d)).length,
      blocked: scoped.deliverables.filter((d) => isDeliverableBlocked(d)).length,
      developmentComplete: scoped.deliverables.filter((d) => isDevelopmentComplete(d)).length,
      sitComplete: scoped.deliverables.filter((d) => isSitComplete(d)).length,
      uatComplete: scoped.deliverables.filter((d) => isUatComplete(d)).length,
    },
    tests: {
      total: scoped.test_cases.length,
      passed: passedTests.length,
      failed: scoped.test_cases.filter((t) => t.status === "Failed").length,
      blocked: scoped.test_cases.filter((t) => t.status === "Blocked").length,
      pending: scoped.test_cases.filter((t) => t.status === "Pending").length,
      allPassed: scoped.test_cases.length > 0 && passedTests.length === scoped.test_cases.length,
    },
    acceptanceCriteria: {
      total: scopedAC.length,
      met: metAC.length,
      failed: scopedAC.filter((ac) => isAcceptanceCriteriaFailed(ac.status)).length,
      outstanding: scopedAC.length - metAC.length,
      allMet: scopedAC.length > 0 && metAC.length === scopedAC.length,
    },
    dependencies: {
      open: scoped.dependencies.filter((d) => isDependencyOpen(d.status)).length,
      blocked: scoped.dependencies.filter((d) => isDependencyBlocked(d.status)).length,
    },
  };
}

// ── ProjectState ─────────────────────────────────────────────────────────────
//
// The single place a project's facts are computed. Every field below is
// produced by calling an existing, already-approved engine with this exact
// project — never by re-deriving logic that engine already owns, and never
// by letting that engine pick its own project internally (every one of the
// underlying calls below is passed `project` explicitly).
//
// Four fields deliberately answer different questions and are NOT collapsed
// into one score, even though they share the same underlying facts:
//   - projectHealth   (lib/control-tower.ts)   — overdue work + blockers + schedule
//   - scheduleHealth  (lib/schedule.ts)         — schedule variance/lateness only
//   - confidence      (lib/delivery-confidence) — phase-aware recommendation penalties
//   - goLive          (lib/go-live-readiness)   — the 13-check readiness model
// A project can legitimately be schedule-Green, health-Amber, confidence 74%,
// and Go-Live Amber all at once — that is four different lenses on the same
// facts, not a bug. See tests/phase7-project-state.test.mjs.
export type ProjectState = {
  project: Project;
  generatedAt: Date;
  scoped: DataStore;
  phase: ProjectPhaseEvidence;
  schedule: ScheduleMetrics;
  goLiveDate: GoLiveDateResolution;
  rollups: LifecycleRollups;
  diagnostics: DeliveryInsightDiagnostics;
  recommendations: Recommendation[];
  confidence: DeliveryConfidenceResult;
  projectHealth: RagStatus;
  progress: { overall: number; components: ProgressComponent[]; trend: { direction: "up" | "flat" | "down"; label: string } };
  scheduleHealth: RagStatus | null;
  goLive: GoLiveDashboard;
  managerSummary: ManagerProjectSummary;
  intelligence: IntelligenceReport;
  blockedMilestones: number;
};

/**
 * buildProjectState never selects a project — it only ever operates on the
 * exact Project object its caller passes in. Callers resolve "which
 * project" exactly once, via their own explicit/approved selection helper
 * (an ID lookup, the active-project selector, etc.), then pass that single
 * Project here.
 */
export function buildProjectState(data: DataStore, project: Project, now = new Date()): ProjectState {
  const scoped = scopeProjectData(data, project);
  const phase = deriveProjectPhase(data, project, now);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);
  const goLiveDate = resolveGoLiveDate(data, project);
  const rollups = buildLifecycleRollups(scoped);

  const blockedMilestones = scoped.milestones.filter((m) => m.status === "Blocked").length + schedule.blocked.length;
  const overdueItems = rollups.actions.overdue + rollups.decisions.overdue;

  const diagnostics = buildDeliveryDiagnostics(data, project, now);
  const recommendations = buildRecommendationAnalysis(data, 10, now, project).recommendations;
  const confidence = computeDeliveryConfidence(data, project);
  const projectHealth = calculateProjectHealth(overdueItems, blockedMilestones, schedule.health);
  const progress = calculateProgress(scoped, schedule.health);
  const goLive = buildGoLiveDashboard(data, project, now);
  const managerSummary = classifyProject(data, project, now);
  const intelligence = buildProjectIntelligence(data, project, now);

  return {
    project,
    generatedAt: now,
    scoped,
    phase,
    schedule,
    goLiveDate,
    rollups,
    diagnostics,
    recommendations,
    confidence,
    projectHealth,
    progress,
    scheduleHealth: schedule.health,
    goLive,
    managerSummary,
    intelligence,
    blockedMilestones,
  };
}
