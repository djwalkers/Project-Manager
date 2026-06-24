import type { DataStore } from "@/lib/data-store";
import type { Project, TimelineItem } from "@/lib/types";

const coreProjectTables = [
  "requirements",
  "deliverables",
  "risks",
  "decisions",
  "actions",
  "dependencies",
  "discovery_questions",
  "milestones",
  "test_cases",
  "meetings",
  "documents",
  "activity_log",
] as const;

function normalizedProjectName(name: string) {
  return name.trim().toLowerCase();
}

function projectScore(data: DataStore, project: Project) {
  const coreRecords = coreProjectTables.reduce(
    (total, table) => total + data[table].filter((record) => record.project_id === project.id).length,
    0,
  );
  const timelineRecords = data.timeline_items.filter((item) => item.project_id === project.id).length;
  const dated = Number(Boolean(project.planned_start_date && project.planned_end_date));
  return coreRecords * 100 + timelineRecords * 10 + dated;
}

function strongestProject(data: DataStore, projects: Project[]) {
  return [...projects].sort((a, b) => {
    const scoreDifference = projectScore(data, b) - projectScore(data, a);
    return scoreDifference || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  })[0] ?? null;
}

export function selectActiveProject(data: DataStore): Project | null {
  const cr028Projects = data.projects.filter((project) => normalizedProjectName(project.name).includes("cr028"));
  const candidates = cr028Projects.length ? cr028Projects : data.projects;
  return strongestProject(data, candidates);
}

export function selectCanonicalProjects(data: DataStore): Project[] {
  const groups = new Map<string, Project[]>();
  data.projects.forEach((project) => {
    const key = normalizedProjectName(project.name);
    groups.set(key, [...(groups.get(key) ?? []), project]);
  });
  return Array.from(groups.values())
    .map((projects) => strongestProject(data, projects))
    .filter((project): project is Project => Boolean(project))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function selectProjectById(data: DataStore, projectId?: string | null): Project | null {
  if (!projectId) return selectActiveProject(data);
  return selectCanonicalProjects(data).find((project) => project.id === projectId)
    ?? data.projects.find((project) => project.id === projectId)
    ?? selectActiveProject(data);
}

export type TimelineScope = {
  items: TimelineItem[];
  mode: "exact" | "duplicate-project" | "unmatched";
  ownerProjectIds: string[];
};

export function selectTimelineItems(data: DataStore, activeProject: Project): TimelineScope {
  const exact = data.timeline_items.filter((item) => item.project_id === activeProject.id);
  const ownerProjectIds = Array.from(new Set(data.timeline_items.map((item) => item.project_id)));
  if (exact.length || data.timeline_items.length === 0) {
    return { items: exact, mode: "exact", ownerProjectIds };
  }

  const activeName = normalizedProjectName(activeProject.name);
  const duplicateIds = new Set(
    data.projects.filter((project) => normalizedProjectName(project.name) === activeName).map((project) => project.id),
  );
  const duplicateProjectItems = data.timeline_items.filter((item) => duplicateIds.has(item.project_id));
  if (duplicateProjectItems.length) {
    return { items: duplicateProjectItems, mode: "duplicate-project", ownerProjectIds };
  }

  return { items: [], mode: "unmatched", ownerProjectIds };
}

export function scopeProjectData(data: DataStore, project: Project): DataStore {
  const belongsToProject = <T extends { project_id: string }>(rows: T[]) => rows.filter((row) => row.project_id === project.id);
  return {
    projects: [project],
    requirements: belongsToProject(data.requirements),
    deliverables: belongsToProject(data.deliverables),
    risks: belongsToProject(data.risks),
    decisions: belongsToProject(data.decisions),
    actions: belongsToProject(data.actions),
    dependencies: belongsToProject(data.dependencies),
    discovery_questions: belongsToProject(data.discovery_questions),
    milestones: belongsToProject(data.milestones),
    timeline_items: selectTimelineItems(data, project).items,
    test_cases: belongsToProject(data.test_cases),
    meetings: belongsToProject(data.meetings),
    documents: belongsToProject(data.documents),
    activity_log: belongsToProject(data.activity_log),
    project_snapshots: belongsToProject(data.project_snapshots),
  };
}
