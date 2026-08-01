import type { DataStore } from "@/lib/data-store";
import { deliverableDaysUntil, isDeliverableComplete, isDevelopmentComplete, isSitComplete, isUatComplete } from "@/lib/delivery";
import {
  isAcceptanceCriteriaFailed,
  isAcceptanceCriteriaMet,
  isActionBlocked,
  isActionOpen,
  isDecisionOpen,
  isDecisionOverdue,
  isDeliverableBlocked,
  isDependencyBlocked,
  isDependencyOpen,
  isRequirementSignedOff,
  isRiskOpen,
  isTestFailedOrBlocked,
} from "@/lib/lifecycle";
import { deriveProjectPhase, type ProjectPhase, type ProjectPhaseEvidence } from "@/lib/project-phase";
import { scopeProjectData, selectActiveProject } from "@/lib/project-scope";
import type { Project } from "@/lib/types";

export type RecommendationType =
  | "action"
  | "risk"
  | "decision"
  | "milestone"
  | "question"
  | "meeting"
  | "intelligence";

export type RecommendationUrgency = "critical" | "high" | "medium" | "low";

export type DeliveryInsight = {
  id: string;
  type: string;
  title: string;
  description: string;
  explanation: string;
  source: string[];
  entityType: string;
  entityId?: string;
  score: number;
  priority: RecommendationUrgency;
  importance: number;
  urgency: number;
  phaseRelevance: number;
  confidence: number;
  confidenceImpact?: number;
  currentPhase: ProjectPhase;
  reason: string;
  actionUrl?: string;
};

export type Recommendation = {
  id: string;
  type: RecommendationType;
  urgency: RecommendationUrgency;
  title: string;
  reason: string;
  href: string;
  score: number;
  ref?: string;
  phase: ProjectPhase;
  importance: number;
  urgencyScore: number;
  phaseRelevance: number;
  confidence: number;
  priority: number;
  confidenceImpact?: number;
  explanation?: string;
  source?: string[];
  entityType?: string;
};

export type DeliveryInsightAnalysis = {
  project: Project | null;
  phase: ProjectPhaseEvidence | null;
  insights: DeliveryInsight[];
};

export type SuppressedDeliveryInsight = DeliveryInsight & {
  suppressionReason: string;
};

export type DeliveryDiagnosticWarning = {
  id: string;
  severity: "warning";
  message: string;
  source: string[];
};

export type DeliveryInsightDiagnostics = DeliveryInsightAnalysis & {
  suppressedInsights: SuppressedDeliveryInsight[];
  confidenceDeductions: Array<{ insightId: string; title: string; impact: number; source: string[] }>;
  recommendationScores: Array<{ insightId: string; title: string; score: number; importance: number; urgency: number; phaseRelevance: number; confidence: number }>;
  warnings: DeliveryDiagnosticWarning[];
};

export type RecommendationAnalysis = DeliveryInsightAnalysis & {
  recommendations: Recommendation[];
};

type RecommendationDomain =
  | "requirements"
  | "technical"
  | "testing"
  | "uat"
  | "deployment"
  | "hypercare"
  | "governance"
  | "dependency"
  | "delivery";

type Candidate = Omit<Recommendation, "score" | "priority" | "phase" | "phaseRelevance"> & {
  domain: RecommendationDomain;
  phaseRelevance?: number;
  entityType?: string;
  entityId?: string;
  explanation?: string;
  source?: string[];
};

function source(ref: string | null | undefined) {
  return ref ? [ref] : [];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const phaseStrategy: Record<ProjectPhase, { focus: RecommendationDomain[]; suppress: RecommendationDomain[] }> = {
  Discovery: {
    focus: ["requirements", "governance", "dependency", "delivery", "technical"],
    suppress: ["deployment", "hypercare"],
  },
  Analysis: {
    focus: ["requirements", "governance", "dependency", "technical", "delivery"],
    suppress: ["hypercare"],
  },
  Design: {
    focus: ["technical", "requirements", "governance", "dependency", "delivery"],
    suppress: ["hypercare"],
  },
  Development: {
    focus: ["technical", "requirements", "dependency", "delivery", "governance"],
    suppress: ["hypercare"],
  },
  SIT: {
    focus: ["testing", "technical", "dependency", "delivery", "governance"],
    suppress: ["hypercare"],
  },
  UAT: {
    focus: ["uat", "governance", "deployment", "dependency", "testing", "delivery"],
    suppress: ["requirements"],
  },
  Deployment: {
    focus: ["deployment", "governance", "dependency", "uat", "delivery"],
    suppress: ["requirements"],
  },
  Hypercare: {
    focus: ["hypercare", "testing", "dependency", "delivery", "governance"],
    suppress: ["requirements"],
  },
  Closed: {
    focus: ["hypercare"],
    suppress: ["requirements", "technical", "testing", "uat", "deployment", "delivery"],
  },
};

function today(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(dateStr?: string | null, now = new Date()): number | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - today(now).getTime()) / DAY_MS);
}

