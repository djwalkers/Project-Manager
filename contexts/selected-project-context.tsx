"use client";

// The single shared "which project is selected" state for the whole app.
// Before this, every page independently read localStorage on its own mount
// (lib/project-selection.ts's loadSelectedProjectId) and never learned about
// a switch made elsewhere without a full remount — the header couldn't show
// a live switcher, and switching project on one page didn't reactively
// update another page that happened to already be mounted.
//
// This provider holds the persisted selection in React state (initialised
// from localStorage, written back to it on every change) so every consumer
// — the header's switcher, the five pages with their own switcher, and every
// project-scoped module page — re-renders from the exact same value the
// instant it changes, with no dependency on navigation or remount.
//
// It does not hold project *data* beyond the project list itself (fetched
// once here, independently of each page's own useProjectData() call, purely
// so the header can render project names/refs without every page having to
// pass its data down through AppShell). Each page's own module data is
// unaffected and keeps loading through its own useProjectData().
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DataStore } from "@/lib/data-store";
import { loadSelectedProjectId, persistSelectedProjectId } from "@/lib/project-selection";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import { useProjectData } from "@/lib/use-project-data";
import type { Project } from "@/lib/types";

type SelectedProjectContextValue = {
  selectedProjectId: string | null;
  projects: Project[];
  activeProject: Project | null;
  loading: boolean;
  selectProject: (projectId: string) => void;
};

const SelectedProjectContext = createContext<SelectedProjectContextValue | null>(null);

export function SelectedProjectProvider({ children }: { children: React.ReactNode }) {
  const { data } = useProjectData();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProjectId(loadSelectedProjectId());
  }, []);

  const projects = useMemo(() => (data ? selectCanonicalProjects(data) : []), [data]);
  // Resolved with the exact same function every page-local useSelectedProject(data)
  // call resolves with — safe to share here because selectProjectById is a pure
  // function of (that page's own data, selectedProjectId), and every page's data
  // reads the same projects table, so this and a page's own resolution always agree.
  const activeProject = useMemo(() => (data ? selectProjectById(data, selectedProjectId) : null), [data, selectedProjectId]);

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
  }, []);

  const value = useMemo(
    () => ({ selectedProjectId, projects, activeProject, loading: !data, selectProject }),
    [selectedProjectId, projects, activeProject, data, selectProject],
  );

  return <SelectedProjectContext.Provider value={value}>{children}</SelectedProjectContext.Provider>;
}

function useSelectedProjectContext(): SelectedProjectContextValue {
  const ctx = useContext(SelectedProjectContext);
  if (!ctx) throw new Error("useSelectedProjectContext must be used within SelectedProjectProvider");
  return ctx;
}

// The canonical selected-project mechanism for any page that needs "the
// currently selected project" resolved against its OWN fetched data —
// every project-scoped page (module CRUD pages, Workspace, Project
// Intelligence, Executive Timeline, Go-Live Readiness, Local AI Assistant,
// Dashboard, Control Tower, Reports, the meeting list, the notification
// bell) uses this, not a page-local copy of the selection. Because the
// selection itself lives in SelectedProjectProvider above (not in this
// hook's own state), switching project anywhere — including the header's
// global switcher — is immediately reflected in every one of those pages
// that happens to be mounted, with no remount or navigation required.
export function useSelectedProject(data: DataStore | null): {
  project: Project | null;
  projects: Project[];
  selectProject: (projectId: string) => void;
} {
  const { selectedProjectId, projects, selectProject } = useSelectedProjectContext();
  const project = data ? selectProjectById(data, selectedProjectId) : null;
  return { project, projects, selectProject };
}

// The header's project switcher — unlike useSelectedProject(data) above, the
// header has no module data of its own to resolve a Project from, so it
// reads the provider's own resolution (activeProject) directly instead.
export function useHeaderProjectSwitcher(): {
  activeProject: Project | null;
  projects: Project[];
  loading: boolean;
  selectProject: (projectId: string) => void;
} {
  const { activeProject, projects, loading, selectProject } = useSelectedProjectContext();
  return { activeProject, projects, loading, selectProject };
}
