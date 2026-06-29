"use client";

import { calculateProgress, calculateProjectHealth } from "@/lib/control-tower";
import type { DataStore } from "@/lib/data-store";
import { scopeProjectData, selectCanonicalProjects } from "@/lib/project-scope";
import { calculateSchedule } from "@/lib/schedule";
import { upsertRecord } from "@/lib/supabase/data-store";
import type { Project, ProjectSnapshot } from "@/lib/types";
import { isOverdue } from "@/lib/utils";

function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function calculateProjectSnapshot(data: DataStore, project: Project, now = new Date()): Omit<ProjectSnapshot, "id" | "created_at"> {
  const scoped = scopeProjectData(data, project);
  const schedule = calculateSchedule(project, scoped.timeline_items, now);
  const overdueActions = scoped.actions.filter((item) => isOverdue(item.due_date, item.status)).length;
  const overdueDecisions = scoped.decisions.filter((item) => isOverdue(item.due_date, item.status)).length;
  const openActions = scoped.actions.filter((item) => !["Complete", "Closed"].includes(item.status)).length;
  const openDecisions = scoped.decisions.filter((item) => !["Approved", "Closed"].includes(item.status)).length;
  const blocked = scoped.milestones.filter((item) => item.status === "Blocked").length + schedule.blocked.length;
  const variance = schedule.variance ?? 0;
  const activeMilestone = scoped.milestones.find((item) => ["In Progress", "At Risk", "Blocked"].includes(item.status))
    ?? [...scoped.milestones].filter((item) => item.status !== "Complete").sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)))[0]
    ?? null;

  return {
    project_id: project.id,
    snapshot_date: localDate(now),
    project_health: calculateProjectHealth(overdueActions + overdueDecisions, blocked, schedule.variance ?? -1),
    schedule_health: schedule.health ?? "Review",
    progress_percent: calculateProgress(scoped, schedule.variance ?? -1).overall,
    schedule_variance: variance,
    open_risks: scoped.risks.filter((item) => !["Complete", "Closed"].includes(item.status)).length,
    open_actions: openActions,
    overdue_actions: overdueActions,
    open_decisions: openDecisions,
    overdue_decisions: overdueDecisions,
    open_questions: scoped.discovery_questions.filter((item) => !["Answered", "Closed"].includes(item.status)).length,
    active_milestone: activeMilestone?.title ?? null,
    active_phase: schedule.active[0]?.phase_name ?? schedule.atRisk[0]?.phase_name ?? schedule.blocked[0]?.phase_name ?? project.status,
    // Delivery intelligence fields — null in legacy snapshot-service path; populated by lib/snapshots.ts
    delivery_confidence: null,
    project_readiness: null,
    requirements_complete: null,
    acceptance_complete: null,
    evidence_complete: null,
    sign_off_complete: null,
    blocked_actions: null,
    high_risks: null,
    outstanding_dependencies: null,
  };
}

export async function saveDailySnapshots(data: DataStore, now = new Date()) {
  const snapshots = selectCanonicalProjects(data).map((project) => calculateProjectSnapshot(data, project, now));
  return Promise.all(snapshots.map((snapshot) => upsertRecord("project_snapshots", snapshot, ["project_id", "snapshot_date"])));
}
