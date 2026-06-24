"use client";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { hasSupabaseConfig } from "@/lib/supabase/client";

export function Header() {
  const [showLocalMode, setShowLocalMode] = useState(false);

  useEffect(() => {
    setShowLocalMode(!hasSupabaseConfig);
  }, []);

  return (
    <div className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      {showLocalMode ? (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Supabase is not configured. The app is running in local mode.
        </div>
      ) : null}
      <header className="flex min-h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Sysco / Replenishment</p>
          <h1 className="text-xl font-semibold">CR028 - Delivery Date Range</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden rounded-md border bg-card px-3 py-2 text-sm font-medium text-muted-foreground sm:inline-flex">
            Discovery
          </span>
          <ThemeToggle />
        </div>
      </header>
    </div>
  );
}