function daysOverdue(dateStr?: string | null, now = new Date()): number {
  const d = daysUntil(dateStr, now);
  return d !== null && d < 0 ? Math.abs(d) : 0;
}

function plural(n: number, s: string, p = `${s}s`) {
  return `${n} ${n === 1 ? s : p}`;
}

function urgencyFromDays(days: number): RecommendationUrgency {
  return days > 7 ? "critical" : days > 3 ? "high" : "medium";
}

function phaseRelevance(phase: ProjectPhase, domain: RecommendationDomain, override?: number) {
  if (override !== undefined) return override;
  const strategy = phaseStrategy[phase];
  if (strategy.focus[0] === domain) return 100;
  if (strategy.focus.includes(domain)) return 82;
  if (strategy.suppress.includes(domain)) return 12;
  return 38;
}

function scoreCandidate(candidate: Candidate, phase: ProjectPhase): Recommendation {
  const relevance = phaseRelevance(phase, candidate.domain, candidate.phaseRelevance);
  const priority = Math.round(
    candidate.importance * 0.4 +
    candidate.urgencyScore * 0.28 +
    relevance * 0.22 +
    candidate.confidence * 0.1,
  );

  return {
    ...candidate,
    phase,
    phaseRelevance: relevance,
    priority,
    score: priority,
    confidenceImpact: confidenceImpactFromScores(candidate.urgency, relevance, candidate.confidence),
  };
}

function confidenceImpactFromScores(priority: RecommendationUrgency, phaseRelevanceValue: number, confidence: number): number {
  if (phaseRelevanceValue < 30 && priority !== "critical") return 0;
  const severityBase = priority === "critical" ? 11 : priority === "high" ? 7 : priority === "medium" ? 4 : 2;
  const relevanceFactor = Math.max(0.25, phaseRelevanceValue / 100);
  const confidenceFactor = Math.max(0.4, confidence / 100);
  return Math.round(severityBase * relevanceFactor * confidenceFactor);
}

function toDeliveryInsight(item: Recommendation): DeliveryInsight {
  const sourceRefs = item.source?.length ? item.source : source(item.ref);
  const explanation = item.explanation
    ?? `${item.reason} Current phase is ${item.phase}; source ${sourceRefs.length ? sourceRefs.join(", ") : item.id}.`;
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.reason,
    explanation,
    source: sourceRefs,
    entityType: item.entityType ?? item.type,
    entityId: item.ref,
    score: item.score,
    priority: item.urgency,
    importance: item.importance,
    urgency: item.urgencyScore,
    phaseRelevance: item.phaseRelevance,
    confidence: item.confidence,
    confidenceImpact: item.confidenceImpact,
    currentPhase: item.phase,
    reason: item.reason,
    actionUrl: item.href,
  };
}

function toRecommendation(item: DeliveryInsight): Recommendation {
  return {
    id: item.id,
    type: item.type as RecommendationType,
    urgency: item.priority,
    title: item.title,
    reason: item.reason,
    href: item.actionUrl ?? "/",
    score: item.score,
    ref: item.entityId,
    phase: item.currentPhase,
    importance: item.importance,
    urgencyScore: item.urgency,
    phaseRelevance: item.phaseRelevance,
    confidence: item.confidence,
    priority: item.score,
    confidenceImpact: item.confidenceImpact,
    explanation: item.explanation,
    source: item.source,
    entityType: item.entityType,
  };
}

function textDomain(value: string): RecommendationDomain {
  const text = value.toLowerCase();
  if (/uat|customer|sign.?off|acceptance/.test(text)) return "uat";
  if (/sit|test|defect|evidence|acceptance criteria/.test(text)) return "testing";
  if (/deploy|go.?live|release|rollback|cab|cutover|comms|communication/.test(text)) return "deployment";
  if (/hypercare|incident|production|support/.test(text)) return "hypercare";
  if (/requirement|analysis|discovery|design|business rule/.test(text)) return "requirements";
  if (/develop|technical|backend|database|performance|code|build/.test(text)) return "technical";
  return "delivery";
}

