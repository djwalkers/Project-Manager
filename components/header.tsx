"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LogOut, Menu, User } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { useAuth } from "@/contexts/auth-context";
import { useHeaderProjectSwitcher } from "@/contexts/selected-project-context";
import { ROLE_COLORS } from "@/lib/auth";
import { cn } from "@/lib/utils";

// The header's project switcher — the one place the currently selected
// project is always visible, on every project-scoped page, so the user
// never has to infer which project's data they're looking at. Switching
// here persists the new selection (contexts/selected-project-context.tsx)
// and every mounted project-scoped page picks it up immediately; the
// current route itself doesn't change, so the user stays on e.g.
// /milestones and simply sees the other project's milestones.
function ProjectSwitcher() {
  const { activeProject, projects, loading, selectProject } = useHeaderProjectSwitcher();
  const [open, setOpen] = useState(false);

  if (loading) return null;
  if (!activeProject) {
    return (
      <span className="hidden rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground sm:inline-flex">
        No project selected
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="font-semibold text-primary">{activeProject.project_ref ?? activeProject.name}</span>
        <span className="hidden max-w-[16rem] truncate text-muted-foreground sm:inline">{activeProject.name}</span>
        {projects.length > 1 && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </button>
      {open && projects.length > 1 && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul
            role="listbox"
            className="absolute left-0 z-20 mt-1 w-72 rounded-md border bg-card p-1 shadow-lg"
          >
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={project.id === activeProject.id}
                  onClick={() => {
                    selectProject(project.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                    project.id === activeProject.id && "bg-muted",
                  )}
                >
                  <span className="font-medium">{project.project_ref ?? project.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{project.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function Header({ onMenuOpen }: { onMenuOpen?: () => void }) {
  const [showLocalMode, setShowLocalMode] = useState(false);
  const { user, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    setShowLocalMode(!hasSupabaseConfig);
  }, []);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <div className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      {showLocalMode && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Supabase is not configured. The app is running in local mode.
        </div>
      )}
      <header className="flex min-h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          {onMenuOpen && (
            <button
              onClick={onMenuOpen}
              aria-label="Open navigation menu"
              className="flex h-9 w-9 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <ProjectSwitcher />
        </div>

        <div className="flex items-center gap-3">
          {user && (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "hidden rounded-md px-2.5 py-1 text-xs font-semibold sm:inline-flex",
                  ROLE_COLORS[user.role],
                )}
              >
                {user.role}
              </span>

              <div className="hidden flex-col items-end sm:flex">
                <span className="text-sm font-medium leading-tight">{user.fullName}</span>
                <span className="text-xs leading-tight text-muted-foreground">{user.email}</span>
              </div>

              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted sm:hidden">
                <User className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </span>

              {hasSupabaseConfig && (
                <button
                  onClick={handleSignOut}
                  className="flex h-9 w-9 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          <NotificationBell />
          <ThemeToggle />
        </div>
      </header>
    </div>
  );
}
