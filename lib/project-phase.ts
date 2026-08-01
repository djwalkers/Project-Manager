import { isDeliverableComplete, isDevelopmentComplete, isSitComplete, isUatComplete } from "@/lib/delivery";
import { scopeProjectData } from "@/lib/project-scope";
import { calculateSchedule } from "@/lib/schedule";
import type { DataStore } from "@/lib/data-store";
import type { Project, TimelineItem } from "@/lib/types";

export type ProjectPhase =
  | "Discovery"
  | "Analysis"
  | "Design"
  | "Development"
  | "SIT"
  | "UAT"
  | "Deployment"
  | "Hypercare"
  | "Closed";

export type ProjectPhaseEvidence = {
  phase: ProjectPhase;
  confidence: number;
  source: "project" | "timeline" | "deliverables" | "milestones" | "testing" | "fallback";
  detail: string;
};

// Central phase ordering — the single place phase-gated applicability rules
// are defined (Phase 6). Consumed by lib/go-live-readiness.ts (manual check
// resolution) and lib/project-intelligence.ts (GLR finding suppression) so
// neither duplicates the ordering or the gate table.
export const PROJECT_PHASE_ORDER: ProjectPhase[] = [
  "Discovery", "Analysis", "Design", "Development", "SIT", "UAT", "Deployment", "Hypercare", "Closed",
];

export function isPhaseAtOrAfter(phase: ProjectPhase, gate: ProjectPhase): boolean {
  return PROJECT_PHASE_ORDER.indexOf(phase) >= PROJECT_PHASE_ORDER.indexOf(gate);
}

export type ManualCheckKey =
  | "customer_approval"
  | "warehouse_training"
  | "deployment_cutover_approval"
  | "rollback_plan_approved"
  | "hypercare_owner_assigned"
  | "support_rota_confirmed";

export const MANUAL_CHECK_APPLICABLE_FROM: Record<ManualCheckKey, ProjectPhase> = {
  customer_approval: "UAT",
  warehouse_training: "UAT",
  deployment_cutover_approval: "Deployment",
  rollback_plan_approved: "Deployment",
  hypercare_owner_assigned: "Deployment",
  support_rota_confirmed: "Deployment",
};

function phaseFromText(value: string | null | undefined): ProjectPhase | null {
  const text = String(value ?? "").toLowerCase();
  if (!text.trim()) return null;
  if (/closed/.test(text)) return "Closed";
  if (/hypercare|support|stabili[sz]ation|warranty/.test(text)) return "Hypercare";
  if (/deploy|deployment|go.?live|release|cutover|cab/.test(text)) return "Deployment";
  if (/uat|user acceptance|customer acceptance|customer sign.?off/.test(text)) return "UAT";
  if (/\bsit\b|system integration|integration test|test execution|testing/.test(text)) return "SIT";
  if (/develop|build|engineering|implementation|code/.test(text)) return "Development";
  if (/design|solution|technical design|ui design/.test(text)) return "Design";
  if (/analysis|analyse|functional|requirements|discovery/.test(text)) {
    return /discovery/.test(text) ? "Discovery" : "Analysis";
  }
  return null;
}

function timelineEvidence(items: TimelineItem[]): ProjectPhaseEvidence | null {
  const active = [...items]
    .filter((item) => ["Blocked", "At Risk", "In Progress"].includes(item.status))
    .sort((a, b) => {
      const statusRank = { Blocked: 0, "At Risk": 1, "In Progress": 2 } as Record<string, number>;
      return statusRank[a.status] - statusRank[b.status] || a.start_date.localeCompare(b.start_date);
    });

  for (const item of active) {
    const phase = phaseFromText(`${item.phase_ref} ${item.phase_name} ${item.owner ?? ""}`);
    if (phase) {
      return {
        phase,
        confidence: item.status === "In Progress" ? 95 : 88,
        source: "timeline",
        detail: `${item.phase_name} is ${item.status}`,
      };
    }
  }

  return null;
}