function addActionCandidates(data: DataStore, candidates: Candidate[], now: Date) {
  const openActions = data.actions.filter((a) => isActionOpen(a.status));

  for (const action of openActions.filter((a) => isActionBlocked(a.status))) {
    const domain = textDomain(`${action.description} ${action.notes ?? ""}`);
    candidates.push({
      id: `blocked-${action.id}`,
      type: "action",
      urgency: "high",
      title: `Unblock action: ${action.action_ref}`,
      reason: `"${action.description.slice(0, 80)}" is blocked; resolving it removes an active delivery constraint.`,
      href: "/actions",
      ref: action.action_ref,
      source: source(action.action_ref),
      entityType: "action",
      entityId: action.id,
      importance: 88,
      urgencyScore: 80,
      confidence: 96,
      domain,
    });
  }

  for (const action of openActions.filter((a) => daysOverdue(a.due_date, now) > 0)) {
    const n = daysOverdue(action.due_date, now);
    const domain = textDomain(`${action.description} ${action.notes ?? ""}`);
    candidates.push({
      id: `action-${action.id}`,
      type: "action",
      urgency: urgencyFromDays(n),
      title: domain === "uat" ? `Progress customer action: ${action.action_ref}` : `Complete overdue action: ${action.action_ref}`,
      reason: `"${action.description.slice(0, 80)}" is ${plural(n, "day")} overdue; it matters now because it sits in the ${domain.replace("_", " ")} workstream.`,
      href: "/actions",
      ref: action.action_ref,
      source: source(action.action_ref),
      entityType: "action",
      entityId: action.id,
      importance: domain === "deployment" || domain === "uat" ? 86 : 74,
      urgencyScore: Math.min(100, 58 + n * 5),
      confidence: 92,
      domain,
    });
  }
}

function addDecisionCandidates(data: DataStore, candidates: Candidate[], now: Date) {
  for (const decision of data.decisions.filter((d) => isDecisionOverdue(d.due_date, d.status, now))) {
    const n = daysOverdue(decision.due_date, now);
    const domain = textDomain(`${decision.question} ${decision.decision ?? ""}`);
    candidates.push({
      id: `decision-${decision.id}`,
      type: "decision",
      urgency: n > 7 ? "high" : "medium",
      title: domain === "uat" ? `Resolve customer decision: ${decision.decision_ref}` : `Resolve overdue decision: ${decision.decision_ref}`,
      reason: `"${decision.question.slice(0, 80)}" is ${plural(n, "day")} past its deadline; unresolved governance can hold up ${domain === "uat" ? "customer acceptance" : "delivery decisions"}.`,
      href: "/decisions",
      ref: decision.decision_ref,
      source: source(decision.decision_ref),
      entityType: "decision",
      entityId: decision.id,
      importance: domain === "uat" || domain === "deployment" ? 86 : 72,
      urgencyScore: Math.min(92, 55 + n * 4),
      confidence: 94,
      domain: domain === "technical" ? "governance" : domain,
    });
  }

  const openGovernanceDecisions = data.decisions.filter((d) => isDecisionOpen(d.status) && !isDecisionOverdue(d.due_date, d.status, now));
  if (openGovernanceDecisions.length >= 3) {
    candidates.push({
      id: "decisions-open-governance",
      type: "decision",
      urgency: "medium",
      title: `Review ${openGovernanceDecisions.length} open governance decisions`,
      reason: "Several decisions remain open; review only those still relevant to the current phase and close obsolete entries.",
      href: "/decisions",
      source: openGovernanceDecisions.map((d) => d.decision_ref),
      entityType: "decision",
      importance: 58,
      urgencyScore: 42,
      confidence: 76,
      domain: "governance",
    });
  }
}

function addRiskCandidates(data: DataStore, candidates: Candidate[]) {
  const openRisks = data.risks.filter((r) => isRiskOpen(r.status));
  for (const risk of openRisks.filter((r) => ["High", "Critical"].includes(r.impact))) {
    const domain = textDomain(`${risk.description} ${risk.mitigation ?? ""}`);
    const noMitigation = !risk.mitigation?.trim();
    candidates.push({
      id: `risk-${risk.id}`,
      type: "risk",
      urgency: risk.impact === "Critical" ? "critical" : "high",
      title: noMitigation ? `Mitigate ${risk.impact.toLowerCase()} risk: ${risk.risk_ref}` : `Review ${risk.impact.toLowerCase()} risk: ${risk.risk_ref}`,
      reason: noMitigation
        ? `${risk.impact}-impact risk has no mitigation plan; this is a genuine delivery exposure.`
        : `${risk.impact}-impact risk remains open; confirm whether the mitigation still protects the current phase.`,
      href: "/risks",
      ref: risk.risk_ref,
      source: source(risk.risk_ref),
      entityType: "risk",
      entityId: risk.id,
      importance: risk.impact === "Critical" ? 100 : 82,
      urgencyScore: risk.impact === "Critical" ? 96 : 78,
      confidence: noMitigation ? 98 : 82,
      domain: domain === "delivery" ? "technical" : domain,
    });
  }
}

