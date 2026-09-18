"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DataStore } from "@/lib/data-store";
import { selectCanonicalProjects, selectProjectById } from "@/lib/project-scope";
import type { Project } from "@/lib/types";

const selectedProjectKey = "project-manager-selected-project-id";

export function loadSelectedProjectId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(selectedProjectKey);
}

export function persistSelectedProjectId(projectId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(selectedProjectKey, projectId);
}

// The canonical "which project is currently selected" resolver — the one
// place that combines "read the persisted id" with "resolve/validate/fall
// back" (selectProjectById already does the validate-and-fall-back part:
// an explicit id that still matches a real project wins outright; an
// unset or no-longer-valid id falls back to selectActiveProject's
// deterministic, name-unbiased pick). For read-only consumers that have no
// project switcher of their own (Dashboard, Control Tower, Reports,
// notification bell, the meeting list) — they must resolve the SAME
// project as every page that does have a switcher, without each
// reimplementing this pairing.
export function resolveSelectedProject(data: DataStore): Project | null {
  return selectProjectById(data, loadSelectedProjectId());
}

// The canonical selected-project mechanism for pages that render their own
// switcher (Workspace, Project Intelligence, Executive Timeline, Local AI
// Assistant, Go-Live Readiness). Replaces five independent, subtly
// inconsistent copies of "load the persisted id on mount, resolve it,
// expose a setter that persists" with one implementation, so every
// switcher-equipped page falls back identically when nothing (or no
// longer anything valid) is selected.
export function useSelectedProject(data: DataStore | null): {
  project: Project | null;
  projects: Project[];
  selectProject: (projectId: string) => void;
} {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProjectId(loadSelectedProjectId());
  }, []);

  const projects = useMemo(() => (data ? selectCanonicalProjects(data) : []), [data]);
  const project = data ? selectProjectById(data, selectedProjectId) : null;

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    persistSelectedProjectId(projectId);
  }, []);

  return { project, projects, selectProject };
}
