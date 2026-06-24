"use client";

export type UserRole = "Admin" | "Manager" | "Viewer";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  Admin: "Admin",
  Manager: "Manager",
  Viewer: "Viewer",
};

export const ROLE_COLORS: Record<UserRole, string> = {
  Admin:   "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  Manager: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  Viewer:  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

// Nav items that each role can access
export const ROLE_NAV_ACCESS: Record<UserRole, "all" | string[]> = {
  Admin: "all",
  Manager: [
    "/",
    "/project-workspace",
    "/project-intelligence",
    "/daily-brief",
    "/project-trends",
    "/projects",
    "/deliverables",
    "/requirements",
    "/risks",
    "/decisions",
    "/discovery-questions",
    "/actions",
    "/milestones",
    "/timeline",
    "/dependencies",
    "/testing",
    "/meetings",
    "/documents",
    "/system-health",
  ],
  Viewer: ["/"],
};