function addRequirementAndQuestionCandidates(data: DataStore, candidates: Candidate[]) {
  const incompleteCriticalReqs = data.requirements.filter(
    (r) => ["High", "Critical"].includes(r.priority) && !isRequirementSignedOff(r.status),
  );
  for (const req of incompleteCriticalReqs.slice(0, 3)) {
    candidates.push({
      id: `requirement-${req.id}`,
      type: "intelligence",
      urgency: req.priority === "Critical" ? "high" : "medium",
      title: `Review outstanding requirement: ${req.requirement_ref}`,
      reason: `${req.priority} ${req.category} requirement is still ${req.status}; it should be settled before later-phase delivery decisions depend on it.`,
      href: "/requirements",
      ref: req.requirement_ref,
      source: source(req.requirement_ref),
      entityType: "requirement",
      entityId: req.id,
      importance: req.priority === "Critical" ? 86 : 72,
      urgencyScore: req.priority === "Critical" ? 74 : 56,
      confidence: 88,
      domain: req.category === "Testing" ? "testing" : req.category === "UI" || req.category === "Backend" || req.category === "Database" || req.category === "Performance" ? "technical" : "requirements",
    });
  }

  const awaitingQueries = data.discovery_questions.filter((q) =>
    ["Awaiting Business", "Awaiting Development", "Awaiting Response", "Open"].includes(q.status),
  );
  for (const q of awaitingQueries.slice(0, 3)) {
    const domain = textDomain(`${q.category} ${q.question}`);
    candidates.push({
      id: `question-${q.id}`,
      type: "question",
      urgency: q.status === "Open" ? "medium" : "high",
      title: q.status === "Awaiting Business" ? `Await business answer: ${q.question_ref}` : `Resolve discovery question: ${q.question_ref}`,
      reason: `"${q.question.slice(0, 80)}" is still ${q.status}; closing it reduces ambiguity for ${domain === "uat" ? "customer acceptance" : "delivery execution"}.`,
      href: "/discovery-questions",
      ref: q.question_ref,
      source: source(q.question_ref),
      entityType: "discovery_question",
      entityId: q.id,
      importance: q.status === "Awaiting Business" ? 78 : 68,
      urgencyScore: q.status === "Open" ? 46 : 68,
      confidence: 86,
      domain: domain === "delivery" ? "requirements" : domain,
    });
  }
}

function addTestingCandidates(data: DataStore, candidates: Candidate[]) {
  for (const test of data.test_cases.filter((t) => isTestFailedOrBlocked(t.status))) {
    candidates.push({
      id: `test-${test.id}`,
      type: "intelligence",
      urgency: test.status === "Blocked" ? "critical" : "high",
      title: test.status === "Blocked" ? `Unblock test case: ${test.test_ref}` : `Investigate failed test: ${test.test_ref}`,
      reason: `"${test.scenario.slice(0, 80)}" is ${test.status}; unresolved test evidence directly affects SIT/UAT readiness.`,
      href: "/testing",
      ref: test.test_ref,
      source: source(test.test_ref),
      entityType: "test_case",
      entityId: test.id,
      importance: test.status === "Blocked" ? 96 : 90,
      urgencyScore: test.status === "Blocked" ? 96 : 82,
      confidence: 98,
      domain: "testing",
    });
  }

  const pendingTests = data.test_cases.filter((t) => t.status === "Pending");
  if (pendingTests.length >= 3) {
    candidates.push({
      id: "tests-pending",
      type: "intelligence",
      urgency: "medium",
      title: `Progress ${pendingTests.length} pending test cases`,
      reason: "A large pending test inventory is normal before testing starts, but it becomes a delivery gap during SIT/UAT.",
      href: "/testing",
      source: pendingTests.map((t) => t.test_ref),
      entityType: "test_case",
      importance: 62,
      urgencyScore: 48,
      confidence: 84,
      domain: "testing",
    });
  }
}