export function deriveProjectPhase(data: DataStore, project: Project, now = new Date()): ProjectPhaseEvidence {
  if (["Complete", "Closed"].includes(project.status)) {
    return { phase: "Closed", confidence: 100, source: "project", detail: `Project status is ${project.status}` };
  }

  const scoped = scopeProjectData(data, project);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);
  const fromTimeline = timelineEvidence([...schedule.blocked, ...schedule.atRisk, ...schedule.active]);
  if (fromTimeline) return fromTimeline;

  const deliverables = scoped.deliverables;
  if (deliverables.some((item) => item.status === "Ready for Deployment" || item.deployment_status === "Ready" || item.deployment_status === "Scheduled")) {
    const uatStillActive = deliverables.some((item) => ["Ready", "In Progress"].includes(item.uat_status) || item.status === "Ready for UAT");
    if (uatStillActive) {
      return { phase: "UAT", confidence: 86, source: "deliverables", detail: "Deliverables are ready for customer UAT and UAT is not yet complete" };
    }
    return { phase: "Deployment", confidence: 82, source: "deliverables", detail: "Deliverables are approaching deployment readiness" };
  }
  if (deliverables.some((item) => item.status === "Ready for UAT" || item.status === "UAT Complete" || ["Ready", "In Progress", "Passed"].includes(item.uat_status))) {
    return { phase: "UAT", confidence: 82, source: "deliverables", detail: "Deliverables are in or approaching UAT" };
  }
  if (deliverables.some((item) => item.status === "Ready for SIT" || item.status === "SIT Complete" || ["Ready", "In Progress", "Passed"].includes(item.sit_status))) {
    return { phase: "SIT", confidence: 82, source: "deliverables", detail: "Deliverables are in or approaching SIT" };
  }
  if (deliverables.some((item) => item.status === "In Development" || (!isDevelopmentComplete(item) && item.development_status === "In Progress"))) {
    return { phase: "Development", confidence: 78, source: "deliverables", detail: "Deliverables are in development" };
  }
  if (deliverables.some((item) => item.status === "In Analysis" || item.development_status === "In Analysis")) {
    return { phase: "Analysis", confidence: 74, source: "deliverables", detail: "Deliverables are in analysis" };
  }
  if (deliverables.length > 0 && deliverables.every(isDeliverableComplete)) {
    return { phase: "Hypercare", confidence: 72, source: "deliverables", detail: "All deliverables are deployed" };
  }

  const fromMilestone = [...scoped.milestones]
    .filter((item) => item.status !== "Complete")
    .sort((a, b) => String(a.target_date ?? "").localeCompare(String(b.target_date ?? "")))
    .map((item) => ({ item, phase: phaseFromText(item.title) }))
    .find((entry) => entry.phase);
  if (fromMilestone?.phase) {
    return {
      phase: fromMilestone.phase,
      confidence: 72,
      source: "milestones",
      detail: `Next milestone is ${fromMilestone.item.title}`,
    };
  }

  if (scoped.test_cases.some((item) => ["Failed", "Blocked", "In Progress"].includes(item.status)) || scoped.test_cases.some((item) => item.status === "Pending")) {
    const sitComplete = deliverables.length > 0 && deliverables.every(isSitComplete);
    const uatComplete = deliverables.length > 0 && deliverables.every(isUatComplete);
    return {
      phase: sitComplete && !uatComplete ? "UAT" : "SIT",
      confidence: 66,
      source: "testing",
      detail: "Testing records are active",
    };
  }

  const fromProject = phaseFromText(project.status);
  if (fromProject) return { phase: fromProject, confidence: 60, source: "project", detail: `Project status is ${project.status}` };

  return { phase: "Discovery", confidence: 45, source: "fallback", detail: "No reliable phase signal found; defaulted to Discovery" };
}
