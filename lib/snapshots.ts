import type { DataStore } from "@/lib/data-store";
import { selectActiveProject } from "@/lib/project-scope";
import { buildProjectState } from "@/lib/project-state";
import { saveRecord } from "@/lib/supabase/data-store";
import { computeReadiness } from "@/components/requirement-readiness";
import {
  isAcceptanceCriteriaMet,
  isActionBlocked,
  isActionOpen,
  isActionOverdue,
  isDecisionOpen,
  isDecisionOverdue,
  isDependencyOpen,
  isRiskHighOrCritical,
  isRiskOpen,
} from "@/lib/lifecycle";
import type { Project, ProjectSnapshot } from "@/lib/types";

export function todaySnapshotExists(data: DataStore, projectId: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return (data.project_snapshots ?? []).some(
    (s) => s.project_id === projectId && s.snapshot_date === today,
  );
}

// Pure snapshot payload builder — no I/O, so it's directly testable without
// a database. Requires an explicit project (never selects one itself, same
// discipline as buildProjectState). Reads schedule health and delivery
// confidence from the same ProjectState Workspace, Control Tower, and
// Manager Summary already read — fixes the previous hard-coded
// schedule_health: "Green", which did not reflect the project's actual
// schedule position.
export function buildSnapshotPayload(data: DataStore, project: Project, now = new Date()) {
  const state = buildProjectState(data, project, now);
  const scoped = state.scoped;
  const today = now.toISOString().slice(0, 10);

  const allAC = scoped.acceptance_criteria ?? [];
  const allEvidence = scoped.evidence ?? [];
  const allSignOffs = scoped.requirement_sign_offs ?? [];

  const readiness = computeReadiness(allAC, allEvidence, allSignOffs, scoped.test_cases);

  const existing = (data.project_snapshots ?? []).find(
    (s) => s.project_id === project.id && s.snapshot_date === today,
  );

  const payload = {
    ...(existing ? { id: existing.id } : {}),
    project_id: project.id,
    snapshot_date: today,
    // Legacy fields (kept for backward compat)
    project_health: project.health,
    schedule_health: state.scheduleHealth ?? "Review",
    progress_percent: 0,
    schedule_variance: 0,
    open_risks: scoped.risks.filter((r) => isRiskOpen(r.status)).length,
    open_actions: scoped.actions.filter((a) => isActionOpen(a.status)).length,
    overdue_actions: scoped.actions.filter((a) => isActionOverdue(a.due_date, a.status)).length,
    open_decisions: scoped.decisions.filter((d) => isDecisionOpen(d.status)).length,
    overdue_decisions: scoped.decisions.filter((d) => isDecisionOverdue(d.due_date, d.status)).length,
    open_questions: scoped.discovery_questions.filter(
      (q) => !["Answered", "Closed"].includes(q.status),
    ).length,
    active_milestone: null,
    active_phase: null,
    // Delivery intelligence fields
    delivery_confidence: state.confidence.score,
    project_readiness: readiness.overall,
    requirements_complete: scoped.requirements.filter((r) =>
      ["Complete", "Closed"].includes(r.status),
    ).length,
    acceptance_complete: allAC.filter((ac) => isAcceptanceCriteriaMet(ac.status)).length,
    evidence_complete: allAC.filter((ac) =>
      allEvidence.some((ev) => ev.ac_id === ac.id),
    ).length,
    sign_off_complete: allSignOffs.filter((s) => s.status === "Approved").length,
    blocked_actions: scoped.actions.filter((a) => isActionBlocked(a.status)).length,
    high_risks: scoped.risks.filter(
      (r) => isRiskHighOrCritical(r.impact) && isRiskOpen(r.status),
    ).length,
    outstanding_dependencies: scoped.dependencies.filter((d) => isDependencyOpen(d.status)).length,
  };

  return payload;
}

// project defaults to selectActiveProject(data) — every existing caller
// that doesn't pass one keeps today's behaviour unchanged. Callers that
// have already resolved an exact project (e.g. app/control-tower/page.tsx)
// pass it explicitly so this never re-selects a different project.
export async function captureSnapshot(data: DataStore, project: Project | null = selectActiveProject(data)): Promise<ProjectSnapshot | null> {
  if (!project) return null;
  const payload = buildSnapshotPayload(data, project);
  return (await saveRecord("project_snapshots", payload)) as ProjectSnapshot;
}
