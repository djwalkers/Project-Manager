import type { DataStore } from "@/lib/data-store";
import type { GoLiveChecklist, GoLiveChecklistCategory, Project, Risk } from "@/lib/types";
import { scopeProjectData } from "@/lib/project-scope";

export type GoLiveStatus = "Green" | "Amber" | "Red";

export type ReadinessCheck = {
  id: string;
  label: string;
  category: GoLiveChecklistCategory;
  matchItem: string;
  complete: boolean;
  blocked: boolean;
  waived: boolean;
  checklistItem: GoLiveChecklist | null;
};

export type GoLiveDashboard = {
  project: Project;
  status: GoLiveStatus;
  readinessPercent: number;
  completedItems: number;
  totalItems: number;
  blockerCount: number;
  openRisks: number;
  openCriticalRisks: number;
  outstandingDecisions: number;
  outstandingDeliverables: number;
  outstandingTesting: number;
  wmsChecks: ReadinessCheck[];
  hasGoLiveDate: boolean;
  goLiveDate: string | null;
  daysToGoLive: number | null;
};

const WMS_CHECKS: Array<{ id: string; label: string; category: GoLiveChecklistCategory; matchItem: string }> = [
  { id: "requirements_signed_off", label: "Requirements Signed Off", category: "Requirements", matchItem: "requirements" },
  { id: "development_complete", label: "Development Complete", category: "Development", matchItem: "development" },
  { id: "sit_complete", label: "SIT Complete", category: "SIT", matchItem: "sit" },
  { id: "uat_signed_off", label: "UAT Signed Off", category: "UAT", matchItem: "uat" },
  { id: "customer_approval", label: "Customer Approval Complete", category: "Customer Approval", matchItem: "customer" },
  { id: "warehouse_training", label: "Warehouse Training Complete", category: "Training", matchItem: "training" },
  { id: "deployment_approved", label: "Deployment Approved", category: "Deployment", matchItem: "deployment" },
  { id: "rollback_approved", label: "Rollback Plan Approved", category: "Rollback", matchItem: "rollback" },
  { id: "hypercare_assigned", label: "Hypercare Owner Assigned", category: "Hypercare", matchItem: "hypercare" },
  { id: "support_rota", label: "Support Rota Confirmed", category: "Support", matchItem: "support" },
];

export const GO_LIVE_CATEGORIES: GoLiveChecklistCategory[] = [
  "Requirements", "Development", "SIT", "UAT", "Data",
  "Training", "Deployment", "Hypercare", "Rollback", "Support", "Customer Approval",
];

export const GO_LIVE_CHECKLIST_STATUSES = ["Not Started", "In Progress", "Complete", "Blocked", "Waived"] as const;
export const CUTOVER_STEP_STATUSES = ["Not Started", "In Progress", "Complete", "Blocked", "Skipped"] as const;

function daysUntil(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

export function buildGoLiveDashboard(data: DataStore, project: Project, now = new Date()): GoLiveDashboard {
  const scoped = scopeProjectData(data, project);
  const checklists = (data.go_live_checklists ?? []).filter((c) => c.project_id === project.id);
  const cutover = (data.cutover_plan ?? []).filter((c) => c.project_id === project.id);

  // Readiness %: complete+waived / all non-waived
  const nonWaived = checklists.filter((c) => c.status !== "Waived");
  const done = checklists.filter((c) => c.status === "Complete" || c.status === "Waived");
  const totalForPercent = nonWaived.length + checklists.filter((c) => c.status === "Waived").length;
  const readinessPercent = totalForPercent === 0 ? 0 : Math.round((done.length / totalForPercent) * 100);
  const blockerCount = checklists.filter((c) => c.status === "Blocked").length + cutover.filter((c) => c.status === "Blocked").length;

  const openRisks = scoped.risks.filter((r: Risk) => !["Complete", "Closed"].includes(r.status)).length;
  const openCriticalRisks = scoped.risks.filter((r: Risk) => !["Complete", "Closed"].includes(r.status) && ["High", "Critical"].includes(r.impact)).length;
  const outstandingDecisions = scoped.decisions.filter((d) => !["Approved", "Closed"].includes(d.status)).length;
  const outstandingDeliverables = scoped.deliverables.filter((d) => !["Deployed", "Blocked"].includes(d.status) || d.status === "Blocked").length;
  const outstandingTesting = scoped.test_cases.filter((t) => !["Passed", "Blocked"].includes(t.status)).length;

  // Go-live date: look for milestone named "Go-Live" or "Go Live"
  const goLiveMilestone = scoped.milestones.find((m) => /go.?live/i.test(m.title));
  const goLiveDate = goLiveMilestone?.target_date ?? project.planned_end_date ?? null;
  const daysToGoLive = daysUntil(goLiveDate, now);

  // WMS readiness checks — match against checklist items by category + fuzzy item name
  const wmsChecks: ReadinessCheck[] = WMS_CHECKS.map((check) => {
    const match = checklists.find((c) =>
      c.category === check.category ||
      c.item.toLowerCase().includes(check.matchItem.toLowerCase()),
    );
    return {
      ...check,
      complete: match?.status === "Complete",
      blocked: match?.status === "Blocked",
      waived: match?.status === "Waived",
      checklistItem: match ?? null,
    };
  });

  // Status logic
  let status: GoLiveStatus;
  if (readinessPercent < 80 || openCriticalRisks > 0 || (blockerCount > 0 && readinessPercent < 90)) {
    status = "Red";
  } else if (readinessPercent < 95 || blockerCount > 0) {
    status = "Amber";
  } else {
    status = "Green";
  }

  return {
    project,
    status,
    readinessPercent,
    completedItems: done.length,
    totalItems: totalForPercent,
    blockerCount,
    openRisks,
    openCriticalRisks,
    outstandingDecisions,
    outstandingDeliverables,
    outstandingTesting,
    wmsChecks,
    hasGoLiveDate: Boolean(goLiveDate),
    goLiveDate,
    daysToGoLive,
  };
}
