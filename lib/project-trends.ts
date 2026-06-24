import type { DataStore } from "@/lib/data-store";
import { selectCanonicalProjects } from "@/lib/project-scope";
import type { Project, ProjectSnapshot } from "@/lib/types";

const DAY_MS = 86_400_000;

export type TrendChange = {
  value: number;
  direction: "up" | "down" | "flat";
};

export type TrendAnalysis = {
  snapshots: ProjectSnapshot[];
  current: ProjectSnapshot | null;
  baseline: ProjectSnapshot | null;
  progressChange: TrendChange;
  riskChange: TrendChange;
  actionChange: TrendChange;
  decisionChange: TrendChange;
  varianceChange: TrendChange;
  narrative: string;
};

export type SinceYesterday = {
  projectId: string;
  projectName: string;
  available: boolean;
  progressChange: number;
  newRisks: number;
  closedRisks: number;
  newActions: number;
  completedActions: number;
  healthChange: string | null;
  milestoneChange: string | null;
};

export type WeeklyExecutiveSummary = {
  improved: string[];
  worsened: string[];
  upcomingMilestones: string[];
  projectsRequiringAttention: string[];
};

function sortedSnapshots(snapshots: ProjectSnapshot[]) {
  return [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
}

function change(current: number, baseline: number): TrendChange {
  const value = Math.round((current - baseline) * 10) / 10;
  return { value, direction: value > 0 ? "up" : value < 0 ? "down" : "flat" };
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

export function buildTrendAnalysis(project: Project, snapshots: ProjectSnapshot[]): TrendAnalysis {
  const ordered = sortedSnapshots(snapshots.filter((snapshot) => snapshot.project_id === project.id));
  const current = ordered.at(-1) ?? null;
  if (!current) {
    const empty = { value: 0, direction: "flat" as const };
    return { snapshots: ordered, current: null, baseline: null, progressChange: empty, riskChange: empty, actionChange: empty, decisionChange: empty, varianceChange: empty, narrative: `${project.name} has no snapshot history yet. Create a manual snapshot to establish the baseline.` };
  }

  const sevenDaysEarlier = new Date(`${current.snapshot_date}T00:00:00Z`).getTime() - 7 * DAY_MS;
  const baseline = [...ordered].reverse().find((snapshot) => new Date(`${snapshot.snapshot_date}T00:00:00Z`).getTime() <= sevenDaysEarlier) ?? ordered[0];
  const progressChange = change(current.progress_percent, baseline.progress_percent);
  const riskChange = change(current.open_risks, baseline.open_risks);
  const actionChange = change(current.open_actions, baseline.open_actions);
  const decisionChange = change(current.open_decisions, baseline.open_decisions);
  const varianceChange = change(current.schedule_variance, baseline.schedule_variance);
  const healthPhrase = current.project_health === baseline.project_health
    ? `Project health remains ${current.project_health}.`
    : `Project health changed from ${baseline.project_health} to ${current.project_health}.`;
  const narrative = `Over the available 7-day window progress changed from ${baseline.progress_percent}% to ${current.progress_percent}% (${signed(progressChange.value)} points). Open risks changed from ${baseline.open_risks} to ${current.open_risks}. Schedule variance moved from ${baseline.schedule_variance}% to ${current.schedule_variance}%. ${healthPhrase}`;

  return { snapshots: ordered, current, baseline, progressChange, riskChange, actionChange, decisionChange, varianceChange, narrative };
}

export function buildSinceYesterday(data: DataStore): SinceYesterday[] {
  return selectCanonicalProjects(data).map((project) => {
    const ordered = sortedSnapshots(data.project_snapshots.filter((snapshot) => snapshot.project_id === project.id));
    const current = ordered.at(-1);
    const previous = ordered.at(-2);
    if (!current || !previous) {
      return { projectId: project.id, projectName: project.name, available: false, progressChange: 0, newRisks: 0, closedRisks: 0, newActions: 0, completedActions: 0, healthChange: null, milestoneChange: null };
    }
    return {
      projectId: project.id,
      projectName: project.name,
      available: true,
      progressChange: Math.round((current.progress_percent - previous.progress_percent) * 10) / 10,
      newRisks: Math.max(0, current.open_risks - previous.open_risks),
      closedRisks: Math.max(0, previous.open_risks - current.open_risks),
      newActions: Math.max(0, current.open_actions - previous.open_actions),
      completedActions: Math.max(0, previous.open_actions - current.open_actions),
      healthChange: current.project_health === previous.project_health ? null : `${previous.project_health} → ${current.project_health}`,
      milestoneChange: current.active_milestone === previous.active_milestone ? null : `${previous.active_milestone ?? "None"} → ${current.active_milestone ?? "None"}`,
    };
  });
}

export function buildWeeklyExecutiveSummary(data: DataStore): WeeklyExecutiveSummary {
  const improved: string[] = [];
  const worsened: string[] = [];
  const upcomingMilestones: string[] = [];
  const projectsRequiringAttention: string[] = [];
  const healthRank = { Green: 3, Amber: 2, Red: 1 } as const;

  selectCanonicalProjects(data).forEach((project) => {
    const trend = buildTrendAnalysis(project, data.project_snapshots);
    if (trend.current && trend.baseline) {
      const healthDelta = healthRank[trend.current.project_health] - healthRank[trend.baseline.project_health];
      if (trend.progressChange.value > 0) improved.push(`${project.name}: progress increased ${trend.progressChange.value} points.`);
      if (trend.riskChange.value < 0) improved.push(`${project.name}: open risks reduced by ${Math.abs(trend.riskChange.value)}.`);
      if (trend.varianceChange.value > 0) improved.push(`${project.name}: schedule variance improved by ${trend.varianceChange.value} points.`);
      if (healthDelta > 0) improved.push(`${project.name}: health improved to ${trend.current.project_health}.`);
      if (trend.progressChange.value < 0) worsened.push(`${project.name}: progress reduced by ${Math.abs(trend.progressChange.value)} points.`);
      if (trend.riskChange.value > 0) worsened.push(`${project.name}: open risks increased by ${trend.riskChange.value}.`);
      if (trend.varianceChange.value < 0) worsened.push(`${project.name}: schedule variance deteriorated by ${Math.abs(trend.varianceChange.value)} points.`);
      if (healthDelta < 0) worsened.push(`${project.name}: health deteriorated to ${trend.current.project_health}.`);
      if (trend.current.project_health !== "Green") projectsRequiringAttention.push(`${project.name}: ${trend.current.project_health}`);
    } else {
      projectsRequiringAttention.push(`${project.name}: snapshot history is still building`);
    }

    const nextMilestone = [...data.milestones]
      .filter((item) => item.project_id === project.id && item.status !== "Complete" && item.target_date)
      .sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)))[0];
    if (nextMilestone) upcomingMilestones.push(`${project.name}: ${nextMilestone.title} on ${nextMilestone.target_date}.`);
  });

  return { improved, worsened, upcomingMilestones, projectsRequiringAttention };
}