function addAcceptanceAndDependencyCandidates(data: DataStore, candidates: Candidate[]) {
  const failedAC = (data.acceptance_criteria ?? []).filter((ac) => isAcceptanceCriteriaFailed(ac.status));
  for (const ac of failedAC.slice(0, 3)) {
    candidates.push({
      id: `acceptance-${ac.id}`,
      type: "intelligence",
      urgency: "high",
      title: `Resolve failed acceptance criterion: ${ac.ac_ref}`,
      reason: `"${ac.criterion.slice(0, 80)}" has failed; acceptance evidence must be clean before customer sign-off or deployment.`,
      href: "/acceptance-criteria",
      ref: ac.ac_ref,
      source: source(ac.ac_ref),
      entityType: "acceptance_criteria",
      entityId: ac.id,
      importance: 92,
      urgencyScore: 84,
      confidence: 98,
      domain: "testing",
    });
  }

  const acceptanceCriteria = data.acceptance_criteria ?? [];
  const evidence = data.evidence ?? [];
  if (acceptanceCriteria.length > 0) {
    const missingEvidence = acceptanceCriteria.filter((ac) =>
      !isAcceptanceCriteriaMet(ac.status) && !evidence.some((ev) => ev.ac_id === ac.id),
    );
    if (missingEvidence.length / acceptanceCriteria.length > 0.5) {
      candidates.push({
        id: "acceptance-missing-evidence",
        type: "intelligence",
        urgency: "medium",
        title: `Attach acceptance evidence for ${missingEvidence.length} criteria`,
        reason: "More than half of the acceptance criteria have no evidence attached; this weakens SIT/UAT and governance confidence.",
        href: "/acceptance-criteria",
        source: missingEvidence.map((ac) => ac.ac_ref),
        entityType: "acceptance_criteria",
        importance: 74,
        urgencyScore: 56,
        confidence: 86,
        domain: "testing",
      });
    }
  }

  const pendingSignOffs = (data.requirement_sign_offs ?? []).filter((s) => s.status === "Pending");
  if (pendingSignOffs.length > 0) {
    candidates.push({
      id: "pending-sign-offs",
      type: "intelligence",
      urgency: "medium",
      title: `Progress ${pendingSignOffs.length} pending sign-off${pendingSignOffs.length === 1 ? "" : "s"}`,
      reason: "Pending sign-offs are governance gates; their priority depends on the current phase and whether customer acceptance or deployment is next.",
      href: "/requirements",
      source: pendingSignOffs.map((s) => s.id),
      entityType: "requirement_sign_off",
      importance: 68,
      urgencyScore: 54,
      confidence: 86,
      domain: "governance",
    });
  }

  for (const dependency of data.dependencies.filter((d) => isDependencyOpen(d.status)).slice(0, 3)) {
    const blocked = isDependencyBlocked(dependency.status);
    candidates.push({
      id: `dependency-${dependency.id}`,
      type: "intelligence",
      urgency: blocked ? "critical" : "medium",
      title: blocked ? `Unblock dependency: ${dependency.name}` : `Confirm dependency: ${dependency.name}`,
      reason: "Open dependencies can constrain the current phase; confirm owner, status and whether it still affects delivery.",
      href: "/dependencies",
      source: [dependency.name],
      entityType: "dependency",
      entityId: dependency.id,
      importance: blocked ? 94 : 64,
      urgencyScore: blocked ? 92 : 48,
      confidence: 84,
      domain: "dependency",
    });
  }
}

