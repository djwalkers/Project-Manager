import type { DataStore } from "@/lib/data-store";
import { scopeProjectData, selectActiveProject } from "@/lib/project-scope";
import { saveRecord } from "@/lib/supabase/data-store";
import { computeReadiness } from "@/components/requirement-readiness";
import { computeDeliveryConfidence } from "@/lib/delivery-confidence";
import type { ProjectSnapshot } from "@/lib/types";

export function todaySnapshotExists(data: DataStore, projectId: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return (data.project_snapshots ?? []).some(
    (s) => s.project_id === projectId && s.snapshot_date === today,
  );
}

export async function captureSnapshot(data: DataStore): Promise<ProjectSnapshot | null> {
  const project = selectActiveProject(data);
  if (!project) return null;

  const scoped = scopeProjectData(data, project);
  const today = new Date().toISOString().slice(0, 10);

  const allAC = scoped.acceptance_criteria ?? [];
  const allEvidence = scoped.evidence ?? [];
  const allSignOffs = scoped.requirement_sign_offs ?? [];

  const readiness = computeReadiness(allAC, allEvidence, allSignOffs, scoped.test_cases);
  const confidence = computeDeliveryConfidence(data);

  const todayStr = today;

  const existing = (data.project_snapshots ?? []).find(
    (s) => s.project_id === project.id && s.snapshot_date === today,
  );

  const payload = {
    ...(existing ? { id: existing.id } : {}),
    project_id: project.id,
    snapshot_date: today,
    // Legacy fields (kept for backward compat)
    project_health: project.health,
    schedule_health: "Green" as const,
    progress_percent: 0,
    schedule_variance: 0,
    open_risks: scoped.risks.filter((r) => !["Complete", "Closed"].includes(r.status)).length,
    open_actions: scoped.actions.filter((a) => !["Complete", "Closed"].includes(a.status)).length,
    overdue_actions: scoped.actions.filter(
      (a) => a.due_date && a.due_date < todayStr && !["Complete", "Closed"].includes(a.status),
    ).length,
    open_decisions: scoped.decisions.filter(
      (d) => !["Approved", "Closed"].includes(d.status),
    ).length,
    overdue_decisions: 0,
    open_questions: scoped.discovery_questions.filter(
      (q) => !["Answered", "Closed"].includes(q.status),
    ).length,
    active_milestone: null,
    active_phase: null,
    // Delivery intelligence fields
    delivery_confidence: confidence.score,
    project_readiness: readiness.overall,
    requirements_complete: scoped.requirements.filter((r) =>
      ["Complete", "Closed"].includes(r.status),
    ).length,
    acceptance_complete: allAC.filter((ac) =>
      ac.status === "Met" || ac.status === "Waived",
    ).length,
    evidence_complete: allAC.filter((ac) =>
      allEvidence.some((ev) => ev.ac_id === ac.id),
    ).length,
    sign_off_complete: allSignOffs.filter((s) => s.status === "Approved").length,
    blocked_actions: scoped.actions.filter((a) => a.status === "Blocked").length,
    high_risks: scoped.risks.filter(
      (r) =>
        ["High", "Critical"].includes(r.impact) && !["Complete", "Closed"].includes(r.status),
    ).length,
    outstanding_dependencies: scoped.dependencies.filter(
      (d) => !["Complete", "Closed"].includes(d.status),
    ).length,
  };

  return (await saveRecord("project_snapshots", payload)) as ProjectSnapshot;
}
