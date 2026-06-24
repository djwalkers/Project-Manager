"use client";

const selectedProjectKey = "project-manager-selected-project-id";

export function loadSelectedProjectId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(selectedProjectKey);
}

export function persistSelectedProjectId(projectId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(selectedProjectKey, projectId);
}