function addDeliverableCandidates(data: DataStore, candidates: Candidate[], now: Date) {
  for (const item of data.deliverables.filter((d) => !isDeliverableComplete(d))) {
    const days = deliverableDaysUntil(item.planned_completion_date, now);
    const blocked = isDeliverableBlocked(item);
    const domain = textDomain(`${item.title} ${item.description ?? ""} ${item.workstream} ${item.status} ${item.development_status} ${item.sit_status} ${item.uat_status} ${item.deployment_status}`);
    const uatReadyOrActive = item.status === "Ready for UAT" || ["Ready", "In Progress", "Passed"].includes(item.uat_status);

    if (blocked) {
      candidates.push({
        id: `deliverable-${item.id}-blocked`,
        type: "intelligence",
        urgency: "critical",
        title: `Unblock deliverable: ${item.deliverable_ref}`,
        reason: `${item.title} is blocked; blocked deliverables are genuine delivery gaps in any active phase.`,
        href: "/deliverables",
        ref: item.deliverable_ref,
        source: source(item.deliverable_ref),
        entityType: "deliverable",
        entityId: item.id,
        importance: 98,
        urgencyScore: 96,
        confidence: 100,
        domain: domain === "delivery" ? "technical" : domain,
      });
      continue;
    }

    if (days !== null && days < 0 && !uatReadyOrActive) {
      candidates.push({
        id: `deliverable-${item.id}-overdue`,
        type: "intelligence",
        urgency: "high",
        title: `Replan overdue deliverable: ${item.deliverable_ref}`,
        reason: `${item.title} is ${Math.abs(days)} days past planned completion; confirm whether the plan or status needs updating.`,
        href: "/deliverables",
        ref: item.deliverable_ref,
        source: source(item.deliverable_ref),
        entityType: "deliverable",
        entityId: item.id,
        importance: 78,
        urgencyScore: Math.min(90, 56 + Math.abs(days) * 4),
        confidence: 88,
        domain: domain === "delivery" ? "technical" : domain,
      });
    }

    if ((item.status === "Ready for SIT" || ["Ready", "In Progress"].includes(item.sit_status)) && !isDevelopmentComplete(item)) {
      candidates.push({
        id: `deliverable-${item.id}-sit-readiness`,
        type: "intelligence",
        urgency: "critical",
        title: `Confirm SIT entry evidence: ${item.deliverable_ref}`,
        reason: `${item.title} is entering SIT before development is marked complete; SIT confidence depends on clear build evidence.`,
        href: "/deliverables",
        ref: item.deliverable_ref,
        source: source(item.deliverable_ref),
        entityType: "deliverable",
        entityId: item.id,
        importance: 96,
        urgencyScore: 92,
        confidence: 98,
        domain: "testing",
      });
    }
    if ((item.status === "Ready for UAT" || ["Ready", "In Progress"].includes(item.uat_status)) && !isSitComplete(item)) {
      candidates.push({
        id: `deliverable-${item.id}-uat-readiness`,
        type: "intelligence",
        urgency: "critical",
        title: `Confirm UAT readiness: ${item.deliverable_ref}`,
        reason: `${item.title} is moving toward UAT without SIT completion; customer acceptance should not start without SIT evidence.`,
        href: "/deliverables",
        ref: item.deliverable_ref,
        source: source(item.deliverable_ref),
        entityType: "deliverable",
        entityId: item.id,
        importance: 98,
        urgencyScore: 94,
        confidence: 98,
        domain: "uat",
      });
    }
    if ((item.status === "Ready for Deployment" || ["Ready", "Scheduled"].includes(item.deployment_status)) && !isUatComplete(item)) {
      const deploymentGateIsActive = item.status === "Ready for Deployment" || item.deployment_status === "Scheduled";
      const uatStillInProgress = ["Ready", "In Progress"].includes(item.uat_status) || item.status === "Ready for UAT";
      candidates.push({
        id: `deliverable-${item.id}-deployment-readiness`,
        type: "intelligence",
        urgency: deploymentGateIsActive ? "critical" : "medium",
        title: uatStillInProgress ? `Confirm customer UAT sign-off: ${item.deliverable_ref}` : `Complete deployment readiness: ${item.deliverable_ref}`,
        reason: uatStillInProgress
          ? `${item.title} is ready for deployment planning while UAT is still ${item.uat_status}; this is a normal UAT readiness dependency unless the customer commitment is overdue or blocked.`
          : `${item.title} is approaching deployment without UAT completion; go-live should be gated by customer sign-off.`,
        href: "/deliverables",
        ref: item.deliverable_ref,
        source: source(item.deliverable_ref),
        entityType: "deliverable",
        entityId: item.id,
        importance: deploymentGateIsActive ? 100 : 62,
        urgencyScore: deploymentGateIsActive ? 96 : 42,
        confidence: deploymentGateIsActive ? 99 : 82,
        domain: uatStillInProgress ? "uat" : "deployment",
      });
    }
  }
}

function addMilestoneCandidates(data: DataStore, candidates: Candidate[], now: Date) {
  for (const milestone of data.milestones.filter((m) => m.status === "Blocked")) {
    candidates.push({
      id: `milestone-blocked-${milestone.id}`,
      type: "milestone",
      urgency: "critical",
      title: `Unblock milestone: ${milestone.milestone_ref}`,
      reason: `"${milestone.title}" is blocked; this can delay downstream governance and delivery gates.`,
      href: "/milestones",
      ref: milestone.milestone_ref,
      source: source(milestone.milestone_ref),
      entityType: "milestone",
      entityId: milestone.id,
      importance: 96,
      urgencyScore: 96,
      confidence: 98,
      domain: textDomain(milestone.title),
    });
  }

  for (const milestone of data.milestones.filter((m) => {
    const d = daysUntil(m.target_date, now);
    return d !== null && d >= 0 && d <= 7 && !["Complete", "Closed"].includes(m.status);
  })) {
    const d = daysUntil(milestone.target_date, now)!;
    const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
    candidates.push({
      id: `milestone-${milestone.id}`,
      type: "milestone",
      urgency: d <= 1 ? "critical" : d <= 3 ? "high" : "medium",
      title: `Prepare milestone due ${when}: ${milestone.milestone_ref}`,
      reason: `"${milestone.title}" is due ${when}; confirm entry/exit criteria for the current phase.`,
      href: "/milestones",
      ref: milestone.milestone_ref,
      source: source(milestone.milestone_ref),
      entityType: "milestone",
      entityId: milestone.id,
      importance: 70 + (7 - d) * 3,
      urgencyScore: 62 + (7 - d) * 4,
      confidence: 88,
      domain: textDomain(milestone.title),
    });
  }
}

