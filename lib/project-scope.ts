import type { DataStore } from "@/lib/data-store";
import type { Project, TimelineItem } from "@/lib/types";

const coreProjectTables = [
  "requirements",
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

export function selectActiveProject(data: DataStore): Project | null {
  const cr028Projects = data.projects.filter((project) => normalizedProjectName(project.name).includes("cr028"));
  const candidates = cr028Projects.length ? cr028Projects : data.projects;
  return [...candidates].sort((a, b) => {
    const scoreDifference = projectScore(data, b) - projectScore(data, a);
    return scoreDifference || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  })[0] ?? null;
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
