"use client";

import { ArrowRight, BriefcaseBusiness, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { LoadErrorState, LoadingState } from "@/components/data-state";
import { FormDialog } from "@/components/form-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { useSelectedProject } from "@/contexts/selected-project-context";
import { getEntityName, logAudit } from "@/lib/audit";
import { moduleByKey, statusOptions, type ModuleConfig } from "@/lib/modules";
import { canCreateProject } from "@/lib/permissions";
import { hasDeliveryEvidence, selectCanonicalProjects } from "@/lib/project-scope";
import { buildProjectWorkspace } from "@/lib/project-workspace";
import { resolveGoLiveDate } from "@/lib/project-dates";
import { saveRecord } from "@/lib/supabase/data-store";
import { useProjectData } from "@/lib/use-project-data";
import { formatScheduleDate } from "@/lib/schedule";
import type { DataStore } from "@/lib/data-store";
import type { Project } from "@/lib/types";

type Row = Record<string, unknown>;

// This page is the application's definitive project entry point — see
// docs (Phase 2/6 of the multi-project scoping fix): Portfolio/Projects is
// GLOBAL (lists every project, unscoped), and "Open Project" is the one
// place a user picks which project every other, project-scoped page then
// stays locked to until they explicitly switch (here or via the header).
//
// Every figure on a card is read from buildProjectWorkspace/ProjectState —
// the same canonical, already-tested engine every other page uses. Nothing
// here re-derives health/progress/phase.

// The dedicated "New Project" dialog's fields — distinct from the generic
// `projects` module config (lib/modules.ts) so creation can require the
// fields a brand-new project actually needs (reference, name, customer,
// workstream) while leaving every lifecycle date optional and blank by
// default (see lib/project-creation.ts — no date is ever invented).
const newProjectFormConfig: ModuleConfig = {
  key: "projects",
  slug: "projects",
  title: "New Project",
  singular: "Project",
  description: "",
  icon: moduleByKey.get("projects")!.icon,
  searchFields: [],
  columns: [],
  fields: [
    { key: "project_ref", label: "Project reference / code", required: true },
    { key: "name", label: "Project name", required: true },
    { key: "customer", label: "Customer", required: true },
    { key: "workstream", label: "Workstream", required: true },
    { key: "owner", label: "Project owner / manager" },
    { key: "status", label: "Status", type: "select", options: statusOptions },
    { key: "description", label: "Description", type: "textarea" },
    { key: "planned_start_date", label: "Planned start date", type: "date" },
    { key: "planned_end_date", label: "Planned end date", type: "date" },
    { key: "go_live_date", label: "Go-Live date", type: "date" },
    { key: "uat_complete_date", label: "UAT complete date", type: "date" },
    { key: "hypercare_start_date", label: "Hypercare start date", type: "date" },
    { key: "hypercare_end_date", label: "Hypercare end date", type: "date" },
  ],
};

function ProjectCard({
  project,
  data,
  isActive,
  onOpen,
  onEdit,
}: {
  project: Project;
  data: DataStore;
  isActive: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const workspace = useMemo(() => buildProjectWorkspace(data, project), [data, project]);
  const assessed = hasDeliveryEvidence(workspace.scoped);
  const goLive = useMemo(() => resolveGoLiveDate(data, project), [data, project]);

  return (
    <div className={`flex flex-col gap-4 rounded-lg border bg-card p-5 shadow-operational ${isActive ? "ring-2 ring-primary" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{project.project_ref ?? "No reference"}</p>
          <h3 className="mt-0.5 truncate text-lg font-semibold">{project.name}</h3>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{project.customer} &middot; {project.workstream}</p>
        </div>
        <button
          onClick={onEdit}
          aria-label={`Edit ${project.name}`}
          title="Edit project"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Phase</p>
          <p className="mt-0.5 font-medium">{assessed ? workspace.activePhase : "Not Assessed"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Status</p>
          <StatusBadge value={project.status} className="mt-0.5" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Health</p>
          <StatusBadge value={assessed ? workspace.projectHealth : "Not Assessed"} className="mt-0.5" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Schedule</p>
          <StatusBadge value={assessed ? workspace.scheduleHealth : "Not Assessed"} className="mt-0.5" />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Progress</span>
          <span className="font-semibold tabular-nums">{workspace.progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={workspace.progress}>
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.min(100, Math.max(0, workspace.progress))}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-t pt-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Next milestone</p>
          <p className="mt-0.5 truncate font-medium">{workspace.nextMilestone?.title ?? "None scheduled"}</p>
          {workspace.nextMilestone?.target_date && (
            <p className="text-xs text-muted-foreground">{formatScheduleDate(workspace.nextMilestone.target_date)}</p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Go-Live date</p>
          <p className="mt-0.5 font-medium">{goLive.date ? formatScheduleDate(goLive.date) : "Not set"}</p>
        </div>
      </div>

      <Button onClick={onOpen} className="mt-1 w-full justify-center">
        {isActive ? "Currently open" : "Open Project"}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function ProjectsPortfolioPage() {
  const { data, setData, error, reload } = useProjectData();
  const { user } = useAuth();
  const { project: activeProject, selectProject } = useSelectedProject(data);
  const router = useRouter();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const projects = useMemo(() => (data ? selectCanonicalProjects(data) : []), [data]);
  const projectsConfig = moduleByKey.get("projects")!;

  function openProject(project: Project) {
    selectProject(project.id);
    router.push("/project-workspace");
  }

  // Goes through the dedicated, service-role-backed app/api/projects route
  // (see its own file for why) rather than saveRecord()/createRecord() —
  // the projects table's RLS only allows Admin to write, which would
  // silently reject a Manager's insert even though canCreateProject()
  // permits it. On success: select it and jump straight to its Workspace.
  async function createProjectAndOpen(record: Row) {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Failed to create project (${res.status})`);

    const created = body as Project;
    setData((current) => (current ? { ...current, projects: [created, ...current.projects] } : current));
    logAudit("projects", created.id, getEntityName("projects", created as unknown as Row), "Create", null);
    setNewProjectOpen(false);
    openProject(created);
  }

  async function persistProjectEdit(record: Row) {
    const saved = await saveRecord("projects", record);
    setData((current) => {
      if (!current) return current;
      const savedP = saved as Project;
      return { ...current, projects: current.projects.map((p) => (p.id === savedP.id ? savedP : p)) };
    });
    setEditingProject(null);
  }

  if (error) return <AppShell><LoadErrorState onRetry={reload} detail={error} /></AppShell>;
  if (!data) return <AppShell><LoadingState /></AppShell>;

  return (
    <AppShell>
      <div className="mb-5 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Projects</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Every project in the portfolio. Open one to work in it — every other page stays locked to that project until you switch.
          </p>
        </div>
        {canCreateProject(user?.role) && (
          <Button onClick={() => setNewProjectOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Project
          </Button>
        )}
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create the first project to start tracking requirements, risks, milestones and delivery readiness."
          icon={BriefcaseBusiness}
          action={canCreateProject(user?.role) ? () => setNewProjectOpen(true) : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              data={data}
              isActive={project.id === activeProject?.id}
              onOpen={() => openProject(project)}
              onEdit={() => setEditingProject(project)}
            />
          ))}
        </div>
      )}

      <FormDialog
        config={newProjectFormConfig}
        record={newProjectOpen ? {} : null}
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onSave={createProjectAndOpen}
      />

      <FormDialog
        config={projectsConfig}
        record={editingProject as unknown as Row | null}
        open={Boolean(editingProject)}
        onClose={() => setEditingProject(null)}
        onSave={persistProjectEdit}
      />
    </AppShell>
  );
}