function addMeetingCandidates(data: DataStore, candidates: Candidate[]) {
  const pendingSuggestions = (data.meeting_suggestions ?? []).filter((s) => s.status === "Pending");
  if (pendingSuggestions.length > 0) {
    candidates.push({
      id: "meeting-intelligence-pending",
      type: "intelligence",
      urgency: "medium",
      title: `Review ${plural(pendingSuggestions.length, "meeting suggestion")}`,
      reason: `Meeting Intelligence has ${plural(pendingSuggestions.length, "unreviewed suggestion")} ready; apply only those that support the current delivery phase.`,
      href: "/meeting-intelligence",
      source: pendingSuggestions.map((s) => s.id),
      entityType: "meeting_suggestion",
      importance: 54,
      urgencyScore: 42,
      confidence: 74,
      domain: "governance",
    });
  }
}

function generateCandidates(data: DataStore, now: Date): Candidate[] {
  const candidates: Candidate[] = [];
  addActionCandidates(data, candidates, now);
  addDecisionCandidates(data, candidates, now);
  addRiskCandidates(data, candidates);
  addRequirementAndQuestionCandidates(data, candidates);
  addTestingCandidates(data, candidates);
  addAcceptanceAndDependencyCandidates(data, candidates);
  addDeliverableCandidates(data, candidates, now);
  addMilestoneCandidates(data, candidates, now);
  addMeetingCandidates(data, candidates);
  return candidates;
}

function scoreInsights(data: DataStore, project: Project, now: Date) {
  const scoped = scopeProjectData(data, project);
  const phase = deriveProjectPhase(data, project, now);
  const scored = generateCandidates(scoped, now)
    .map((candidate) => scoreCandidate(candidate, phase.phase))
    .sort((a, b) => b.priority - a.priority);
  const seen = new Set<string>();
  const deduped = scored.filter((item) => {
    const sourceKey = item.source?.length === 1 ? `${item.entityType ?? item.type}:${item.source[0]}` : item.id;
    return seen.has(sourceKey) ? false : seen.add(sourceKey) && true;
  });
  const stale = (item: Recommendation) => isLikelyStaleForPhase(item, phase.phase);
  const generated = deduped.filter((item) => !stale(item) && (item.phaseRelevance >= 20 || item.urgency === "critical"));
  const suppressed = deduped.filter((item) => stale(item) || (item.phaseRelevance < 20 && item.urgency !== "critical"));
  return { phase, generated, suppressed };
}

function isLikelyStaleForPhase(item: Recommendation, phase: ProjectPhase) {
  const text = `${item.title} ${item.reason} ${item.source?.join(" ") ?? ""}`.toLowerCase();
  if (["UAT", "Deployment", "Hypercare"].includes(phase) && /development complete|system integration test environment|sit environment/.test(text)) return true;
  if (["Deployment", "Hypercare"].includes(phase) && /uat availability/.test(text)) return true;
  return false;
}

function diagnosticWarnings(data: DataStore, phase: ProjectPhaseEvidence, project: Project): DeliveryDiagnosticWarning[] {
  const warnings: DeliveryDiagnosticWarning[] = [];
  if (project.status === "Discovery" && phase.phase !== "Discovery") {
    warnings.push({
      id: "project-status-lags-derived-phase",
      severity: "warning",
      message: `Project status is Discovery, but delivery evidence derives the current phase as ${phase.phase}.`,
      source: [project.name],
    });
  }

  const incompleteRequirements = data.requirements.filter((r) => !isRequirementSignedOff(r.status));
  const developmentComplete = data.deliverables.length > 0 && data.deliverables.every(isDevelopmentComplete);
  if (developmentComplete && incompleteRequirements.length > 0) {
    warnings.push({
      id: "development-complete-requirements-open",
      severity: "warning",
      message: `Development appears complete but ${incompleteRequirements.length} requirement${incompleteRequirements.length === 1 ? " is" : "s are"} still not signed off.`,
      source: incompleteRequirements.map((r) => r.requirement_ref),
    });
  }

  const sitComplete = data.deliverables.length > 0 && data.deliverables.every(isSitComplete);
  const notStartedTests = data.test_cases.filter((t) => ["Pending", "In Progress"].includes(t.status));
  if (sitComplete && notStartedTests.length > 0) {
    warnings.push({
      id: "sit-complete-tests-not-started",
      severity: "warning",
      message: `SIT appears complete but ${notStartedTests.length} test case${notStartedTests.length === 1 ? " is" : "s are"} still Pending or In Progress.`,
      source: notStartedTests.map((t) => t.test_ref),
    });
  }

  const uatReadyDeliverables = data.deliverables.filter((d) =>
    d.status === "Ready for UAT" ||
    d.status === "UAT Complete" ||
    ["Ready", "In Progress", "Passed"].includes(d.uat_status),
  );
  if (phase.phase === "UAT" && uatReadyDeliverables.length === 0) {
    warnings.push({
      id: "uat-active-no-deliverable-ready",
      severity: "warning",
      message: "UAT is the derived current phase, but no deliverable is marked ready for UAT or active in UAT.",
      source: data.timeline_items.filter((item) => /uat|customer acceptance/i.test(item.phase_name)).map((item) => item.phase_ref),
    });
  }

  const staleDependencies = data.dependencies.filter((dependency) =>
    isDependencyOpen(dependency.status) &&
    ["UAT", "Deployment", "Hypercare"].includes(phase.phase) &&
    /development complete|system integration test environment|sit environment/i.test(dependency.name),
  );
  if (staleDependencies.length > 0) {
    warnings.push({
      id: "prior-phase-dependencies-still-open",
      severity: "warning",
      message: `${staleDependencies.length} prior-phase dependenc${staleDependencies.length === 1 ? "y is" : "ies are"} still open while the project is in ${phase.phase}.`,
      source: staleDependencies.map((dependency) => dependency.name),
    });
  }

  return warnings;
}

