"use client";

import type { DataStore } from "@/lib/data-store";
import { selectProjectById } from "@/lib/project-scope";
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

// The reactive, cross-page version of the resolver above — every consumer
// that needs "the currently selected project" to update live when the
// selection changes anywhere else in the app (the header's global switcher,
// or any project-scoped page) imports useSelectedProject from
// contexts/selected-project-context.tsx directly, not from this module —
// that file owns the shared React state (SelectedProjectProvider) this
// module's plain functions don't have, and importing it from here would
// create a circular dependency (it imports loadSelectedProjectId/
// persistSelectedProjectId from this file).
