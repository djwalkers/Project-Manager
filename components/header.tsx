"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Menu, User } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import { useAuth } from "@/contexts/auth-context";
import { ROLE_COLORS } from "@/lib/auth";
import { cn } from "@/lib/utils";

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
          <div>
            <p className="text-sm font-medium text-muted-foreground">Sysco / Replenishment</p>
            <h1 className="text-xl font-semibold">CR028 - Delivery Date Range</h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden rounded-md border bg-card px-3 py-2 text-sm font-medium text-muted-foreground sm:inline-flex">
            Discovery
          </span>

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