// project defaults to selectActiveProject(data) — every existing caller that
// doesn't pass one keeps today's behaviour unchanged. Callers that have
// already resolved an exact project (e.g. lib/project-state.ts) pass it
// explicitly so this never re-selects a different project underneath them.
export function buildDeliveryInsightAnalysis(data: DataStore, maxCount = 5, now = new Date(), project = selectActiveProject(data)): DeliveryInsightAnalysis {
  if (!project) return { project: null, phase: null, insights: [] };

  const { phase, generated } = scoreInsights(data, project, now);
  const insights = generated
    .slice(0, maxCount)
    .map(toDeliveryInsight);

  return { project, phase, insights };
}

export function buildDeliveryInsights(data: DataStore, maxCount = 5, now = new Date(), project = selectActiveProject(data)): DeliveryInsight[] {
  return buildDeliveryInsightAnalysis(data, maxCount, now, project).insights;
}

export function buildDeliveryDiagnostics(data: DataStore, project = selectActiveProject(data), now = new Date()): DeliveryInsightDiagnostics {
  if (!project) {
    return {
      project: null,
      phase: null,
      insights: [],
      suppressedInsights: [],
      confidenceDeductions: [],
      recommendationScores: [],
      warnings: [],
    };
  }

  const scoped = scopeProjectData(data, project);
  const { phase, generated, suppressed } = scoreInsights(data, project, now);
  const insights = generated.map(toDeliveryInsight);
  const suppressedInsights = suppressed.map((item): SuppressedDeliveryInsight => ({
    ...toDeliveryInsight(item),
    suppressionReason: isLikelyStaleForPhase(item, phase.phase)
      ? `${item.phase} phase indicates this prior-phase source is likely stale and should be reviewed as data quality.`
      : `${item.phase} phase relevance is ${item.phaseRelevance}%, below the active threshold for non-critical insights.`,
  }));
  return {
    project,
    phase,
    insights,
    suppressedInsights,
    confidenceDeductions: insights
      .filter((item) => recommendationPenalty(item) > 0)
      .map((item) => ({ insightId: item.id, title: item.title, impact: recommendationPenalty(item), source: item.source })),
    recommendationScores: insights.map((item) => ({
      insightId: item.id,
      title: item.title,
      score: item.score,
      importance: item.importance,
      urgency: item.urgency,
      phaseRelevance: item.phaseRelevance,
      confidence: item.confidence,
    })),
    warnings: diagnosticWarnings(scoped, phase, project),
  };
}

export function buildRecommendationAnalysis(data: DataStore, maxCount = 5, now = new Date(), project = selectActiveProject(data)): RecommendationAnalysis {
  const analysis = buildDeliveryInsightAnalysis(data, maxCount, now, project);
  return {
    ...analysis,
    recommendations: analysis.insights.map(toRecommendation),
  };
}

export function buildRecommendations(data: DataStore, maxCount = 5, project = selectActiveProject(data)): Recommendation[] {
  return buildRecommendationAnalysis(data, maxCount, new Date(), project).recommendations;
}

export function recommendationPenalty(item: DeliveryInsight | Recommendation): number {
  if ("confidenceImpact" in item && typeof item.confidenceImpact === "number") return item.confidenceImpact;
  const priority = typeof item.priority === "string" ? item.priority : item.urgency as RecommendationUrgency;
  return confidenceImpactFromScores(priority, item.phaseRelevance, item.confidence);
}
